"""Exercise genuine-task throttle integration without Kubernetes or a model."""
import importlib.util
import json
import sys
import types

mode, path = sys.argv[1:3]
helper = types.ModuleType('logs_task_writer')
calls = []
def start_task_writer(report, options, loader, cluster, run_id, rate, seconds, size=0, bound=180):
    calls.append({'run': run_id, 'rate': rate, 'size': size})
    if mode == 'denied':
        report.not_valid('the core did not launch a task writer')
        return None
    pod = 'task-fast' if rate == 1000 else 'task-large'
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
clock = [0]
walk.time.monotonic = lambda: clock[0]
walk.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
options = types.SimpleNamespace(throttle_seconds=3, recover_bound=10,
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
walk.metrics_text = lambda *args: '' if mode == 'empty' else '\n'.join(
    'walk_throttle_window_' + kind + '{pod="' + pod + '"} 10'
    for pod in ['task-fast', 'task-large'] for kind in ['input', 'accepted'])
walk.throttle_windows = lambda text: ([{'pod': 'someone-else', 'input': 20, 'accepted': 10}]
    if mode == 'unrelated' else [] if mode == 'empty' else [
        {'pod': 'task-fast', 'input': 3000, 'accepted': 1500},
        {'pod': 'task-large', 'input': 60, 'accepted': 60}])
class Cluster:
    def run(self, args, **kwargs):
        if '--timestamps' in args:
            name = args[args.index('logs') + 1]
            if name.startswith('task-'):
                return types.SimpleNamespace(returncode=1, stdout='')
            prefix = 'walk-trusted-writer trusted' if name == 'walk-trusted-writer' else (
                'walk-task-writer fast' if name == 'task-fast' else 'walk-task-writer large')
            start, end = ('00', '03') if mode != 'no-overlap' or name != 'task-large' else ('05', '08')
            return types.SimpleNamespace(returncode=0, stdout=(
                '2026-11-10T00:00:' + start + 'Z ' + prefix + ' seq=1\n' +
                '2026-11-10T00:00:' + end + 'Z ' + prefix + ' seq=2'))
        return types.SimpleNamespace(returncode=0, stdout='walk-trusted-writer trusted seq=1')
class Loader:
    def logs_page(self, params):
        if params.get('module') == 'task':
            run_id = params.get('text') or ''
            pod = 'task-fast' if run_id.startswith('fast') else 'task-large'
            end = '08' if mode == 'no-overlap' and pod == 'task-large' else '03'
            return 200, {'state': 'ok', 'records': [
                {'time': '2026-11-10T00:00:' + end + 'Z',
                 'message': 'walk-task-writer ' + run_id + ' seq=2',
                 'fields': {'module': 'task', 'pod': pod, 'namespace': 'lifemodel-motor',
                            'untrusted': 'true'}},
            ]}
        return 200, {'state': 'ok', 'records': [
            {'message': 'walk-trusted-writer trusted seq=1'},
            {'message': 'walk-trusted-writer trusted seq=2'},
        ]}

    def logs(self, params):
        status, answer = self.logs_page(params)
        return answer if status == 200 else None
report = walk.Report()
state = {'trusted_run': 'trusted', 'task_fast': 'fast', 'task_large': 'large', 'throttle_start': 0}
ok = walk.throttle_case(report, options, Loader(), Cluster(), state)
print('INTEGRATION ' + json.dumps({'ok': ok, 'calls': calls, 'created': created,
                                  'elapsed': clock[0]}))
sys.exit(report.result())
