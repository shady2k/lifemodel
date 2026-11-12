"""Launch log-walk writers through the real owner's chat and core task path."""
import http.client
import json
import math
import os
import re
import shlex
import time
import uuid

from logs_walk_support import PortForward, WalkError, free_port, now_ms, parse_ms

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
        ' line=("walk-task-writer %s seq="+str(seq)+" duration=%ds "+pad+"\\n").encode()\n'
        ' while line:\n'
        '  written=os.write(out,line); line=line[written:]\n'
        'os.close(out)'
    ) % (size, math.ceil(rate * seconds), repr(rate), run_id, seconds)
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
            and spec.get('serviceAccountName') == 'task')


TASK_WRITER_ATTEMPTS = 3
# A task on the test VM can take minutes from chat to its first collected line;
# the bound is raised to 360 s and the accepted attempt's measured timings are
# reported, so the number is backed by the run rather than an assumption.
TASK_WRITER_BOUND = 360
# Each later attempt starts while every earlier attempt is still watched.
TASK_WRITER_START_GAP = 180
# Bound on deleting an abandoned attempt's Job and confirming its pods are gone.
TASK_WRITER_STOP_BOUND = 60
# A started chat can still create its task pod late; look for it for this long
# after the last abandoned Job was removed before declaring the cleanup quiet.
TASK_WRITER_SETTLE = 20
# The longest owner request the walk makes is the throttle case's fast writer:
# its burst seconds (at most 120) plus the launch bound. The accepted seconds
# limit adds that burst again as margin, so raising the bound raises it too.
THROTTLE_SECONDS_MAX = 120
TASK_WRITER_SECONDS_MAX = THROTTLE_SECONDS_MAX + TASK_WRITER_BOUND + THROTTLE_SECONDS_MAX


def task_prompt(attempt, command, seconds):
    """Ask for a real task; each later attempt is plainer about what is wanted."""
    hold = (' The command runs for %d seconds and must not be changed or shortened: '
            'wait until it exits, do not background it, and do not kill it.' % seconds)
    if attempt == 1:
        return (
            'Start a task now: call core.startTask with profile small and no expected '
            'output files. Its briefing must run exactly the command below once and wait '
            'for completion. The command must run as a task, not be answered in chat; do '
            'not create Kubernetes objects or change settings. Reply with the accepted '
            'task id. Command:\n' + command + hold)
    if attempt == 2:
        return (
            'Do not answer this message in chat. You must start a task: call '
            'core.startTask with profile small and no expected output files, and its '
            'briefing must run exactly the command below once and wait for completion. '
            'The command must run as a task, not be answered in chat. Reply with the task '
            'id only after the task exists. Command:\n' + command + hold)
    return (
        'This is the last request. Do not reply in chat and do not run anything '
        'yourself. Call core.startTask now with profile small and no expected output '
        'files; its briefing must be exactly the command below and nothing else. The '
        'command must run as a task, not be answered in chat; only a started task '
        'satisfies this request. Command:\n' + command + hold)


def attempt_seen(attempt, state):
    """What one attempt saw, without any text of the agent's reply."""
    text = ('attempt %d run=%s: chat_accepted=%s reply_names_task=%s new_task_pod=%s '
            'first_collected_marker=%s'
            % (attempt, str(state.get('run_id') or '-'), bool(state.get('accepted')),
               bool(state.get('reply_names_task')), bool(state.get('new_task_pod')),
               bool(state.get('marker'))))
    if state.get('transport'):
        text += ' transport=' + str(state['transport'])
    if state.get('refused'):
        text += ' refused=HTTP %s' % state['refused']
    if state.get('marker_problem'):
        text += ' problem=' + str(state['marker_problem'])
    return text


def attempt_run_id(run_id, attempt):
    """A run id no other attempt can write, so a late attempt is never mistaken."""
    return '%s-a%d' % (run_id, attempt)


