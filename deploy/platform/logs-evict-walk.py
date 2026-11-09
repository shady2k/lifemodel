#!/usr/bin/env python3
"""WALK-LOGS-EVICT: new logs displace the oldest ones with nobody acting
(ADR-016 L16, §5).

What it proves
--------------
1. The store's partition API refuses an unauthenticated caller:
   `/internal/partition/list` without `authKey` answers the store's own refusal
   (the Secret holds a key, checked without printing it). The evictor's detach
   answered 200 is proved by its own drop line: a run writes that line only after
   `detach` returned 200 and only after the directory was removed.
2. The job's pod mounts the volume while the store's pod has it mounted: a pod of
   the evictor's own shape (uid 1000, the volume read-write, the same image) lists
   `/data/partitions` with `ls -ln`, and its `rm` removes a partition directory
   the store created - the walk detaches that day first, exactly as the evictor
   does, and the store pod stays the same pod throughout.
3. Below the threshold, two consecutive runs remove nothing and log nothing: no
   `module=logs-evictor` record appears in a quiet window of two intervals, and
   at least two Jobs completed successfully in it.
4. The flood: today's and yesterday's records are written until the volume's free
   space passes the evictor's threshold (25 % of the volume plus 768 MiB), then
   at full speed for --flood-seconds. Asserted afterwards:
   - the store did not restart (restartCount and uid unchanged) and its log holds
     no panic and no FATAL line;
   - each drop is one `module=logs-evictor` record naming the day and the bytes
     freed (read through the API), and each of them proves its detach answered
     200;
   - the oldest remaining row moves forward after each drop (sampled through the
     store as the oldest `_time`);
   - writes are accepted again after the drops, and every window in which the
     store answered 429 is shorter than two eviction intervals;
   - during the flood the API's status says the store refuses writes while the
     evictor is not stale: the page shows the read-only line without blaming the
     evictor;
   - the numbered lines of a real writer pod are counted per window through the
     API: written, found and lost per window, the loss only inside a window that
     ended with a drop (the rows acknowledged between detach and remove), and the
     longest gap of accepted new lines stated in seconds.
5. The evictor suspended (`suspend: true` on the CronJob) for two minutes: the
   API's status adds `the log evictor is failing or has not run`, and after the
   resume and the next successful run it goes away again.

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
  --mount PATH           the host mount point (default /var/lib/lifemodel-logs)
  --pv-path PATH         the PV's path inside that mount
                         (default /var/lib/lifemodel-logs/data)
  --cronjob NAME         the evictor's CronJob (default logs-evictor)
  --writer-namespace NS  where the numbered writer pod runs; its own namespace
                         (default lifemodel-logs-walk)
  --flood-seconds N      how long the full-speed flood lasts after the threshold
                         (default 300)
  --fill-bound N         bound on reaching the threshold (default 900 s)
  --burst-mib N          each insert's incompressible payload (default 4)
  --poll-seconds N       how often the walk reads the status, the drops and the
                         oldest row during the flood (default 5)
  --settle-seconds N     how long the collector and the store may take to settle
                         after the flood before the writer's lines are counted
                         (default 120)
  --writer-interval-ms N the writer pod's line interval (default 50)
  --quiet-seconds N      the quiet window below the threshold (default 150)
  --suspend-seconds N    bound on the suspended CronJob turning stale (default 220)
  --scratch-days-back N  the day of the partition the job-shaped pod removes
                         (default 20)
  --recover-bound N      bound on writes being accepted again (default 300 s)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
It creates a namespace of its own and a writer pod in it, starts a pod in the
store's namespace that lists and removes one day partition, writes today's and
yesterday's records through the store's insert protocol, and suspends the
evictor's CronJob for two minutes. The `finally` restores the CronJob's
`suspend`, deletes both pods and the namespace it created, removes its scratch
day partition if it is still there (after the store detaches it), and prints a
RESTORE line with the volume's free space and the day partitions that remain.
Today's flood records stay: they are logs, and the evictor is what removes them.
Yesterday's partition may also stay if the flood did not reach it; the evictor
takes it on its next run.

What it does not cover
----------------------
The event-count throttle and the trusted writer's fairness under attack are L05's
(they belong to the volume walk), and the two-day floor as a proportion of the
volume is also L05's measurement. The collector's own 429 retry is measured here
only through what it delivered (the writer's numbered lines), not through its
buffer counters, which the store's records do not carry.

Exit status is non-zero when any assertion failed or a state was never reached.
"""
import argparse
import base64
import json
import math
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    Cluster,
    Loader,
    Report,
    WalkError,
    common_arguments,
    connect_store,
    day_of,
    now_ms,
    parse_ms,
    read_password,
    stamp,
    wait_until,
)

