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
   exact six-second window (collector-made `throttle-window` records queried
   through the store read interface; missing or duplicate pairs are unknown); and
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
  --throttle-seconds N   the concurrent throttle burst (default 60 s)
  --trusted-interval-ms N the trusted writer's line interval (default 20)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
It creates one walk-owned namespace for Postgres and writer pods, including
trusted writers in the existing `lifemodel-system` namespace, and a shared-filesystem directory with the
Postgres data in it; it writes into the log volume and plants records on two
past days inside the store's retention, so the evictor has a past day it can
drop even when every older day was already evicted. The `finally` deletes the
pods and namespaces it created and the shared directory, removes its filler and
its flood files, waits for the store to be Ready and prints a RESTORE line with
both filesystems' free space; it removes no day it did not plant beyond what
the evictor dropped. Image content and snapshots, rotated container logs, Postgres data and walk
files consume shared root space. They are measured separately after pod startup;
--postgres-bytes is a legacy planning value, not an enforced quota. The store
flood stays inside its mounted log volume.

The throttle volume
-------------------
The throttle case proves a real agent task's lines reach the collector untrusted,
then writes the throttled volume with two pods the walk creates itself in the
task namespace `lifemodel-motor` (1000 small lines/s and 20 large lines/s). The
agent decides when its task is done and can end its writer early, so it cannot
produce a fixed-duration volume; the collector decides trust and throttling by
namespace and pod alone, so walk-owned pods in that namespace are throttled
exactly like a task pod while the walk controls their duration. The walk refuses
to start when pods of its own names already exist there, and restore deletes
only those two pods, never anything else in the namespace.

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
    RESPONSE_LIMIT,
    Cluster,
    Loader,
    Report,
    Volume,
    WalkError,
    common_arguments,
    connect_store,
    day_bounds,
    day_of,
    days_of,
    now_ms,
    parse_ms,
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
# The large task writer's pad, and the space one stored record costs in an
# answer beyond its message. A loader answer over RESPONSE_LIMIT cannot be read.
LARGE_TASK_LINE_BYTES = 20 * 1024
# The throttle volume is written by walk-owned pods in the task namespace, not
# by an agent: the collector decides trust and throttling by namespace and pod,
# so these untrusted pods are throttled like a task pod, while the walk controls
# their duration. (name, interval in ms, line pad)
THROTTLE_VOLUME = (
    ('walk-throttle-fast', 1, 0),
    ('walk-throttle-large', 50, LARGE_TASK_LINE_BYTES),
)
LOADER_PAGE_MAX = 1000
RESPONSE_HEADROOM = 4 * MIB
RECORD_OVERHEAD_BYTES = 4096
# The past days the flood plants for the evictor; two are the smallest set whose
# oldest day can be dropped before today's day is all that is left.
PAST_DAYS = 2
PLANT_RECORD_MIB = 2
PLANT_BOUND_SECONDS = 60


