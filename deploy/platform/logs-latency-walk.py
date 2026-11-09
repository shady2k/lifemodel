#!/usr/bin/env python3
"""WALK-LOGS-LATENCY: paging is total and the page's queries are inside its
deadline (ADR-016 L15, §4).

What it proves
--------------
1. Forty queries per filter — a time window, `module`, `level`,
   `conversation_id` and a text search — with the page's real form (the same
   field filters the loader builds, 100-record pages, a window that steps back a
   minute per query). The walk prints p50, p95 and max for each filter, quiet and
   again with an ingest writing into the store, and fails when a p95 reaches
   2.5 s. The numbers are printed so a reviewer can see how far from the
   deadline they are, not only whether they passed.
2. Paging through the API at 250 records per page over a window the walk wrote
   itself: 1,000 numbered records at one timestamp and 300 byte-identical lines
   at another. Every numbered record appears exactly once, nothing is repeated,
   the identical group's rows are all accounted for, every page reports a stable
   window (`incomplete: false`), and the same page fetched twice returns the
   same bytes.

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
  --query-count N        queries per filter (default 40)
  --limit-ms N           the page's deadline for a p95, in milliseconds (default 2500)
  --window-minutes N     the time window each query asks for (default 60)
  --ingest-mib-per-s N   the ingest's payload per second while the second round
                         runs (default 20)
  --same-time-records N  numbered records written at one timestamp (default 1000)
  --identical-records N  byte-identical lines written at another timestamp (default 300)
  --page-limit N         records per page in the paging check (default 250)
  --paging-minutes-back N  how far back the paging window is written (default 3)
  --deadline-seconds N   the whole walk's bound (default 1800)

What it changes and restores
----------------------------
It writes records through the store's insert protocol — the paging fixture, a
short ingest while the second round of queries runs, and nothing else — and in
the `finally` stops the ingest, closes the port-forward and removes its own day
partitions if any are not today's (after the store detaches them; the partition
key is read into a variable and never printed). Today's records stay: they are
logs. The setting and the CronJob are untouched, and the RESTORE line says
which days, if any, were removed.

What it does not cover
----------------------
The measured figures of the prototype (81-176 ms at 5.38 GB) are not reproduced:
this walk measures whatever the instance holds when it runs, which is the point.
The identical-lines help text and the cursor protocol's `incomplete` wording are
the page's, asserted on the drawn page by `logs-page-walk.mjs`; here the answer's
`incomplete` flag is asserted. `tests/integration/logs-paging.test.ts` holds the
adapter's own paging contract against a fixture, so this walk does not repeat the
5,000-record case at scale.

Exit status is non-zero when any assertion failed or a state was never reached.
"""
import argparse
import base64
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

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
    read_password,
    stamp,
    wait_until,
)

MIB = 1024 * 1024
MODULE = 'walk-latency'
RECORD_PAYLOAD_BYTES = 384
IDENTITY = re.compile(r'walk-latency (\S+) seq=(\d+)')
PARTITION_KEY_SECRET = 'lifemodel-logs-partition-key'


def percentile(values, fraction):
    """The fraction-th percentile with linear interpolation, as a page's numbers are read."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def summarise(samples):
    return {
        'count': len(samples),
        'p50': percentile(samples, 0.5),
        'p95': percentile(samples, 0.95),
        'max': max(samples) if samples else None,
    }


def measure(loader, params):
    """One page query with the page's own form; its wall time in milliseconds."""
    started = time.monotonic()
    answer = loader.logs(params)
    elapsed = (time.monotonic() - started) * 1000.0
    if answer is None or answer.get('state') != 'ok':
        return None
    return elapsed


