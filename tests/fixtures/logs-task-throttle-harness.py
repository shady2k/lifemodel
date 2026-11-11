"""Exercise genuine-task throttle integration without Kubernetes or a model."""
import importlib.util
import json
import sys
import types

mode, path = sys.argv[1:3]
real_helper_path = sys.argv[3] if len(sys.argv) > 3 else None
helper = types.ModuleType('logs_task_writer')
calls = []
validated = []


REALISTIC_MODES = ('processing-windows', 'processing-gap', 'two-collectors',
                   'stored-mismatch')
FAST_START = '2026-11-10T15:50:54Z'
LARGE_START = '2026-11-10T15:55:54Z'
GAP_START = '2026-11-10T15:52:00Z'
FAST_WINDOWS, FAST_INPUT, FAST_ACCEPTED = 37, 10000, 2980
LARGE_WINDOWS, LARGE_INPUT, LARGE_ACCEPTED = 5, 120, 120


def realistic():
    return mode in REALISTIC_MODES


def start_task_writer(report, options, loader, cluster, run_id, rate, seconds, size=0, bound=180):
    calls.append({'run': run_id, 'rate': rate, 'size': size})
    if mode == 'denied':
        report.not_valid('the core did not launch a task writer')
        return None
    pod = 'task-fast' if rate == 1000 else 'task-large'
    if realistic():
        first = walk_support.parse_ms('2026-11-10T15:50:10Z' if pod == 'task-fast'
                                      else '2026-11-10T15:55:12Z')
        return (pod, 'task', run_id + '-a2', first)
    start = '05' if mode == 'no-overlap' and pod == 'task-large' else '00'
    first = walk_support.parse_ms('2026-11-10T00:00:' + start + 'Z')
    return (pod, 'task', run_id + '-a2', first)
helper.start_task_writer = start_task_writer
sys.modules['logs_task_writer'] = helper
spec = importlib.util.spec_from_file_location('flood_walk', path)
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
walk.start_task_writer = start_task_writer
walk_support = sys.modules['logs_walk_support']
walk_support.start_task_writer = start_task_writer
if real_helper_path:
    real_spec = importlib.util.spec_from_file_location('logs_task_writer_real', real_helper_path)
    real = importlib.util.module_from_spec(real_spec)
    real_spec.loader.exec_module(real)
    helper.THROTTLE_SECONDS_MAX = real.THROTTLE_SECONDS_MAX
    helper.TASK_WRITER_BOUND = real.TASK_WRITER_BOUND
if mode.startswith('args'):
    class Validated(Exception):
        pass

    def stop_at_forward(*args, **kwargs):
        raise Validated()

    real.PortForward = stop_at_forward

    def checked_start(report, options, loader, cluster, run_id, rate, seconds, size=0,
                      bound=None):
        if bound is None:
            bound = real.TASK_WRITER_BOUND
        try:
            outcome = real.start_task_writer(report, options, loader, cluster, run_id,
                                             rate, seconds, size, bound)
        except Validated:
            outcome = 'validated'
        validated.append({'run': run_id, 'rate': rate, 'seconds': seconds,
                          'bound': bound, 'validated': outcome == 'validated'})
        if outcome != 'validated':
            return None
        return start_task_writer(report, options, loader, cluster, run_id, rate,
                                 seconds, size, bound)

    walk_support.start_task_writer = checked_start
    walk.start_task_writer = checked_start
clock = [0]
walk.time.monotonic = lambda: clock[0]
walk.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
throttle_seconds = int(mode.split('-', 1)[1]) if mode.startswith('args-') else 3
options = types.SimpleNamespace(kubectl='true', throttle_seconds=throttle_seconds, recover_bound=10,
                               writer_namespace='trusted', trusted_interval_ms=20)
created = []
def create_pod(report, cluster, manifest):
    created.append(manifest['metadata']['namespace'])
    if manifest['metadata']['namespace'] == 'lifemodel-motor':
        raise AssertionError('direct task pod creation bypasses core ownership')
    return True
walk.create_pod = create_pod
walk.writer_manifest = lambda options, namespace, *args, **kwargs: {'metadata': {'namespace': namespace}}
walk.wait_running = lambda *args: True


def window_records(pod, start_text, count, given, accepted):
    first = walk_support.parse_ms(start_text)
    records = []
    for index in range(count):
        at = first + index * 6000
        for kind, value in (('input', given), ('accepted', accepted)):
            records.append({'module': 'throttle-window', 'namespace': 'lifemodel-motor',
                            'pod': pod, 'counter': kind, 'value': str(value),
                            'window_start': walk_support.stamp(at),
                            'window_end': walk_support.stamp(at + 6000),
                            '_time': walk_support.stamp(at + 6000),
                            'collector_start': '2026-11-10T15:49:00Z'})
    return records


