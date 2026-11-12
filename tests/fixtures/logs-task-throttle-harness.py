"""Exercise genuine-task throttle integration without Kubernetes or a model."""
import importlib.util
import json
import sys
import types

mode, path = sys.argv[1:3]
real_helper_path = sys.argv[3] if len(sys.argv) > 3 else None
helper = types.ModuleType('logs_task_writer')
calls = []
task_calls = []
validated = []
deleted = []


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
    task_calls.append({'run': run_id, 'rate': rate, 'size': size, 'seconds': seconds,
                       'bound': bound})
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
manifests = []
run_ids = {}


def writer_manifest(options, namespace, name, module, run_id, seconds, interval, size=0,
                    *args, **kwargs):
    manifests.append({'name': name, 'namespace': namespace, 'module': module,
                      'seconds': seconds, 'interval': interval, 'size': size})
    run_ids[name] = run_id
    return {'metadata': {'name': name, 'namespace': namespace}}


walk.writer_manifest = writer_manifest
walk.wait_running = lambda *args: True


def window_records(pod, start_text, count, given, accepted):
    first = walk_support.parse_ms(start_text)
    records = []
    for index in range(count):
        at = first + index * 6000
        for kind, value in (('input', given), ('accepted', accepted)):
            records.append({'module': 'throttle-window', 'namespace': 'lifemodel-logs-walk',
                            'pod': pod, 'counter': kind, 'value': str(value),
                            'window_start': walk_support.stamp(at),
                            'window_end': walk_support.stamp(at + 6000),
                            '_time': walk_support.stamp(at + 6000),
                            'collector_start': '2026-11-10T15:49:00Z'})
    return records


FAST_POD, LARGE_POD = 'walk-throttle-fast', 'walk-throttle-large'
FAST_START = '2026-11-10T15:50:54Z'
LARGE_START = '2026-11-10T15:55:54Z'
GAP_START = '2026-11-10T15:52:00Z'
FAST_WINDOWS, FAST_INPUT, FAST_ACCEPTED = 37, 10000, 2980
LARGE_WINDOWS, LARGE_INPUT, LARGE_ACCEPTED = 5, 120, 120
REALISTIC_MODES = ('processing-windows', 'processing-gap', 'two-collectors',
                   'stored-mismatch')


def realistic():
    return mode in REALISTIC_MODES