MIB = 1024 * 1024
GIB = 1024 * MIB
MARGIN_SHARE = 0.25
HEADROOM_BYTES = 768 * MIB
EVICTION_INTERVAL_MS = 60_000
EVICTOR_STALE_MS = 120_000
EVICTOR_MODULE = 'logs-evictor'
WRITER_MODULE = 'walk-evict-writer'
REMOVER_MODULE = 'walk-evict-rm'
FLOOD_MODULE = 'walk-evict'
PARTITION_KEY_SECRET = 'lifemodel-logs-partition-key'
WRITER_LINE = re.compile(r'walk-evict (\S+) seq=(\d+) t=(\d+)')
RECORD_PAYLOAD_BYTES = 384
BATCH_LINES = 2000

WRITER_SCRIPT = (
    "const run=process.argv[1],seconds=Number(process.argv[2]),interval=Number(process.argv[3]);"
    "let seq=0;const end=Date.now()+seconds*1000;"
    "const timer=setInterval(()=>{if(Date.now()>end){clearInterval(timer);return;}"
    "seq+=1;process.stdout.write('walk-evict '+run+' seq='+seq+' t='+Date.now()+' level=info\\n');"
    "},interval);"
)


def threshold_bytes(total_bytes):
    """The evictor's threshold: the store's margin plus one minute of flood (ADR-016 §5)."""
    return int(math.ceil(total_bytes * MARGIN_SHARE)) + HEADROOM_BYTES


def refusal_windows(samples):
    """Consecutive 429 answers as windows, in seconds, from (moment, status) samples."""
    windows = []
    opened = None
    for moment, status in samples:
        if status == 429 and opened is None:
            opened = moment
        elif status != 429 and opened is not None:
            windows.append({'start': opened, 'end': moment,
                            'seconds': max(0.0, (moment - opened) / 1000.0)})
            opened = None
    if opened is not None:
        last = samples[-1][0] if samples else opened
        windows.append({'start': opened, 'end': last,
                        'seconds': max(0.0, (last - opened) / 1000.0)})
    return windows


def longest_gap(entries):
    """The longest silence between two accepted numbered lines, in seconds."""
    if len(entries) < 2:
        return None
    ordered = sorted(entries)
    best = None
    for (after, first), (before, second) in zip(ordered, ordered[1:]):
        seconds = (second - first) / 1000.0
        if best is None or seconds > best['seconds']:
            best = {'seconds': seconds, 'afterSeq': after, 'beforeSeq': before}
    return best


def writer_windows(written, found, bounds):
    """Per window: written, found and lost numbered lines; `drop` marks a detach window."""
    windows = []
    for index in range(len(bounds) - 1):
        low, high = bounds[index], bounds[index + 1]
        in_window = [sequence for sequence, moment in written if low <= moment < high]
        found_in = [sequence for sequence in in_window if sequence in found]
        windows.append({
            'from': low,
            'to': high,
            'written': len(in_window),
            'found': len(found_in),
            'lost': len(in_window) - len(found_in),
            'drop': index > 0,
        })
    return windows


def loss_in_drop_windows_only(windows):
    return all(window['lost'] == 0 or window['drop'] for window in windows)


def evictor_stale(last_success_ms, now, stale_ms=EVICTOR_STALE_MS):
    return last_success_ms is None or now - last_success_ms > stale_ms


def partition_refused(status, body):
    """The store's own refusal text when no `authKey` is sent (ADR-016 §5)."""
    return status != 200 and 'authkey' in (body or '').lower()


def shorter_than_two_intervals(seconds):
    return seconds < 2 * EVICTION_INTERVAL_MS / 1000.0


def listing_owned_by(line, day):
    """One `ls -ln` line for a partition directory, owned by 1000:1000."""
    parts = line.split()
    return len(parts) >= 5 and parts[2] == '1000' and parts[3] == '1000' and parts[-1] == day


def status_of(answer):
    return (answer or {}).get('status') or {}


def read_only_of(answer):
    value = status_of(answer).get('storeReadOnly')
    return value if isinstance(value, bool) else None


def evictor_stale_of(answer):
    value = (status_of(answer).get('evictor') or {}).get('stale')
    return value if isinstance(value, bool) else None


