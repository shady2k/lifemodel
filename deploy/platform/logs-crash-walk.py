#!/usr/bin/env python3
"""WALK-LOGS-CRASH: what a collector crash loses, at the buffer's edge
(ADR-016 L07, §6).

What it proves
--------------
1. The saturated crash: with the store scaled to zero (its Deployment), a writer
   pod writes numbered lines with a run id until the sink's buffer is at its
   configured maximum - `vector_buffer_size_events` read from the collector's own
   exporter, with `vector_component_received_events_total` for the source well
   above `vector_buffer_max_size_events` - and if that state is not reached
   within --fill-bound the walk prints TEST NOT VALID and fails. The walk then
   `kill -9`s the **vector process** by its host pid, read with
   `k3s crictl inspect` for the collector's container: a pid of 1 (the pause
   container, not vector) means nothing was killed, which also fails.
2. Then the store returns, the collector recovers (bounded), and the walk counts
   through the loader's logs API: lines written, delivered, missing, duplicated,
   and the collector's restart count. Which numbered lines are still in the
   kubelet's files under `/var/log/pods/<writer pod>/` is read on the node, so a
   missing line is classed as "still in the kubelet's files" or "rotated away".
3. The verdict is the one L07 states, not one judged afterwards: every line still
   in the kubelet's files is delivered at least once, duplicates are allowed and
   counted, and a line lost while still in those files is a FAIL whose detail
   names its sequence numbers. Losing a line the kubelet has rotated away is
   allowed and said so.
4. The unsaturated crash - the same, with the buffer below its maximum - is a
   separate NOTE block: informative, never a substitute.

How the buffer is read, and when it cannot be
---------------------------------------------
This walk reads them from the collector's own Prometheus exporter
(`--metrics-port`, default 9598), declared in `deploy/platform/logs/config/
vector.yaml` as a `sources.internal_metrics` of type `internal_metrics` and a
`sinks.metrics` of type `prometheus_exporter` on 127.0.0.1:9598 - the pod's
loopback, read through a kubectl port-forward (ADR-016 §6). It never guesses: when
nothing answers there, or the answer carries no buffer gauge, the walk prints
TEST NOT VALID with the reason and fails; the unsaturated case still runs and is
reported.

Arguments (defaults are the test VM's)
-------------------------------------
  --password-file PATH   the loader's login password, read from this file and
                         never printed (required)
  --loader-host HOST     where the walk connects (default boot-lifemodel.local)
  --loader-port PORT     the loader's TLS port (default 443)
  --origin-host HOST     the host the loader answers on (default
                         boot-lifemodel.local)
  --ca-file PATH         verify the loader's certificate with this CA
  --kubectl COMMAND      default "k3s kubectl"
  --namespace NS         the store's namespace (default lifemodel-system)
  --store NAME           the store's Deployment (default logs-store)
  --collector-namespace NS  the collector's namespace (default lifemodel-logs)
  --collector NAME       the collector's DaemonSet (default logs-collector)
  --writer-namespace NS  where the writer pod runs; its own namespace
                         (default lifemodel-logs-walk)
  --metrics-port PORT    the collector's Prometheus exporter (default 9598)
  --fill-bound N         bound on reaching a full buffer (default 600 s)
  --recover-bound N      bound on the collector and the store recovering
                         (default 300 s)
  --writer-interval-ms N the writer pod's line interval (default 20)
  --saturated-seconds N  how long the saturated writer keeps writing after the
                         buffer is full before the kill (default 15)
  --unsaturated-lines N  lines the unsaturated case writes (default 5000)
  --settle-seconds N     how long the store may take to settle before counting
                         (default 60)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
It creates a namespace of its own and a writer pod in it, scales the store's
Deployment to zero and back, and kills the collector's vector process once or
twice. The `finally` scales the store back to the replicas it read, waits for it
to be Ready, deletes the writer pod and its namespace, waits for the collector to
be Running again, and prints a RESTORE line saying so.

What it does not cover
----------------------
What the collector does while its own pod is being replaced by k3s (that is the
restart count, read and reported); the kubelet's rotation policy is not changed,
so a run whose files rotated faster than the kill is stated, not fixed.
"""
import argparse
import http.client
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    Cluster,
    Loader,
    PortForward,
    Report,
    WalkError,
    common_arguments,
    now_ms,
    read_password,
    wait_until,
)