def job_owner(pod):
    """The controlling Job of a task pod, from its ownerReferences."""
    for owner in (pod.get('metadata') or {}).get('ownerReferences') or []:
        if (owner.get('kind') == 'Job' and owner.get('controller') is True
                and owner.get('name') and owner.get('uid')):
            return {'name': owner['name'], 'uid': owner['uid']}
    return None


def delete_job(report, cluster, job):
    """Delete an abandoned task's Job, never its pod, and verify no pod remains."""
    result = cluster.run(['-n', TASK_NAMESPACE, 'delete', 'job', job['name'],
                          '--ignore-not-found', '--cascade=background',
                          '--wait=false'], timeout=60)
    if result.returncode != 0:
        report.check(False, 'the abandoned task Job is deleted',
                     '%s: exit %s' % (job['name'], result.returncode))
        return
    deadline = time.monotonic() + TASK_WRITER_STOP_BOUND
    remaining = []
    while True:
        remaining = [pod for pod in cluster.pods(TASK_NAMESPACE, 'job-name=' + job['name'])
                     if (job_owner(pod) or {}).get('uid') == job['uid']]
        if not remaining or time.monotonic() >= deadline:
            break
        time.sleep(2)
    report.check(not remaining, 'the abandoned task Job leaves no pod',
                 '%s: %s' % (job['name'],
                             'no pod remains' if not remaining else
                             '%d pod(s) remained after %d s'
                             % (len(remaining), TASK_WRITER_STOP_BOUND)))


def stop_abandoned_jobs(report, cluster, observed, before, keep_pod=None, settle=True):
    """Delete every abandoned attempt's Job, never a pod, and verify it is gone."""
    winner = observed.get(keep_pod) if keep_pod else None
    if keep_pod and winner is None:
        winner = cluster.pod(TASK_NAMESPACE, keep_pod)
    keep_job = job_owner(winner) if winner else None
    deleted = set()

    def abandoned(pod):
        if not task_pod(pod) or (pod.get('metadata') or {}).get('uid') in before:
            return None
        if keep_pod and (pod.get('metadata') or {}).get('name') == keep_pod:
            return None
        owner = job_owner(pod)
        if owner is None:
            return None
        if keep_job is not None and owner['uid'] == keep_job['uid']:
            return None
        return owner

    for pod in observed.values():
        owner = abandoned(pod)
        if owner is not None and owner['uid'] not in deleted:
            deleted.add(owner['uid'])
            delete_job(report, cluster, owner)
    if not settle:
        return
    quiet_until = time.monotonic() + TASK_WRITER_SETTLE
    while time.monotonic() < quiet_until:
        late = {}
        for pod in cluster.pods(TASK_NAMESPACE):
            owner = abandoned(pod)
            if owner is not None and owner['uid'] not in deleted:
                late[owner['uid']] = owner
        for uid, owner in late.items():
            deleted.add(uid)
            delete_job(report, cluster, owner)
        if late:
            quiet_until = time.monotonic() + TASK_WRITER_SETTLE
        else:
            time.sleep(2)


def start_attempt(forward, origin, attempt, run_id, command, bound, seconds):
    """Send one chat request; return the attempt state the poll loop watches."""
    started_ms = now_ms()
    state = {'run_id': run_id, 'accepted': False, 'reply_names_task': False,
             'new_task_pod': False, 'marker': False}
    status, baseline = web_request(forward.local_port, 'GET', '/api/transcript?limit=1',
                                   origin, timeout=max(1, min(20, bound)))
    cursor = baseline.get('cursor') if status == 200 else None
    if not isinstance(cursor, str) or re.fullmatch(r'0|[1-9][0-9]*', cursor) is None:
        cursor = '0'
    status, _ = web_request(forward.local_port, 'POST', '/api/messages', origin,
                            {'id': message_id(), 'text': task_prompt(attempt, command, seconds)},
                            timeout=max(1, min(20, bound)))
    state['accepted'] = status == 202
    accepted_at = time.monotonic() if state['accepted'] else None
    return {'attempt': attempt, 'run_id': run_id, 'command': command,
            'seconds': seconds, 'pods': [],
            'started_ms': started_ms, 'cursor': cursor, 'state': state,
            'accepted_at': accepted_at,
            'deadline': accepted_at + bound if accepted_at is not None else None,
            'pod_seen_at': None, 'marker_at': None, 'first_ms': None,
            'pod': None, 'done': not state['accepted']}