def run_filter_round(report, loader, label, filters, count, limit_ms, window_minutes=60):
    """One round of queries per filter; p50/p95 printed, FAIL at the deadline."""
    ok = True
    for name, base in filters:
        samples = []
        for index in range(count):
            to = now_ms() - index * 60_000
            params = dict(base)
            params.update({'from': str(to - window_minutes * 60_000), 'to': str(to),
                           'limit': '100'})
            elapsed = measure(loader, params)
            if elapsed is None:
                samples = None
                break
            samples.append(elapsed)
        if samples is None:
            report.not_valid('the %s filter did not answer: its latency cannot be measured (%s)'
                             % (name, label))
            ok = False
            continue
        stats = summarise(samples)
        print('NOTE %s round, %s filter: p50 %.0f ms, p95 %.0f ms, max %.0f ms over %d queries'
              % (label, name, stats['p50'], stats['p95'], stats['max'], stats['count']))
        ok = report.check(
            stats['p95'] < limit_ms,
            'the %s filter stays inside the page\'s deadline %s' % (name, label),
            'p50 %.0f ms, p95 %.0f ms, max %.0f ms over %d queries'
            % (stats['p50'], stats['p95'], stats['max'], stats['count']),
        ) and ok
    return ok


def filters_from(report, loader):
    """The values the real records offer, so each filter measures a query the page makes."""
    answer = loader.logs({'from': str(now_ms() - 3600_000), 'to': str(now_ms()), 'limit': '200'})
    if answer is None or answer.get('state') != 'ok' or not (answer.get('records') or []):
        report.not_valid('the last hour holds no record: no filter value can be chosen')
        return None
    records = answer['records']
    module = None
    level = None
    conversation = None
    text = None
    for record in records:
        fields = record.get('fields') or {}
        if module is None and isinstance(fields.get('module'), str):
            module = fields['module']
        if level is None and isinstance(fields.get('level'), str) and fields['level'] != 'unknown':
            level = fields['level']
        if conversation is None and isinstance(fields.get('conversation_id'), str):
            conversation = fields['conversation_id']
        if text is None:
            for word in re.findall(r'[A-Za-z][A-Za-z0-9_-]{3,}', record.get('message') or ''):
                text = word
                break
        if all(value is not None for value in (module, level, conversation, text)):
            break
    filters = [('time', {})]
    if module:
        filters.append(('module', {'module': module}))
    else:
        report.not_valid('no record names a module: the module filter cannot be measured')
    if level:
        filters.append(('level', {'level': level}))
    else:
        report.not_valid('no record names a level: the level filter cannot be measured')
    if conversation:
        filters.append(('conversation', {'conversation_id': conversation}))
    else:
        report.not_valid('no record carries a conversation id: the conversation filter cannot be '
                         'measured')
    if text:
        filters.append(('text', {'text': text}))
    else:
        report.not_valid('no record holds a word to search: the text filter cannot be measured')
    report.note('the filters measure module=%s level=%s conversation=%s text=%s'
                % (module, level, conversation, text))
    return filters


def latency_batch(count, moment_ms, run_id):
    moment = stamp(moment_ms)
    lines = []
    for sequence in range(count):
        lines.append({
            'timestamp': moment,
            'message': '%s ingest %06d %s' % (run_id, sequence,
                                              base64.b64encode(os.urandom(RECORD_PAYLOAD_BYTES))
                                              .decode('ascii')),
            'module': MODULE,
            'namespace': 'walk',
            'pod': 'walk-latency',
            'container': 'walk',
            'stream': 'stdout',
            'level': 'info',
            'untrusted': False,
        })
    return lines