WRITER_MODULE = 'walk-crash-writer'
WRITER_LINE = re.compile(r'walk-crash (\S+) seq=(\d+)')
BUFFER_SIZE = 'vector_buffer_size_events'
BUFFER_MAX = 'vector_buffer_max_size_events'
RECEIVED = 'vector_component_received_events_total'
WRITER_SCRIPT = (
    "const run=process.argv[1],seconds=Number(process.argv[2]),interval=Number(process.argv[3]);"
    "let seq=0;const end=Date.now()+seconds*1000;"
    "const timer=setInterval(()=>{if(Date.now()>end){clearInterval(timer);return;}"
    "seq+=1;process.stdout.write('walk-crash '+run+' seq='+seq+' t='+Date.now()+'\\n');"
    "},interval);"
)


def writer_manifest(image, options, run_id, seconds):
    return {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': 'walk-crash-writer', 'namespace': options.writer_namespace,
                     'labels': {'app.kubernetes.io/name': WRITER_MODULE}},
        'spec': {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                                'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{
                'name': 'writer',
                'image': image,
                'command': ['node', '-e', WRITER_SCRIPT, run_id, str(seconds),
                            str(options.writer_interval_ms)],
                'securityContext': {'readOnlyRootFilesystem': True,
                                    'allowPrivilegeEscalation': False,
                                    'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '20m', 'memory': '32Mi'}},
            }],
        },
    }


def writer_image(cluster, options):
    """The deployed Node-based image used by the working eviction writer."""
    body = cluster.json(['-n', options.namespace, 'get', 'cronjob', 'logs-evictor',
                         '-o', 'json']) or {}
    containers = (((body.get('spec') or {}).get('jobTemplate') or {}).get('spec') or {}) \
        .get('template', {}).get('spec', {}).get('containers') or []
    return containers[0].get('image') if containers else None


def collector_pod(cluster, options):
    pods = cluster.pods(options.collector_namespace,
                        'app.kubernetes.io/name=' + options.collector)
    return pods[0] if pods else None


def collector_pod_name(cluster, options):
    pod = collector_pod(cluster, options) or {}
    return (pod.get('metadata') or {}).get('name')


def parse_metrics(text, names):
    """The named gauges/counters from a Prometheus body, labels kept out of the key."""
    values = {}
    for raw in (text or '').splitlines():
        line = raw.strip()
        if line == '' or line.startswith('#'):
            continue
        sample = line.split(' ')
        if len(sample) < 2:
            continue
        name = sample[0].split('{')[0]
        if name not in names:
            continue
        try:
            value = float(sample[1])
        except ValueError:
            continue
        labels = sample[0][len(name):]
        key = (name, labels)
        values[key] = values.get(key, 0.0) + value
    return values


def component_value(values, name, component):
    """One component's sample: the sink's buffer, the source's received counter."""
    for (sample, labels), value in values.items():
        if sample != name:
            continue
        if 'component_id="%s"' % component in labels or "component_id='%s'" % component in labels:
            return int(value)
        if component == 'any' and 'component_id=' in labels:
            return int(value)
    return None


def read_metrics(options, cluster):
    """The collector's exporter, read through a port-forward: (values, reason)."""
    pod = collector_pod_name(cluster, options)
    if not pod:
        return None, 'the collector has no pod'
    forward = PortForward(options.kubectl, options.collector_namespace, 'pod/' + pod,
                          free_port(), options.metrics_port)
    forward.start()
    try:
        if not forward.wait_ready(20):
            return None, ('nothing answered port %d on %s (%s)'
                          % (options.metrics_port, pod, forward.death or 'never ready'))
        connection = http.client.HTTPConnection('127.0.0.1', forward.local_port, timeout=15)
        try:
            connection.request('GET', '/metrics')
            response = connection.getresponse()
            body = response.read(4 * 1024 * 1024).decode('utf8', 'replace')
            if response.status != 200:
                return None, 'GET /metrics answered %d' % response.status
        finally:
            connection.close()
    finally:
        forward.close()
    values = parse_metrics(body, {BUFFER_SIZE, BUFFER_MAX, RECEIVED})
    if not any(sample == BUFFER_SIZE for sample, _labels in values):
        return None, ('the exporter answers but carries no %s (Vector %d)'
                      % (BUFFER_SIZE, len(body)))
    return values, ''