def poll_attempt(report, attempt, loader, cluster, forward, origin, before, observed,
                 seen_at):
    """Poll one open attempt's transcript, task pods and its own first marker."""
    if attempt['done'] or attempt['deadline'] is None:
        attempt['done'] = True
        return False
    moment = time.monotonic()
    if moment > attempt['deadline']:
        attempt['done'] = True
        return False
    remaining = max(1, attempt['deadline'] - moment)
    status, transcript = web_request(forward.local_port, 'GET',
                                     '/api/transcript?after=' + attempt['cursor']
                                     + '&limit=100', origin,
                                     timeout=max(1, min(20, remaining)))
    if status == 200:
        attempt['state']['reply_names_task'] = attempt['state']['reply_names_task'] or any(
            row.get('role') == 'assistant' and re.search(r'\btask[_-][a-zA-Z0-9_-]+',
                                                        str(row.get('text') or ''))
            for row in transcript.get('messages', []) if isinstance(row, dict))
    candidates = [pod for pod in cluster.pods(TASK_NAMESPACE)
                  if task_pod(pod) and (pod.get('metadata') or {}).get('uid') not in before]
    for pod in candidates:
        name = (pod.get('metadata') or {}).get('name')
        if name and name not in seen_at:
            seen_at[name] = moment
            attempt['pods'].append(name)
        if name:
            observed.setdefault(name, pod)
    if candidates:
        attempt['state']['new_task_pod'] = True
    # A pod can fail or be deleted before its collected marker is read, so the
    # store is always asked: the marker proves the writer ran even when the pod
    # object is gone, and the fields name the pod that ran.
    marker = re.compile(r'^walk-task-writer ' + re.escape(attempt['run_id'])
                        + r' seq=1 duration=(\d+)s(?: |$)')
    bare = re.compile(r'^walk-task-writer ' + re.escape(attempt['run_id'])
                      + r' seq=1(?: |$)')
    status, answer = loader.logs_page({
        'from': str(attempt['started_ms']), 'to': str(now_ms()), 'module': 'task',
        'text': 'walk-task-writer ' + attempt['run_id'] + ' seq=1 ', 'limit': '1000'})
    if status != 200:
        attempt['state']['refused'] = status
        attempt['done'] = True
        return False
    for record in (answer or {}).get('records') or []:
        fields = record.get('fields') or {}
        pod_name = fields.get('pod')
        known = (observed.get(pod_name) if pod_name else None) \
            or (cluster.pod(TASK_NAMESPACE, pod_name) if pod_name else None)
        if not (known is not None and task_pod(known)
                and fields.get('module') == 'task'
                and fields.get('namespace') == TASK_NAMESPACE
                and fields.get('container') == 'task'
                and fields.get('untrusted') == 'true'):
            continue
        message = record.get('message') or ''
        match = marker.match(message)
        if match is None:
            if bare.match(message):
                attempt['state']['marker_problem'] = (
                    'the collected seq=1 line carries no duration token: %r'
                    % message[:120])
                report.not_valid('task writer attempt %d %s (pod %s)'
                                 % (attempt['attempt'],
                                    attempt['state']['marker_problem'], pod_name))
                attempt['done'] = True
                return False
            continue
        ran = int(match.group(1))
        if ran != attempt['seconds']:
            attempt['state']['ran_duration'] = ran
            attempt['state']['marker_problem'] = (
                'the collected seq=1 line carries duration=%ds, not the requested %ds'
                % (ran, attempt['seconds']))
            report.not_valid('task writer attempt %d %s (pod %s)'
                             % (attempt['attempt'], attempt['state']['marker_problem'],
                                pod_name))
            attempt['done'] = True
            return False
        attempt['state']['marker'] = True
        attempt['first_ms'] = parse_ms(record.get('time'))
        attempt['marker_at'] = time.monotonic()
        attempt['pod'] = pod_name
        attempt['done'] = True
        return True
    return False