def start_ingest(store, run_id, mib_per_s):
    """Write `mib_per_s` MiB a second while the second round runs; returns stop + thread."""
    stop = threading.Event()

    def loop():
        per_line = RECORD_PAYLOAD_BYTES + 220
        per_burst = max(1, int(mib_per_s * MIB) // 10 // per_line)
        while not stop.is_set():
            started = time.monotonic()
            for _ in range(10):
                try:
                    store.insert(latency_batch(per_burst, now_ms(), run_id))
                except WalkError:
                    break
                if stop.is_set():
                    break
            elapsed = time.monotonic() - started
            if elapsed < 1.0:
                stop.wait(1.0 - elapsed)

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return stop, thread


def write_paging_fixture(report, store, moment_ms, numbered, identical, run_id):
    """1,000 numbered records at one timestamp, 300 identical lines at another."""
    moment = stamp(moment_ms)
    other = stamp(moment_ms + 1000)
    written = 0
    for start in range(0, numbered, 2000):
        lines = [{
            'timestamp': moment,
            'message': '%s seq=%06d' % (run_id, sequence),
            'module': MODULE,
            'namespace': 'walk',
            'pod': 'walk-latency',
            'container': 'walk',
            'stream': 'stdout',
            'level': 'info',
            'untrusted': False,
        } for sequence in range(start, min(start + 2000, numbered))]
        status, _body = store.insert(lines)
        if status not in (200, 204):
            report.fail('the paging fixture is written', 'insert answered %d' % status)
            return False
        written += len(lines)
    lines = [{
        'timestamp': other,
        'message': '%s identical' % run_id,
        'module': MODULE,
        'namespace': 'walk',
        'pod': 'walk-latency',
        'container': 'walk',
        'stream': 'stdout',
        'level': 'info',
        'untrusted': False,
    } for _ in range(identical)]
    status, _body = store.insert(lines)
    if status not in (200, 204):
        report.fail('the byte-identical lines are written', 'insert answered %d' % status)
        return False
    return written > 0


def load_pages(loader, params, limit):
    """Every page of a window at `limit` per page, with the first page's count."""
    first = loader.logs(dict(params, offset='0', limit=str(limit)))
    if first is None or first.get('state') != 'ok':
        return None
    count = first.get('count')
    if not isinstance(count, int):
        return None
    records = list(first.get('records') or [])
    incomplete = bool(first.get('incomplete'))
    pages = 1
    offset = limit
    while offset < count and pages < 200:
        answer = loader.logs(dict(params, offset=str(offset), limit=str(limit),
                                 expected=str(count)))
        if answer is None or answer.get('state') != 'ok':
            return None
        records.extend(answer.get('records') or [])
        incomplete = incomplete or bool(answer.get('incomplete'))
        pages += 1
        offset += limit
    return {'records': records, 'count': count, 'pages': pages, 'incomplete': incomplete}


def raw_page(loader, params):
    status, data = loader.request('GET', '/api/logs?' + urlencode(params))
    return status, data


def check_paging(report, loader, params, limit, numbered, identical):
    """Total paging, no repetition, a stable window and the same page twice."""
    loaded = load_pages(loader, params, limit)
    if loaded is None:
        report.not_valid('the paging window did not answer: paging cannot be asserted')
        return False
    expected = numbered + identical
    if loaded['count'] != expected:
        report.not_valid('the window holds %s records, %d were written: paging cannot be judged'
                         % (loaded['count'], expected))
        return False
    sequences = []
    identical_rows = 0
    for record in loaded['records']:
        match = IDENTITY.search(record.get('message') or '')
        if match and match.group(1) == params.get('text', ''):
            sequences.append(int(match.group(2)))
        elif (record.get('message') or '').endswith('identical'):
            identical_rows += 1
    report.check(len(loaded['records']) == loaded['count'],
                 'paging at %d per page is total' % limit,
                 '%d rows in %d page(s) for a window count of %d'
                 % (len(loaded['records']), loaded['pages'], loaded['count']))
    report.check(len(sequences) == len(set(sequences)),
                 'no numbered record appears twice across the pages',
                 '%d numbered rows read, %d distinct' % (len(sequences), len(set(sequences))))
    report.check(sorted(sequences) == list(range(1, numbered + 1)),
                 'every numbered record appears exactly once',
                 '%d of %d found' % (len(set(sequences)), numbered))
    report.check(identical_rows == identical,
                 'every byte-identical line is accounted for',
                 '%d of %d rows' % (identical_rows, identical))
    report.check(not loaded['incomplete'],
                 'every page reports a stable window (incomplete: false)',
                 'no records arrived while the pages were read')
    first = raw_page(loader, dict(params, offset='0', limit=str(limit)))
    second = raw_page(loader, dict(params, offset='0', limit=str(limit)))
    report.check(first == second, 'the same page fetched twice returns the same bytes',
                 'page 1 at %d per page' % limit)
    return True


def run(report, options, loader, store, state):
    filters = filters_from(report, loader)
    if filters is None:
        return False
    run_filter_round(report, loader, 'quiet', filters, options.query_count, options.limit_ms,
                     options.window_minutes)
    stop, thread = start_ingest(store, state['run_id'], options.ingest_mib_per_s)
    try:
        run_filter_round(report, loader, 'with ingest running', filters, options.query_count,
                         options.limit_ms, options.window_minutes)
    finally:
        stop.set()
        thread.join(timeout=30)
    moment = now_ms() - options.paging_minutes_back * 60_000
    if not write_paging_fixture(report, store, moment, options.same_time_records,
                                options.identical_records, state['run_id']):
        report.not_valid('the paging fixture was not written: paging cannot be asserted')
        return False
    state['written_day'] = day_of(moment)
    params = {'from': str(moment - 5_000), 'to': str(moment + 5_000), 'module': MODULE,
              'text': state['run_id']}
    appeared = wait_until(
        time.monotonic() + 180, 3,
        lambda: (lambda answer: answer is not None and answer.get('count') ==
                 options.same_time_records + options.identical_records)(
                     loader.logs(dict(params, limit='1'))),
    )
    if not appeared:
        report.not_valid('the paging fixture\'s records never all arrived: paging cannot be judged')
        return False
    report.pass_('the paging fixture is stored', '%d numbered rows and %d identical rows'
                 % (options.same_time_records, options.identical_records))
    return check_paging(report, loader, params, options.page_limit,
                        options.same_time_records, options.identical_records)


def restore(report, options, cluster, store, state):
    """Nothing but the walk's own non-today days is changed; say what remains."""
    removed = []
    failed = []
    day = state.get('written_day')
    if day and day != day_of(now_ms()) and store is not None:
        try:
            volume_days = state.get('volume_days', lambda: [])()
            if day in volume_days:
                key = state.get('key')
                if key is None:
                    key = cluster.secret_value(options.namespace, PARTITION_KEY_SECRET,
                                               'partition-key')
                    state['key'] = key
                status, _body = store.detach(day, key)
                if status == 200 and state.get('remove_day') is not None:
                    state['remove_day'](day)
                    removed.append(day)
                else:
                    failed.append(day)
        except (WalkError, OSError):
            failed.append(day)
    print('RESTORE ingest stopped, port-forward closed; removed the walk\'s own day(s) %s; '
          'today\'s records stay' % (', '.join(removed) if removed else 'none'))
    if failed:
        print('RESTORE incomplete: these walk days could not be removed: %s'
              % ', '.join(failed))


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-LATENCY (ADR-016 L15)')
    common_arguments(parser)
    parser.add_argument('--query-count', type=int, default=40)
    parser.add_argument('--limit-ms', type=int, default=2500)
    parser.add_argument('--window-minutes', type=int, default=60)
    parser.add_argument('--ingest-mib-per-s', type=int, default=20)
    parser.add_argument('--same-time-records', type=int, default=1000)
    parser.add_argument('--identical-records', type=int, default=300)
    parser.add_argument('--page-limit', type=int, default=250)
    parser.add_argument('--paging-minutes-back', type=int, default=3)
    options = parser.parse_args(argv)

    from logs_walk_support import Volume

    report = Report()
    cluster = Cluster(options.kubectl)
    volume = Volume(options.mount, options.pv_path)
    state = {'run_id': 'walk-latency-%d' % now_ms()}
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
        state['volume_days'] = volume.partitions
        state['remove_day'] = volume.remove_day
        run(report, options, loader, store, state)
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        restore(report, options, cluster, store, state)
        if forwarding is not None:
            forwarding.close()
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