def buffer_state(values):
    """The sink's buffer, its maximum and the source's received counter."""
    return {
        'size': component_value(values, BUFFER_SIZE, 'logs-store'),
        'max': component_value(values, BUFFER_MAX, 'logs-store'),
        'received': component_value(values, RECEIVED, 'kubernetes'),
    }


def saturated(state):
    """The state L07 asks for: the buffer at its maximum, well fed."""
    size, maximum, received = state.get('size'), state.get('max'), state.get('received')
    return (size is not None and maximum is not None and received is not None
            and size >= maximum and maximum > 0 and received > maximum)


def collectors_metrics_gap(reason):
    """The exact configuration the saturated case needs, when nothing exposes it."""
    return ('the collector exposes no internal metrics: %s. '
            'deploy/platform/logs/config/vector.yaml declares a `sources.internal_metrics` of '
            '`type: internal_metrics` and a `sinks.metrics` of `type: prometheus_exporter` on '
            '127.0.0.1:9598 (ADR-016 §6), so the collector or the port-forward to it is at '
            'fault; the buffer state is not guessed.' % (reason or 'no answer'))


def store_replicas(cluster, options):
    body = cluster.json(['-n', options.namespace, 'get', 'deployment', options.store,
                         '-o', 'json']) or {}
    replicas = (body.get('spec') or {}).get('replicas')
    return replicas if isinstance(replicas, int) and replicas >= 0 else 1


def set_replicas(cluster, options, replicas):
    return cluster.run([
        '-n', options.namespace, 'scale', 'deployment', options.store,
        '--replicas=%d' % replicas,
    ]).returncode == 0


def store_ready(cluster, options):
    body = cluster.json(['-n', options.namespace, 'get', 'deployment', options.store,
                         '-o', 'json']) or {}
    status = body.get('status') or {}
    desired = (body.get('spec') or {}).get('replicas') or 0
    return (int(status.get('readyReplicas') or 0) == int(desired)
            and int(status.get('availableReplicas') or 0) == int(desired)
            and int(status.get('observedGeneration') or 0)
            >= int((body.get('metadata') or {}).get('generation') or 0))


def collector_restarts(cluster, options):
    pod = collector_pod(cluster, options) or {}
    statuses = ((pod.get('status') or {}).get('containerStatuses') or [])
    return sum(int(status.get('restartCount') or 0) for status in statuses)


def collector_running(cluster, options):
    pod = collector_pod(cluster, options) or {}
    phase = (pod.get('status') or {}).get('phase')
    return phase == 'Running' and cluster.is_ready(options.collector_namespace,
                                                   (pod.get('metadata') or {}).get('name') or '')


def vector_pid(cluster, options):
    """The vector process's host pid from `k3s crictl inspect`: (pid, detail)."""
    pod = collector_pod_name(cluster, options)
    if not pod:
        return None, 'the collector has no pod'
    listing = cluster.run([options.crictl, 'ps', '--name', pod, '--output', 'json'])
    if listing.returncode != 0:
        return None, 'crictl ps refused: %s' % tail(listing.stderr)
    try:
        containers = (json.loads(listing.stdout or '{}').get('containers') or [])
    except ValueError:
        return None, 'crictl ps answered no JSON'
    target = None
    for container in containers:
        names = (container.get('labels') or {}).get('io.kubernetes.container.name')
        if names == 'logs-collector':
            target = container.get('id')
    if not target:
        return None, 'crictl ps lists no logs-collector container for %s' % pod
    inspected = cluster.run([options.crictl, 'inspect', target])
    if inspected.returncode != 0:
        return None, 'crictl inspect refused: %s' % tail(inspected.stderr)
    try:
        info = (json.loads(inspected.stdout or '{}').get('info') or {})
    except ValueError:
        return None, 'crictl inspect answered no JSON'
    pid = info.get('pid')
    if not isinstance(pid, int) or pid <= 1:
        return None, ('the inspected pid is %s: pid 1 is the pause container, not vector, '
                      'so nothing would be killed' % (pid,))
    return pid, 'pid %d' % pid