def attempt_evidence(report, cluster, loader, attempt):
    """Note what the attempt's pods ran and why they ended, without reply text."""
    names = list(dict.fromkeys((attempt.get('pods') or [])
                               + ([attempt['pod']] if attempt.get('pod') else [])))
    parts = []
    for name in names:
        pod = cluster.pod(TASK_NAMESPACE, name)
        if pod is None:
            parts.append('%s gone' % name)
            continue
        status = pod.get('status') or {}
        command = '(image entrypoint)'
        for container in (pod.get('spec') or {}).get('containers') or []:
            words = list(container.get('command') or []) + list(container.get('args') or [])
            if words:
                command = ' '.join(words)[:160]
        ended = 'not terminated'
        for container in status.get('containerStatuses') or []:
            if container.get('name') != 'task':
                continue
            state = container.get('state') or {}
            done = state.get('terminated') or {}
            if done:
                ended = 'exit=%s reason=%s' % (done.get('exitCode'), done.get('reason'))
            elif state.get('running'):
                ended = 'running'
        deadline = None
        owner = job_owner(pod)
        if owner is not None:
            job = cluster.json(['-n', TASK_NAMESPACE, 'get', 'job', owner['name'], '-o', 'json'])
            deadline = ((job or {}).get('spec') or {}).get('activeDeadlineSeconds')
        parts.append('%s phase=%s %s command=%s job_deadline=%s%s'
                     % (name, status.get('phase', 'unknown'), ended, command,
                        ('%ss' % deadline) if deadline else 'unknown',
                        (' (the requested %ds is under it)' % attempt.get('seconds' or 0))
                        if deadline and attempt.get('seconds') and
                        attempt['seconds'] < deadline else ''))
    lines, span = 0, 'unknown'
    status, answer = loader.logs_page({
        'from': str(attempt['started_ms']), 'to': str(now_ms()), 'module': 'task',
        'text': 'walk-task-writer ' + attempt['run_id'], 'limit': '1'})
    if status == 200:
        body = answer or {}
        try:
            lines = int(body.get('count') or 0)
        except (TypeError, ValueError):
            lines = 0
        newest = parse_ms(((body.get('records') or [{}])[0] or {}).get('time'))
        first = attempt.get('first_ms')
        if first is not None and newest is not None and newest >= first:
            span = '%.1f s' % ((newest - first) / 1000.0)
    report.note('task writer attempt %d ran: %s; collected_lines=%d span=%s; '
                'requested=%d s'
                % (attempt['attempt'], '; '.join(parts) or 'no pod seen', lines, span,
                   attempt.get('seconds') or 0))