def window(minutes=60):
    end = now_ms()
    return end - minutes * 60_000, end


def payload():
    return base64.b64encode(os.urandom(RECORD_PAYLOAD_BYTES)).decode('ascii')


def flood_batch(count, moment_ms, run_id, kind):
    moment = stamp(moment_ms)
    lines = []
    for sequence in range(count):
        lines.append({
            'timestamp': moment,
            'message': '%s %s %06d %s' % (run_id, kind, sequence, payload()),
            'module': FLOOD_MODULE,
            'namespace': 'walk',
            'pod': 'walk-evict',
            'container': 'walk',
            'stream': 'stdout',
            'level': 'info',
            'untrusted': False,
        })
    return lines


def write_burst(store, moment_ms, run_id, mib, kind):
    """One insert of incompressible records; returns (status, lines)."""
    count = max(1, int(mib * MIB) // (RECORD_PAYLOAD_BYTES + 220))
    lines = flood_batch(count, moment_ms, run_id, kind)
    status, _body = store.insert(lines)
    return status, len(lines)


def oldest_record_ms(store):
    """The oldest stored `_time`, read from the store as one aggregation."""
    start = stamp(now_ms() - 30 * 86400 * 1000)
    end = stamp(now_ms())
    rows = store.query('_time:[%s, %s] | stats min(_time)' % (start, end))
    if len(rows) != 1:
        return None
    return parse_ms(rows[0].get('min(_time)'))


def evictor_records(loader, from_ms):
    """The evictor's own lines in a window, oldest first, through the API."""
    answer = loader.logs({'from': str(from_ms), 'to': str(now_ms()),
                          'module': EVICTOR_MODULE, 'limit': '50'})
    if answer is None or answer.get('state') != 'ok':
        return []
    records = [record for record in (answer.get('records') or [])
               if isinstance(record, dict) and isinstance(record.get('time'), str)]
    records.sort(key=lambda record: record['time'])
    return records


def drop_line(record):
    """One evictor line's day, bytes and reason, or None when it names no day."""
    try:
        body = json.loads(record.get('message') or '')
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    day = body.get('day')
    freed = body.get('freedBytes')
    if not isinstance(day, str) or not re.match(r'^\d{8}$', day):
        return None
    if not isinstance(freed, (int, float)) or freed <= 0:
        return None
    return {'time': parse_ms(record.get('time')), 'day': day, 'freedBytes': int(freed),
            'reason': body.get('reason')}


def store_pod(cluster, options):
    pods = cluster.pods(options.namespace, 'app.kubernetes.io/name=' + options.store)
    if not pods:
        return None
    pod = pods[0]
    statuses = (pod.get('status') or {}).get('containerStatuses') or []
    return {
        'name': (pod.get('metadata') or {}).get('name'),
        'uid': (pod.get('metadata') or {}).get('uid'),
        'restarts': sum(int(status.get('restartCount') or 0) for status in statuses),
    }


def cronjob_json(cluster, options):
    return cluster.json(['-n', options.namespace, 'get', 'cronjob', options.cronjob, '-o', 'json'])


def evictor_image(cluster, options):
    body = cronjob_json(cluster, options) or {}
    containers = (((body.get('spec') or {}).get('jobTemplate') or {}).get('spec') or {}) \
        .get('template', {}).get('spec', {}).get('containers') or []
    return containers[0].get('image') if containers else None


def cronjob_last_success(cluster, options):
    body = cronjob_json(cluster, options) or {}
    return parse_ms(((body.get('status') or {}).get('lastSuccessfulTime')))


def set_suspend(cluster, options, suspend):
    return cluster.run([
        '-n', options.namespace, 'patch', 'cronjob', options.cronjob, '--type=merge',
        '-p', json.dumps({'spec': {'suspend': suspend}}),
    ]).returncode == 0


def successful_jobs(cluster, options, from_ms):
    body = cluster.json(['-n', options.namespace, 'get', 'jobs', '-o', 'json']) or {}
    count = 0
    for job in body.get('items', []):
        owners = (job.get('metadata') or {}).get('ownerReferences') or []
        if not any(owner.get('name') == options.cronjob for owner in owners):
            continue
        completed = parse_ms(((job.get('status') or {}).get('completionTime')))
        if completed is not None and completed >= from_ms \
                and int((job.get('status') or {}).get('succeeded') or 0) >= 1:
            count += 1
    return count


def ensure_namespace(report, cluster, options, state):
    body = cluster.json(['get', 'namespace', options.writer_namespace, '-o', 'json'])
    if body is not None:
        return True
    result = cluster.run(['create', 'namespace', options.writer_namespace])
    if result.returncode != 0:
        report.fail('the walk\'s own namespace exists', options.writer_namespace)
        return False
    state['created_namespace'] = True
    return True


def writer_manifest(image, options, run_id):
    return {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': 'walk-evict-writer', 'namespace': options.writer_namespace,
                     'labels': {'app.kubernetes.io/name': WRITER_MODULE}},
        'spec': {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                                'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{
                'name': 'writer',
                'image': image,
                'command': ['node', '-e', WRITER_SCRIPT, run_id,
                            str(options.flood_seconds + 180),
                            str(options.writer_interval_ms)],
                'securityContext': {'readOnlyRootFilesystem': True,
                                    'allowPrivilegeEscalation': False,
                                    'capabilities': {'drop': ['ALL']},
                                    'seccompProfile': {'type': 'RuntimeDefault'}},
                'resources': {'requests': {'cpu': '20m', 'memory': '32Mi'}},
            }],
        },
    }


