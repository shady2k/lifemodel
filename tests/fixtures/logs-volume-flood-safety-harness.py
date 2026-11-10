"""Safety contracts for the deployed volume-flood walk; all cluster I/O is fake."""
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Report:
    def __init__(self):
        self.events = []

    def pass_(self, name, detail=''):
        self.events.append({'kind': 'pass', 'name': name, 'detail': detail})

    def fail(self, name, detail=''):
        self.events.append({'kind': 'fail', 'name': name, 'detail': detail})

    def check(self, ok, name, detail=''):
        (self.pass_ if ok else self.fail)(name, detail)
        return ok

    def note(self, text):
        self.events.append({'kind': 'note', 'name': text})

    def not_valid(self, text):
        self.events.append({'kind': 'invalid', 'name': text})


def options():
    return SimpleNamespace(
        shared_namespace='walk-pg', writer_namespace='walk-trusted',
        shared_path='/walk-owned/shared', postgres_image='postgres:17-bookworm',
        writer_image='writer@sha256:fixture', commit_interval_ms=200,
        trusted_interval_ms=20, flood_seconds=300, postgres_bytes=64 * 1024**2,
        mount='/logs', commit_gap_bound=10, namespace='lifemodel-system',
        store='logs-store', poll_seconds=5, burst_mib=4, fill_bound=900,
        recover_bound=300)


