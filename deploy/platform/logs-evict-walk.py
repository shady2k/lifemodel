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
   two distinct runs completed successfully in it. A run is counted by what
   outlives it: the CronJob reports one Job of history on purpose
   (`successfulJobsHistoryLimit: 1`), so the Job objects alone can never show two,
   and `status.lastSuccessfulTime` is sampled every --run-sample-seconds seconds
   to see it advance (a Job name seen reaching Complete counts too).
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
     store answered 429 is shorter than two eviction intervals.
5. The read-only line while the evictor is healthy, produced the way the
   freshness walk produces it: the evictor removes day partitions only, so a
   uid-1000 filler beside `partitions/` takes the volume below the store's own
   margin. The store answers 429, the API says `storeReadOnly: true`, the
   status the page reads does not carry `the log evictor is failing or has not
   run` while the CronJob's last success is recent, and once the filler is
   removed writes are accepted again. The flood no longer reaches this state by
   itself when the evictor works, so the state is produced rather than awaited.
   The verdict is a known one: the status and the CronJob are polled up to the
   bound until `evictor.stale` is a boolean and the CronJob read answered, and
   the polls with no value are reported; no known value at all within the bound
   is its own result, not a blamed evictor. The page is then judged against the
   evictor's real state at the poll: a last success within two intervals of the
   answer must leave the line out, and an older one must add it together with
   the failing run's own reason - with the filler in, the volume holds something
   the evictor cannot remove, so its runs end `no_partition` (ADR-016 §5) and the
   page is right to name it.
6. The numbered lines of a real writer pod are counted per window through the
   API: written, found, dropped with its day and lost. The store partitions by
   `_time`'s day (ADR-016 §3) and the evictor removes a whole day, today's only
   when nothing older is left (§5), so every line that was in a dropped day is
   expected lost with that day, whichever window wrote it. A line in a day that
   was never dropped must be found, except one acknowledged inside a
   detach-to-remove window (the rows lost between detach and `rm`). Only a line
   lost outside both is a failure. The drops are collected from the flood's
   start up to the moment the lines are counted and frozen there, so a drop
   after the flood window - today's day, removed by the next run when the
   volume sat at the threshold, as a run across midnight does - is part of the
   accounting too. The writer pod keeps writing past the flood, and the walk
   waits (--tail-bound) until two eviction intervals have passed since the last
   drop it sees, so the lines after that drop exist: every one of them must be
   found (not lost, not dropped), there must be at least 200 of them, and the
   longest gap of accepted new lines is stated from them. A run with no line
   after the last drop, or no drop at all, is TEST NOT VALID with the reason,
   never a pass.
