"""Launch log-walk writers through the real owner's chat and core task path."""
import http.client
import json
import math
import os
import re
import shlex
import time
import uuid

from logs_walk_support import PortForward, WalkError, free_port, now_ms

TASK_NAMESPACE = 'lifemodel-motor'


def writer_command(run_id, rate, seconds, size):
    """Tool stdout is captured: write to PID 1's actual CRI stdout instead."""
    program = (
        'import os,time; '
        'out=os.open("/proc/1/fd/1",os.O_WRONLY); '
        'start=time.monotonic(); '
        'pad="x"*%d\n'
        'for seq in range(1,%d+1):\n'
        ' delay=start+(seq-1)/%s-time.monotonic()\n'
        ' if delay>0: time.sleep(delay)\n'
        ' line=("walk-task-writer %s seq="+str(seq)+" "+pad+"\\n").encode()\n'
        ' while line:\n'
        '  written=os.write(out,line); line=line[written:]\n'
        'os.close(out)'
    ) % (size, math.ceil(rate * seconds), repr(rate), run_id)
    return 'python3 -c ' + shlex.quote(program)


def message_id():
    value = bytearray(os.urandom(16))
    value[:6] = (int(time.time() * 1000) & ((1 << 48) - 1)).to_bytes(6, 'big')
    value[6] = (value[6] & 15) | 0x70
    value[8] = (value[8] & 63) | 0x80
    return str(uuid.UUID(bytes=bytes(value)))


def web_request(port, method, path, origin, body=None, timeout=20):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        connection.request(method, path, None if body is None else json.dumps(body).encode(),
                           {'content-type': 'application/json', 'origin': 'https://' + origin})
        response = connection.getresponse()
        raw = response.read(64 * 1024)
        try:
            value = json.loads(raw)
        except ValueError:
            value = None
        return response.status, value if isinstance(value, dict) else {}
    finally:
        connection.close()


def task_pod(pod):
    metadata = pod.get('metadata') or {}
    labels = metadata.get('labels') or {}
    owners = metadata.get('ownerReferences') or []
    spec = pod.get('spec') or {}
    return (metadata.get('namespace') == TASK_NAMESPACE and bool(metadata.get('uid'))
            and labels.get('app.kubernetes.io/name') == 'task'
            and bool(labels.get('lifemodel.dev/launch-id'))
            and len(owners) == 1 and owners[0].get('kind') == 'Job'
            and owners[0].get('controller') is True and bool(owners[0].get('uid'))
            and spec.get('serviceAccountName') == 'task'
            and (pod.get('status') or {}).get('phase') in ('Running', 'Succeeded'))


def start_task_writer(report, options, loader, cluster, run_id, rate, seconds, size=0,
                      bound=180):
    """Return only after a newly launched task's first marker reached the loader.

    This asks the core; it never creates or edits objects in the task namespace.
    The core owns the bounded task lifecycle, including cleanup after completion.
    """
    if (not isinstance(run_id, str) or re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', run_id) is None
            or not isinstance(rate, (int, float)) or not math.isfinite(rate) or not 1 <= rate <= 2000
            or not isinstance(seconds, (int, float)) or not math.isfinite(seconds)
            or not 1 <= seconds <= 300 or not isinstance(size, int) or not 0 <= size <= 20480
            or not isinstance(bound, (int, float)) or not math.isfinite(bound) or not 1 <= bound <= 600):
        report.not_valid('task writer arguments are outside the bounded walk limits')
        return None
    deadline = time.monotonic() + bound
    started = now_ms()
    accepted = reply_names_task = new_pod_seen = marker_seen = False
    forward = PortForward(options.kubectl, getattr(options, 'web_namespace', 'lifemodel'),
                          'svc/' + getattr(options, 'web_service', 'web'), free_port(),
                          getattr(options, 'web_port', 8080))
    try:
        before = {item.get('metadata', {}).get('uid') for item in cluster.pods(TASK_NAMESPACE)}
        forward.start()
        if not forward.wait_ready(max(1, deadline - time.monotonic())):
            return None
        origin = getattr(options, 'web_host', 'lifemodel.local')
        status, baseline = web_request(forward.local_port, 'GET', '/api/transcript?limit=1',
                                       origin, timeout=max(1, min(20, deadline-time.monotonic())))
        cursor = baseline.get('cursor') if status == 200 else None
        if not isinstance(cursor, str) or re.fullmatch(r'0|[1-9][0-9]*', cursor) is None:
            cursor = '0'
        prompt = (
            'Run this bounded platform log walk now. Use core.startTask with profile small, '
            'no expected output files. Its briefing must run exactly the command below once '
            'and wait for completion. This deliberately writes to the task container stdout '
            'through /proc/1/fd/1, not the captured tool output. Do not create Kubernetes '
            'objects or change settings. Reply with the accepted task id. Command:\n'
            + writer_command(run_id, rate, seconds, size))
        status, _ = web_request(forward.local_port, 'POST', '/api/messages', origin,
                                {'id': message_id(), 'text': prompt},
                                timeout=max(1, min(20, deadline-time.monotonic())))
        accepted = status == 202
        if not accepted:
            return None
        marker = re.compile(r'^walk-task-writer ' + re.escape(run_id) + r' seq=1(?: |$)')
        while time.monotonic() < deadline:
            status, transcript = web_request(forward.local_port, 'GET',
                                             '/api/transcript?after=' + cursor + '&limit=100', origin,
                                             timeout=max(1, min(20, deadline-time.monotonic())))
            if status == 200:
                reply_names_task = reply_names_task or any(
                    row.get('role') == 'assistant' and re.search(r'\btask[_-][a-zA-Z0-9_-]+',
                                                               str(row.get('text') or ''))
                    for row in transcript.get('messages', []) if isinstance(row, dict))
            candidates = {item['metadata']['name']: item for item in cluster.pods(TASK_NAMESPACE)
                          if task_pod(item) and item['metadata']['uid'] not in before}
            new_pod_seen = new_pod_seen or bool(candidates)
            if candidates:
                answer = loader.logs({'from': str(started), 'to': str(now_ms()),
                                      'module': 'task', 'text': 'walk-task-writer ' + run_id + ' seq=1 ',
                                      'limit': '1000'})
                for record in (answer or {}).get('records') or []:
                    fields = record.get('fields') or {}
                    if (fields.get('pod') in candidates and fields.get('module') == 'task'
                            and fields.get('namespace') == TASK_NAMESPACE
                            and fields.get('container') == 'task'
                            and fields.get('untrusted') == 'true'
                            and marker.match(record.get('message') or '')):
                        marker_seen = True
                        report.pass_('real task writer reached the collector',
                                     'pod=%s module=task untrusted=true reply_names_task=%s'
                                     % (fields['pod'], bool(reply_names_task)))
                        return fields['pod'], 'task'
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        return None
    except (OSError, http.client.HTTPException, WalkError) as error:
        report.note('task writer transport failed: ' + type(error).__name__)
        return None
    finally:
        try:
            forward.close()
        except (OSError, WalkError) as error:
            report.note('task writer forward cleanup failed: ' + type(error).__name__)
        if not marker_seen:
            report.not_valid('real task writer not confirmed: chat_accepted=%s '
                             'reply_names_task=%s new_task_pod=%s first_collected_marker=false'
                             % (accepted, bool(reply_names_task), new_pod_seen))
