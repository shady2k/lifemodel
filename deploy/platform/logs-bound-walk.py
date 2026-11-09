#!/usr/bin/env python3
"""WALK-LOGS-BOUND: the retention bounds and the two ways they act (ADR-016 L06, §5).

What it proves
--------------
1. A byte bound above `volume − evictor threshold` is refused with both numbers:
   the bound asked for, and the largest bound the volume can ever reach, with the
   volume and the threshold it came from. The API also states the same
   relationship the loader computes (`largestMaxBytes == volumeBytes −
   evictorThresholdBytes`), so a reviewer can check the arithmetic from the
   walk's own output. The largest bound that fits, and one MiB below it, are
   accepted.
2. Under a 300 MiB byte bound (and the age bound left at 14 days so that only
   the byte bound can act), the store drops the oldest day partitions first: a
   200-record canary written 10 days back is gone, the flood days written 2 to 9
   days back are gone or going, and today's records — protected by the store's
   own two-newest-day floor — are all still found. The walk reads the day
   partitions on the volume before and after and prints which days went, so the
   "oldest first" order is visible and not only inferred.
3. A separate case with only the age bound shortened (1 day, the byte bound left
   at 300 MiB and no byte pressure) drops the old day and nothing younger than
   the age deadline; today's records stay.
4. Every record the walk writes carries one run id in its message, so each count
   it reads through the API counts only its own lines. Records are written
   through the store's own `/insert/jsonline` protocol with `_time_field`, so
   their event time is the day the walk asks for, not the receipt time.

The two-day floor above the byte bound (a bound is a floor on partitions, and the
volume — not the bound — is what a flood reaches) is L16's case, not this walk's:
here the point is which day goes first and that the bound is refused when it
could never act.

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
  --byte-bound-mib N     the byte bound the retention cases set (default 300)
  --days-case N          the age bound kept during the byte-bound case, so only
                         the byte bound can act (default 14)
  --canary-days-back N   how far back the canary is written (default 10)
  --canary-records N     how many canary records (default 200)
  --today-mib N          today's records, in MiB of incompressible payload (default 24)
  --old-day-mib N        each flood day's payload (default 40)
  --old-days N           how many flood days, 2 to N+1 days back (default 8)
  --age-days N           the shortened age bound of the separate case (default 1)
  --age-old-days-back N  the old day the age case writes and expects dropped (default 3)
  --largest-max-bytes N  the largest byte bound, when the walk should not read it
                         from the API's limits
  --retention-bound N    bound on the store acting on a bound (default 600 s)
  --apply-bound N        bound on a change reaching `applied` (default 180 s)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
The retention setting: the walk sets the 300 MiB bound with a 14-day age bound,
then 1 day with the same byte bound, and puts the setting it found back in the
`finally`, waiting for `applied` there too. It writes records through the
store's insert protocol into days it computes from the run id, and in the
`finally` removes its own day partitions — never today's — after the store has
detached each one (the partition key is read into a variable and never printed),
and prints a RESTORE line naming the days removed and that today's records stay.

What it does not cover
----------------------
The two-day floor as a proportion of the volume (the 300 MiB bound reaching
444 MiB) is L16's measurement: this walk asserts today survives the byte bound,
not how far above the bound the floor lets usage reach. The admission of the
setting and the first-install defaults are repository tests (L08's rendered
manifests). The age case shortens the stored days to 1, which deletes every
stored day older than one day, including real logs the instance holds: run it on
a test instance, and expect the days it drops not to come back.

Exit status is non-zero when any assertion failed or a state was never reached.
"""
import argparse
import base64
import os
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
    day_bounds,
    day_of,
    days_of,
    now_ms,
    quantity,
    read_password,
    read_store_flags,
    stamp,
    wait_until,
)

MIB = 1024 * 1024
RUN_MODULE = 'walk-bound'
RECORD_PAYLOAD_BYTES = 384
BATCH_LINES = 2000
DETACH_NAMESPACE = 'lifemodel-system'
PARTITION_KEY_SECRET = 'lifemodel-logs-partition-key'


def settings_answer(loader):
    answer = loader.settings()
    return answer if isinstance(answer, dict) and answer.get('state') == 'ok' else None