def counter_records():
    if mode == 'empty':
        return []
    if realistic():
        records = (window_records('task-fast', FAST_START, FAST_WINDOWS,
                                  FAST_INPUT, FAST_ACCEPTED)
                   + window_records('task-large', LARGE_START, LARGE_WINDOWS,
                                    LARGE_INPUT, LARGE_ACCEPTED))
        if mode == 'processing-gap':
            skipped = walk_support.parse_ms(GAP_START)
            records = [record for record in records
                       if walk_support.parse_ms(record['window_start']) != skipped]
        if mode == 'two-collectors':
            for record in records[:2]:
                record['collector_start'] = '2026-11-10T15:50:00Z'
        return records
    records = [
        {'module': 'throttle-window', 'namespace': 'lifemodel-motor',
         'pod': pod if mode != 'unrelated' else 'someone-else',
         'counter': kind, 'value': str(3000 if kind == 'input' else 1500),
         'window_start': '2026-11-10T00:00:00Z',
         'window_end': '2026-11-10T00:00:06Z',
         '_time': '2026-11-10T00:00:06Z',
         'collector_start': '2026-11-09T23:59:00Z'}
        for pod in ['task-fast', 'task-large'] for kind in ['input', 'accepted']]
    if mode == 'partial-window':
        for record in records:
            record['collector_start'] = '2026-11-10T00:00:01Z'
    if mode == 'mixed-instance':
        records[-1]['collector_start'] = '2026-11-09T23:59:06Z'
    if mode == 'missing-instance':
        for record in records:
            record.pop('collector_start')
    if mode == 'missing':
        records.pop()
    if mode == 'duplicate':
        records.append(dict(records[-1]))
    if mode == 'different-window':
        records[-1].update(window_start='2026-11-10T00:00:06Z',
                           window_end='2026-11-10T00:00:12Z')
    if mode == 'forged':
        for record in records:
            record['untrusted'] = 'true'
    if mode == 'message-only':
        records = [{'module': 'throttle-window', 'pod': 'task-fast',
                    '_msg': json.dumps(records)}]
    if mode == 'bad-count':
        records[-1]['value'] = '4000'
    if mode == 'no-throttle':
        for record in records:
            record['value'] = '3000'
    if mode == 'malformed-duplicate':
        records.append(dict(records[-1], value='not-a-count'))
    return records


def stored_totals(records):
    totals = {'task-fast': 0, 'task-large': 0}
    for record in records:
        if (record.get('counter') == 'accepted' and record.get('pod') in totals
                and str(record.get('value', '')).isdigit()):
            totals[record['pod']] += int(record['value'])
    return totals


records_now = counter_records()
totals = stored_totals(records_now)
if mode == 'stored-mismatch':
    totals['task-fast'] += 1


def stored_lines(store, pod, run_id, first_ms, last_ms):
    return totals.get(pod, 0)


walk.stored_task_lines = stored_lines


class Store:
    def query(self, query):
        assert 'module:"throttle-window"' in query
        assert 'task-fast' in query and 'task-large' in query
        return records_now

class Cluster:
    def run(self, args, **kwargs):
        if '--timestamps' in args:
            name = args[args.index('logs') + 1]
            if name.startswith('task-'):
                return types.SimpleNamespace(returncode=1, stdout='')
            prefix = 'walk-trusted-writer trusted' if name == 'walk-trusted-writer' else (
                'walk-task-writer fast' if name == 'task-fast' else 'walk-task-writer large')
            if realistic():
                start, end = '2026-11-10T15:49:00Z', '2026-11-10T15:56:30Z'
            else:
                first, last = ('00', '03') if mode != 'no-overlap' or name != 'task-large' else ('05', '08')
                start, end = '2026-11-10T00:00:' + first + 'Z', '2026-11-10T00:00:' + last + 'Z'
            return types.SimpleNamespace(returncode=0, stdout=(
                start + ' ' + prefix + ' seq=1\n' + end + ' ' + prefix + ' seq=2'))
        return types.SimpleNamespace(returncode=0, stdout='walk-trusted-writer trusted seq=1')
class Loader:
    def logs_page(self, params):
        if params.get('module') == 'task':
            run_id = params.get('text') or ''
            pod = 'task-fast' if run_id.startswith('fast') else 'task-large'
            if realistic():
                end = '2026-11-10T15:55:19Z' if pod == 'task-fast' else '2026-11-10T15:56:22Z'
            else:
                end = '2026-11-10T00:00:' + (
                    '08' if mode == 'no-overlap' and pod == 'task-large' else '03') + 'Z'
            return 200, {'state': 'ok', 'records': [
                {'time': end,
                 'message': 'walk-task-writer ' + run_id + ' seq=2',
                 'fields': {'module': 'task', 'pod': pod, 'namespace': 'lifemodel-motor',
                            'untrusted': 'true'}},
            ]}
        return 200, {'state': 'ok', 'records': [
            {'message': 'walk-trusted-writer trusted seq=1',
             'fields': {'namespace': 'trusted', 'pod': 'walk-trusted-writer',
                        'untrusted': 'true' if mode == 'untrusted-writer' else 'false'}},
            {'message': 'walk-trusted-writer trusted seq=2',
             'fields': {'namespace': 'trusted', 'pod': 'walk-trusted-writer',
                        'untrusted': 'true' if mode == 'untrusted-writer' else 'false'}},
        ]}

    def logs(self, params):
        status, answer = self.logs_page(params)
        return answer if status == 200 else None
report = walk.Report()
state = {'trusted_run': 'trusted', 'task_fast': 'fast', 'task_large': 'large', 'throttle_start': 0}
ok = walk.throttle_case(report, options, Loader(), Cluster(), Store(), state)
print('INTEGRATION ' + json.dumps({'ok': ok, 'calls': calls, 'created': created,
                                  'elapsed': clock[0], 'validated': validated}))
sys.exit(report.result())