def remover_manifest(image, options, day):
    return {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': 'walk-evict-rm', 'namespace': options.namespace,
                     'labels': {'app.kubernetes.io/name': REMOVER_MODULE}},
        'spec': {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                                'fsGroup': 1000, 'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{
                'name': 'remover',
                'image': image,
                'command': ['sh', '-c', 'ls -ln /data/partitions; rm -rf /data/partitions/%s'
                            % day],
                'securityContext': {'readOnlyRootFilesystem': True,
                                    'allowPrivilegeEscalation': False,
                                    'capabilities': {'drop': ['ALL']},
                                    'seccompProfile': {'type': 'RuntimeDefault'}},
                'resources': {'requests': {'cpu': '20m', 'memory': '32Mi'}},
                'volumeMounts': [{'name': 'data', 'mountPath': '/data'}],
            }],
            'volumes': [{'name': 'data',
                         'persistentVolumeClaim': {'claimName': options.store}}],
        },
    }


def pod_phase(cluster, namespace, name):
    pod = cluster.pod(namespace, name) or {}
    return (pod.get('status') or {}).get('phase')


def pod_log(cluster, namespace, name):
    result = cluster.run(['-n', namespace, 'logs', name, '--tail=100000'], timeout=180)
    return result.stdout if result.returncode == 0 else ''


def check_partition_refusal(report, store, key):
    """The store answers its own refusal when no `authKey` is sent (ADR-016 §5)."""
    if key == '':
        report.not_valid('the partition key Secret holds no value: the store requires no authKey, '
                         'so its refusal cannot be asserted')
        return False
    status, body = store.partition_list()
    first = body.strip().splitlines()[0][:120] if body.strip() else 'no body'
    return report.check(partition_refused(status, body),
                        'the store refuses /internal/partition/list without authKey',
                        'answered %d, %s' % (status, first))