def tail(text, count=160):
    return ' '.join((text or '').strip().splitlines()[-2:])[:count]


def diagnostic_tail(text):
    """A bounded public-word tail: unknown words/values are always redacted."""
    public = set(('error from server badrequest forbidden notfound unauthorized container pod '
                  'writer walk-crash-writer is waiting to start running pending failed terminated '
                  'image pull backoff imagepullbackoff errimagepull errimageneverpull '
                  'containercreating podinitializing crashloopbackoff createcontainerconfigerror '
                  'createcontainererror runcontainererror starterror oomkilled completed '
                  'failedscheduling failedcreate failedpull failed restricted started scheduled '
                  'pulled pulling backoff successfulcreate failedmount failedattachvolume '
                  'node executable missing logs unavailable no such file or directory '
                  'permission denied exec executable found in path unknown normal warning').split())
    words = tail(text, 500).split()
    return ' '.join(word if word.strip('.,:;()"').lower() in public else '[redacted]'
                    for word in words) or '-'


def writer_read(cluster, options, run_id):
    """Keep kubectl's outcome alongside numbered lines so failures explain themselves."""
    result = cluster.run(['-n', options.writer_namespace, 'logs', 'walk-crash-writer',
                          '--tail=100000'], timeout=120)
    written = []
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            match = WRITER_LINE.search(line)
            if match and match.group(1) == run_id:
                written.append(int(match.group(2)))
    return written, result


def writer_lines(cluster, options, run_id):
    return writer_read(cluster, options, run_id)[0]


def writer_diagnostics(report, cluster, options, pod, result):
    status = (pod or {}).get('status') or {}
    report.note('writer phase=%s' % status.get('phase', 'absent'))
    statuses = status.get('containerStatuses') or []
    for container in statuses:
        state = container.get('state') or {}
        kind = next((name for name in ('waiting', 'running', 'terminated') if name in state),
                    'unknown')
        detail = state.get(kind) or {}
        report.note('writer container state=%s reason=%s exit=%s' % (
            kind, diagnostic_tail(detail.get('reason')), detail.get('exitCode', '-')))
    if not statuses:
        report.note('writer container state=unknown reason=unknown')
    events = cluster.run(['-n', options.writer_namespace, 'get', 'events',
                          '--sort-by=.metadata.creationTimestamp', '-o', 'json'])
    try:
        items = json.loads(events.stdout).get('items', []) if events.returncode == 0 else []
    except ValueError:
        items = []
    for event in items[-5:]:
        report.note('writer namespace event reason=%s message=%s' % (
            diagnostic_tail(event.get('reason')), diagnostic_tail(event.get('message'))))
    if not items:
        report.note('writer namespace events exit=%d tail=%s stderr=%s' % (
            events.returncode, diagnostic_tail(events.stdout), diagnostic_tail(events.stderr)))
    report.note('writer logs exit=%d stderr=%s' % (
        result.returncode, diagnostic_tail(result.stderr)))


def wait_writer(report, options, cluster, run_id):
    """Do not inspect the buffer until a Running writer has produced a numbered line."""
    observation = {'pod': None, 'read': None}
    def started():
        pod = cluster.pod(options.writer_namespace, 'walk-crash-writer')
        observation['pod'] = pod
        if ((pod or {}).get('status') or {}).get('phase') != 'Running':
            return False
        written, result = writer_read(cluster, options, run_id)
        observation['read'] = result
        return bool(written)
    if wait_until(time.monotonic() + 180, 3, started):
        report.pass_('the writer is Running and its first numbered line is readable')
        return True
    result = observation['read']
    if result is None:
        _written, result = writer_read(cluster, options, run_id)
    writer_diagnostics(report, cluster, options, observation['pod'], result)
    report.not_valid('the writer pod wrote no numbered line the walk could read')
    return False


