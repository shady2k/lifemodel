"""Drive WALK-LOGS-EGRESS decisions without a cluster or live connections.

usage: logs-egress-walk-harness.py <matrix|observation> <walk.py> <fixture.json>
"""
import contextlib
import importlib.util
import io
import json
import sys


def load(path):
    sys.path.insert(0, str(__import__('pathlib').Path(path).resolve().parent))
    spec = importlib.util.spec_from_file_location('walk_under_test', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module



def lifecycle(walk, report, fixture, calls):
    from types import SimpleNamespace
    result = lambda body='': SimpleNamespace(returncode=0, stdout=body)
    labels = {'app.kubernetes.io/name': 'logs-collector', 'fixture': 'same-policy'}
    def workload(name, ip):
        return {'metadata': {'name': name, 'uid': name + '-uid', 'labels': labels},
                'spec': {'nodeName': 'fixture-node'},
                'status': {'podIPs': [{'ip': ip}]}}
    class Cluster:
        def pods(self, namespace, selector):
            name, ip = ('collector', '10.42.0.10') if 'collector' in selector else (
                ('dns', '10.42.0.53') if 'dns' in selector else ('store', '10.42.0.20'))
            return [workload(name, ip)]

        def json(self, args):
            if 'nodes' in args:
                return {'items': [{'metadata': {'name': 'fixture-node'}, 'status': {
                    'addresses': [{'type': 'InternalIP', 'address': '192.0.2.10'}]}}]}
            if 'endpoints' in args:
                return {'subsets': [{'addresses': [{'ip': '192.0.2.10'}],
                                     'ports': [{'port': 6443}]}]}
            if 'cronjob' in args:
                return {'spec': {'jobTemplate': {'spec': {'template': {'spec': {
                    'containers': [{'image': 'fixture-node-image'}]}}}}}}
            return {'spec': {'clusterIP': '10.43.0.10'}}

        def apply(self, manifest):
            calls.append(['apply', manifest])
            name = manifest['metadata']['name']
            point = ('namespace' if manifest['kind'] == 'Namespace' else
                     'probe' if name.startswith('walk-egress-') else name)
            if fixture.get('exception') == point:
                raise walk.WalkError('fixture_apply_exception')
            return result()

        def is_ready(self, namespace, name):
            calls.append(['ready', name])
            if fixture.get('exception') == 'start':
                raise walk.WalkError('fixture_start_exception')
            return True

        def pod(self, namespace, name):
            return {'status': {'podIP': '10.42.1.30'}}

        def run(self, args, timeout=120):
            calls.append(['exec', args])
            return result()

        def ok(self, args, timeout=120):
            calls.append(['delete', args])
            return True
    options = SimpleNamespace(collector_namespace='lifemodel-logs',
                              namespace='lifemodel-system', node='fixture-node',
                              public_resolver='1.1.1.1', public_host='1.1.1.1',
                              observation_seconds=600)
    walk.subprocess.run = lambda *args, **kwargs: result(json.dumps(
        [{'addr_info': [{'local': '192.0.2.10'}]}]))
    walk.time.sleep = lambda seconds: calls.append(['settle', seconds])
    walk.wait_until = lambda deadline, interval, probe: probe()
    walk.check_matrix = lambda report, connect, targets: calls.append(['matrix', targets])
    walk.observe = lambda *args: calls.append(['observe'])
    try:
        walk.run(report, Cluster(), options)
    except walk.WalkError as error:
        report.not_valid(str(error))


def run(mode, path, fixture):
    walk = load(path)
    report = walk.Report()
    calls = []
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        if mode == 'matrix':
            def connect(role, target):
                calls.append([role, target['name']])
                key = role + ':' + target['name']
                return fixture.get('answers', {}).get(
                    key, True if role == 'witness' else target['open'])
            walk.check_matrix(report, connect, fixture['targets'])
        elif mode == 'observation':
            walk.check_observation(
                report, fixture['text'], set(fixture['collector_ips']),
                set(fixture['store_ips']),
                {tuple(entry) for entry in fixture['permitted']})
        elif mode == 'lifecycle':
            lifecycle(walk, report, fixture, calls)
        elif mode == 'packets':
            walk.check_packets(report, fixture['packets'], fixture['connections'],
                               set(fixture['collector_ips']), set(fixture['store_ips']))
        else:
            raise SystemExit('unknown mode: ' + mode)
        status = report.result()
    print(output.getvalue(), end='')
    print('SUMMARY ' + json.dumps({
        'failures': report.failures, 'invalid': report.invalid,
        'calls': calls, 'passes': [line for line in output.getvalue().splitlines()
                                  if line.startswith('PASS ')]}))
    return status


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    with open(sys.argv[3], encoding='utf8') as source:
        value = json.load(source)
    sys.exit(run(sys.argv[1], sys.argv[2], value))