7. The evictor suspended (`suspend: true` on the CronJob) for two minutes: the
   line is absent while it runs, the API's status adds `the log evictor is
   failing or has not run` once its last success is older than two intervals,
   and after the resume and the next successful run it goes away again. Every
   poll keeps what it asked and what answered - the answer's state and reason,
   `evictor.stale` and `evictor.lastSuccessAt`, the CronJob's own last success
   and active Jobs, and the elapsed seconds - so a failure says what the API
   said; an API that never answered is its own result, never "the line never
   came". The staleness is due two intervals plus slack after the last success
   the walk saw AFTER the suspension, and no active Job ends the wait: a Job
   already running when the CronJob was suspended can still succeed and move
   `lastSuccessfulTime` forward.
8. A stranded day (ADR-016 §5): the walk writes a day older than every partition
   present (or strands the oldest one itself when that is already at the
   retention edge), detaches it by hand through the store and leaves its
   directory - exactly a lost detach answer - then fills the volume below the
   evictor's threshold while staying above the store's own margin, so the store
   keeps writing. Each step is bounded by --stranded-bound and asserted: the
   evictor writes `stranded_partition` for that day and removes nothing; the
   Deployment's `lifemodel.dev/logs-stranded-days` gains the day once in both
   annotation maps; the store pod is replaced; the restarted store lists the day
   as attached again; a later run drops it with its usual drop line (a detach
   answered 200) and the directory is gone; and the ledger names the day once
   and the store restarted once for it, both counted across the case.

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
  --poll-seconds N       how often the walk reads the evictor's drops and the
                         oldest row during the flood (default 5)
  --settle-seconds N     how long the collector and the store may take to settle
                         after the flood before the writer's lines are counted
                         (default 120)
  --tail-bound N         bound on waiting for two eviction intervals after the
                         last drop before the writer's lines are counted; the
                         writer pod keeps writing for the whole wait
                         (default 240 s)
  --stranded-bound N     bound on each step of the stranded-day case: the failed
                         run, the annotation, the store restart, the re-attach
                         and the drop (default 600 s)
  --writer-interval-ms N the writer pod's line interval (default 50)
  --quiet-seconds N      the quiet window below the threshold (default 150)
  --run-sample-seconds N how often the CronJob's last successful run is read in
                         the quiet window (default 10, so two runs are seen)
  --suspend-seconds N    overall bound on the suspended CronJob turning stale;
                         it allows a Job already running (its own deadline is
                         60 s) to finish and two intervals to pass after that
                         (default 360)
  --suspend-poll-seconds N  how often the status and the CronJob are read while
                         the evictor is suspended or its read-only verdict is
                         settling (default 10)
  --evictor-bound N      bound on the evictor having a recent successful run
                         before the read-only state is produced (default 180)
  --fill-timeout N       bound on filling the volume below the store's margin
                         (default 300)
  --refuse-bound N       bound on the store refusing a write after the fill
                         (default 30)
  --read-only-bound N    bound on the API saying the store is read-only after
                         the refusal, and on a known evictor state while it is
                         (default 180)
  --scratch-days-back N  the day of the partition the job-shaped pod removes;
                         it is inside the retention period, so the store accepts
                         the records and does not age them out (default 3)
  --collector-namespace NS  the collector's namespace (default lifemodel-logs)
  --collector NAME       the collector's DaemonSet (default logs-collector)
  --recover-bound N      bound on writes being accepted again (default 300 s)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
It creates a namespace of its own and a writer pod in it, starts a pod in the
store's namespace that lists and removes one day partition, writes today's and
yesterday's records through the store's insert protocol, strands one day and
lets the loader restart the store for it, puts a uid-1000 filler beside
`partitions/` until the store refuses writes and removes it again, and suspends
the evictor's CronJob for two minutes. The `finally` restores the
CronJob's `suspend`, deletes both pods and the namespace it created, removes the
scratch and stranded day partitions if they are still there (after the store
detaches them), removes any filler it left, and prints a RESTORE line with the
volume's free space and the day partitions that remain. The stranded-days
annotation is the loader's ledger and keeps the day: RESTORE says so. Today's flood records stay: they are logs, and
the evictor is what removes them. Yesterday's partition may also stay if the
flood did not reach it; the evictor takes it on its next run.

What it does not cover
----------------------
The event-count throttle and the trusted writer's fairness under attack are L05's
(they belong to the volume walk), and the two-day floor as a proportion of the
volume is also L05's measurement. The collector's own 429 retry is measured here
only through what it delivered (the writer's numbered lines), not through its
buffer counters, which the store's records do not carry. A lost line's partition
day is read from the stored record when the line is found and from the writer's
own `t=` otherwise, because the collector stores a line seconds after it is
written: a line written within those seconds of UTC midnight is the one place the
day is inferred, and the walk says so rather than claiming otherwise.

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
    MARGIN_SHARE,
    Report,
    Volume,
    WalkError,
    check_read_only_gauge,
    common_arguments,
    connect_store,
    day_bounds,
    day_of,
    days_of,
    fill_volume,
    margin_bytes,
    now_ms,
    parse_ms,
    probe_write,
    quantity,
    read_only_of,
    read_password,
    read_store_flags,
    stamp,
    status_of,
    wait_refused,
    wait_until,
    watch_read_only,
    window as status_window,
)

MIB = 1024 * 1024
GIB = 1024 * MIB
HEADROOM_BYTES = 768 * MIB
EVICTION_INTERVAL_MS = 60_000
EVICTOR_STALE_MS = 120_000
# The loader reads the CronJob afresh per request, but the controller writes
# `lastSuccessfulTime` only when it observes a completed Job: the line can come
# a poll or two after the two intervals.
STALE_SLACK_MS = 30_000
EVICTOR_MODULE = 'logs-evictor'
WRITER_MODULE = 'walk-evict-writer'
REMOVER_MODULE = 'walk-evict-rm'
FLOOD_MODULE = 'walk-evict'
PARTITION_KEY_SECRET = 'lifemodel-logs-partition-key'
WRITER_LINE = re.compile(r'walk-evict (\S+) seq=(\d+) t=(\d+)')
RECORD_PAYLOAD_BYTES = 384
BATCH_LINES = 2000
# The tail after the last drop: at least two eviction intervals of lines, and at
# least this many of them (10 s of the writer's 50 ms interval).
TAIL_MIN_LINES = 200

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


def writer_windows(written, found, bounds, dropped=()):
    """Per window: written, found, dropped with its day and lost numbered lines.

    `drop` marks a window that ended with a detach; a line lost in it is the one
    acknowledged between `detach` and `rm` (ADR-016 §5). `dropped` holds the
    lines whose day the evictor removed entirely, whichever window wrote them.
    """
    windows = []
    for index in range(len(bounds) - 1):
        low, high = bounds[index], bounds[index + 1]
        in_window = [sequence for sequence, moment in written if low <= moment < high]
        found_in = [sequence for sequence in in_window if sequence in found]
        dropped_in = [sequence for sequence in in_window if sequence in dropped]
        windows.append({
            'from': low,
            'to': high,
            'written': len(in_window),
            'found': len(found_in),
            'dropped': len(dropped_in),
            'lost': len(in_window) - len(found_in) - len(dropped_in),
            'drop': index > 0,
        })
    return windows


def loss_in_drop_windows_only(windows):
    """A lost line is allowed only inside a window that ended with a detach."""
    return all(window['lost'] == 0 or window['drop'] for window in windows)


def line_day(sequence, moment, found_times):
    """The partition a writer line went to: its stored `_time`'s day (ADR-016 §3).

    A found line's `_time` is read back from its record; a line that is not there
    has only the writer's own `t=` (its acceptance), which the collector stores
    within seconds, and the header says so.
    """
    return day_of(found_times.get(sequence, moment))


def dropped_with_its_day(written, found, found_times, drops):
    """The lines in a day the evictor removed after they were accepted.

    The evictor removes a whole day partition, today's only when nothing older
    is left (ADR-016 §5), so a line that was in a removed day is expected lost
    with that day. A drop that came before the line was accepted is not this
    line's: the day had been removed when the line went to its successor.
    """
    dropped = set()
    for sequence, moment in written:
        if sequence in found:
            continue
        day = line_day(sequence, moment, found_times)
        if any(drop['day'] == day and drop['time'] >= moment for drop in drops):
            dropped.add(sequence)
    return dropped


def collected_drops(loader, result):
    """Every drop the evictor logged from the flood's start to now, one per line.

    The evictor removes a whole day, today's only when nothing older is left
    (ADR-016 §5), so a run that crosses midnight can have its only flood-window
    drop name one day and the next run remove today's day - the one that held
    every writer line - after the flood window. The day accounting needs every
    drop up to the moment the lines are counted, not only those the flood saw.
    """
    drops = list(result['drops'])
    seen = {(drop['time'], drop['day']) for drop in drops}
    for record in evictor_records(loader, result['started']):
        line = drop_line(record)
        if line is None or (line['time'], line['day']) in seen:
            continue
        seen.add((line['time'], line['day']))
        drops.append(line)
    drops.sort(key=lambda drop: drop['time'])
    return drops


def wait_past_last_drop(report, options, loader, result):
    """Wait until two eviction intervals have passed since the last drop seen.

    The writer pod keeps writing for the whole walk (writer_seconds), so lines
    exist after the last drop even when today's partition is removed after the
    flood window; the walk waits for them, bounded by --tail-bound, and a drop
    seen during the wait restarts the two intervals.
    """
    drops = collected_drops(loader, result)
    if not drops:
        report.note('the evictor logged no drop: there is no tail to wait for')
        return drops
    started = time.monotonic()
    deadline = started + options.tail_bound
    while now_ms() - drops[-1]['time'] < 2 * EVICTION_INTERVAL_MS:
        if time.monotonic() >= deadline:
            report.note('the wait for two intervals after the last drop ended at its bound '
                        '(%d s), the last drop being %s at %s'
                        % (options.tail_bound, drops[-1]['day'], stamp(drops[-1]['time'])))
            break
        time.sleep(max(1, options.poll_seconds))
        drops = collected_drops(loader, result)
    else:
        report.pass_('the writer keeps storing for two intervals after the last drop',
                     '%s at %s, %.0f s before the count'
                     % (drops[-1]['day'], stamp(drops[-1]['time']),
                        (now_ms() - drops[-1]['time']) / 1000.0))
    return drops


def evictor_stale(last_success_ms, now, stale_ms=EVICTOR_STALE_MS):
    return last_success_ms is None or now - last_success_ms > stale_ms


def partition_refused(status, body):
    """The store's own refusal when no `authKey` is sent (ADR-016 §5).

    The key now travels in a form body (a POST), so the refusal proves the
    store requires the key at all rather than naming the URL form it used to
    read. The pinned store answered 400 with `Expected to receive non-empty
    authKey ...`; 401 is how `CheckAuthFlag` refuses a missing key in some
    versions, so both are a refusal here, and the walk prints the status it got.
    """
    return status in (400, 401) and 'authkey' in (body or '').lower()


def shorter_than_two_intervals(seconds):
    return seconds < 2 * EVICTION_INTERVAL_MS / 1000.0


def listing_owned_by(line, day):
    """One `ls -ln` line for a partition directory, owned by 1000:1000."""
    parts = line.split()
    return len(parts) >= 5 and parts[2] == '1000' and parts[3] == '1000' and parts[-1] == day


def evictor_stale_of(answer):
    value = (status_of(answer).get('evictor') or {}).get('stale')
    return value if isinstance(value, bool) else None


def window(minutes=60):
    """The API status read's own range: the last `minutes`, named as the walk reads it."""
    return status_window(minutes * 60)


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


def failure_line_of(record):
    """One evictor failure line's time and reason, or None for any other line."""
    try:
        body = json.loads(record.get('message') or '')
    except ValueError:
        return None
    if not isinstance(body, dict) or body.get('msg') != 'the log evictor removed nothing':
        return None
    day = body.get('day')
    return {'time': parse_ms(record.get('time')), 'reason': body.get('reason'),
            'day': day if isinstance(day, str) else None}


def latest_evictor_failure(loader, since_ms):
    """The evictor's newest failure line at or after `since_ms`, or None."""
    newest = None
    for record in evictor_records(loader, since_ms):
        failure = failure_line_of(record)
        if failure is None or failure['time'] is None:
            continue
        if newest is None or failure['time'] > newest['time']:
            newest = failure
    return newest


def collector_ready(cluster, options):
    """The collector's DaemonSet readiness: the numbered lines arrive through it."""
    body = cluster.json(['-n', options.collector_namespace, 'get', 'daemonset',
                         options.collector, '-o', 'json'])
    if body is None:
        return False
    status = body.get('status') or {}
    ready = int(status.get('numberReady') or 0)
    desired = int(status.get('desiredNumberScheduled') or 0)
    return desired >= 1 and ready == desired


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


def cronjob_state(cluster, options):
    """The evictor's CronJob as the walk sees it: last success and active Jobs.

    `known` is False when kubectl did not answer: an unread CronJob must not end
    the wait - its active Jobs are then unknown, not absent.
    """
    body = cronjob_json(cluster, options)
    status = (body or {}).get('status') or {}
    active = [name for name in (status.get('active') or []) if isinstance(name, str)]
    return {'known': body is not None, 'lastSuccess': parse_ms(status.get('lastSuccessfulTime')),
            'active': active}


def evictor_last_success_of(answer):
    """The API's own reading of the CronJob's last success, in milliseconds."""
    return parse_ms(((status_of(answer).get('evictor') or {}).get('lastSuccessAt')))


def poll_line(poll):
    """One status poll in a detail line: what was asked and what answered."""
    stale = poll['stale']
    active = 'unknown' if not poll['cronKnown'] else (
        ','.join(poll['active']) if poll['active'] else 'none')
    parts = ['t+%.0fs' % poll['elapsedSeconds'], 'state=%s' % poll['state']]
    if poll['reason']:
        parts.append('reason=%s' % poll['reason'])
    parts.append('stale=%s' % ('unknown' if stale is None else str(stale).lower()))
    parts.append('api last=%s' % (stamp(poll['apiLast']) if poll['apiLast'] else 'none'))
    parts.append('CronJob last=%s' % (stamp(poll['cronLast']) if poll['cronLast'] else 'none'))
    parts.append('active=%s' % active)
    parts.append('readOnly=%s' % ('unknown' if poll['readOnly'] is None
                                 else str(poll['readOnly']).lower()))
    return ' '.join(parts)


def staleness_due_ms(last_success_ms, now, active, cron_known=True):
    """Milliseconds until the line is due, or None while a run may still move it.

    The line is due two intervals (plus slack) after the last success the walk
    has seen, and never while the CronJob lists an active Job or could not be
    read: a Job created before the suspension can still complete and move
    `lastSuccessfulTime`, which restarts the two intervals.
    """
    if last_success_ms is None or active or not cron_known:
        return None
    return last_success_ms + EVICTOR_STALE_MS + STALE_SLACK_MS - now


def poll_evictor_state(loader, cluster, options, started):
    """One status and CronJob read, kept whole: the answer and the object beside it."""
    answer = loader.logs_status(*window())
    cron = cronjob_state(cluster, options)
    return {
        'elapsedSeconds': time.monotonic() - started,
        'state': answer.get('state') or 'unreadable',
        'reason': answer.get('reason') or '',
        'stale': evictor_stale_of(answer),
        'apiLast': evictor_last_success_of(answer),
        'cronLast': cron['lastSuccess'],
        'cronKnown': cron['known'],
        'active': cron['active'],
        'readOnly': read_only_of(answer),
    }


def watch_suspension(loader, cluster, options):
    """Poll the status and the CronJob until the line appears, it is due, or the bound.

    Every poll is kept, whatever it said: a state the API could not answer and
    an unknown staleness are evidence of their own, not of a missing line.
    """
    observations = []
    started = time.monotonic()
    hard_deadline = started + options.suspend_seconds
    last_seen = None
    while True:
        poll = poll_evictor_state(loader, cluster, options, started)
        seen = [moment for moment in (poll['apiLast'], poll['cronLast']) if moment is not None]
        if seen:
            last_seen = max(seen) if last_seen is None else max(last_seen, max(seen))
        observations.append(poll)
        if poll['stale'] is True:
            break
        due = staleness_due_ms(last_seen, now_ms(), poll['active'], poll['cronKnown'])
        if due is not None and due <= 0:
            break
        if time.monotonic() >= hard_deadline:
            break
        time.sleep(max(0.2, options.suspend_poll_seconds))
    return observations


def watch_evictor_verdict(loader, cluster, options):
    """Poll the status and the CronJob until both give a known evictor state.

    The store at its margin sits on the node's root disk, so both the API server
    and the loader can be slow at that moment: a failed CronJob read is
    `evictor.stale: null` by design (ADR-016 §5), and kubectl can fail too. The
    case judges only a known value and keeps every poll, so a run with none says
    so instead of blaming an evictor it never heard about.
    """
    observations = []
    started = time.monotonic()
    deadline = started + options.read_only_bound
    while True:
        poll = poll_evictor_state(loader, cluster, options, started)
        observations.append(poll)
        if poll['stale'] is not None and poll['cronKnown']:
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(max(0.2, options.suspend_poll_seconds))
    return observations


def set_suspend(cluster, options, suspend):
    return cluster.run([
        '-n', options.namespace, 'patch', 'cronjob', options.cronjob, '--type=merge',
        '-p', json.dumps({'spec': {'suspend': suspend}}),
    ]).returncode == 0


def completed_job_names(cluster, options, from_ms):
    """The evictor's Job names that reached Complete since `from_ms`, as listed now."""
    body = cluster.json(['-n', options.namespace, 'get', 'jobs', '-o', 'json']) or {}
    names = set()
    for job in body.get('items', []):
        owners = (job.get('metadata') or {}).get('ownerReferences') or []
        if not any(owner.get('name') == options.cronjob for owner in owners):
            continue
        status = job.get('status') or {}
        completed = parse_ms(status.get('completionTime'))
        if int(status.get('succeeded') or 0) < 1 or completed is None or completed < from_ms:
            continue
        name = (job.get('metadata') or {}).get('name')
        if name:
            names.add(name)
    return names


def runs_in_window(cluster, options, seconds, interval=10):
    """The distinct successful evictor runs seen while a window elapses.

    A run leaves two things that outlive it: `CronJob.status.lastSuccessfulTime`,
    which the controller advances on each success, and — for as long as it is
    kept — its Job object. The CronJob keeps `successfulJobsHistoryLimit: 1`
    (ADR-016 §5, on purpose), so the Job objects alone can never show two runs;
    the timestamp is therefore sampled `interval` seconds apart, often enough to
    see it advance, and a Job name seen reaching Complete counts as well. Two
    distinct runs is what the quiet window asserts; on a quiet volume a minute
    apart it is two or three in the default 150 s.
    """
    interval = max(1.0, min(float(interval), seconds / 3.0))
    times = set()
    jobs = set()
    started = now_ms()
    deadline = time.monotonic() + seconds
    while True:
        moment = cronjob_last_success(cluster, options)
        if moment is not None:
            times.add(moment)
        jobs |= completed_job_names(cluster, options, started)
        if time.monotonic() >= deadline:
            break
        time.sleep(interval)
    return max(len(times), len(jobs))


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


def writer_seconds(options):
    """How long the writer pod writes: the whole walk, past the tail's end.

    The pod is deleted with the walk's namespace, so this only has to outlast
    the fill, the flood, the settle and the wait for two intervals after the
    last drop - today's partition can be removed after the flood window.
    """
    return (options.fill_bound + options.flood_seconds + options.settle_seconds
            + options.tail_bound + 2 * EVICTION_INTERVAL_MS // 1000 + 120)


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
                            str(writer_seconds(options)),
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
    runs = runs_in_window(cluster, options, options.quiet_seconds,
                          options.run_sample_seconds)
    lines = evictor_records(loader, started)
    report.check(not lines, 'two quiet runs below the threshold remove nothing and log nothing',
                 'no module=logs-evictor record in %d s' % options.quiet_seconds)
    report.check(runs >= 2, 'two distinct evictor runs completed in the quiet window',
                 '%d run(s) in %d s, counted from the CronJob\'s last successful run and the '
                 'Job names seen reaching Complete (one Job of history is kept)'
                 % (runs, options.quiet_seconds))
    return not lines


def flood(report, options, volume, store, loader, run_id):
    """Fill to the threshold, then write at full speed; return what was observed."""
    total, avail = volume.space()
    threshold = threshold_bytes(total)
    report.note('the volume holds %.2f GiB with %.2f GiB free; the evictor threshold is '
                '%.2f GiB' % (total / GIB, avail / GIB, threshold / GIB))
    result = {'threshold': threshold, 'filled': False, 'samples': [], 'drops': [], 'seen': set(),
              'oldest': [], 'oldestBefore': oldest_record_ms(store),
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
    if result['filled']:
        report.note('the flood wrote about %.1f GiB in %.0f s and ended at %.2f GiB free'
                    % (result['bytes'] / GIB, (result['ended'] - result['started']) / 1000.0,
                       volume.space()[1] / GIB))
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
    return bool(drops)


def read_only_case(report, options, loader, cluster, store, volume):
    """The read-only line while the evictor is healthy (ADR-016 §4, §5).

    A flood of day partitions no longer drives the store below its margin once
    the evictor works, so the state the page's read-only line needs is produced
    the way the freshness walk produces it: a uid-1000 filler beside
    `partitions/`, which the evictor never removes because it removes day
    partitions only. The status the page reads must then say read-only and not
    add `the log evictor is failing or has not run`: the evictor's last success
    is checked to be recent in the CronJob itself, so the line's absence is not
    an accident of a stale read. The filler is removed on every exit and the
    writes must be accepted again.
    """

    def recent_run():
        return not evictor_stale(cronjob_last_success(cluster, options), now_ms())

    if not wait_until(time.monotonic() + options.evictor_bound, 5, recent_run):
        report.not_valid('the evictor has no recent successful run: the read-only line cannot '
                         'be told apart from a failing evictor')
        return False
    flags = read_store_flags(report, options, cluster, 'the store\'s margin')
    margin = quantity((flags or {}).get('storage.minFreeDiskSpaceBytes'))
    threshold = margin_bytes(volume, margin)
    report.note('the store keeps %s free for its merges (-storage.minFreeDiskSpaceBytes)'
                % (('%.1f MiB' % (margin / MIB)) if margin else 'an unreadable amount'))
    try:
        reached, avail, wanted = fill_volume(report, options, volume, store, threshold)
        if not reached:
            report.not_valid('the volume was never filled below the store\'s margin: no '
                             'read-only state to assert (%d MiB free, %d MiB needed)'
                             % (avail // MIB, wanted // MIB))
            return False
        report.pass_('the volume is filled below the store\'s margin while the evictor is '
                     'healthy', '%d MiB free, margin %d MiB' % (avail // MIB, wanted // MIB))
        refused, _body, answers = wait_refused(report, store, options.refuse_bound)
        if refused != 429:
            report.not_valid('the store did not refuse a write within %d s with %d MiB free: '
                             'it answered %s'
                             % (options.refuse_bound, avail // MIB,
                                ', '.join(str(status) for status in answers)))
            return False
        report.pass_('the store refuses a write (429) with the volume below its margin',
                     '%d probe(s); the refusal is the state the page must name' % len(answers))
        check_read_only_gauge(report, store)
        if not watch_read_only(report, loader,
                               'the API says the store is refusing writes (read-only)',
                               options.read_only_bound, avail):
            return False
        observations = watch_evictor_verdict(loader, cluster, options)
        polls = len(observations)
        unknown = [poll for poll in observations
                   if poll['stale'] is None or not poll['cronKnown']]
        last = observations[-1]
        last_polls = '; '.join(poll_line(poll) for poll in observations[-4:])
        if last['stale'] is None or not last['cronKnown']:
            report.fail('the API and the CronJob both answer the evictor\'s state while the '
                        'store is read-only',
                        'no poll in %d carried both a staleness and the CronJob\'s own last '
                        'success: %s' % (polls, last_polls))
            report.not_valid('no poll carried a known evictor state within %d s: the read-only '
                             'line cannot be told apart from a failing evictor'
                             % options.read_only_bound)
        else:
            # The page is judged against the evictor's real state at the poll: a
            # recent success must not be blamed, and an old one must be, with the
            # failing run's own reason (ADR-016 §5: with the filler in, the
            # volume holds something the evictor cannot remove, so its runs end
            # `no_partition` and the page is right to name it).
            age = (now_ms() - last['cronLast']) / 1000.0 if last['cronLast'] else None
            detail = ('storeReadOnly=%s, evictor.stale=%s, API last success %s, CronJob last '
                      'success %s (%.0f s before the poll); %d poll(s), %d without a known value'
                      % (str(last['readOnly']).lower(), str(last['stale']).lower(),
                         stamp(last['apiLast']) if last['apiLast'] else 'none',
                         stamp(last['cronLast']) if last['cronLast'] else 'never',
                         age if age is not None else -1.0, polls, len(unknown)))
            if age is not None and age * 1000 <= EVICTOR_STALE_MS:
                report.check(
                    last['stale'] is False and last['readOnly'] is True,
                    'the page shows read-only without blaming the evictor: its last run is '
                    'recent', detail)
            else:
                failure = latest_evictor_failure(
                    loader, last['cronLast'] if last['cronLast'] else window()[0])
                reason = failure['reason'] if failure else 'none'
                report.check(
                    last['stale'] is True and last['readOnly'] is True
                    and reason == 'no_partition',
                    'the page names the evictor only because its last success is older than two '
                    'intervals, and the run says why',
                    detail + ', latest failure reason %s at %s'
                    % (reason, stamp(failure['time']) if failure else 'none'))
        return True
    finally:
        if not volume.clear_filler():
            report.fail('the filler is removed from the volume', volume.filler_dir)
        recovered = wait_until(time.monotonic() + options.recover_bound, 5,
                               lambda: probe_write(store)[0] in (200, 204))
        report.check(bool(recovered),
                     'the store accepts writes again after the filler is removed',
                     'no restart was needed')
        after = loader.logs_status(*window())
        report.check(read_only_of(after) is False,
                     'the API says the store is not read-only after the filler is removed',
                     'storeReadOnly=%s' % str(read_only_of(after)).lower())


def collect_writer(report, options, loader, cluster, run_id, result, state):
    """The writer's numbered lines, per window, the tail after the last drop and its gap."""
    pod = 'walk-evict-writer'
    log = pod_log(cluster, options.writer_namespace, pod)
    # The lines are counted up to the moment their log was read; a line written
    # after that is not in the log and not in any window.
    logged_at = now_ms()
    written = []
    for line in log.splitlines():
        match = WRITER_LINE.search(line)
        if match and match.group(1) == run_id:
            written.append((int(match.group(2)), int(match.group(3))))
    if not written:
        report.not_valid('the writer pod wrote no numbered line the walk could read')
        return False
    found = set()
    found_times = {}
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
                sequence = int(match.group(2))
                found.add(sequence)
                moment = parse_ms(record.get('time'))
                if moment is not None:
                    found_times.setdefault(sequence, moment)
        if len(records) < limit or (isinstance(expected, int) and offset + limit > expected):
            break
        offset += limit
    # Every drop up to this count, frozen here: a drop after the flood window can
    # be the one that took the writer's lines (today's day, removed by the next
    # run when the volume sat at the threshold).
    drops = collected_drops(loader, result)
    late = [drop for drop in drops if drop['time'] > result['ended']]
    if late:
        report.note('the evictor also removed %s after the flood window and before the writer\'s '
                    'lines were counted'
                    % ', '.join('%s at %s' % (drop['day'], stamp(drop['time'])) for drop in late))
    # The windows run between the drops and end where the lines were counted, so
    # the last one is the tail after the last drop - the lines the DONE WHEN's
    # "new lines keep being stored" is shown on. A drop's own `_time` can sit a
    # second before the walk's start (two clocks), so the boundaries are ordered
    # and deduplicated, never trusted in.
    bounds = [result['started']] + [drop['time'] for drop in drops] + [logged_at]
    bounds = sorted({moment for moment in bounds if moment})
    dropped = dropped_with_its_day(written, found, found_times, drops)
    windows = writer_windows(written, found, bounds, dropped)
    for index, window_result in enumerate(windows):
        report.note('writer window %d (drop after: %s): wrote %d, found %d, '
                    'dropped with its day %d, lost %d'
                    % (index + 1, str(window_result['drop']).lower(), window_result['written'],
                       window_result['found'], window_result['dropped'], window_result['lost']))
    lost = sum(window_result['lost'] for window_result in windows)
    report.pass_('the writer\'s numbered lines are counted per window through the API',
                 '%d written, %d found after the flood, %d dropped with its day, %d lost'
                 % (len(written), len(found), len(dropped), lost))
    report.check(loss_in_drop_windows_only(windows),
                 'a row is lost only with the day the evictor removed or inside a window that '
                 'ended with a detach and a remove',
                 'windows: %s' % ', '.join(
                     'wrote %d, found %d, dropped %d, lost %d'
                     % (window_result['written'], window_result['found'],
                        window_result['dropped'], window_result['lost'])
                     for window_result in windows))
    if not drops:
        report.not_valid('the evictor dropped no day: the lines after a drop cannot be judged')
    else:
        tail_after_drop(report, written, found, drops[-1], logged_at)
    return True


def tail_after_drop(report, written, found, drop, logged_at):
    """The lines written after the last drop: all found, enough of them, and their gap.

    This is the DONE WHEN's "new lines keep being stored and found while the
    oldest disappear": a run whose writer stopped before the last drop has no
    such lines, and that is TEST NOT VALID with the reason, never a pass.
    """
    tail = [(sequence, moment) for sequence, moment in written if moment > drop['time']]
    span = (logged_at - drop['time']) / 1000.0
    if not tail:
        report.not_valid('no writer line was written after the last drop (%s at %s, %.0f s '
                         'before the count): the tail after the displacement cannot be judged'
                         % (drop['day'], stamp(drop['time']), span))
        return
    missing = [sequence for sequence, _moment in tail if sequence not in found]
    report.check(
        not missing and len(tail) >= TAIL_MIN_LINES and logged_at - drop['time']
        >= 2 * EVICTION_INTERVAL_MS,
        'every line written after the last drop is found, and there are enough of them',
        '%d line(s), %s, over %.0f s since %s at %s was removed'
        % (len(tail), 'none lost' if not missing else '%d not found' % len(missing), span,
           drop['day'], stamp(drop['time'])))
    gap = longest_gap([(sequence, moment) for sequence, moment in tail if sequence in found])
    if gap is None:
        report.note('the longest gap of accepted new lines after the last drop cannot be '
                    'stated: fewer than two lines were found after it')
        return
    report.note('the longest gap of accepted new lines after the last drop: %.1f s '
                '(after seq %d, before seq %d)'
                % (gap['seconds'], gap['afterSeq'], gap['beforeSeq']))
    report.check(gap['seconds'] < 2 * EVICTION_INTERVAL_MS / 1000.0,
                 'the longest gap of accepted new lines after the last drop is shorter than '
                 'two eviction intervals', '%.1f s' % gap['seconds'])


def suspend_case(report, options, loader, cluster):
    """Two minutes suspended: the API adds the evictor line; the next run removes it."""

    probes = []

    def not_stale():
        answer = loader.logs_status(*window())
        probes.append(answer)
        return evictor_stale_of(answer) is False

    # The line must be absent first: the read-only case fills the volume with
    # something the evictor cannot remove, so its runs may have failed since the
    # last success, and a line that was there before the suspension would prove
    # nothing about the suspension.
    if not wait_until(time.monotonic() + options.evictor_bound, 5, not_stale):
        last = probes[-1] if probes else {}
        report.not_valid('the evictor is not fresh before it is suspended: state=%s%s, '
                         'stale=%s in the last of %d probe(s)'
                         % (last.get('state', 'unreadable'),
                            (' reason=%s' % last['reason']) if last.get('reason') else '',
                            ('unknown' if last.get('state') != 'ok'
                             else str(evictor_stale_of(last)).lower()), len(probes)))
        return False
    report.pass_('the evictor line is absent while the evictor runs',
                 'the CronJob\'s last success is recent')
    if not set_suspend(cluster, options, True):
        report.fail('the evictor is suspended for two minutes', 'the patch was refused')
        return False
    report.pass_('the evictor is suspended', 'CronJob %s suspend=true' % options.cronjob)

    observations = watch_suspension(loader, cluster, options)
    polls = len(observations)
    unreadable = [poll for poll in observations if poll['state'] != 'ok']
    known = [poll for poll in observations if poll['stale'] is not None]
    last_polls = '; '.join(poll_line(poll) for poll in observations[-4:])
    reached = observations[-1]['stale'] is True
    if reached:
        report.pass_('the API adds the evictor line once its last run is older than two intervals',
                     'stale=true at t+%.0fs after %d poll(s), %d with no answer; %s'
                     % (observations[-1]['elapsedSeconds'], polls, len(unreadable), last_polls))
    elif not known:
        # Not one poll carried a staleness: the API did not answer, which is its
        # own result and not a line that never came.
        report.fail('the API answers the evictor\'s status while the evictor is suspended',
                    'every one of %d poll(s) was unreadable: %s' % (polls, last_polls))
        report.not_valid('the API never answered the evictor\'s status during the suspension: '
                         'the evictor line cannot be judged')
    else:
        report.fail('the API adds the evictor line once its last run is older than two intervals',
                    '%d poll(s), %d with no answer; the line is due two intervals plus %d s after '
                    'the last success: %s'
                    % (polls, len(unreadable), STALE_SLACK_MS // 1000, last_polls))
    if not set_suspend(cluster, options, False):
        report.fail('the evictor is resumed', 'the patch was refused')
        return reached
    report.pass_('the evictor is resumed', 'CronJob %s suspend=false' % options.cronjob)

    def fresh():
        return evictor_stale_of(loader.logs_status(*window())) is False

    return report.check(wait_until(time.monotonic() + options.suspend_seconds, 10, fresh),
                        'the evictor line goes away after the next successful run',
                        'within %d s of the resume' % options.suspend_seconds)


STRANDED_ANNOTATION = 'lifemodel.dev/logs-stranded-days'
STRANDED_REASON = 'stranded_partition'


def store_annotations(cluster, options):
    """The store Deployment's annotation maps: the object's and the pod template's."""
    body = cluster.json(['-n', options.namespace, 'get', 'deployment', options.store, '-o', 'json'])
    if body is None:
        return None
    metadata = (body.get('metadata') or {}).get('annotations') or {}
    template = ((((body.get('spec') or {}).get('template') or {}).get('metadata') or {})
                .get('annotations') or {})
    return {'object': metadata.get(STRANDED_ANNOTATION),
            'template': template.get(STRANDED_ANNOTATION)}


def stranded_days_of(annotations):
    """The days the ledger names, or None when its two maps disagree (ADR-016 §5)."""
    if annotations is None:
        return None
    object_days = annotations.get('object') or ''
    template_days = annotations.get('template') or ''
    if object_days != template_days:
        return None
    return [day for day in object_days.split(',') if day]


def stranded_day(volume, now, retention_days):
    """The day the case strands, and whether the walk creates it.

    A day the walk writes must be older than every partition present, or the
    evictor takes an older attached day first, and inside the store's retention,
    or the store ages it out. When the oldest present day already sits at the
    retention edge, the case strands that day itself: the lost detach answer is
    the same, and a day it created could not be kept.
    """
    present = volume.partitions()
    if not present:
        return day_of(now - 5 * 86400 * 1000), True
    start, _end = day_bounds(present[0])
    candidate_ms = start - 86400 * 1000
    if retention_days is not None \
            and now - candidate_ms > (retention_days - 1) * 86400 * 1000:
        return present[0], False
    return day_of(candidate_ms), True


def stranded_failure(loader, day, from_ms):
    """The evictor's newest stranded_partition line for `day` since `from_ms`."""
    newest = None
    for record in evictor_records(loader, from_ms):
        failure = failure_line_of(record)
        if failure is None or failure['reason'] != STRANDED_REASON or failure['day'] != day:
            continue
        if failure['time'] is not None and (newest is None or failure['time'] > newest['time']):
            newest = failure
    return newest


def drop_of(loader, day, from_ms):
    """The evictor's newest drop line for `day` since `from_ms`, or None."""
    newest = None
    for record in evictor_records(loader, from_ms):
        line = drop_line(record)
        if line is None or line['day'] != day:
            continue
        if newest is None or line['time'] > newest['time']:
            newest = line
    return newest


def attached_days(store, key):
    """The store's attached days through the partition list, or None when it did not answer."""
    try:
        status, body = store.partition_list(key)
    except WalkError:
        return None
    if status != 200:
        return None
    try:
        days = json.loads(body)
    except ValueError:
        return None
    return days if isinstance(days, list) else None


def stranded_case(report, options, loader, cluster, store, volume, state):
    """A hand-detached day is recovered by the loader's restart, then dropped (ADR-016 §5).

    A lost detach answer leaves a day's directory on disk while the store no
    longer lists it. ADR-016 §5's second rule is that such a day is never
    removed on that absence: the run writes `stranded_partition` and exits 1,
    the loader's 30 s reconcile adds the day to the Deployment's
    `lifemodel.dev/logs-stranded-days` annotation once, the store restarts and
    re-attaches the directory, and the next run detaches it with a 200 and
    removes it. Every step is bounded by --stranded-bound, and the store pod is
    counted so "restarted once" is measured, not assumed.
    """
    deadline = time.monotonic() + options.stranded_bound
    started_ms = now_ms()
    flags = read_store_flags(report, options, cluster, 'the store\'s retention')
    retention = days_of((flags or {}).get('retentionPeriod'))
    day, created = stranded_day(volume, now_ms(), retention)
    report.note('the stranded day is %s (%s)'
                % (day, 'a scratch day older than every partition present' if created
                   else 'the oldest partition present, already at the retention edge'))
    before = store_pod(cluster, options)
    uids = {(before or {}).get('uid')} - {None}

    def track_pod():
        pod = store_pod(cluster, options)
        uid = (pod or {}).get('uid')
        if uid is not None:
            uids.add(uid)
        return uid

    try:
        if created:
            moment = day_bounds(day)[0] + 12 * 3600 * 1000
            try:
                write_burst(store, moment, state['run_id'], 2, 'stranded')
            except WalkError as error:
                report.not_valid('a day to strand could not be written (%s)' % error)
                return False
            if not wait_until(min(deadline, time.monotonic() + 120), 3,
                              lambda: day in volume.partitions()):
                report.not_valid('the store never created the day %s partition' % day)
                return False
            report.pass_('the walk writes a day that holds records, older than the rest', day)
        status, _body = store.detach(day, state.get('key', ''))
        if not report.check(status == 200,
                            'the day is detached by hand through the store and its directory '
                            'is not removed',
                            'detach answered %d; the lost answer leaves the directory on disk'
                            % status):
            return False
        state['stranded_day'] = day
        total = volume.space()[0]
        threshold = threshold_bytes(total)
        reached, avail, wanted = fill_volume(report, options, volume, store, threshold)
        if not reached:
            report.not_valid('the volume never went below the evictor\'s threshold: no run '
                             'finds the stranded day (%d MiB free, %d MiB needed)'
                             % (avail // MIB, wanted // MIB))
            return False
        report.pass_('the volume is below the evictor\'s threshold and above the store\'s '
                     'margin', '%d MiB free; the filler stops at the evictor threshold, which '
                     'is 768 MiB of headroom above the 25 %% store margin' % (avail // MIB))
        status, _body = probe_write(store)
        if not report.check(status in (200, 204),
                            'the store still accepts writes at that fill',
                            'probe answered %d: the filler is above the store\'s margin' % status):
            return False

        failure = wait_until(deadline, options.poll_seconds,
                             lambda: stranded_failure(loader, day, started_ms))
        report.check(failure is not None,
                     'the evictor writes a stranded_partition line for the day and removes '
                     'nothing',
                     ('%s for %s at %s' % (failure['reason'], failure['day'],
                                           stamp(failure['time']))
                      if failure else 'no line for %s within %d s'
                      % (day, options.stranded_bound)))
        if failure is None:
            report.not_valid('the stranded run never happened: the recovery has no state')
            return False
        report.check(day in volume.partitions(),
                     'the day\'s directory is still on disk after that run', 'day %s' % day)

        def annotated():
            days = stranded_days_of(store_annotations(cluster, options))
            return days if days is not None and days.count(day) == 1 else None

        added = wait_until(deadline, options.poll_seconds, annotated)
        report.check(added is not None,
                     'the loader adds the day to the Deployment\'s stranded-days annotation once',
                     ('%s in both maps' % ','.join(added)) if added is not None
                     else 'no annotation naming %s within %d s'
                     % (day, options.stranded_bound))
        if added is None:
            report.not_valid('the annotation never named the day: the restart and the drop '
                             'have no state')
            return False

        def replaced():
            uid = track_pod()
            return uid if uid is not None and uid not in ((before or {}).get('uid'),) else None

        replacement = wait_until(deadline, options.poll_seconds, replaced)
        report.check(replacement is not None,
                     'the store pod is replaced for that day',
                     ('pod uid %s -> %s' % ((before or {}).get('uid'), replacement))
                     if replacement is not None
                     else 'pod uid %s still runs after %d s'
                     % ((before or {}).get('uid'), options.stranded_bound))
        if replacement is None:
            report.not_valid('the store did not restart: the re-attach has no state')
            return False

        def reattached():
            days = attached_days(store, state.get('key', ''))
            return days if days is not None and day in days else None

        attached = wait_until(deadline, options.poll_seconds, reattached)
        report.check(attached is not None,
                     'the restarted store lists the day as attached again',
                     '%s in /internal/partition/list' % day
                     if attached is not None
                     else '%s absent from /internal/partition/list after %d s'
                     % (day, options.stranded_bound))
        if attached is None:
            report.not_valid('the day was not re-attached: the acknowledged detach has no state')
            return False

        dropped = wait_until(deadline, options.poll_seconds,
                             lambda: drop_of(loader, day, started_ms))
        report.check(dropped is not None,
                     'a later run drops the day with its usual drop line',
                     ('%s at %s, %.1f MiB freed' % (dropped['day'], stamp(dropped['time']),
                                                    dropped['freedBytes'] / MIB))
                     if dropped else 'no drop line for %s within %d s'
                     % (day, options.stranded_bound))
        if dropped is None:
            return False
        report.check(day not in volume.partitions(),
                     'the stranded day\'s directory is gone after the drop', 'day %s' % day)
        track_pod()
        days = stranded_days_of(store_annotations(cluster, options))
        report.check(days is not None and days.count(day) == 1,
                     'the ledger names the day exactly once across the case',
                     'annotation %s' % (','.join(days) if days is not None
                                        else 'unreadable or the two maps disagree'))
        report.check(len(uids) - 1 == 1,
                     'the store restarted exactly once for that day',
                     '%d store pod(s) after the first: %s'
                     % (len(uids) - 1, ', '.join(sorted(uids)) or 'none'))
        return True
    finally:
        if not volume.clear_filler():
            report.fail('the filler is removed from the volume', volume.filler_dir)


def run(report, options, loader, cluster, store, volume, state):
    if not report.check(volume.mounted(), 'the log volume is mounted', options.mount):
        return False
    if store_pod(cluster, options) is None:
        report.not_valid('the store has no pod: nothing to flood')
        return False
    # The partition key is read into a variable and never printed.
    try:
        state['key'] = cluster.secret_value(options.namespace, PARTITION_KEY_SECRET,
                                            'partition-key')
    except WalkError:
        state['key'] = ''
    if not report.check(collector_ready(cluster, options), 'the collector is Ready before the flood',
                        '%s/%s' % (options.collector_namespace, options.collector)):
        report.not_valid('the collector is not Ready: the writer pod\'s numbered lines would never '
                         'reach the store')
        return False
    state['run_id'] = 'walk-evict-%d' % now_ms()
    partition_evidence(report, options, cluster, store, volume, state['run_id'], state)
    quiet_case(report, options, loader, cluster, volume)
    # The stranded case restarts the store by design; the flood's own
    # "did not restart" baseline is taken after it.
    stranded_case(report, options, loader, cluster, store, volume, state)
    pod_before = store_pod(cluster, options)
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
        wait_past_last_drop(report, options, loader, result)
        collect_writer(report, options, loader, cluster, state['run_id'], result, state)
    # After the writer's lines are counted: the fill removes whole days through
    # the evictor, and those days are evidence the counting above needs.
    read_only_case(report, options, loader, cluster, store, volume)
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
    try:
        restored = volume.clear_filler() and restored
    except OSError:
        restored = False
    for name, day in (('scratch', state.get('scratch_day')),
                      ('stranded', state.get('stranded_day'))):
        if not day or day not in volume.partitions() or store is None:
            continue
        try:
            status, _body = store.detach(day, state.get('key', ''))
        except (WalkError, OSError):
            status = None
        if status == 200:
            try:
                volume.remove_day(day)
            except OSError:
                restored = False
            continue
        if name == 'stranded':
            # A day the store no longer lists cannot be detached by hand, and its
            # directory must not be removed without a 200 (ADR-016 §5): the
            # ledger now names it, so the next run and a restart recover it.
            print('RESTORE note: the stranded day %s stays on disk; the stranded-days ledger '
                  'will restart the store for it' % day)
        else:
            restored = False
    total, avail = volume.space()
    remaining = [day for day in volume.partitions() if day != day_of(now_ms())]
    print('RESTORE evictor suspend=false, walk pods deleted%s, no filler on %s, %.2f GiB free '
          'on %s, day partitions other than today: %s (today\'s records stay%s)'
          % (', the walk\'s namespace deleted' if state.get('created_namespace') else '',
             options.pv_path, avail / GIB, options.mount,
             ', '.join(remaining) if remaining else 'none',
             '; the stranded-days annotation keeps its ledger, including a day the case '
             'stranded' if state.get('stranded_day') else ''))
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
    parser.add_argument('--tail-bound', type=int, default=240)
    parser.add_argument('--stranded-bound', type=int, default=600)
    parser.add_argument('--writer-interval-ms', type=int, default=50)
    parser.add_argument('--quiet-seconds', type=int, default=150)
    parser.add_argument('--run-sample-seconds', type=int, default=10)
    parser.add_argument('--suspend-seconds', type=int, default=360)
    parser.add_argument('--suspend-poll-seconds', type=float, default=10)
    parser.add_argument('--evictor-bound', type=int, default=180)
    parser.add_argument('--fill-timeout', type=int, default=300)
    parser.add_argument('--refuse-bound', type=int, default=30)
    parser.add_argument('--read-only-bound', type=int, default=180)
    parser.add_argument('--scratch-days-back', type=int, default=3)
    parser.add_argument('--collector-namespace', default='lifemodel-logs')
    parser.add_argument('--collector', default='logs-collector')
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
