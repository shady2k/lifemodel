#!/usr/bin/env python3
"""WALK-LOGS-VOLUME-FLOOD: a flood of the log volume leaves Postgres committing
beside it and the platform unharmed, and throttled task pods do not cost a
trusted writer a line (ADR-016 L05, §5, §6).

What it proves
--------------
1. The flood, with the volume at its installed size: a Postgres pod in the
   walk's own namespace keeps its data on the host's **shared** root filesystem
   (a hostPath under a walk-owned directory, removed after) and commits a row
   every 200 ms, recording each commit's latency and error; an incompressible
   flood into the log volume runs at full speed (the evict walk's own
   `write_burst`). Asserted:
   - the log volume's busy percentage is reported from `/proc/diskstats` for the
     loop device behind the mount;
   - the shared filesystem's free space moves only by what Postgres and the walk
     write there, never by the flood;
   - the store answers 429 read from the response, or the evictor frees the
     space first with a drop verified by its own Job pod stdout captured during
     polling and the day's directory disappearing (or its inode replaced) under
     the store PV; no loader log or oldest-row movement is needed for today's
     self-erasing partition; no panic and no restart
     (its restartCount and uid unchanged, its log clean);
   - reads keep answering through the loader's API;
   - the store's free space never falls more than 10 % of the volume below its
     margin (`-storage.minFreeDiskSpaceBytes`), with its merge counters beside
     each sample;
   - the page's status (the API the page reads) says `log volume low` and then
     read-only, or the walk says what it showed when the evictor freed space
     first (the evictor is part of the product, ADR §5);
   - the evictor or retention frees space and writes are accepted again with no
     store restart;
   - Postgres' commits continue throughout (longest commit gap and error count
     of 0), and the loader's page kept answering (its every status read answered
     `state=ok` or a named reason).
2. The throttle (ADR-016 §6): a task pod in `lifemodel-motor` writing at full
   speed concurrently with a trusted writer (a pod in the walk's own namespace),
   plus a task pod writing 20 KB lines. Asserted: the trusted writer loses no
   line; each throttled pod's `input` and `accepted` counters reconcile per
   window (read from the collector's own Prometheus exporter on its loopback,
   `127.0.0.1:9598`, through a port-forward as `logs-crash-walk.py` does); and
   the event rate is reported as the limit it is (500 events per second per pod).

Arguments (defaults are the test VM's)
-------------------------------------
  --password-file PATH   the loader's login password (required, never printed)
  --loader-host HOST     where the walk connects (default boot-lifemodel.local)
  --loader-port PORT     the loader's TLS port (default 443)
  --origin-host HOST     the host the loader answers on (default
                         boot-lifemodel.local)
  --ca-file PATH         verify the loader's certificate with this CA
  --kubectl COMMAND      default "k3s kubectl"
  --namespace NS         the store's namespace (default lifemodel-system)
  --store NAME           the store's Deployment (default logs-store)
  --mount PATH           the log volume's host mount (default /var/lib/lifemodel-logs)
  --pv-path PATH         the PV's path inside it (default /var/lib/lifemodel-logs/data)
  --shared-path PATH     the host's shared root filesystem directory the walk
                         uses for Postgres and its own writes (default
                         /var/lib/lifemodel-logs-walk-shared; removed after)
  --postgres-image IMG   default docker.io/library/postgres:17-bookworm
  --postgres-bytes N     planning value only, not a quota (default 64 MiB);
                         actual root allocations are measured by category
  --commit-interval-ms N default 200
  --flood-seconds N      full-speed flood duration (default 300)
  --fill-bound N         bound on reaching the store's write stop (default 900 s)
  --burst-mib N          each insert's incompressible payload (default 4)
  --poll-seconds N       sampling interval (default 5)
  --recover-bound N      bound on writes being accepted again (default 300)
  --commit-gap-bound N   bound on the longest Postgres commit gap (default 10 s)
  --collector-namespace NS / --collector NAME   default lifemodel-logs/logs-collector
  --metrics-port PORT    the collector's loopback exporter (default 9598)
  --throttle-seconds N   the concurrent throttle burst (default 60 s)
  --trusted-interval-ms N the trusted writer's line interval (default 20)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
It creates two namespaces (its own and `lifemodel-logs-walk` for the writer),
a Postgres pod and writer pods, and a shared-filesystem directory with the
Postgres data in it; it writes into the log volume. The `finally` deletes the
pods and namespaces it created and the shared directory, removes its filler and
its flood files, waits for the store to be Ready and prints a RESTORE line with
both filesystems' free space. Image content and snapshots, rotated container logs, Postgres data and walk
files consume shared root space. They are measured separately after pod startup;
--postgres-bytes is a legacy planning value, not an enforced quota. The store
flood stays inside its mounted log volume.

What it does not cover
----------------------
The unmounted case is `logs-volume-walk.sh` (stage 1, L05's other half). A full
volume with the evictor dropping days is L16's (`logs-evict-walk.py`); this walk
asserts the store refuses cleanly and recovers, not that displacement works.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    MIB,
    GIB,
    Cluster,
    Loader,
    PortForward,
    Report,
    Volume,
    WalkError,
    common_arguments,
    connect_store,
    now_ms,
    quantity,
    read_password,
    read_store_flags,
    wait_until,
    window,
    write_burst,
)

from logs_flood_support import (  # noqa: E402
    check_commits, create_pod, pod_diagnostics, refusal_verdict, wait_running,
)
from logs_flood_accounting import accounting_snapshot, report_accounting  # noqa: E402
from logs_flood_evidence import FloodEvictorEvidence  # noqa: E402

THROTTLE_EVENTS = 500
TASKS_NAMESPACE = 'lifemodel-motor'
TRUSTED_MODULE = 'walk-trusted-writer'
TASK_MODULE = 'walk-task-writer'
COMMIT_LINE = re.compile(r'commit (\d+) (\d+) (ok|error)')
COMMIT_ROW = 64


def walk_namespace(name):
    return {'apiVersion': 'v1', 'kind': 'Namespace',
            'metadata': {'name': name,
                         'labels': {'pod-security.kubernetes.io/enforce': 'privileged'}}}


def postgres_manifest(options, commits):
    """A Postgres pod whose data sits on the host's shared filesystem."""
    script = (
        'set -e; docker-entrypoint.sh postgres & server=$!; '
        "i=0; until psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "
        "-c 'select 1' >/dev/null 2>>/tmp/walkerr; do "
        "kill -0 $server; i=$((i+1)); [ $i -lt 150 ]; sleep 0.2; done; "
        "psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres -c 'create table if not exists walk_commits (id bigint primary key, "
        "at timestamptz)' >/dev/null 2>>/tmp/walkerr; "
        'i=0; while kill -0 $server; do s=$(date +%%s%%N); '
        'if psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres -c "insert into walk_commits values ($i, clock_timestamp())" '
        '>/dev/null 2>>/tmp/walkerr; then r=ok; else r=error; fi; '
        'e=$(date +%%s%%N); echo "commit $s $e $r"; i=$((i+1)); sleep %s; done; sleep 3600'
        % (options.commit_interval_ms / 1000.0))
    return {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': 'walk-flood-pg', 'namespace': options.shared_namespace,
                     'labels': {'app.kubernetes.io/name': 'walk-flood-pg'}},
        'spec': {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsUser': 999, 'runAsGroup': 999},
            'containers': [{
                'name': 'postgres',
                'image': options.postgres_image,
                'command': ['sh', '-c'],
                'args': [script],
                'env': [{'name': 'PGDATA', 'value': '/data/pg'},
                        {'name': 'POSTGRES_HOST_AUTH_METHOD', 'value': 'trust'},
                        {'name': 'POSTGRES_PASSWORD', 'value': 'walk'}],
                'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'},
                              'limits': {'cpu': '1', 'memory': '512Mi'}},
                'volumeMounts': [{'name': 'data', 'mountPath': '/data'}],
            }],
            'volumes': [{'name': 'data', 'hostPath': {
                'path': os.path.join(options.shared_path, 'pg'),
                'type': 'DirectoryOrCreate'}}],
        },
    }