def counter_records():
    if mode == 'empty':
        return []
    if realistic():
        records = (window_records(FAST_POD, FAST_START, FAST_WINDOWS,
                                  FAST_INPUT, FAST_ACCEPTED)
                   + window_records(LARGE_POD, LARGE_START, LARGE_WINDOWS,
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
        {'module': 'throttle-window', 'namespace': 'lifemodel-logs-walk',
         'pod': pod if mode != 'unrelated' else 'someone-else',
         'counter': kind, 'value': str(3000 if kind == 'input' else 1500),
         'window_start': '2026-11-10T00:00:00Z',
         'window_end': '2026-11-10T00:00:06Z',
         '_time': '2026-11-10T00:00:06Z',
         'collector_start': '2026-11-09T23:59:00Z'}
        for pod in [FAST_POD, LARGE_POD] for kind in ['input', 'accepted']]
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
        records = [{'module': 'throttle-window', 'pod': FAST_POD,
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
    totals = {FAST_POD: 0, LARGE_POD: 0}
    for record in records:
        if (record.get('counter') == 'accepted' and record.get('pod') in totals
                and str(record.get('value', '')).isdigit()):
            totals[record['pod']] += int(record['value'])
    return totals


records_now = counter_records()
totals = stored_totals(records_now)
if mode == 'stored-mismatch':
    totals[FAST_POD] += 1


def stored_lines(store, pod, run_id, first_ms, to_ms, module='task'):
    return totals.get(pod, 0)


walk.stored_task_lines = stored_lines


def store_lifetime(name):
    if mode == 'rotated-log':
        return '2026-11-10T00:00:00Z', '2026-11-10T00:00:10Z'
    startup, end = lifetime(name)
    return startup, end


class Store:
    def query(self, query):
        if '| stats min(_time), max(_time)' in query:
            if FAST_POD in query:
                name = FAST_POD
            elif LARGE_POD in query:
                name = LARGE_POD
            else:
                name = 'walk-trusted-writer'
            startup, end = store_lifetime(name)
            return [{'min(_time)': startup, 'max(_time)': end}]
        assert 'module:"throttle-window"' in query
        assert FAST_POD in query and LARGE_POD in query
        return records_now


class Cluster:
    def apply(self, manifest, namespace=None):
        calls.append(['apply', manifest['metadata']['name'], namespace])
        if scenario_refuse():
            return types.SimpleNamespace(returncode=1, stderr=(
                'Error from server (Forbidden): error when creating "STDIN": pods '
                '"%s" is forbidden: violates PodSecurity "restricted:latest": '
                'allowPrivilegeEscalation != false' % manifest['metadata']['name']))
        return types.SimpleNamespace(returncode=0, stdout='')

    def json(self, args, timeout=120):
        calls.append(['json'] + list(args))
        if 'namespace' in args:
            return {'metadata': {'labels': {'pod-security.kubernetes.io/enforce':
                                            'restricted'}}}
        return {'items': []}

    def pod(self, namespace, name):
        calls.append(['pod', namespace, name])
        if mode == 'existing-pod':
            return {'metadata': {'name': name, 'uid': 'existing'}}
        return None

    def run(self, args, **kwargs):
        calls.append(['run'] + list(args))
        if len(args) >= 5 and args[2] == 'delete' and args[3] == 'pod':
            deleted.append((args[1], args[4]))
        if '--timestamps' in args and 'logs' in args:
            name = args[args.index('logs') + 1]
            module = 'walk-trusted-writer' if name == 'walk-trusted-writer' else name
            run_id = run_ids.get(name, 'run')
            start, end = lifetime(name)
            prefix = module + ' ' + run_id
            return types.SimpleNamespace(returncode=0, stdout=(
                start + ' ' + prefix + ' seq=1\n' + end + ' ' + prefix + ' seq=2'))
        return types.SimpleNamespace(returncode=0, stdout='')


def lifetime(name):
    if realistic():
        return '2026-11-10T15:49:00Z', '2026-11-10T15:56:30Z'
    if mode.startswith('args'):
        return '2026-11-09T23:59:00Z', '2026-11-10T00:11:00Z'
    if mode == 'no-overlap':
        if name == LARGE_POD:
            return '2026-11-10T00:00:05Z', '2026-11-10T00:00:08Z'
        return '2026-11-10T00:00:00Z', '2026-11-10T00:00:03Z'
    if mode == 'rotated-log' and name == LARGE_POD:
        return '2026-11-10T00:00:05Z', '2026-11-10T00:00:10Z'
    return '2026-11-10T00:00:00Z', '2026-11-10T00:00:10Z'


def scenario_refuse():
    return mode == 'refused-apply'


class Loader:
    def logs_page(self, params):
        if params.get('module') in (FAST_POD, LARGE_POD):
            if mode == 'no-untrusted-record':
                return 200, {'state': 'ok', 'records': []}
            return 200, {'state': 'ok', 'records': [
                {'message': 'walk-throttle line',
                 'fields': {'pod': params['module'],
                            'namespace': 'lifemodel-logs-walk',
                            'module': params['module'],
                            'untrusted': 'false' if mode == 'trusted-namespace' else 'true'}},
            ]}
        if params.get('module') == 'task':
            return 200, {'state': 'ok', 'records': []}
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
if mode == 'restore':
    options.shared_namespace = 'lifemodel-logs-walk-pg'
    rows = walk.restore_pod_deletions(Cluster(), options)
    print('RESTORE ' + json.dumps({'rows': rows, 'calls': deleted}))
    sys.exit(report.result())
state = {'trusted_run': 'trusted', 'task_fast': 'fast', 'throttle_start': 0}
ok = walk.throttle_case(report, options, Loader(), Cluster(), Store(), state)
print('INTEGRATION ' + json.dumps({'ok': ok, 'calls': calls, 'task_calls': task_calls,
                                  'created': created, 'elapsed': clock[0],
                                  'validated': validated, 'manifests': manifests,
                                  'deleted': deleted}))
sys.exit(report.result())