def kubelet_lines(pod_name, options):
    """The numbered lines still in the kubelet's files for the writer's pod."""
    root = os.path.join('/var/log/pods', pod_name)
    sequences = set()
    try:
        directories = [os.path.join(root, name) for name in os.listdir(root)]
    except OSError:
        return None
    for directory in directories:
        try:
            files = [os.path.join(directory, name) for name in os.listdir(directory)]
        except OSError:
            continue
        for path in files:
            if not path.endswith('.log'):
                continue
            try:
                with open(path, 'r', encoding='utf8', errors='replace') as handle:
                    for line in handle:
                        match = WRITER_LINE.search(line)
                        if match:
                            sequences.add(int(match.group(2)))
            except OSError:
                continue
    return sequences


def delivered_lines(loader, from_ms, run_id, bound=120):
    """The writer's numbered lines the loader's API returns, paginated."""
    deadline = time.monotonic() + bound
    while True:
        found = set()
        offset = 0
        while True:
            answer = loader.logs({'from': str(from_ms), 'to': str(now_ms()),
                                  'module': WRITER_MODULE, 'text': run_id,
                                  'offset': str(offset), 'limit': '1000'})
            if answer is None or answer.get('state') != 'ok':
                break
            records = answer.get('records') or []
            for record in records:
                match = WRITER_LINE.search(record.get('message') or '')
                if match and match.group(1) == run_id:
                    found.add(int(match.group(2)))
            if len(records) < 1000 or offset + 1000 > int(answer.get('count') or 0):
                break
            offset += 1000
        if found or time.monotonic() >= deadline:
            return found
        time.sleep(5)


def crash_verdict(written, delivered, kubelet, duplicated):
    """L07's verdict: nothing still in the kubelet's files may be lost."""
    if kubelet is None:
        return {'ok': False, 'detail': 'the kubelet\'s files were not read'}
    still_there = set(kubelet)
    missing = sorted(still_there - set(delivered))
    rotated = sorted(set(written) - set(delivered) - still_there)
    detail = ('%d written, %d delivered, %d duplicated, %d missing of which %d are still in '
              'the kubelet\'s files, %d rotated away'
              % (len(written), len(delivered), duplicated, len(missing) + len(rotated),
                 len(missing), len(rotated)))
    if missing:
        detail = 'lost while still in the kubelet\'s files: seq %s (%s)' % (
            sequence_ranges(missing), detail)
    return {'ok': not missing, 'detail': detail, 'missing': missing, 'rotated': rotated}


def sequence_ranges(sequences):
    """A sorted number list as ranges: `1, 3..5, 9`."""
    ordered = sorted(sequences)
    parts = []
    start = previous = None
    for value in ordered:
        if start is None:
            start = previous = value
        elif value == previous + 1:
            previous = value
        else:
            parts.append(str(start) if start == previous else '%d..%d' % (start, previous))
            start = previous = value
    if start is not None:
        parts.append(str(start) if start == previous else '%d..%d' % (start, previous))
    return ', '.join(parts)