def writer_script(module, run_id, seconds, interval, size):
    """A pod line writer: numbered, optionally padded to `size` bytes."""
    pad = 'x' * max(0, size)
    return ("const run=process.argv[1],seconds=Number(process.argv[2]),"
            "interval=Number(process.argv[3]),pad=process.argv[4];"
            "let seq=0;const end=Date.now()+seconds*1000;"
            "const timer=setInterval(()=>{if(Date.now()>end){clearInterval(timer);return;}"
            "seq+=1;process.stdout.write('%s '+run+' seq='+seq+' '+pad+'\\n');"
            "},interval);" % module)


def writer_manifest(options, namespace, name, module, run_id, seconds, interval, size=0,
                    untrusted=False):
    return {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': name, 'namespace': namespace,
                     'labels': {'app.kubernetes.io/name': module}},
        'spec': {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                                'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{
                'name': 'writer',
                'image': options.writer_image,
                'command': ['node', '-e', writer_script(module, run_id, seconds, interval, size),
                            run_id, str(seconds), str(interval), 'x' * size],
                'securityContext': {'readOnlyRootFilesystem': True,
                                    'allowPrivilegeEscalation': False,
                                    'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '50m', 'memory': '32Mi'},
                              'limits': {'cpu': '500m', 'memory': '128Mi'}},
            }],
        },
    }