def main():
    mode, walk_path = sys.argv[1:]
    data = json.load(sys.stdin)
    walk = load('flood_walk_under_test', walk_path)
    support = load('flood_safety_under_test', str(Path(walk_path).with_name('logs_flood_support.py')))
    shared = load('flood_shared_under_test', str(Path(walk_path).with_name('logs_walk_support.py')))
    report = Report()
    result = {}
    if mode == 'commits':
        support.check_commits(report, data['commits'], data['start'], data['end'], data['bound'])
    elif mode == 'refusal':
        support.refusal_verdict(report, data['samples'], data.get('drops', []), data.get('bound', 120))
    elif mode == 'verified-drop':
        default_record = {
            'module': 'logs-evictor',
            'time': '2026-11-10T00:00:01Z',
            'message': json.dumps({
                'msg': 'the oldest log day was removed',
                'day': '20261109',
                'freedBytes': 4096,
                'reason': 'below_threshold',
            }),
        }
        record = data['record'] if 'record' in data else default_record
        records = [] if record is None else [record]
        queries = []
        class Loader:
            def logs(self, params):
                queries.append(params)
                assert params.get('module') == 'logs-evictor', params
                return {'state': 'ok', 'records': records}
        class Volume:
            def partitions(self):
                return list(data.get('partitions', ['20261110']))
        oldest_before = shared.parse_ms(data.get('oldestBefore', '2026-11-09T12:00:00Z'))
        oldest_after = shared.parse_ms(data.get('oldestAfter', '2026-11-10T00:00:01Z'))
        verified = support.verified_drops(report, Loader(), Volume(), 0,
                                          oldest_before, oldest_after)
        result['verified'] = len(verified)
        result['queries'] = queries
        support.refusal_verdict(report, data.get('samples', [[0, 200], [300000, 200]]),
                                verified)
    elif mode == 'create':
        class Cluster:
            def apply(self, manifest, **kwargs):
                result['namespace'] = kwargs.get('namespace')
                return SimpleNamespace(returncode=data.get('code', 1), stdout='',
                                       stderr=data.get('stderr', ''))
        manifest = {'apiVersion': 'v1', 'kind': 'Pod',
                    'metadata': {'name': 'writer', 'namespace': 'lifemodel-motor'}}
        result['created'] = support.create_pod(report, Cluster(), manifest)
    elif mode == 'manifests':
        result['postgres'] = walk.postgres_manifest(options(), 25)
        result['writer'] = walk.writer_manifest(
            options(), walk.TASKS_NAMESPACE, 'task', walk.TASK_MODULE, 'run', 1, 1,
            untrusted=True)
    elif mode == 'prepare':
        events = []
        def created(*args, **kwargs):
            events.append('created')
            return True
        def running(*args, **kwargs):
            events.append('running')
            return data.get('running', True)
        def committed(*args, **kwargs):
            events.append('commit-probe')
            return data.get('committed', True)
        with patch.object(walk, 'create_pod', created), \
             patch.object(walk, 'wait_running', running), \
             patch.object(walk, 'pod_diagnostics', return_value='fixture pod not ready'), \
             patch.object(walk, 'wait_until', committed):
            result['prepared'] = walk.prepare_flood(
                report, options(), object(), {'trusted_run': 'trusted'})
        result['probes'] = events
    elif mode == 'recovery':
        from contextlib import ExitStack
        samples = []
        writes = []
        moments = iter([0, 0, 1, 400, 401, 402])
        epochs = iter([0, 300_000_000_000])
        statuses = iter([429, 503, 204])
        def burst(*args, **kwargs):
            status = next(statuses)
            writes.append(status)
            return status, []
        def waiting(deadline, interval, predicate):
            return predicate() or predicate()
        def refusal(_report, observed, drops, bound=120, state=''):
            samples.extend(observed)
        class Cluster:
            def run(self, *args, **kwargs):
                return SimpleNamespace(returncode=0, stdout='', stderr='')
        loader = SimpleNamespace(logs=lambda *args: {'state': 'ok'})
        volume = SimpleNamespace(space=lambda: (3 * 1024**3, 2 * 1024**3))
        before = {'uid': 'original', 'restarts': 0}
        after = {'uid': 'replacement' if data.get('restart') else 'original',
                 'restarts': 1 if data.get('restart') else 0}
        replacements = {
            'prepare_flood': lambda *args: True,
            'accounting_snapshot': lambda *args: {},
            'report_accounting': lambda *args: None,
            'oldest_record_ms': lambda *args: None,
            'verified_drops': lambda *args: [],
            'shared_space': lambda: (100 * 1024**3, 90 * 1024**3),
            'loop_device': lambda *args: None,
            'write_burst': burst,
            'wait_until': waiting,
            'read_store_flags': lambda *args: {'storage.minFreeDiskSpaceBytes': '1GiB'},
            'store_log': lambda *args: '',
            'margin_verdict': lambda *args: {'ok': True, 'detail': 'fixture margin'},
            'refusal_verdict': refusal,
            'check_commits': lambda *args: True,
        }
        with ExitStack() as stack:
            for name, replacement in replacements.items():
                stack.enter_context(patch.object(walk, name, replacement))
            stack.enter_context(patch.object(walk, 'store_pod', side_effect=[before, after]))
            stack.enter_context(patch.object(walk.time, 'monotonic', side_effect=lambda: next(moments)))
            stack.enter_context(patch.object(walk.time, 'time_ns', side_effect=lambda: next(epochs)))
            walk.flood_case(report, options(), loader, Cluster(), None, volume,
                            {'trusted_run': 'trusted', 'flood_run': 'flood'})
        result['samples'] = samples
        result['writes'] = writes
    elif mode == 'baseline-order':
        events = []
        class BaselineReached(Exception):
            pass
        def prepared(*args, **kwargs):
            events.append('ready')
            return data.get('ready', True)
        def baseline(*args, **kwargs):
            events.append('baseline')
            raise BaselineReached()
        def burst(*args, **kwargs):
            raise AssertionError('a flood write must never precede the accounting baseline')
        with patch.object(walk, 'prepare_flood', prepared), \
             patch.object(walk, 'accounting_snapshot', baseline), \
             patch.object(walk, 'shared_space', return_value=(100 * 1024**3, 90 * 1024**3)), \
             patch.object(walk, 'loop_device', return_value=None), \
             patch.object(walk, 'write_burst', burst):
            try:
                walk.flood_case(report, options(), None, object(), None, None,
                                {'trusted_run': 'trusted', 'flood_run': 'flood'})
            except BaselineReached:
                pass
        result['events'] = events
    else:
        raise AssertionError('unknown mode: ' + mode)
    result['events'] = result.get('events', report.events)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