def crash_case(report, options, loader, cluster, state, saturated_case):
    """One crash: write, kill, recover, count - saturated or informative."""
    label = 'saturated' if saturated_case else 'unsaturated'
    metrics, reason = read_metrics(options, cluster) if saturated_case else (None, '')
    state_ok = True
    if saturated_case:
        if metrics is None:
            report.not_valid(collectors_metrics_gap(reason))
            return False
        state_ok = False
    run_id = 'walk-crash-%s-%d' % (label, now_ms())
    state['run_id'] = run_id
    image = state.get('writer_image') or writer_image(cluster, options)
    if not image:
        report.not_valid('the evictor CronJob names no Node image: the writer cannot be created')
        return False
    seconds = options.fill_bound + options.saturated_seconds + 120
    applied = cluster.apply(writer_manifest(image, options, run_id, seconds))
    if applied.returncode != 0:
        report.not_valid('the writer pod was not created: %s' % tail(applied.stderr))
        return False
    if not wait_writer(report, options, cluster, run_id):
        return False
    started = now_ms()
    try:
        if saturated_case:
            fill_deadline = time.monotonic() + options.fill_bound
            while True:
                metrics, reason = read_metrics(options, cluster)
                if metrics is not None and saturated(buffer_state(metrics)):
                    state_ok = True
                    report.pass_('the sink buffer is at its configured maximum',
                                 'size %d, max %d, received %d'
                                 % (buffer_state(metrics)['size'], buffer_state(metrics)['max'],
                                    buffer_state(metrics)['received']))
                    break
                if time.monotonic() >= fill_deadline:
                    report.not_valid(
                        'the sink buffer never reached its maximum within %d s: the last '
                        'reading was %s (%s)'
                        % (options.fill_bound,
                           json.dumps(buffer_state(metrics)) if metrics is not None else 'none',
                           reason or 'no exporter'))
                    return False
                time.sleep(3)
            # Keep writing past the full buffer, so the lines behind it are real.
            time.sleep(options.saturated_seconds)
        else:
            wait_until(time.monotonic() + 60, 3,
                       lambda: len(writer_lines(cluster, options, run_id))
                       >= options.unsaturated_lines)
            report.note('the unsaturated case wrote %d line(s) with the buffer below its maximum'
                        % len(writer_lines(cluster, options, run_id)))
        written = writer_lines(cluster, options, run_id)
        pid, detail = vector_pid(cluster, options)
        if pid is None:
            report.not_valid('nothing was killed: %s' % detail)
            return False
        killed = cluster.run(['kill', '-9', str(pid)]).returncode == 0
        report.check(killed, 'the vector process is killed by its host pid', detail)
        if not killed:
            return False
        if not set_replicas(cluster, options, state['replicas']):
            report.fail('the store is scaled back up', options.store)
            return False
        if not wait_until(time.monotonic() + options.recover_bound, 5,
                          lambda: collector_running(cluster, options)):
            report.not_valid('the collector did not come back within %d s'
                             % options.recover_bound)
            return False
        report.check(wait_until(time.monotonic() + options.recover_bound, 5,
                                lambda: store_ready(cluster, options)),
                     'the store answers again', options.store)
        time.sleep(options.settle_seconds)
        delivered = delivered_lines(loader, started, run_id)
        pod_name = None
        pods = cluster.pods(options.writer_namespace, 'app.kubernetes.io/name=' + WRITER_MODULE)
        if pods:
            pod_name = (pods[0].get('metadata') or {}).get('name')
        kubelet = kubelet_lines(pod_name, options) if pod_name else None
        duplicated = sum(max(0, count - 1) for count in count_deliveries(
            loader, started, run_id).values())
        verdict = crash_verdict(written, delivered, kubelet, duplicated)
        if saturated_case:
            report.check(verdict['ok'],
                         'every line still in the kubelet\'s files is delivered at least once',
                         verdict['detail'])
            report.note('the collector restarted %d time(s) across the crash'
                        % collector_restarts(cluster, options))
        else:
            report.note('unsaturated crash (informative): %s; after the kill the collector '
                        'restarted %d time(s)'
                        % (verdict['detail'], collector_restarts(cluster, options)))
        return True
    finally:
        cluster.run(['-n', options.writer_namespace, 'delete', 'pod', 'walk-crash-writer',
                     '--ignore-not-found', '--wait=false'])


def count_deliveries(loader, from_ms, run_id):
    """How many times the API returns each numbered line, paginated."""
    counts = {}
    offset = 0
    while True:
        answer = loader.logs({'from': str(from_ms), 'to': str(now_ms()),
                              'module': WRITER_MODULE, 'text': run_id,
                              'offset': str(offset), 'limit': '1000'})
        if answer is None or answer.get('state') != 'ok':
            break
        records = answer.get('records') or []
        for record in records:
            match = WRITER_LINE.search(record.get('message') or '')
            if match and match.group(1) == run_id:
                sequence = int(match.group(2))
                counts[sequence] = counts.get(sequence, 0) + 1
        if len(records) < 1000 or offset + 1000 > int(answer.get('count') or 0):
            break
        offset += 1000
    return counts


def ensure_namespace(report, cluster, options, state):
    body = cluster.json(['get', 'namespace', options.writer_namespace, '-o', 'json'])
    if body is not None:
        return True
    result = cluster.run(['create', 'namespace', options.writer_namespace])
    if result.returncode != 0:
        report.not_valid('the walk\'s own namespace was not created: %s' % tail(result.stderr))
        return False
    state['created_namespace'] = True
    return True