def wait_applied(loader, bound_seconds):
    def attempt():
        answer = settings_answer(loader)
        return answer if answer is not None and answer.get('applied') is True else None

    return bool(wait_until(time.monotonic() + bound_seconds, 2, attempt))


def set_retention(report, loader, days, max_bytes, bound_seconds):
    """One change through the page's route, then wait for the store to run it."""
    status, answer = loader.put_settings(days, max_bytes, loader.csrf())
    if status != 200 or answer.get('state') != 'ok':
        report.fail('the setting %d days / %d MiB is accepted' % (days, max_bytes // MIB),
                    'PUT answered %d, state %s' % (status, answer.get('state', 'unreadable')))
        return False
    if not wait_applied(loader, bound_seconds):
        report.fail('the setting %d days / %d MiB is applied' % (days, max_bytes // MIB),
                    'not applied within %d s' % bound_seconds)
        return False
    report.pass_('the setting %d days / %d MiB is applied' % (days, max_bytes // MIB),
                 'desiredRevision %s' % answer.get('desiredRevision'))
    return True


def check_limits(report, limits):
    volume = limits.get('volumeBytes')
    threshold = limits.get('evictorThresholdBytes')
    largest = limits.get('largestMaxBytes')
    if not all(isinstance(value, int) for value in (volume, threshold, largest)):
        report.not_valid('the API did not state the volume\'s capacity and the evictor threshold')
        return False
    return report.check(
        largest == volume - threshold,
        'the largest bound the API states is volume minus the evictor threshold',
        'volume %.2f GiB, threshold %.1f MiB, largest %.1f MiB'
        % (volume / 1024**3, threshold / MIB, largest / MIB),
    )


def check_refusals(report, options, loader, days, limits):
    """The refused bound and the two accepted ones (ADR-016 §5)."""
    largest = limits['largestMaxBytes']
    extra = options.largest_extra_bytes
    status, answer = loader.put_settings(days, largest + extra, loader.csrf())
    refused = (
        status == 400
        and answer.get('state') == 'refused'
        and answer.get('reason') == 'above_volume'
        and answer.get('maxBytes') == largest + extra
        and answer.get('largestMaxBytes') == largest
        and answer.get('volumeBytes') == limits['volumeBytes']
        and answer.get('evictorThresholdBytes') == limits['evictorThresholdBytes']
    )
    report.check(
        refused,
        'a bound above volume minus the evictor threshold is refused with both numbers',
        'asked %d bytes (%.2f MiB plus %d), largest %.2f MiB (volume %.2f GiB minus a %.1f MiB '
        'threshold); answered %d, state %s'
        % (largest + extra, largest / MIB, extra, largest / MIB,
           limits['volumeBytes'] / 1024**3, limits['evictorThresholdBytes'] / MIB,
           status, answer.get('state', 'unreadable')),
    )
    for value, name in (
        (largest, 'the largest bound that fits is accepted'),
        (largest - MIB, 'a bound one MiB below the largest is accepted'),
    ):
        status, answer = loader.put_settings(days, value, loader.csrf())
        report.check(status == 200 and answer.get('state') == 'ok', name,
                     '%.2f MiB answered %d' % (value / MIB, status))
    return refused


def check_bound_flags(report, options, cluster, days, max_bytes):
    """The store's own flags run the bound the walk asked for, or the case is void."""
    flags = read_store_flags(report, options, cluster,
                             'the byte bound the store runs')
    if flags is None:
        return False
    observed_days = days_of(flags.get('retentionPeriod'))
    observed_bytes = quantity(flags.get('retention.maxDiskSpaceUsageBytes'))
    return report.check(
        observed_days == days and observed_bytes == max_bytes,
        'the store runs the byte bound the walk set',
        '-retentionPeriod="%s" -retention.maxDiskSpaceUsageBytes="%s"'
        % (flags.get('retentionPeriod'), flags.get('retention.maxDiskSpaceUsageBytes')),
    )


def payload():
    return base64.b64encode(os.urandom(RECORD_PAYLOAD_BYTES)).decode('ascii')


def records(records_wanted, moment_ms, run_id, kind):
    moment = stamp(moment_ms)
    for sequence in range(records_wanted):
        yield {
            'timestamp': moment,
            'message': '%s %s %06d %s' % (run_id, kind, sequence, payload()),
            'module': RUN_MODULE,
            'namespace': 'walk',
            'pod': 'walk-bound',
            'container': 'walk',
            'stream': 'stdout',
            'level': 'info',
            'untrusted': False,
        }


def write_records(store, moment_ms, mib, run_id, kind):
    """Write one day's records through the store's own sink; return the count."""
    total = int(mib * MIB)
    per_line = RECORD_PAYLOAD_BYTES + 220
    wanted = max(1, total // per_line)
    written = 0
    while written < wanted:
        batch = list(records(min(BATCH_LINES, wanted - written), moment_ms, run_id,
                             '%s-%06d' % (kind, written)))
        status, _body = store.insert(batch)
        if status not in (200, 204):
            raise WalkError('insert_%d' % status)
        written += len(batch)
    return written


def write_canary(store, moment_ms, run_id, count):
    batch = list(records(count, moment_ms, run_id, 'canary'))
    status, _body = store.insert(batch)
    if status not in (200, 204):
        raise WalkError('insert_%d' % status)
    return count


def records_in_window(loader, moment_ms, run_id):
    """The API's own count for one day of the walk's records, or None."""
    start, end = day_bounds(day_of(moment_ms))
    answer = loader.logs({'from': str(start), 'to': str(end), 'module': RUN_MODULE,
                          'text': run_id, 'limit': '1'})
    if answer is None or answer.get('state') != 'ok':
        return None
    count = answer.get('count')
    return count if isinstance(count, int) else None


def require_records(report, loader, moment_ms, run_id, expected, name):
    """The records are in the store before any retention result is judged."""
    count = records_in_window(loader, moment_ms, run_id)
    if count is None:
        report.not_valid('%s: the API did not answer its count' % name)
        return None
    if count < expected:
        report.not_valid('%s: only %d of %d records were stored, so a deletion cannot be told '
                         'from a write that never landed' % (name, count, expected))
        return None
    report.pass_(name, '%d records of the run stored in that day' % count)
    return count


def wait_records_gone(loader, moment_ms, run_id, bound_seconds):
    """Wait until no record of the run is in that day; True when it went."""
    def attempt():
        return records_in_window(loader, moment_ms, run_id) == 0

    return bool(wait_until(time.monotonic() + bound_seconds, 10, attempt))


def only_older_days_removed(before, after, deadline_day):
    """Which days went, and whether any of them was younger than the deadline.

    Day names are `YYYYMMDD`, so the comparison is the same string order the
    store's partition names have.
    """
    removed = sorted(set(before) - set(after))
    younger = [day for day in removed if day > deadline_day]
    return {'dropped': removed, 'olderOnly': not younger, 'youngerRemoved': bool(younger)}


def read_partition_key(cluster, state):
    """The key, held in memory only; the store's detach needs it as `authKey`."""
    if 'key' not in state:
        try:
            state['key'] = cluster.secret_value(DETACH_NAMESPACE, PARTITION_KEY_SECRET,
                                                'partition-key')
        except WalkError:
            state['key'] = ''
    return state['key']


def byte_case(report, options, loader, cluster, store, volume, run_id, state):
    """The byte bound drops the oldest day partitions first."""
    byte_bound = options.byte_bound_mib * MIB
    if not set_retention(report, loader, options.days_case, byte_bound, options.apply_bound):
        report.not_valid('the store does not run the byte bound: the retention case is void')
        return False
    if not check_bound_flags(report, options, cluster, options.days_case, byte_bound):
        report.not_valid('the store\'s flags do not hold the byte bound: the retention case is void')
        return False
    now = now_ms()
    canary_moment = now - options.canary_days_back * 86400 * 1000
    try:
        write_canary(store, canary_moment, run_id, options.canary_records)
        today_written = write_records(store, now, options.today_mib, run_id, 'today')
        flood = []
        for back in range(2, 2 + options.old_days):
            moment = now - back * 86400 * 1000
            write_records(store, moment, options.old_day_mib, run_id, 'old')
            flood.append(moment)
    except WalkError as error:
        report.fail('the walk\'s records are written through the store\'s sink', str(error))
        report.not_valid('the flood could not be written: no retention result to assert')
        return False
    state['written_days'].add(day_of(canary_moment))
    state['written_days'].update(day_of(moment) for moment in flood)
    if require_records(report, loader, canary_moment, run_id, options.canary_records,
                       'the canary 10 days back is stored before the flood') is None:
        return False
    if require_records(report, loader, now, run_id, today_written,
                       'today\'s records are stored before the flood') is None:
        return False
    for moment in flood:
        if require_records(report, loader, moment, run_id, 1,
                           'the flood day %s is stored' % day_of(moment)) is None:
            return False

    before = volume.partitions()
    report.note('day partitions before the byte bound acts: %s' % ', '.join(before))
    gone = wait_records_gone(loader, canary_moment, run_id, options.retention_bound)
    report.check(gone, 'the oldest day partition is dropped first: the canary 10 days back is gone',
                 'day %s, within %d s' % (day_of(canary_moment), options.retention_bound))
    today_count = records_in_window(loader, now, run_id)
    report.check(today_count == today_written, 'today\'s records are kept under the byte bound',
                 '%s of %d found' % (today_count, today_written))
    after = volume.partitions()
    report.note('day partitions after the byte bound acted: %s' % ', '.join(after))
    dropped = sorted(set(before) - set(after))
    report.check(day_of(canary_moment) in dropped or not gone,
                 'the canary\'s day is one of the partitions the store removed',
                 'removed: %s' % (', '.join(dropped) if dropped else 'none seen'))
    return gone


def age_case(report, options, loader, cluster, store, volume, run_id, state):
    """Only the age bound shortened: the old day goes, nothing younger does.

    The byte bound is first raised to the largest bound that fits, so no byte
    pressure can act and the day is dropped by the age bound alone; the old day
    is written while the 14-day bound still accepts it, and only then is the age
    bound shortened to --age-days.
    """
    largest = options.largest_max_bytes
    if largest is None:
        limits = (settings_answer(loader) or {}).get('limits') or {}
        largest = limits.get('largestMaxBytes')
    if not isinstance(largest, int):
        report.not_valid('the largest byte bound is unknown: the age case cannot be isolated')
        return False
    if not set_retention(report, loader, options.days_case, largest, options.apply_bound):
        report.not_valid('the store does not take the raised byte bound: the age case is void')
        return False
    if not check_bound_flags(report, options, cluster, options.days_case, largest):
        report.not_valid('the store\'s flags do not hold the raised byte bound: the case is void')
        return False
    now = now_ms()
    old_moment = now - options.age_old_days_back * 86400 * 1000
    try:
        wanted = write_records(store, old_moment, options.old_day_mib, run_id, 'age-old')
    except WalkError as error:
        report.fail('the age case\'s old day is written', str(error))
        report.not_valid('the old day could not be written: no age result to assert')
        return False
    state['written_days'].add(day_of(old_moment))
    if require_records(report, loader, old_moment, run_id, wanted,
                       'the old day is stored before the age bound is judged') is None:
        return False
    if not set_retention(report, loader, options.age_days, largest, options.apply_bound):
        report.not_valid('the store does not run the shortened age bound: the case is void')
        return False
    if not check_bound_flags(report, options, cluster, options.age_days, largest):
        report.not_valid('the store\'s flags do not hold the age bound: the case is void')
        return False
    today_before = records_in_window(loader, now, run_id)
    before = volume.partitions()
    gone = wait_records_gone(loader, old_moment, run_id, options.retention_bound)
    report.check(gone, 'the age bound drops the old day without byte pressure',
                 'day %s, within %d s' % (day_of(old_moment), options.retention_bound))
    after = volume.partitions()
    deadline_day = day_of(now_ms() - options.age_days * 86400 * 1000)
    result = only_older_days_removed(before, after, deadline_day)
    report.note('age case removed days: %s (deadline day %s)'
                % (', '.join(result['dropped']) if result['dropped'] else 'none', deadline_day))
    report.check(result['olderOnly'], 'the age bound drops nothing younger than its deadline',
                 'removed %s, deadline day %s'
                 % (', '.join(result['dropped']) or 'none', deadline_day))
    report.check(records_in_window(loader, now, run_id) == today_before,
                 'today\'s records are kept when only the age bound changes',
                 '%s of %s found' % (records_in_window(loader, now, run_id), today_before))
    return gone


def run(report, options, loader, cluster, store, volume, state):
    found = settings_answer(loader)
    if found is None:
        report.not_valid('GET /api/logs/settings did not answer: nothing to compare against')
        return False
    limits = found.get('limits') or {}
    if not check_limits(report, limits):
        return False
    found_days = found.get('days')
    state['found'] = found if isinstance(found_days, int) else None
    days = found_days if isinstance(found_days, int) else options.days_case
    report.note('the setting found: %d days, %d MiB'
                % (days, int(found.get('maxBytes') or 0) // MIB))
    check_refusals(report, options, loader, days, limits)
    run_id = 'walk-bound-%d' % now_ms()
    byte_case(report, options, loader, cluster, store, volume, run_id, state)
    age_case(report, options, loader, cluster, store, volume, run_id, state)
    return True


def restore(report, options, loader, cluster, store, volume, state):
    """Put the setting found back, and remove the walk's own non-today days."""
    found = state.get('found')
    if found is None:
        print('RESTORE nothing to restore: the setting the walk found is unknown')
        return
    days = int(found.get('days'))
    max_bytes = int(found.get('maxBytes'))
    status, answer = loader.put_settings(days, max_bytes, loader.csrf())
    applied = status == 200 and answer.get('state') == 'ok' and wait_applied(loader, options.apply_bound)
    setting = ('the setting found is back: %d days, %d MiB' % (days, max_bytes // MIB)
               if applied else
               'INCOMPLETE: the setting was asked back (%d days, %d MiB) but the store did not '
               'prove it within %d s' % (days, max_bytes // MIB, options.apply_bound))
    today = day_of(now_ms())
    removable = sorted(day for day in state.get('written_days', set()) if day != today)
    removed = []
    failed = []
    for day in removable:
        if day not in volume.partitions():
            continue
        if store is None:
            failed.append(day)
            continue
        try:
            key = read_partition_key(cluster, state)
            status, _body = store.detach(day, key)
            if status != 200:
                failed.append(day)
                continue
            volume.remove_day(day)
            removed.append(day)
        except (WalkError, OSError):
            failed.append(day)
    print('RESTORE %s; removed the walk\'s own day(s) %s after the store detached them; '
          'today\'s records stay in place' % (
              setting, ', '.join(removed) if removed else 'none'))
    if failed:
        print('RESTORE incomplete: these walk days could not be removed: %s' % ', '.join(failed))


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-BOUND (ADR-016 L06)')
    common_arguments(parser)
    parser.add_argument('--byte-bound-mib', type=int, default=300)
    parser.add_argument('--days-case', type=int, default=14)
    parser.add_argument('--canary-days-back', type=int, default=10)
    parser.add_argument('--canary-records', type=int, default=200)
    parser.add_argument('--today-mib', type=int, default=24)
    parser.add_argument('--old-day-mib', type=int, default=40)
    parser.add_argument('--old-days', type=int, default=8)
    parser.add_argument('--age-days', type=int, default=1)
    parser.add_argument('--age-old-days-back', type=int, default=3)
    parser.add_argument('--retention-bound', type=int, default=600)
    parser.add_argument('--apply-bound', type=int, default=180)
    parser.add_argument('--largest-extra-bytes', type=int, default=1)
    parser.add_argument('--largest-max-bytes', type=int)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    volume = Volume(options.mount, options.pv_path)
    state = {'written_days': set(), 'key': ''}
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
        if not report.check(volume.mounted(), 'the log volume is mounted', options.mount):
            return 1
        store, forwarding = connect_store(report, options, cluster)
        if store is None:
            return 1
        run(report, options, loader, cluster, store, volume, state)
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        if loader is not None:
            try:
                if loader.login(read_password(options.password_file)) != 200:
                    print('RESTORE incomplete: the loader did not accept a login after the walk')
                else:
                    restore(report, options, loader, cluster, store, volume, state)
            except WalkError:
                print('RESTORE incomplete: the loader did not answer; put the setting it found '
                      'back by hand')
        if forwarding is not None:
            forwarding.close()
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