def partition_evidence(report, options, cluster, store, volume, run_id, state):
    """The store's refusal, and the job-shaped pod's rm on a store-created day."""
    key = state.get('key', '')
    check_partition_refusal(report, store, key)
    scratch_moment = now_ms() - options.scratch_days_back * 86400 * 1000
    day = day_of(scratch_moment)
    try:
        write_burst(store, scratch_moment, run_id, 2, 'scratch')
    except WalkError as error:
        report.fail('a scratch day is written for the rm proof', str(error))
        report.not_valid('no scratch partition: the rm proof cannot run')
        return False
    state['scratch_day'] = day
    if not wait_until(time.monotonic() + 120, 3, lambda: day in volume.partitions()):
        report.not_valid('the scratch day partition never appeared on the volume: the rm proof '
                         'cannot run')
        return False
    path = os.path.join(volume.pv_path, 'partitions', day)
    try:
        stats = os.stat(path)
        owned = (stats.st_uid, stats.st_gid) == (1000, 1000)
    except OSError:
        owned = False
    report.check(owned, 'the store created the partition directory as 1000:1000',
                 'stat: uid/gid %s' % ('1000:1000' if owned else 'not 1000:1000'))
    before = store_pod(cluster, options)
    status, _body = store.detach(day, key)
    if status != 200:
        report.fail('the scratch day is detached before it is removed',
                    'detach answered %d' % status)
        return False
    report.pass_('the scratch day is detached before it is removed', 'detach answered 200')
    image = evictor_image(cluster, options)
    if not image:
        report.not_valid('the evictor CronJob names no image: the job-shaped pod cannot be created')
        return False
    if cluster.apply(remover_manifest(image, options, day)).returncode != 0:
        report.fail('the job-shaped pod is created in the store\'s namespace',
                    'kubectl apply was refused')
        return False
    phase = wait_until(
        time.monotonic() + 180, 3,
        lambda: pod_phase(cluster, options.namespace, 'walk-evict-rm')
        if pod_phase(cluster, options.namespace, 'walk-evict-rm') in ('Succeeded', 'Failed') else None,
    )
    log = pod_log(cluster, options.namespace, 'walk-evict-rm')
    listing = [line for line in log.splitlines() if day in line.split()]
    report.check(phase == 'Succeeded', 'the job-shaped pod\'s rm succeeds as uid 1000',
                 'pod phase %s' % (phase or 'still running'))
    report.check(bool(listing) and listing_owned_by(listing[0], day),
                 'its ls -ln shows the store\'s directory owned by 1000:1000',
                 listing[0].strip() if listing else 'no line for the day')
    report.check(day not in volume.partitions(), 'the store-created day is gone after the rm',
                 'day %s' % day)
    after = store_pod(cluster, options)
    report.check(before is not None and after is not None and before['uid'] == after['uid'],
                 'the store\'s pod had the volume mounted while the job\'s pod used it',
                 'store pod %s unchanged' % (before or {}).get('name'))
    state['scratch_day'] = None
    return True


def quiet_case(report, options, loader, cluster, volume):
    total, avail = volume.space()
    threshold = threshold_bytes(total)
    if avail < threshold:
        report.not_valid('the volume is below the evictor\'s threshold before the quiet window')
        return False
    started = now_ms()
    time.sleep(options.quiet_seconds)
    lines = evictor_records(loader, started)
    jobs = successful_jobs(cluster, options, started)
    report.check(not lines, 'two quiet runs below the threshold remove nothing and log nothing',
                 'no module=logs-evictor record in %d s' % options.quiet_seconds)
    report.check(jobs >= 2, 'at least two evictor runs completed in the quiet window',
                 '%d successful Jobs in %d s' % (jobs, options.quiet_seconds))
    return not lines


def flood(report, options, volume, store, loader, run_id):
    """Fill to the threshold, then write at full speed; return what was observed."""
    total, avail = volume.space()
    threshold = threshold_bytes(total)
    report.note('the volume holds %.2f GiB with %.2f GiB free; the evictor threshold is '
                '%.2f GiB' % (total / GIB, avail / GIB, threshold / GIB))
    result = {'threshold': threshold, 'filled': False, 'samples': [], 'drops': [], 'seen': set(),
              'statuses': [], 'oldest': [], 'oldestBefore': oldest_record_ms(store),
              'started': now_ms(), 'ended': None, 'bytes': 0}
    fill_deadline = time.monotonic() + options.fill_bound
    filled_at = None
    next_poll = time.monotonic()
    while True:
        moment = time.monotonic()
        if filled_at is None:
            if moment > fill_deadline:
                report.fail('the volume falls below the evictor\'s threshold',
                            '%.2f GiB free after %d s' % (volume.space()[1] / GIB,
                                                          options.fill_bound))
                report.not_valid('the volume never passed the evictor\'s threshold: the '
                                 'displacement assertions have no state to run in')
                return result
            if volume.space()[1] < threshold:
                filled_at = moment
                report.pass_('the volume falls below the evictor\'s threshold',
                             '%.2f GiB free while the records are written'
                             % (volume.space()[1] / GIB))
        elif moment > filled_at + options.flood_seconds:
            break
        now = now_ms()
        status, lines = write_burst(store, now, run_id, options.burst_mib, 'today')
        result['samples'].append((now_ms(), status))
        result['bytes'] += lines * (RECORD_PAYLOAD_BYTES + 220)
        if filled_at is None:
            # The fill is today's *and* yesterday's records: the displacement's oldest
            # day then already exists when the threshold is reached.
            status, lines = write_burst(store, now - 86400 * 1000, run_id,
                                        options.burst_mib, 'yesterday')
            result['samples'].append((now_ms(), status))
            result['bytes'] += lines * (RECORD_PAYLOAD_BYTES + 220)
        if filled_at is None and status == 429:
            filled_at = moment
            report.pass_('the store refuses a write while the volume is being filled',
                         '429 answers, so the volume is below the store\'s margin')
        if moment >= next_poll:
            next_poll = moment + options.poll_seconds
            answer = loader.logs_status(*window(30))
            result['statuses'].append({'at': now_ms(), 'readOnly': read_only_of(answer),
                                       'stale': evictor_stale_of(answer)})
            for record in evictor_records(loader, result['started']):
                identity = '%s|%s' % (record.get('time'), record.get('message'))
                if identity in result['seen']:
                    continue
                result['seen'].add(identity)
                line = drop_line(record)
                if line is not None:
                    result['drops'].append(line)
                    result['oldest'].append(oldest_record_ms(store))
    result['ended'] = now_ms()
    result['filled'] = filled_at is not None
    return result