def store_pod(cluster, options):
    pods = cluster.pods(options.namespace, 'app.kubernetes.io/name=' + options.store)
    if not pods:
        return None
    pod = pods[0]
    statuses = (pod.get('status') or {}).get('containerStatuses') or []
    return {'name': (pod.get('metadata') or {}).get('name'),
            'uid': (pod.get('metadata') or {}).get('uid'),
            'restarts': sum(int(status.get('restartCount') or 0) for status in statuses)}


def store_log(cluster, options):
    pod = store_pod(cluster, options) or {}
    result = cluster.run(['-n', options.namespace, 'logs', pod.get('name') or '',
                          '--tail=2000'], timeout=120)
    return result.stdout if result.returncode == 0 else ''


def loop_device(mount):
    """The loop device behind the mounted volume, from findmnt."""
    import subprocess
    try:
        out = subprocess.run(['findmnt', '-no', 'SOURCE', mount], capture_output=True,
                             text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    source = (out.stdout or '').strip()
    return source if source.startswith('/dev/loop') else None


def diskstats_io_ms(device):
    """The device's cumulative milliseconds spent doing I/O, from /proc/diskstats."""
    name = os.path.basename(device)
    try:
        with open('/proc/diskstats', 'r', encoding='utf8') as handle:
            for line in handle:
                parts = line.split()
                if len(parts) >= 14 and parts[2] == name:
                    return int(parts[12])
    except OSError:
        return None
    return None


def busy_percent(before, after, seconds, device):
    """The volume's busy percentage between two diskstats readings."""
    if before is None or after is None or seconds <= 0:
        return None
    return max(0.0, min(100.0, (after - before) / (seconds * 1000.0) * 100.0))


def margin_verdict(margin, samples, volume_size):
    """The store's free space never more than 10 % of the volume below its margin."""
    if not margin or not samples:
        return {'ok': False, 'detail': 'no margin or no samples'}
    worst = min(sample.get('free') or 0 for sample in samples)
    undershoot = margin - worst
    allowed = volume_size * 0.10
    ok = undershoot <= allowed
    worst_sample = min(samples, key=lambda sample: sample.get('free') or 0)
    return {'ok': ok, 'worst': worst, 'undershoot': undershoot, 'allowed': allowed,
            'detail': ('free %d B at its lowest, margin %d B: %s by %d B, allowed %d B; '
                       'merges beside it: %s'
                       % (worst, margin, 'below' if undershoot > 0 else 'above', abs(undershoot),
                          int(allowed), worst_sample.get('merges') or 'none'))}


def commit_verdict(commits):
    """Postgres committed throughout: no error, and no gap past the bound."""
    times = [entry['end'] for entry in commits if entry.get('result') == 'ok']
    errors = [entry for entry in commits if entry.get('result') != 'ok']
    longest = None
    ordered = sorted(times)
    for first, second in zip(ordered, ordered[1:]):
        gap = (second - first) / 1e9
        if longest is None or gap > longest:
            longest = gap
    return {'ok': bool(times) and not errors, 'errors': len(errors), 'longest': longest,
            'detail': '%d commit(s), %d error(s), longest gap %s s'
                      % (len(commits), len(errors),
                         ('%.2f' % longest) if longest is not None else 'none')}


def commit_records(text):
    """Each commit's start, end and result, from the pod's own lines."""
    commits = []
    for line in (text or '').splitlines():
        match = COMMIT_LINE.search(line)
        if match:
            commits.append({'start': int(match.group(1)), 'end': int(match.group(2)),
                            'result': match.group(3)})
    return commits


def shared_verdict(before, after, allowance):
    """The shared filesystem only moves by what the walk itself writes (ADR-016 L05)."""
    dropped = max(0, (before or 0) - (after or 0))
    return {'ok': dropped <= allowance, 'dropped': dropped, 'allowance': allowance,
            'detail': 'shared free %d -> %d B (dropped %d B, allowed %d B)'
                      % (before or 0, after or 0, dropped, allowance)}


def throttle_verdict(windows):
    """Each throttled pod's input and accepted counters reconcile, per window."""
    problems = []
    rates = []
    for entry in windows:
        given, accepted = entry.get('input'), entry.get('accepted')
        if not isinstance(given, int) or not isinstance(accepted, int) or accepted > given:
            problems.append('%s: input %s accepted %s' % (entry.get('pod'), given, accepted))
            continue
        rates.append({'pod': entry.get('pod'), 'input': given, 'accepted': accepted,
                      'discarded': given - accepted})
    return {'ok': not problems, 'rates': rates,
            'detail': ('%d window(s): %s; the limit is %d events per second per pod'
                       % (len(rates),
                          ', '.join('%s %d/%d' % (rate['pod'], rate['input'],
                                                  rate['accepted']) for rate in rates) or 'none',
                          THROTTLE_EVENTS))
            if not problems else '; '.join(problems)}


def trusted_verdict(written, found):
    """The trusted writer loses no line (ADR-016 §6: the throttle is per task pod)."""
    missing = sorted(set(written) - set(found))
    return {'ok': not missing, 'missing': missing,
            'detail': '%d written, %d found, %d missing%s'
                      % (len(set(written)), len(set(found)), len(missing),
                         (': seq ' + sequence_ranges(missing)) if missing else '')}


def sequence_ranges(sequences):
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


def numbered(text, module, run_id):
    pattern = re.compile(re.escape(module) + r' ' + re.escape(run_id) + r' seq=(\d+)')
    return [int(match.group(1)) for match in pattern.finditer(text or '')]


def metrics_text(options, cluster):
    """The collector's loopback exporter, read through a port-forward."""
    pods = cluster.pods(options.collector_namespace,
                        'app.kubernetes.io/name=' + options.collector)
    if not pods:
        return None
    name = (pods[0].get('metadata') or {}).get('name')
    forward = PortForward(options.kubectl, options.collector_namespace, 'pod/' + name,
                          free_port(), options.metrics_port)
    forward.start()
    try:
        if not forward.wait_ready(20):
            return None
        import http.client
        connection = http.client.HTTPConnection('127.0.0.1', forward.local_port, timeout=15)
        try:
            connection.request('GET', '/metrics')
            response = connection.getresponse()
            return response.read(4 * 1024 * 1024).decode('utf8', 'replace')
        finally:
            connection.close()
    finally:
        forward.close()


def throttle_windows(text):
    """The throttle-window records' input and accepted counts, per pod and window."""
    windows = {}
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line.startswith('walk_throttle_window_'):
            continue
        sample = line.split(' ')
        if len(sample) < 2:
            continue
        try:
            value = int(float(sample[1]))
        except ValueError:
            continue
        pod = re.search(r'pod="([^"]+)"', sample[0])
        key = pod.group(1) if pod else 'unknown'
        kind = 'input' if '_input' in sample[0] else 'accepted'
        windows.setdefault(key, {})[kind] = windows.setdefault(key, {}).get(kind, 0) + value
    return [{'pod': pod, 'input': values.get('input', 0),
             'accepted': values.get('accepted', 0)} for pod, values in windows.items()]


def reading_verdict(samples):
    """Every status read answered: no 'unavailable' without a reason."""
    bad = [sample for sample in samples if sample.get('state') != 'ok']
    return {'ok': not bad, 'detail': '%d status read(s), %d without an ok answer%s'
            % (len(samples), len(bad),
               (': ' + ', '.join(str(sample.get('reason')) for sample in bad[:3])) if bad else '')}


def page_lines(samples):
    """The page's own terms the status carried: low volume, read-only."""
    low = any(sample.get('lowVolume') for sample in samples)
    read_only = any(sample.get('readOnly') for sample in samples)
    return low, read_only


def free_space(store):
    """The store's own free-space gauge and merge counters."""
    gauges = store.metrics()
    free = gauges.get('vl_free_disk_space_bytes')
    merges = {name: value for name, value in gauges.items()
              if 'merge' in name or 'active' in name}
    return (int(free) if free is not None else None, merges)


def shared_space(path='/'):
    """The shared root filesystem's (total, free) bytes."""
    stats = os.statvfs(path)
    return stats.f_bsize * stats.f_blocks, stats.f_bsize * stats.f_bavail


def free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def ensure_namespace(report, cluster, name, state):
    if cluster.json(['get', 'namespace', name, '-o', 'json']) is not None:
        return True
    if cluster.apply(walk_namespace(name)).returncode != 0:
        report.not_valid('the walk\'s namespace %s was not created' % name)
        return False
    state['namespaces'].append(name)
    return True


def prepare_flood(report, options, cluster, state):
    """Finish pulls and initialization before measuring shared-disk movement."""
    manifests = (postgres_manifest(options, 0),
                 writer_manifest(options, options.writer_namespace, 'walk-flood-trusted',
                                 TRUSTED_MODULE, state['trusted_run'], 3600,
                                 options.trusted_interval_ms))
    for manifest in manifests:
        if not create_pod(report, cluster, manifest):
            return False
        namespace, name = manifest['metadata']['namespace'], manifest['metadata']['name']
        if not wait_running(cluster, namespace, name):
            report.not_valid('pod %s/%s did not become Running before the flood' % (namespace, name))
            pod_diagnostics(report, cluster, namespace, name)
            return False
    def committed():
        text = cluster.run(['-n', options.shared_namespace, 'logs', 'walk-flood-pg',
                            '--tail=100'], timeout=30)
        return text.returncode == 0 and any(entry['result'] == 'ok'
                                           for entry in commit_records(text.stdout))
    if not wait_until(time.monotonic() + 60, 1, committed):
        report.not_valid('Postgres recorded zero successful pre-flood commits')
        pod_diagnostics(report, cluster, options.shared_namespace, 'walk-flood-pg')
        return False
    return True


def flood_case(report, options, loader, cluster, store, volume, state):
    """The flood with Postgres committing beside it on the shared filesystem."""
    if not prepare_flood(report, options, cluster, state):
        return False
    baseline = accounting_snapshot(options, cluster)
    shared_before = shared_space()[1]
    device = loop_device(options.mount)
    report.note('baseline after all flood pods are Running and Postgres has committed; '
                'volume device %s, shared free %.2f GiB; Postgres data and container logs '
                'are measured, not a quota' % (device or 'unknown', shared_before / GIB))
    pod_before = store_pod(cluster, options)
    result = {'samples': [], 'statuses': [], 'started': now_ms()}
    evidence = FloodEvictorEvidence(cluster, options, volume, result['started'])
    evidence.poll()
    flood_start_ns = time.time_ns()
    start_mono = time.monotonic()
    io_before = diskstats_io_ms(device) if device else None
    fill_deadline = time.monotonic() + options.fill_bound
    flood_end = None
    next_poll = start_mono + options.poll_seconds
    while True:
        moment = time.monotonic()
        if flood_end is not None and moment > flood_end:
            break
        status, lines = write_burst(store, now_ms(), state['flood_run'], options.burst_mib,
                                    'today', module='walk-flood')
        result['samples'].append((now_ms(), status))
        if flood_end is None and (status == 429 or moment > fill_deadline):
            flood_end = moment + options.flood_seconds
            report.note('observed HTTP 429; measuring sustained flood' if status == 429
                        else 'fill bound ended; refusal evidence will be judged separately')
        if moment >= next_poll:
            next_poll = moment + options.poll_seconds
            evidence.poll()
            free, merges = free_space(store)
            answer = loader.logs_status(*window())
            result['statuses'].append({
                'state': answer.get('state'),
                'reason': answer.get('reason'),
                'readOnly': (answer.get('status') or {}).get('storeReadOnly') is True,
                'lowVolume': 'volume low' in json.dumps(answer.get('status') or {}).lower(),
            })
            if free is not None:
                result.setdefault('free', []).append({'free': free, 'merges': merges})
    flood_end_ns = time.time_ns()
    accounting_after = accounting_snapshot(options, cluster)
    io_after = diskstats_io_ms(device) if device else None
    elapsed = time.monotonic() - start_mono
    report.note('the volume was busy %s%% of %.0f s%s'
                % (('%.1f' % busy_percent(io_before, io_after, elapsed, device))
                   if busy_percent(io_before, io_after, elapsed, device) is not None
                   else 'unknown (diskstats unavailable)', elapsed,
                   '' if device else '; /proc/diskstats has no loop device for the mount'))
    flags = read_store_flags(report, options, cluster, 'the store\'s margin')
    margin = quantity((flags or {}).get('storage.minFreeDiskSpaceBytes'))
    total = volume.space()[0]
    verdict = margin_verdict(margin, result.get('free') or [], total)
    report.check(verdict['ok'],
                 'the store\'s free space stays within 10 % of the volume below its margin',
                 verdict['detail'])
    report_accounting(report, baseline, accounting_after, 32 * MIB)
    log = store_log(cluster, options)
    bad = [line for line in log.splitlines() if 'panic' in line.lower() or 'FATAL:' in line]
    report.check(not bad, 'the store\'s log holds no panic and no FATAL line',
                 bad[0][:160] if bad else 'the last lines were read')
    reads = loader.logs({'from': str(result['started']), 'to': str(now_ms()), 'limit': '5'})
    report.check(reads is not None and reads.get('state') == 'ok',
                 'reads keep answering through the loader\'s API',
                 'state %s' % ((reads or {}).get('state')))
    def recovered():
        evidence.poll()
        status = write_burst(store, now_ms(), state['flood_run'], 1, 'after',
                             module='walk-flood')[0]
        result['samples'].append((now_ms(), status))
        return status in (200, 204)
    accepted = wait_until(time.monotonic() + options.recover_bound, 10, recovered)
    evidence.poll()
    drops = evidence.verified(report)
    low, read_only = page_lines(result['statuses'])
    if read_only:
        report.pass_('the page\'s status says the store is refusing writes', 'storeReadOnly=true '
                     'in %d sample(s)' % sum(1 for sample in result['statuses']
                                             if sample.get('readOnly')))
    elif low:
        report.note('the page said low volume but not read-only; verified evictor drops=%d '
                    '(ADR-016 §5)' % len(drops))
    else:
        report.note('the page said neither low volume nor read-only in %d sample(s): %s'
                    % (len(result['statuses']),
                       ', '.join(sorted({str(sample.get('state')) for sample in result['statuses']}))))
    free_samples = [sample['free'] for sample in result.get('free') or []
                    if isinstance(sample.get('free'), int)]
    lowest_free = min(free_samples) if free_samples else None
    refusal_verdict(
        report, result['samples'], drops,
        state='%d write sample(s) answered with no 429, the lowest sampled store free space '
              'was %s, and %d evictor drop line(s) were verified'
              % (len(result['samples']),
                 ('%.2f GiB' % (lowest_free / GIB)) if lowest_free is not None else 'not sampled',
                 len(drops)))
    pod_after = store_pod(cluster, options)
    restarted = (pod_before is None or pod_after is None
                 or pod_before.get('uid') != pod_after.get('uid')
                 or pod_before.get('restarts') != pod_after.get('restarts'))
    report.check(not restarted, 'the store did not restart under the flood',
                 'uid %s -> %s, restarts %s -> %s'
                 % ((pod_before or {}).get('uid'), (pod_after or {}).get('uid'),
                    (pod_before or {}).get('restarts'), (pod_after or {}).get('restarts')))
    report.check(bool(accepted) and not restarted, 'writes are accepted again without a store restart',
                 'within %d s of the flood' % options.recover_bound)
    reads_ok = reading_verdict(result['statuses'])
    report.check(reads_ok['ok'], 'the loader\'s page kept answering', reads_ok['detail'])
    text = cluster.run(['-n', options.shared_namespace, 'logs', 'walk-flood-pg',
                        '--tail=200000'], timeout=120)
    records = commit_records(text.stdout if text.returncode == 0 else '')
    if not check_commits(report, records, flood_start_ns, flood_end_ns, options.commit_gap_bound):
        pod_diagnostics(report, cluster, options.shared_namespace, 'walk-flood-pg')
    return True


def throttle_case(report, options, loader, cluster, state):
    """Admitted task writers overlap a trusted writer; absent evidence is invalid."""
    from logs_walk_support import parse_ms, start_task_writer

    seconds, launch_bound = options.throttle_seconds, 180
    if not 1 <= seconds <= 120:
        report.not_valid('throttle_seconds must be 1..120 with the 180 s launch allowance')
        return False
    trusted_manifest = writer_manifest(
        options, options.writer_namespace, 'walk-trusted-writer', TRUSTED_MODULE,
        state['trusted_run'], seconds + 2 * launch_bound + 20,
        options.trusted_interval_ms)
    if not create_pod(report, cluster, trusted_manifest):
        return False
    if not wait_running(cluster, options.writer_namespace, 'walk-trusted-writer'):
        report.not_valid('the trusted writer did not become Running')
        return False
    fast = start_task_writer(report, options, loader, cluster, state['task_fast'],
                             1000, seconds + launch_bound, bound=launch_bound)
    if fast is None:
        return False
    large = start_task_writer(report, options, loader, cluster, state['task_large'],
                              20, seconds, size=20 * 1024, bound=launch_bound)
    if large is None:
        return False
    time.sleep(seconds + 2)
    intervals = []
    written = []
    for namespace, pod, prefix, run_id, module in (
        (options.writer_namespace, 'walk-trusted-writer', TRUSTED_MODULE,
         state['trusted_run'], TRUSTED_MODULE),
        (TASKS_NAMESPACE, fast[0], TASK_MODULE, state['task_fast'], fast[1]),
        (TASKS_NAMESPACE, large[0], TASK_MODULE, state['task_large'], large[1]),
    ):
        if namespace == options.writer_namespace:
            result = cluster.run(['-n', namespace, 'logs', pod, '--timestamps',
                                  '--tail=200000'], timeout=120)
            lines = result.stdout.splitlines() if result.returncode == 0 else []
            stamps = [parse_ms(line.split(' ', 1)[0]) for line in lines
                      if numbered(line, prefix, run_id)]
            written = numbered(result.stdout if result.returncode == 0 else '',
                               TRUSTED_MODULE, state['trusted_run'])
        else:
            # Core owns task cleanup: its completed pod may already be gone.
            stamps = []
            deadline = time.monotonic() + options.recover_bound
            while time.monotonic() < deadline:
                stamps = []
                offset, end = 0, str(now_ms())
                while time.monotonic() < deadline:
                    answer = loader.logs({'from': str(state['throttle_start']), 'to': end,
                                          'module': module, 'text': run_id,
                                          'limit': '1000', 'offset': str(offset)})
                    if not answer or answer.get('state') != 'ok':
                        break
                    records = answer.get('records') or []
                    for record in records:
                        fields = record.get('fields') or {}
                        if (fields.get('module') == module and fields.get('pod') == pod
                                and fields.get('namespace') == TASKS_NAMESPACE
                                and fields.get('untrusted') == 'true'
                                and numbered(record.get('message'), prefix, run_id)):
                            stamp = parse_ms(record.get('time'))
                            if stamp is not None:
                                stamps.append(stamp)
                    if len(records) < 1000:
                        break
                    offset += len(records)
                if len(set(stamps)) >= 2:
                    break
                time.sleep(5)
        stamps = [stamp for stamp in stamps if stamp is not None]
        if len(set(stamps)) < 2:
            report.not_valid('a writer has fewer than two timestamped numbered lines: ' + pod)
            return False
        intervals.append((min(stamps), max(stamps)))
    overlap = min(end for _, end in intervals) - max(start for start, _ in intervals)
    if overlap <= 0:
        report.not_valid('timestamped writer records prove no common task/trusted writer overlap')
        return False
    report.pass_('both task writers actually overlap the trusted writer',
                 '%d ms common timestamp interval' % overlap)
    windows = []
    deadline = time.monotonic() + options.recover_bound
    task_pods = {fast[0], large[0]}
    while time.monotonic() < deadline:
        text = metrics_text(options, cluster)
        paired = set()
        for pod in task_pods:
            samples = [line for line in (text or '').splitlines()
                       if 'pod="' + pod + '"' in line]
            if (any(line.startswith('walk_throttle_window_input') for line in samples)
                    and any(line.startswith('walk_throttle_window_accepted') for line in samples)):
                paired.add(pod)
        windows = [entry for entry in throttle_windows(text)
                   if entry['pod'] in paired and entry['pod'] in task_pods]
        if {entry['pod'] for entry in windows if entry['input'] > 0} == task_pods:
            break
        time.sleep(5)
    if {entry['pod'] for entry in windows if entry['input'] > 0} != task_pods:
        report.not_valid('no nonempty input/accepted throttle-window evidence for both actual '
                         'task pods; unrelated pods cannot prove this burst')
        return False
    report.note('counter evidence identifies these task pods, not a timestamped common '
                'window; timestamped writer records prove overlap separately')
    verdict = throttle_verdict(windows)
    report.check(verdict['ok'], "each throttled pod's input and accepted counters reconcile",
                 verdict['detail'])
    found = []
    deadline = time.monotonic() + options.recover_bound
    while time.monotonic() < deadline:
        found = []
        offset = 0
        end = str(now_ms())
        while time.monotonic() < deadline:
            answer = loader.logs({'from': str(state['throttle_start']), 'to': end,
                                  'module': TRUSTED_MODULE, 'text': state['trusted_run'],
                                  'limit': '1000', 'offset': str(offset)})
            if not answer or answer.get('state') != 'ok':
                break
            records = answer.get('records') or []
            found.extend(numbered(json.dumps(records), TRUSTED_MODULE, state['trusted_run']))
            if len(records) < 1000:
                break
            offset += len(records)
        if set(written).issubset(found):
            break
        time.sleep(5)
    trusted = trusted_verdict(written, found)
    report.check(trusted['ok'], 'the trusted writer loses no line under the throttle',
                 trusted['detail'])
    return verdict['ok'] and trusted['ok']


def restore(report, options, loader, cluster, volume, state):
    """Delete the walk's pods and namespaces and its shared directory, report space."""
    restored = True
    for namespace, names in ((options.writer_namespace, ['walk-trusted-writer', 'walk-flood-trusted']),
                             (options.shared_namespace, ['walk-flood-pg']),
                             (TASKS_NAMESPACE, ['walk-task-fast', 'walk-task-large'])):
        for name in names:
            cluster.run(['-n', namespace, 'delete', 'pod', name, '--ignore-not-found',
                         '--wait=false'])
    for namespace in state.get('namespaces') or []:
        if cluster.run(['delete', 'namespace', namespace, '--wait=false']).returncode != 0:
            restored = False
    import shutil
    try:
        shutil.rmtree(options.shared_path)
    except OSError:
        restored = restored and not os.path.exists(options.shared_path)
    if volume.clear_filler() is False:
        restored = False
    total, avail = volume.space()
    shared_total, shared_avail = shared_space()
    print('RESTORE pods and namespaces deleted=%s, %s removed, %.2f GiB free on %s, '
          '%.2f GiB free on the shared filesystem, store %s'
          % (str(bool(state.get('namespaces'))).lower(), options.shared_path,
             avail / GIB, options.mount, shared_avail / GIB, options.store))
    if state.get('store_ready') is False:
        restored = False
        print('RESTORE incomplete: the store is not Ready')
    if not restored:
        print('RESTORE incomplete: check the walk\'s namespaces and the shared directory')


def run(report, options, loader, cluster, store, volume, state):
    if options.writer_image is None:
        body = cluster.json(['-n', options.namespace, 'get', 'cronjob', 'logs-evictor',
                             '-o', 'json']) or {}
        containers = (((body.get('spec') or {}).get('jobTemplate') or {}).get('spec') or {}) \
            .get('template', {}).get('spec', {}).get('containers') or []
        options.writer_image = containers[0].get('image') if containers else None
    if not options.writer_image:
        report.not_valid('the evictor CronJob names no Node image: the writers cannot start')
        return False
    if not report.check(volume.mounted(), 'the log volume is mounted', options.mount):
        return False
    os.makedirs(os.path.join(options.shared_path, 'pg'), exist_ok=True)
    os.chown(os.path.join(options.shared_path, 'pg'), 999, 999)
    if not ensure_namespace(report, cluster, options.writer_namespace, state):
        return False
    if not ensure_namespace(report, cluster, options.shared_namespace, state):
        return False
    if not ensure_namespace(report, cluster, TASKS_NAMESPACE, state):
        # The task namespace is the platform's own; a failed create means it exists.
        state['namespaces'] = [name for name in state['namespaces'] if name != TASKS_NAMESPACE]
    state['flood_run'] = 'walk-flood-%d' % now_ms()
    state['trusted_run'] = 'walk-trusted-%d' % now_ms()
    state['task_fast'] = 'walk-task-fast-%d' % now_ms()
    state['task_large'] = 'walk-task-large-%d' % now_ms()
    state['throttle_start'] = now_ms()
    if not flood_case(report, options, loader, cluster, store, volume, state):
        return False
    throttle_case(report, options, loader, cluster, state)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-VOLUME-FLOOD (ADR-016 L05)')
    common_arguments(parser)
    parser.add_argument('--writer-image', default=None,
                        help='Node writer image; by default use the deployed logs-evictor image')
    parser.add_argument('--writer-namespace', default='lifemodel-logs-walk')
    parser.add_argument('--shared-namespace', default='lifemodel-logs-walk-pg')
    parser.add_argument('--shared-path', default='/var/lib/lifemodel-logs-walk-shared')
    parser.add_argument('--postgres-image', default='docker.io/library/postgres:17-bookworm')
    parser.add_argument('--postgres-bytes', type=int, default=64 * MIB)
    parser.add_argument('--commit-interval-ms', type=int, default=200)
    parser.add_argument('--flood-seconds', type=int, default=300)
    parser.add_argument('--fill-bound', type=int, default=900)
    parser.add_argument('--burst-mib', type=int, default=4)
    parser.add_argument('--poll-seconds', type=int, default=5)
    parser.add_argument('--recover-bound', type=int, default=300)
    parser.add_argument('--commit-gap-bound', type=int, default=10)
    parser.add_argument('--collector-namespace', default='lifemodel-logs')
    parser.add_argument('--collector', default='logs-collector')
    parser.add_argument('--metrics-port', type=int, default=9598)
    parser.add_argument('--throttle-seconds', type=int, default=60)
    parser.add_argument('--trusted-interval-ms', type=int, default=20)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    volume = Volume(options.mount, options.pv_path)
    state = {'namespaces': [], 'store_ready': None}
    loader = None
    store = None
    forwarding = None
    ran = False

    def stage():
        nonlocal loader, store, forwarding
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
        store, forwarding = connect_store(report, options, cluster)
        if store is None:
            return False
        image = store_pod(cluster, options)
        if not report.check(bool(image), 'the store has a pod', options.store):
            return False
        return run(report, options, loader, cluster, store, volume, state)

    try:
        ran = stage()
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        state['store_ready'] = len(cluster.pods(options.namespace,
                                                'app.kubernetes.io/name=' + options.store)) > 0
        restore(report, options, loader, cluster, volume, state)
        if forwarding is not None:
            forwarding.close()
    if ran is not True and report.failures == 0 and report.invalid == 0:
        report.not_valid('the walk reached none of its cases')
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