def loader_page_limit(line_bytes):
    """Records per page that keep one loader answer well under RESPONSE_LIMIT."""
    budget = RESPONSE_LIMIT - RESPONSE_HEADROOM
    per_record = max(1, int(line_bytes) + RECORD_OVERHEAD_BYTES)
    return max(1, min(LOADER_PAGE_MAX, budget // per_record))


def loader_records(loader, query, limit):
    """Every record of one loader query, paged; a short page ends the loop.

    Returns (records, HTTP status). A refused page keeps its status, so a caller
    can say TEST NOT VALID with it instead of treating the answer as empty.
    """
    offset = 0
    collected = []
    while True:
        status, answer = loader.logs_page(dict(query, limit=str(limit), offset=str(offset)))
        if status != 200:
            return None, status
        if not isinstance(answer, dict) or answer.get('state') != 'ok':
            return None, status
        page = answer.get('records') or []
        collected.extend(page)
        if len(page) < limit:
            return collected, status
        offset += len(page)


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


def throttle_pod_verdict(pod, entries, stored_lines):
    """One task pod's counter windows reconcile with the lines the store holds.

    The accepted counters over the pod's windows must add up to its stored
    lines, every present window is one complete input/accepted pair with input
    at least accepted, and its windows come from one collector process. Windows
    without counters inside a collector process are noted, not failed: the
    collector read nothing of that pod in them. The windows are processing time
    and are never compared with the writers' write timestamps.
    """
    from logs_walk_support import stamp

    def label(first):
        return stamp(first) if isinstance(first, int) else 'unknown'

    if not entries:
        return {'ok': False, 'pod': pod, 'windows': 0, 'input': 0, 'accepted': 0,
                'stored': stored_lines, 'discarded': 0, 'notes': [],
                'detail': '%s: no input/accepted counter windows' % pod}
    problems = []
    notes = []
    by_start = {}
    for entry in entries:
        by_start.setdefault(entry.get('window_start'), []).append(entry)
    for first, group in sorted(by_start.items(), key=lambda item: (item[0] or 0)):
        if not isinstance(first, int) or len(group) != 1:
            problems.append('%s: window %s has %d counter pairs'
                            % (pod, label(first), len(group)))
    given_total = accepted_total = 0
    for entry in entries:
        first = entry.get('window_start')
        given, accepted = entry.get('input'), entry.get('accepted')
        if entry.get('invalid') or not isinstance(given, int) or not isinstance(accepted, int):
            problems.append('%s: window %s %s'
                            % (pod, label(first),
                               entry.get('problem') or 'has no complete counter pair'))
            continue
        if accepted > given:
            problems.append('%s: window %s has input %d below accepted %d'
                            % (pod, label(first), given, accepted))
            continue
        given_total += given
        accepted_total += accepted
    processes = {}
    for entry in entries:
        if isinstance(entry.get('window_start'), int) and isinstance(entry.get('window_end'), int):
            processes.setdefault(min(entry.get('collector_starts') or {None}), []).append(entry)
    starts = {process for process in processes if process is not None}
    if len(starts) > 1:
        notes.append('%s: counter windows come from %d collector processes (%s); '
                     'each process is judged on its own windows'
                     % (pod, len(starts), ', '.join(sorted(label(value) for value in starts))))
    missing = set()
    for group in processes.values():
        low = min(entry['window_start'] for entry in group)
        high = max(entry['window_end'] for entry in group)
        for first in range(low, high, 6000):
            if first not in by_start:
                missing.add(first)
    if missing:
        notes.append('%s: %d window(s) without counters inside a collector process '
                     '(the collector read nothing of that pod then): %s'
                     % (pod, len(missing),
                        ', '.join(label(first) for first in sorted(missing))))
    if accepted_total != stored_lines:
        problems.append('%s: accepted total %d differs from %d stored line(s)'
                        % (pod, accepted_total, stored_lines))
    detail = ('%s: %d window(s), input %d, accepted %d, stored %d, discarded %d'
              % (pod, len(entries), given_total, accepted_total, stored_lines,
                 given_total - accepted_total))
    if problems:
        detail += '; ' + '; '.join(problems)
    return {'ok': not problems, 'pod': pod, 'windows': len(entries),
            'input': given_total, 'accepted': accepted_total,
            'stored': stored_lines, 'discarded': given_total - accepted_total,
            'notes': notes, 'detail': detail}


def throttle_counter_verdict(windows, stored):
    """Every task pod's own counter windows reconcile with its stored lines."""
    pods = sorted(set(stored) | {entry['pod'] for entry in windows})
    verdicts = {pod: throttle_pod_verdict(
        pod, [entry for entry in windows if entry['pod'] == pod],
        stored.get(pod, 0)) for pod in pods}
    return {'ok': bool(verdicts) and all(value['ok'] for value in verdicts.values()),
            'pods': verdicts,
            'notes': [note for value in verdicts.values() for note in value['notes']],
            'detail': '; '.join(value['detail'] for value in verdicts.values()) or 'no pods'}


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


def throttle_windows(records, task_pods):
    """Pair collector-only records by exact pod and aligned six-second window.

    Store fields are strings. Task normalization never promotes these fields and
    always sets untrusted, even for a pod labelled throttle-window. Missing or
    repeated counters stay unknown; a missing accepted sample is not zero. The
    windows are the collector's processing time, so no caller range is applied.
    """
    from logs_walk_support import parse_ms

    windows = {}

    def entry_for(record, first, last):
        key = (record['pod'], first, last)
        return windows.setdefault(key, {
            'pod': key[0], 'window_start': first, 'window_end': last,
            'input': None, 'accepted': None, 'collector_starts': set()})

    for record in records or []:
        if (record.get('module') != 'throttle-window'
                or record.get('namespace') != TASKS_NAMESPACE
                or record.get('pod') not in task_pods or 'untrusted' in record):
            continue
        kind = record.get('counter')
        first, last = (parse_ms(record.get(field))
                       for field in ('window_start', 'window_end'))
        stamp = parse_ms(record.get('_time'))
        if first is None or last is None or stamp is None:
            continue
        entry = entry_for(record, first, last)
        if first % 6000 != 0 or last - first != 6000:
            entry['invalid'] = True
            entry.setdefault('problem', 'is not one aligned six-second window')
            continue
        collector_start = parse_ms(record.get('collector_start'))
        if collector_start is not None:
            entry['collector_starts'].add(collector_start)
        raw = record.get('value')
        if collector_start is None:
            entry['invalid'] = True
            entry.setdefault('problem', 'has no collector process start')
        elif first < collector_start:
            entry['invalid'] = True
            entry.setdefault('problem', 'begins before its collector process started')
        elif kind not in ('input', 'accepted'):
            entry['invalid'] = True
            entry.setdefault('problem', 'has an unknown counter')
        elif isinstance(raw, bool) or not re.fullmatch(r'\d+', str(raw)):
            entry['invalid'] = True
            entry.setdefault('problem', 'has a non-numeric %s value' % kind)
        else:
            seen = entry.setdefault('seen', {})
            seen[kind] = seen.get(kind, 0) + 1
            if seen[kind] > 1:
                entry['invalid'] = True
                entry.setdefault('problem', 'has %d %s records' % (seen[kind], kind))
                entry[kind] = None
            else:
                entry[kind] = int(raw)
    for entry in windows.values():
        if len(entry['collector_starts']) > 1:
            entry['invalid'] = True
            entry.setdefault('problem', 'mixes %d collector processes'
                             % len(entry['collector_starts']))
    return list(windows.values())


def throttle_records(store, task_pods, start_ms, end_ms):
    """Read collector records directly: the loader intentionally hides internals."""
    from logs_walk_support import stamp

    pods = ' OR '.join('pod:=' + json.dumps(pod) for pod in sorted(task_pods))
    # Include the containing windows. Their timestamps can be emitted after the
    # writers finish; the pod's own first and last window bound the judgement.
    return store.query('module:"throttle-window" namespace:"lifemodel-motor" '
                       '(%s) _time:[%s, %s]' % (pods, stamp(start_ms - 6000), stamp(end_ms + 12000)))


def exact_stamp(milliseconds):
    """RFC 3339 with milliseconds, so the last fraction of a window is included."""
    return '%s.%03dZ' % (time.strftime('%Y-%m-%dT%H:%M:%S',
                                       time.gmtime(milliseconds / 1000)),
                         milliseconds % 1000)


def task_record_query(pod, run_id, first_ms, last_ms, module='task'):
    """The store query for one writer pod's own numbered lines."""
    return ('module:%s namespace:"lifemodel-motor" pod:=%s _msg:%s _time:[%s, %s]'
            % (json.dumps(module), json.dumps(pod), json.dumps(run_id),
               exact_stamp(first_ms), exact_stamp(last_ms)))


def stored_count(store, query):
    """A LogSQL count the store must answer with one numeric row."""
    rows = store.query(query + ' | stats count(*)')
    try:
        return int(rows[0]['count(*)'])
    except (IndexError, KeyError, TypeError, ValueError):
        raise WalkError('store_count_value') from None


def stored_task_lines(store, pod, run_id, first_ms, to_ms, module='task'):
    """How many of the pod's numbered lines the store holds for its run."""
    return stored_count(store, task_record_query(pod, run_id, first_ms, to_ms, module))


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


def plant_past_days(report, options, cluster, store, volume, state, run_id):
    """Write records on past days inside retention, so the evictor has a day to drop.

    The evictor never removes the current day; a store whose older days were
    already evicted gives it nothing. The walk creates the past days it depends
    on through the store's own insert path and verifies both partitions appear.
    A missing partition is TEST NOT VALID with the reason, never a pass.
    """
    flags = read_store_flags(report, options, cluster, 'the store\'s retention')
    if flags is None:
        return False
    retention = days_of(flags.get('retentionPeriod'))
    if retention is None:
        report.not_valid('the store\'s retention period was not read: past days cannot be '
                         'planted inside it')
        return False
    if retention < PAST_DAYS + 1:
        report.not_valid('the store\'s retention (%d day(s)) leaves fewer than %d past days '
                         'to plant' % (retention, PAST_DAYS))
        return False
    offset = 2 if retention >= PAST_DAYS + 2 else 1
    days = [day_of(now_ms() - (offset + index) * 86400 * 1000)
            for index in range(PAST_DAYS)]
    for day in days:
        moment = day_bounds(day)[0] + 12 * 3600 * 1000
        status, _lines = write_burst(store, moment, run_id, PLANT_RECORD_MIB, 'planted',
                                     module='walk-flood')
        if status not in (200, 204):
            report.not_valid('the store refused the planted records on %s (insert answered %s): '
                             'the evictor has no past day to drop' % (day, status))
            return False
    def appeared():
        present = set(volume.partitions())
        return all(day in present for day in days)

    if not wait_until(time.monotonic() + PLANT_BOUND_SECONDS, 2, appeared):
        missing = [day for day in days if day not in set(volume.partitions())]
        report.not_valid('the store did not create the planted past-day partition(s) %s: '
                         'the evictor has no past day to drop' % ', '.join(missing))
        return False
    state['planted_days'] = days
    report.pass_('the walk planted records on past days the evictor can drop',
                 '%s (retention %d day(s))' % (', '.join(days), retention))
    return True


def flood_case(report, options, loader, cluster, store, volume, state):
    """The flood with Postgres committing beside it on the shared filesystem."""
    if not prepare_flood(report, options, cluster, state):
        return False
    started = now_ms()
    evidence = FloodEvictorEvidence(cluster, options, volume, started)
    evidence.poll()
    if not plant_past_days(report, options, cluster, store, volume, state,
                          state['flood_run']):
        return False
    evidence.poll()
    baseline = accounting_snapshot(options, cluster)
    shared_before = shared_space()[1]
    device = loop_device(options.mount)
    report.note('baseline after all flood pods are Running and Postgres has committed; '
                'volume device %s, shared free %.2f GiB; Postgres data and container logs '
                'are measured, not a quota' % (device or 'unknown', shared_before / GIB))
    pod_before = store_pod(cluster, options)
    result = {'samples': [], 'statuses': [], 'started': started}
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


def pod_lifetime(cluster, namespace, name, module, run_id, tail=200000):
    """One writer pod's numbered lines' first and last write timestamps."""
    result = cluster.run(['-n', namespace, 'logs', name, '--timestamps',
                          '--tail=%d' % tail], timeout=120)
    if result.returncode != 0:
        return None
    stamps = [parse_ms(line.split(' ', 1)[0])
              for line in result.stdout.splitlines()
              if numbered(line, module, run_id)]
    stamps = [value for value in stamps if value is not None]
    return (min(stamps), max(stamps)) if stamps else None


def throttle_volume(options, state):
    """The two walk-owned throttle writers, each with its own run id."""
    entries = []
    for name, interval, size in THROTTLE_VOLUME:
        entries.append({'name': name, 'module': name, 'interval': interval,
                        'size': size, 'run_id': '%s-%d' % (name, now_ms())})
        state.setdefault('throttle_pods', []).append(name)
    return entries


def throttle_volume_manifests(options, volume, seconds):
    """The walk-owned writer pods, in the writer image and security context."""
    return [writer_manifest(options, TASKS_NAMESPACE, entry['name'], entry['module'],
                            entry['run_id'], seconds, entry['interval'], entry['size'])
            for entry in volume]


def start_throttle_volume(report, options, cluster, volume, seconds):
    """Create the walk's own throttled writers; never touch another pod there."""
    namespace = cluster.json(['get', 'namespace', TASKS_NAMESPACE, '-o', 'json']) or {}
    labels = (namespace.get('metadata') or {}).get('labels') or {}
    enforce = labels.get('pod-security.kubernetes.io/enforce', 'not set')
    policies = cluster.json(['-n', TASKS_NAMESPACE, 'get', 'networkpolicies',
                             '-o', 'json']) or {}
    report.note('the throttle volume is written by walk-owned pods %s in %s '
                '(pod-security enforce=%s, %d NetworkPolicy(ies)); the collector '
                'decides trust and throttling by namespace and pod, so they are '
                'throttled like a task pod and the walk controls their duration'
                % (', '.join(entry['name'] for entry in volume), TASKS_NAMESPACE,
                   enforce, len(policies.get('items') or [])))
    for entry in volume:
        if cluster.pod(TASKS_NAMESPACE, entry['name']) is not None:
            report.not_valid('throttle volume pod %s/%s already exists; the walk '
                             'refuses to replace a pod it did not create'
                             % (TASKS_NAMESPACE, entry['name']))
            return False
    for entry, manifest in zip(volume, throttle_volume_manifests(options, volume, seconds)):
        result = cluster.apply(manifest, namespace=TASKS_NAMESPACE)
        if result.returncode != 0:
            lines = (result.stderr or '').strip().splitlines()
            report.not_valid('the throttle volume pod %s/%s was refused: %s'
                             % (TASKS_NAMESPACE, entry['name'],
                                lines[0][:400] if lines else '(no message)'))
            return False
        if not wait_running(cluster, TASKS_NAMESPACE, entry['name']):
            report.not_valid('the throttle volume pod %s/%s did not become Running'
                             % (TASKS_NAMESPACE, entry['name']))
            pod_diagnostics(report, cluster, TASKS_NAMESPACE, entry['name'])
            return False
    return True


def throttle_case(report, options, loader, cluster, store, state):
    """A real task's lines arrive untrusted; walk-owned pods carry the volume."""
    from logs_task_writer import THROTTLE_SECONDS_MAX, TASK_WRITER_BOUND
    from logs_walk_support import stamp, start_task_writer

    seconds, launch_bound = options.throttle_seconds, TASK_WRITER_BOUND
    if not 1 <= seconds <= THROTTLE_SECONDS_MAX:
        report.not_valid('throttle_seconds must be 1..%d with the %d s launch allowance'
                         % (THROTTLE_SECONDS_MAX, TASK_WRITER_BOUND))
        return False
    # 1. One real agent task proves its collected lines arrive untrusted.
    real = start_task_writer(report, options, loader, cluster, state['task_fast'],
                             1000, seconds, bound=launch_bound)
    if real is None:
        return False
    # 2. The throttle volume itself is walk-owned, so the agent cannot end it
    # early; the trusted writer covers both volume writers from their launch.
    volume_seconds = seconds + 30
    trusted_manifest = writer_manifest(
        options, options.writer_namespace, 'walk-trusted-writer', TRUSTED_MODULE,
        state['trusted_run'], volume_seconds + 30, options.trusted_interval_ms)
    if not create_pod(report, cluster, trusted_manifest):
        return False
    if not wait_running(cluster, options.writer_namespace, 'walk-trusted-writer'):
        report.not_valid('the trusted writer did not become Running')
        return False
    volume = throttle_volume(options, state)
    if not start_throttle_volume(report, options, cluster, volume, volume_seconds):
        return False
    # The large writer's line is the largest the walk writes; a full page of
    # 1000 of them exceeds the loader's 16 MiB answer limit.
    page_limit = loader_page_limit(LARGE_TASK_LINE_BYTES)
    time.sleep(seconds + 2)
    # 3. All three walk-owned writers must overlap for the whole burst.
    required = seconds * 1000
    deadline = time.monotonic() + options.recover_bound
    intervals = []
    overlap = None
    writers = [('walk-trusted-writer', options.writer_namespace, TRUSTED_MODULE,
                state['trusted_run'])]
    writers += [(entry['name'], TASKS_NAMESPACE, entry['module'], entry['run_id'])
                for entry in volume]
    while time.monotonic() < deadline:
        intervals = []
        for name, namespace, module, run_id in writers:
            lifetime = pod_lifetime(cluster, namespace, name, module, run_id)
            if lifetime is None:
                intervals = []
                break
            intervals.append({'name': name, 'start': lifetime[0], 'end': lifetime[1]})
        if intervals:
            overlap = (min(entry['end'] for entry in intervals)
                       - max(entry['start'] for entry in intervals))
            if overlap >= required:
                break
        time.sleep(5)
    if overlap is None or overlap < required:
        late = max(intervals, key=lambda entry: entry['start']) if intervals else None
        report.not_valid(
            'the three writers overlap for %s ms by line timestamps, %s ms short of the '
            'required %d s; %s'
            % (overlap, required - overlap if overlap is not None else 'unknown', seconds,
               ('%s started last at %s' % (late['name'], stamp(late['start'])))
               if late else 'not every writer had a timestamped line'))
        return False
    report.pass_('all three writers overlap by line timestamps',
                 '%d ms common timestamp interval, at least %d s required'
                 % (overlap, seconds))
    for entry in volume:
        lifetime = pod_lifetime(cluster, TASKS_NAMESPACE, entry['name'],
                                entry['module'], entry['run_id'], tail=200)
        entry['first_ms'] = lifetime[0] if lifetime else None
    # 4. Each walk-owned volume pod reconciles its counters with its stored lines.
    task_info = {entry['name']: {'run_id': entry['run_id'], 'module': entry['module'],
                                 'first_ms': entry['first_ms']} for entry in volume}
    for name, info in task_info.items():
        if info['first_ms'] is None:
            report.not_valid('the walk-owned volume pod %s has no readable first line' % name)
            return False
    task_pods = set(task_info)
    first_bound = min(info['first_ms'] for info in task_info.values())
    counter = None
    deadline = time.monotonic() + options.recover_bound
    while time.monotonic() < deadline:
        records = throttle_records(store, task_pods, first_bound, now_ms())
        windows = throttle_windows(records, task_pods)
        stored = {pod: stored_task_lines(store, pod, info['run_id'],
                                         info['first_ms'], now_ms(), info['module'])
                  for pod, info in task_info.items()}
        counter = throttle_counter_verdict(windows, stored)
        if counter['ok']:
            break
        time.sleep(5)
    notes = counter.get('notes') if counter is not None else []
    for note in notes:
        report.note(note)
    if counter is None or not counter['ok']:
        report.not_valid('throttle-window counters do not reconcile for the walk-owned '
                         'volume pods: ' + (counter['detail'] if counter else 'no counter read'))
        return False
    report.pass_("each throttled pod's input and accepted counters reconcile",
                 counter['detail'])
    fast_name = volume[0]['name']
    fast_totals = counter['pods'][fast_name]
    throttled = fast_totals['accepted'] < fast_totals['input']
    report.check(throttled, 'the fast walk-owned writer actually crosses the throttle limit',
                 '%s: accepted %d of input %d in %d window(s); the limit is %d events '
                 'per second per pod'
                 % (fast_name, fast_totals['accepted'], fast_totals['input'],
                    fast_totals['windows'], THROTTLE_EVENTS))
    result = cluster.run(['-n', options.writer_namespace, 'logs', 'walk-trusted-writer',
                          '--timestamps', '--tail=200000'], timeout=120)
    written = numbered(result.stdout if result.returncode == 0 else '',
                       TRUSTED_MODULE, state['trusted_run'])
    if len(set(written)) < 2:
        report.not_valid('the trusted writer wrote fewer than two timestamped numbered lines')
        return False
    found = []
    deadline = time.monotonic() + options.recover_bound
    while time.monotonic() < deadline:
        records, status = loader_records(loader, {
            'from': str(state['throttle_start']), 'to': str(now_ms()),
            'module': TRUSTED_MODULE, 'text': state['trusted_run']}, page_limit)
        if records is None:
            report.not_valid('the loader refused the trusted writer page (HTTP %d)' % status)
            return False
        trusted_records = [record for record in records
                           if (record.get('fields') or {}).get('namespace') == options.writer_namespace
                           and (record.get('fields') or {}).get('pod') == 'walk-trusted-writer'
                           and (record.get('fields') or {}).get('untrusted') == 'false']
        found = numbered(json.dumps(trusted_records), TRUSTED_MODULE, state['trusted_run'])
        if set(written).issubset(found):
            break
        time.sleep(5)
    trusted = trusted_verdict(written, found)
    report.check(trusted['ok'], 'the trusted writer loses no line under the throttle',
                 trusted['detail'])
    return counter['ok'] and throttled and trusted['ok']


def restore_pod_deletions(cluster, options):
    """Delete only the pods the walk created, by their exact names."""
    deleted = []
    for namespace, names in ((options.writer_namespace, ['walk-trusted-writer', 'walk-flood-trusted']),
                             (options.shared_namespace, ['walk-flood-pg']),
                             (TASKS_NAMESPACE, [name for name, _, _ in THROTTLE_VOLUME])):
        for name in names:
            result = cluster.run(['-n', namespace, 'delete', 'pod', name,
                                  '--ignore-not-found', '--wait=false'])
            deleted.append((namespace, name, result.returncode == 0))
    return deleted


def restore(report, options, loader, cluster, volume, state):
    """Delete the walk's pods and namespaces and its shared directory, report space."""
    restored = True
    for namespace, name, ok in restore_pod_deletions(cluster, options):
        restored = restored and ok
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
    planted = state.get('planted_days') or []
    print('RESTORE pods and namespaces deleted=%s, %s removed, %.2f GiB free on %s, '
          '%.2f GiB free on the shared filesystem, store %s; planted past days: %s '
          '(the evictor may have dropped them)'
          % (str(bool(state.get('namespaces'))).lower(), options.shared_path,
             avail / GIB, options.mount, shared_avail / GIB, options.store,
             ', '.join(planted) if planted else 'none'))
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
    if options.writer_namespace != 'lifemodel-system':
        report.not_valid('the trusted writer must use the known trusted lifemodel-system namespace')
        return False
    if cluster.json(['get', 'namespace', options.writer_namespace, '-o', 'json']) is None:
        report.not_valid('the trusted writer namespace lifemodel-system is not installed')
        return False
    if not ensure_namespace(report, cluster, options.shared_namespace, state):
        return False
    if not ensure_namespace(report, cluster, TASKS_NAMESPACE, state):
        # The task namespace is the platform's own; a failed create means it exists.
        state['namespaces'] = [name for name in state['namespaces'] if name != TASKS_NAMESPACE]
    state['flood_run'] = 'walk-flood-%d' % now_ms()
    state['trusted_run'] = 'walk-trusted-%d' % now_ms()
    state['task_fast'] = 'walk-task-fast-%d' % now_ms()
    state['throttle_start'] = now_ms()
    if not flood_case(report, options, loader, cluster, store, volume, state):
        return False
    throttle_case(report, options, loader, cluster, store, state)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-VOLUME-FLOOD (ADR-016 L05)')
    common_arguments(parser)
    parser.add_argument('--writer-image', default=None,
                        help='Node writer image; by default use the deployed logs-evictor image')
    parser.add_argument('--writer-namespace', default='lifemodel-system')
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
    parser.add_argument('--throttle-seconds', type=int, default=60)
    parser.add_argument('--trusted-interval-ms', type=int, default=20)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    volume = Volume(options.mount, options.pv_path)
    state = {'namespaces': [], 'store_ready': None, 'planted_days': []}
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