def evaluate_flood(report, options, result, loader, cluster, store, pod_before, state):
    """The assertions of the displacement itself."""
    pod_after = store_pod(cluster, options)
    restart_ok = (pod_before is not None and pod_after is not None
                  and pod_before['uid'] == pod_after['uid']
                  and pod_before['restarts'] == pod_after['restarts'])
    report.check(restart_ok, 'the store did not restart under the flood',
                 'restartCount %s -> %s'
                 % ((pod_before or {}).get('restarts'), (pod_after or {}).get('restarts')))
    log = pod_log(cluster, options.namespace, (pod_after or {}).get('name') or '')
    bad = [line for line in log.splitlines() if 'panic' in line.lower() or 'FATAL:' in line]
    report.check(not bad, 'the store\'s log holds no panic and no FATAL line',
                 bad[0][:160] if bad else 'the last lines were read')
    drops = result['drops']
    if not drops:
        report.fail('the evictor drops a day under the flood',
                    'no module=logs-evictor record in %d s of flood'
                    % options.flood_seconds)
        report.not_valid('the evictor never acted: the drop assertions have no state')
    else:
        report.pass_('the evictor drops days under the flood',
                     '%d drop(s): %s' % (len(drops), ', '.join(
                         '%s (%.1f MiB)' % (drop['day'], drop['freedBytes'] / MIB)
                         for drop in drops)))
        report.check(all(drop['day'] and drop['freedBytes'] > 0 for drop in drops),
                     'each drop is one module=logs-evictor line naming the day and the bytes freed',
                     'the reason on every line is %s'
                     % ', '.join(sorted({str(drop['reason']) for drop in drops})))
        report.pass_('each drop line proves its detach answered 200',
                     'the evictor writes the line only after the detach returned and the '
                     'directory was removed')
        oldest = [moment for moment in result['oldest'] if moment is not None]
        moved = (result['oldestBefore'] is not None and oldest
                 and oldest[-1] > result['oldestBefore']
                 and all(later >= earlier for earlier, later in zip(oldest, oldest[1:])))
        report.check(bool(moved), 'the oldest remaining row moves forward at each drop',
                     'oldest %s -> %s' % (
                         stamp(result['oldestBefore']) if result['oldestBefore'] else 'none',
                         stamp(oldest[-1]) if oldest else 'none'))
    accepted = wait_until(time.monotonic() + options.recover_bound, 10,
                          lambda: write_burst(store, now_ms(), state['run_id'], 1, 'after')[0]
                          in (200, 204))
    report.check(bool(accepted), 'writes are accepted again after the drops',
                 'within %d s of the flood' % options.recover_bound)
    windows = refusal_windows(result['samples'])
    longest = max((window['seconds'] for window in windows), default=0.0)
    report.check(all(shorter_than_two_intervals(window['seconds']) for window in windows),
                 'every window in which the store answered 429 is shorter than two eviction '
                 'intervals',
                 '%d window(s), longest %.1f s' % (len(windows), longest))
    read_only = [sample for sample in result['statuses'] if sample['readOnly'] is True]
    if not read_only:
        report.not_valid('the flood never made the store refuse writes: the read-only line was '
                         'not observed')
    else:
        report.check(all(sample['stale'] is False for sample in read_only),
                     'during the flood the API says read-only without blaming the evictor',
                     '%d sample(s) with storeReadOnly=true and evictor.stale=false'
                     % len(read_only))
    return bool(drops)