def free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def run(report, options, loader, cluster, state):
    state['writer_image'] = writer_image(cluster, options)
    if not report.check(bool(state['writer_image']), 'the evictor names the Node writer image',
                        'logs-evictor'):
        return False
    if not ensure_namespace(report, cluster, options, state):
        return False
    state['replicas'] = store_replicas(cluster, options)
    report.note('the store runs %d replica(s) before the crash' % state['replicas'])
    if not set_replicas(cluster, options, 0):
        report.not_valid('the store could not be scaled to zero: the sink never fills')
        return False
    if not wait_until(time.monotonic() + 120, 3,
                      lambda: cluster.json(['-n', options.namespace, 'get', 'deployment',
                                            options.store, '-o', 'json']) is not None
                      and int(((cluster.json(['-n', options.namespace, 'get', 'deployment',
                                              options.store, '-o', 'json']) or {})
                               .get('status') or {}).get('replicas') or 0) == 0):
        report.not_valid('the store did not scale to zero')
        return False
    report.pass_('the store is scaled to zero', options.store)
    saturated_ok = crash_case(report, options, loader, cluster, state, True)
    if saturated_ok:
        # A second, informative case with the buffer below its maximum.
        wait_until(time.monotonic() + 120, 3, lambda: not cluster.pods(
            options.writer_namespace, 'app.kubernetes.io/name=' + WRITER_MODULE))
        if not set_replicas(cluster, options, 0):
            return saturated_ok
        time.sleep(5)
        crash_case(report, options, loader, cluster, state, False)
    return saturated_ok


def restore(report, options, loader, cluster, state):
    """Scale the store back, delete the walk's pod and namespace, unstick the collector."""
    restored = True
    if state.get('replicas') is not None:
        restored = set_replicas(cluster, options, state['replicas']) and restored
        if not wait_until(time.monotonic() + 180, 5, lambda: store_ready(cluster, options)):
            restored = False
            print('RESTORE incomplete: the store is not Ready at %d replica(s)'
                  % state['replicas'])
    cluster.run(['-n', options.writer_namespace, 'delete', 'pod', 'walk-crash-writer',
                 '--ignore-not-found', '--wait=false'])
    if state.get('created_namespace'):
        restored = cluster.run(['delete', 'namespace', options.writer_namespace,
                                '--wait=false']).returncode == 0 and restored
    if not wait_until(time.monotonic() + 180, 5, lambda: collector_running(cluster, options)):
        restored = False
        print('RESTORE incomplete: the collector is not Running')
    print('RESTORE store %s at %s replica(s), writer pod and namespace deleted=%s, collector '
          'Running' % (options.store, state.get('replicas'),
                       str(bool(state.get('created_namespace'))).lower()))
    if not restored:
        print('RESTORE incomplete: check the store Deployment and the collector by hand')


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-CRASH (ADR-016 L07)')
    common_arguments(parser)
    parser.add_argument('--collector-namespace', default='lifemodel-logs')
    parser.add_argument('--collector', default='logs-collector')
    parser.add_argument('--writer-namespace', default='lifemodel-logs-walk')
    parser.add_argument('--metrics-port', type=int, default=9598)
    parser.add_argument('--crictl', default='k3s crictl')
    parser.add_argument('--fill-bound', type=int, default=600)
    parser.add_argument('--recover-bound', type=int, default=300)
    parser.add_argument('--writer-interval-ms', type=int, default=20)
    parser.add_argument('--saturated-seconds', type=int, default=15)
    parser.add_argument('--unsaturated-lines', type=int, default=5000)
    parser.add_argument('--settle-seconds', type=int, default=60)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    state = {'created_namespace': False, 'replicas': None, 'run_id': None}
    loader = None
    ran = False

    def stage():
        nonlocal loader
        try:
            secret = read_password(options.password_file)
        except WalkError as error:
            print('FAIL the credential file is readable - ' + str(error))
            return False
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return False
        return run(report, options, loader, cluster, state)

    try:
        ran = stage()
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        restore(report, options, loader, cluster, state)
    if ran is not True and report.failures == 0 and report.invalid == 0:
        report.not_valid('the walk reached none of its cases')
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
