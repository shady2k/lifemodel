"""Offline regression harness; never contacts a cluster."""
import importlib.util
import json
import sys
import types
from pathlib import Path

spec = importlib.util.spec_from_file_location('crash_walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
fixture = json.loads(sys.argv[2])
mode = fixture['mode']
if mode == 'disk':
    labels = 'component_id="logs-store",buffer_type="disk"'
    body = '\n'.join('%s{%s} %s' % (name, labels, value) for name, value in {
        'vector_buffer_max_size_bytes': 335544320,
        'vector_buffer_size_bytes': fixture.get('size', 192 * 1024 * 1024),
        'vector_buffer_size_events': 900,
        'vector_buffer_received_events_total': 1000,
        'vector_buffer_sent_events_total': 100,
    }.items())
    body += '\nvector_buffer_size_bytes{component_id="metrics",buffer_type="memory"} 1'
    values = walk.parse_metrics(body, {
        'vector_buffer_max_size_bytes', 'vector_buffer_size_bytes',
        'vector_buffer_size_events', 'vector_buffer_received_events_total',
        'vector_buffer_sent_events_total'})
    state = walk.buffer_state(values)
    print(json.dumps({'state': state, 'saturated': walk.saturated(state)}))
elif mode == 'kubelet':
    options = types.SimpleNamespace(writer_namespace='walk-ns')
    print(json.dumps(sorted(walk.kubelet_lines('writer', options, 'wanted',
                                             root=Path(fixture['root'])))))
elif mode == 'recovery':
    events = []
    walk.require_safe_load = lambda *args: True
    walk.collector_running = lambda *args: (events.append('collector-ready') or True)
    walk.store_ready = lambda *args: (events.append('store-ready') or True)
    walk.set_replicas = lambda *args: (events.append('store-up') or True)
    walk.wait_until = lambda deadline, interval, predicate: predicate()
    walk.require_store_down = lambda *args: True
    options = types.SimpleNamespace(recover_bound=3)
    ok = walk.recover_after_crash(walk.Report(), options, None, {'replicas': 1},
                                  store_down_restart=True)
    print(json.dumps({'ok': ok, 'events': events}))
elif mode == 'run-order':
    events = []
    walk.safe_load = lambda *args: True
    walk.writer_image = lambda *args: 'image'
    walk.ensure_namespace = lambda *args: True
    walk.wait_store_down = lambda *args: True
    walk.store_replicas = lambda *args: 1
    walk.set_replicas = lambda *args: True
    walk.stop_store = lambda *args: True
    walk.wait_until = lambda *args: True
    walk.time.sleep = lambda *args: None
    def case(report, options, loader, cluster, state, saturated_case, store_down_restart=False):
        events.append('saturated' if saturated_case else ('store-down' if store_down_restart else 'informative'))
        return True
    walk.crash_case = case
    options = types.SimpleNamespace(writer_rate=1700, writer_pods=3, max_load=8,
        namespace='system', store='logs-store', writer_namespace='walk')
    cluster = types.SimpleNamespace(pods=lambda *args: [])
    ok = walk.run(walk.Report(), options, None, cluster, {})
    print(json.dumps({'ok': ok, 'events': events}))
elif mode == 'case-order':
    events = []
    walk.safe_load = lambda *args: True
    walk.require_safe_load = lambda *args: True
    walk.writer_image = lambda *args: 'image'
    walk.wait_writer = lambda *args: True
    walk.wait_store_down = lambda *args: True
    walk.writer_lines = lambda *args: [1, 2]
    walk.collector_memory = lambda *args: (100 * walk.MIB, '')
    restarts = iter([0, 1, 1, 1])
    walk.collector_restarts = lambda *args: next(restarts, 1)
    walk.vector_pid = lambda *args: (42, 'pid 42')
    walk.collector_running = lambda *args: (events.append('collector-ready') or True)
    walk.set_replicas = lambda *args: (events.append('store-up') or True)
    walk.store_ready = lambda *args: (events.append('store-ready') or True)
    def wait(deadline, interval, predicate):
        for _ in range(3):
            if predicate():
                return True
        return False
    walk.wait_until = wait
    walk.kubelet_lines = lambda name, *args: (events.append(name) or {1, 2})
    walk.emitted_seqs = lambda *args: [2, 50_000_002]
    def delivery(*args):
        events.append('query')
        missing = [2] if fixture.get('gap') else []
        return {'ok': not missing, 'complete': True, 'missing': missing,
                'detail': ('2 written, 2 delivered, 1 duplicated, %d missing of which %d are '
                           'still in the kubelet\'s files, 0 rotated away'
                           % (len(missing), len(missing)))}
    walk.store_delivery = delivery
    walk.restore_step = lambda *args: True
    class Cluster:
        def apply(self, body):
            return types.SimpleNamespace(returncode=0)
        def run(self, args):
            events.append('kill')
            return types.SimpleNamespace(returncode=0)
    walk.require_store_down = lambda *args: True
    options = types.SimpleNamespace(writer_namespace='walk', writer_pods=2,
        writer_rate=1700, fill_bound=1, fill_ceiling=2400, saturated_seconds=0,
        unsaturated_lines=1, memory_limit_bytes=300 * walk.MIB, recover_bound=1,
        settle_seconds=0, restore_bound=180)
    report = walk.Report()
    cluster = Cluster()
    walk.node_run = cluster.run
    ok = walk.crash_case(report, options, None, cluster, {'replicas': 1}, False, True)
    print(json.dumps({'ok': ok, 'events': events}))
elif mode == 'native-cri':
    commands = []
    class Cluster:
        def pods(self, *args):
            return [{'metadata': {'name': 'collector'}}]
        def run(self, args):
            raise AssertionError('kubectl must not execute node commands: ' + repr(args))
    def native(args):
        commands.append(args)
        body = {'containers': [{'id': 'c', 'metadata': {'name': 'logs-collector'}}]}
        if 'inspect' in args:
            body = {'info': {'pid': 4242}}
        return types.SimpleNamespace(stdout=json.dumps(body), returncode=0)
    walk.node_run = native
    options = types.SimpleNamespace(crictl='k3s crictl', collector_namespace='logs', collector='collector')
    pid, reason = walk.vector_pid(Cluster(), options)
    print(json.dumps({'pid': pid, 'commands': commands}))
elif mode == 'cri-memory':
    walk.collector_pod_name = lambda *args: 'collector'
    class Cluster:
        def run(self, args):
            if 'ps' in args:
                body = {'containers': [{'id': 'c', 'metadata': {
                    'name': 'logs-collector'}}]}
            else:
                body = {'stats': [{'memory': {'usageBytes': {'value': '104857600'},
                    'workingSetBytes': {'value': '94371840'}}}]}
            return types.SimpleNamespace(stdout=json.dumps(body), returncode=0)
    cluster = Cluster()
    walk.node_run = cluster.run
    memory, reason = walk.collector_memory(cluster, types.SimpleNamespace(crictl='crictl', collector_namespace='lifemodel-logs'))
    print(json.dumps({'memory': memory, 'reason': reason}))
elif mode == 'memory':
    verdict = walk.memory_verdict(301 * walk.MIB, 300 * walk.MIB,
                                  10, 20, 0, 0, '')
    print(json.dumps(verdict))