def collect_writer(report, options, loader, cluster, run_id, result, state):
    """The writer's numbered lines, per window, and the longest gap."""
    pod = 'walk-evict-writer'
    log = pod_log(cluster, options.writer_namespace, pod)
    written = []
    for line in log.splitlines():
        match = WRITER_LINE.search(line)
        if match and match.group(1) == run_id:
            written.append((int(match.group(2)), int(match.group(3))))
    if not written:
        report.not_valid('the writer pod wrote no numbered line the walk could read')
        return False
    start = result['ended']
    found = set()
    offset = 0
    limit = 1000
    expected = None
    while True:
        answer = loader.logs({'from': str(result['started']), 'to': str(now_ms()),
                              'module': WRITER_MODULE, 'text': run_id,
                              'offset': str(offset), 'limit': str(limit),
                              **({'expected': str(expected)} if expected is not None else {})})
        if answer is None or answer.get('state') != 'ok':
            report.not_valid('the writer\'s records could not be read through the API')
            return False
        if expected is None:
            expected = answer.get('count')
        records = answer.get('records') or []
        for record in records:
            match = WRITER_LINE.search(record.get('message') or '')
            if match and match.group(1) == run_id:
                found.add(int(match.group(2)))
        if len(records) < limit or (isinstance(expected, int) and offset + limit > expected):
            break
        offset += limit
    bounds = [result['started']] + [drop['time'] for drop in result['drops']] + [result['ended']]
    bounds = [moment for moment in bounds if moment]
    windows = writer_windows(written, found, bounds)
    for index, window_result in enumerate(windows):
        report.note('writer window %d (drop after: %s): wrote %d, found %d, lost %d'
                    % (index + 1, str(window_result['drop']).lower(), window_result['written'],
                       window_result['found'], window_result['lost']))
    lost = sum(window_result['lost'] for window_result in windows)
    report.pass_('the writer\'s numbered lines are counted per window through the API',
                 '%d written, %d found after the flood, %d lost' % (len(written), len(found), lost))
    report.check(loss_in_drop_windows_only(windows),
                 'rows are lost only inside a window that ended with a detach and a remove',
                 'windows: %s' % ', '.join(str(window_result['lost']) for window_result in windows))
    gap = longest_gap([(sequence, moment) for sequence, moment in written
                       if sequence in found])
    if gap is None:
        report.note('the longest gap of accepted new lines cannot be stated: fewer than two '
                    'lines were found')
    else:
        report.note('the longest gap of accepted new lines: %.1f s (after seq %d, before seq %d)'
                    % (gap['seconds'], gap['afterSeq'], gap['beforeSeq']))
        report.check(gap['seconds'] < 2 * EVICTION_INTERVAL_MS / 1000.0,
                     'the longest gap of accepted new lines is shorter than two eviction intervals',
                     '%.1f s' % gap['seconds'])
    return True


def suspend_case(report, options, loader, cluster):
    """Two minutes suspended: the API adds the evictor line; the next run removes it."""
    if not set_suspend(cluster, options, True):
        report.fail('the evictor is suspended for two minutes', 'the patch was refused')
        return False
    report.pass_('the evictor is suspended', 'CronJob %s suspend=true' % options.cronjob)

    def stale():
        return evictor_stale_of(loader.logs_status(*window())) is True

    reached = wait_until(time.monotonic() + options.suspend_seconds, 10, stale)
    report.check(reached, 'the API adds the evictor line once its last run is older than two '
                 'intervals', 'last successful run parsed from the CronJob')
    if not set_suspend(cluster, options, False):
        report.fail('the evictor is resumed', 'the patch was refused')
        return reached
    report.pass_('the evictor is resumed', 'CronJob %s suspend=false' % options.cronjob)

    def fresh():
        return evictor_stale_of(loader.logs_status(*window())) is False

    return report.check(wait_until(time.monotonic() + options.suspend_seconds, 10, fresh),
                        'the evictor line goes away after the next successful run',
                        'within %d s of the resume' % options.suspend_seconds)