def start_task_writer(report, options, loader, cluster, run_id, rate, seconds, size=0,
                      bound=TASK_WRITER_BOUND):
    """Return only after a newly launched task's first marker reached the loader.

    Up to TASK_WRITER_ATTEMPTS chat requests are started TASK_WRITER_START_GAP
    apart; every earlier attempt keeps being watched for its own run id until
    its bound, and the first collected marker wins. Abandoned attempts' Jobs are
    deleted (never a pod) and their pods' absence is verified. The accepted
    attempt's timings from chat accepted to pod Running to first marker are
    reported. No reply text is printed.
    """
    if (not isinstance(run_id, str) or re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', run_id) is None
            or not isinstance(rate, (int, float)) or not math.isfinite(rate) or not 1 <= rate <= 2000
            or not isinstance(seconds, (int, float)) or not math.isfinite(seconds)
            or not 1 <= seconds <= TASK_WRITER_SECONDS_MAX \
            or not isinstance(size, int) or not 0 <= size <= 20480
            or not isinstance(bound, (int, float)) or not math.isfinite(bound) or not 1 <= bound <= 600):
        report.not_valid('task writer arguments are outside the bounded walk limits')
        return None
    attempts = []
    observed = {}
    seen_at = {}
    winner = None
    forward = PortForward(options.kubectl, getattr(options, 'web_namespace', 'lifemodel'),
                          'svc/' + getattr(options, 'web_service', 'web'), free_port(),
                          getattr(options, 'web_port', 8080))
    try:
        before = {item.get('metadata', {}).get('uid') for item in cluster.pods(TASK_NAMESPACE)}
        forward.start()
        origin = getattr(options, 'web_host', 'lifemodel.local')
        overall = (time.monotonic() + (TASK_WRITER_ATTEMPTS - 1) * TASK_WRITER_START_GAP
                   + bound + 30)
        if not forward.wait_ready(max(1, min(bound, overall - time.monotonic()))):
            report.note('task writer: the web port-forward did not answer')
        else:
            next_start = time.monotonic()
            while time.monotonic() < overall:
                moment = time.monotonic()
                if (winner is None and len(attempts) < TASK_WRITER_ATTEMPTS
                        and moment >= next_start):
                    number = len(attempts) + 1
                    attempt_run = attempt_run_id(run_id, number)
                    attempts.append(start_attempt(
                        forward, origin, number, attempt_run,
                        writer_command(attempt_run, rate, seconds, size), bound, seconds))
                    next_start = moment + TASK_WRITER_START_GAP
                found = []
                for attempt in attempts:
                    if attempt['done']:
                        continue
                    if poll_attempt(report, attempt, loader, cluster, forward, origin,
                                    before, observed, seen_at):
                        found.append(attempt)
                if found:
                    winner = min(found, key=lambda item: (
                        item['first_ms'] if item['first_ms'] is not None else overall,
                        item['attempt']))
                    break
                if (len(attempts) >= TASK_WRITER_ATTEMPTS
                        and all(attempt['done'] for attempt in attempts)):
                    break
                time.sleep(min(1, max(0, overall - time.monotonic())))
        if attempts:
            for attempt in attempts:
                attempt_evidence(report, cluster, loader, attempt)
            stop_abandoned_jobs(report, cluster, observed, before,
                                winner['pod'] if winner is not None else None,
                                settle=any(item['state']['accepted'] for item in attempts))
        if winner is not None:
            accepted_at = winner['accepted_at']
            pod_at = seen_at.get(winner['pod'])
            marker_at = winner['marker_at']

            def measured(start, end):
                return ('%.1f s' % max(0.0, end - start)
                        if start is not None and end is not None else 'not sampled')

            report.pass_('real task writer reached the collector',
                         'attempt=%d run=%s pod=%s module=task untrusted=true '
                         'reply_names_task=%s; chat accepted -> pod Running %s, '
                         'pod Running -> first marker %s, chat accepted -> first marker %s'
                         % (winner['attempt'], winner['run_id'], winner['pod'],
                            bool(winner['state']['reply_names_task']),
                            measured(accepted_at, pod_at), measured(pod_at, marker_at),
                            measured(accepted_at, marker_at)))
            return (winner['pod'], 'task', winner['run_id'], winner['first_ms'])
    except (OSError, http.client.HTTPException, WalkError) as error:
        report.note('task writer transport failed: ' + type(error).__name__)
    finally:
        try:
            forward.close()
        except (OSError, WalkError) as error:
            report.note('task writer forward cleanup failed: ' + type(error).__name__)
    for attempt in attempts:
        report.note('task writer ' + attempt_seen(attempt['attempt'], attempt['state']))
    detail = '; '.join(attempt_seen(attempt['attempt'], attempt['state'])
                       for attempt in attempts)
    report.not_valid('real task writer not confirmed after %d attempt(s): %s'
                     % (TASK_WRITER_ATTEMPTS, detail or 'no attempt ran'))
    return None