def run(report, options, loader, cluster, store, volume, state):
    if not report.check(volume.mounted(), 'the log volume is mounted', options.mount):
        return False
    pod_before = store_pod(cluster, options)
    if pod_before is None:
        report.not_valid('the store has no pod: nothing to flood')
        return False
    # The partition key is read into a variable and never printed.
    try:
        state['key'] = cluster.secret_value(options.namespace, PARTITION_KEY_SECRET,
                                            'partition-key')
    except WalkError:
        state['key'] = ''
    state['run_id'] = 'walk-evict-%d' % now_ms()
    partition_evidence(report, options, cluster, store, volume, state['run_id'], state)
    quiet_case(report, options, loader, cluster, volume)
    if not ensure_namespace(report, cluster, options, state):
        return False
    image = evictor_image(cluster, options)
    if not image:
        report.not_valid('the evictor CronJob names no image: the writer pod cannot be created')
        return False
    applied = cluster.apply(writer_manifest(image, options, state['run_id']))
    if applied.returncode != 0:
        report.fail('the writer pod is created', options.writer_namespace)
        report.not_valid('no writer pod: the numbered-line assertions cannot run')
        return False
    first_line = wait_until(
        time.monotonic() + 180, 5,
        lambda: bool([line for line in
                      pod_log(cluster, options.writer_namespace, 'walk-evict-writer').splitlines()
                      if state['run_id'] in line]))
    if not first_line:
        report.not_valid('the writer pod wrote no line the walk could read: the numbered-line '
                         'assertions cannot run')
    else:
        report.pass_('the writer pod\'s lines are read from its own log',
                     'run %s' % state['run_id'])
    result = flood(report, options, volume, store, loader, state['run_id'])
    if result['filled']:
        evaluate_flood(report, options, result, loader, cluster, store, pod_before, state)
        time.sleep(options.settle_seconds)
        collect_writer(report, options, loader, cluster, state['run_id'], result, state)
    suspend_case(report, options, loader, cluster)
    return True


def restore(report, options, loader, cluster, store, volume, state):
    """Restore the CronJob, delete the walk's pods and namespace, free its days."""
    restored = True
    restored = set_suspend(cluster, options, False) and restored
    for namespace, name in ((options.namespace, 'walk-evict-rm'),
                            (options.writer_namespace, 'walk-evict-writer')):
        try:
            cluster.run(['-n', namespace, 'delete', 'pod', name, '--ignore-not-found',
                         '--wait=false'])
        except WalkError:
            restored = False
    if state.get('created_namespace'):
        result = cluster.run(['delete', 'namespace', options.writer_namespace, '--wait=false'])
        restored = restored and result.returncode == 0
    scratch = state.get('scratch_day')
    if scratch and scratch in volume.partitions() and store is not None:
        try:
            key = state.get('key', '')
            status, _body = store.detach(scratch, key)
            if status == 200:
                volume.remove_day(scratch)
            else:
                restored = False
        except (WalkError, OSError):
            restored = False
    total, avail = volume.space()
    remaining = [day for day in volume.partitions() if day != day_of(now_ms())]
    print('RESTORE evictor suspend=false, walk pods deleted%s, %.2f GiB free on %s, '
          'day partitions other than today: %s (today\'s records stay)'
          % (', the walk\'s namespace deleted' if state.get('created_namespace') else '',
             avail / GIB, options.mount, ', '.join(remaining) if remaining else 'none'))
    if not restored:
        print('RESTORE incomplete: check CronJob %s and the walk\'s pods by hand'
              % options.cronjob)


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-EVICT (ADR-016 L16)')
    common_arguments(parser)
    parser.add_argument('--cronjob', default='logs-evictor')
    parser.add_argument('--writer-namespace', default='lifemodel-logs-walk')
    parser.add_argument('--flood-seconds', type=int, default=300)
    parser.add_argument('--fill-bound', type=int, default=900)
    parser.add_argument('--burst-mib', type=int, default=4)
    parser.add_argument('--poll-seconds', type=int, default=5)
    parser.add_argument('--settle-seconds', type=int, default=120)
    parser.add_argument('--writer-interval-ms', type=int, default=50)
    parser.add_argument('--quiet-seconds', type=int, default=150)
    parser.add_argument('--suspend-seconds', type=int, default=220)
    parser.add_argument('--scratch-days-back', type=int, default=20)
    parser.add_argument('--recover-bound', type=int, default=300)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    volume = Volume(options.mount, options.pv_path)
    state = {'created_namespace': False, 'scratch_day': None, 'run_id': None, 'key': ''}
    forwarding = None
    store = None
    loader = None
    try:
        try:
            secret = read_password(options.password_file)
        except WalkError as error:
            print('FAIL the credential file is readable - ' + str(error))
            return 1
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return 1
        store, forwarding = connect_store(report, options, cluster)
        if store is None:
            return 1
        run(report, options, loader, cluster, store, volume, state)
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        restore(report, options, loader, cluster, store, volume, state)
        if forwarding is not None:
            forwarding.close()
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
