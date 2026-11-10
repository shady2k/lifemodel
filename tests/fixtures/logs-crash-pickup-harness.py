"""Offline pickup wait with deterministic time and exporter samples."""
import importlib.util
import json
import sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
mode = sys.argv[2]
options = SimpleNamespace(writer_namespace='walk', writer_pods=3, writer_rate=1700,
    fill_bound=4, saturated_seconds=0, memory_limit_bytes=300 * walk.MIB, restore_bound=180)


def source_metrics(value):
    rows = [
        'vector_component_received_events_total{component_id="kubernetes",pod_namespace="kube-system",pod_name="coredns"} 88198',
        'vector_component_received_events_total{component_id="kubernetes",pod_namespace="other",pod_name="walk-crash-writer"} 999999',
        'vector_component_received_events_total{component_id="kubernetes",pod_namespace="walk",pod_name="unrelated"} 999999',
    ]
    rows.extend('vector_component_received_events_total{component_id="kubernetes",pod_namespace="walk",pod_name="%s"} %d'
                % (pod, value) for pod in walk.writer_names(options))
    return walk.parse_metrics('\n'.join(rows), {walk.RECEIVED})

clock = [0]
walk.time.monotonic = lambda: clock[0]
walk.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
walk.safe_load = lambda *_args: True
calls = []
def read(*args):
    calls.append(clock[0])
    if mode == 'missing':
        return None, 'GET /metrics answered 503'
    value = 1002 if clock[0] < 60 or mode == 'timeout' else 6100
    if mode == 'integration' and len(calls) == 1:
        value = 1000
    if mode == 'reset':
        value = 1
    return source_metrics(value), 'HTTP 200'
walk.read_metrics = read
baseline = walk.source_rate_sample(source_metrics(1000), '', options)
if mode == 'integration':
    walk.wait_writer = lambda *_args: True
    walk.collector_restarts = lambda *_args: 0
    walk.emitted_count = lambda *_args: 10000
    walk.restore_step = lambda *_args: True
    walk.collector_memory = lambda *_args: ((100, '') if clock[0] < 60
        else (None, 'fixture stops at fill sample'))
    # Permit the discovery sample at 60 s, then stop inside the fill loop.
    memory_calls = [0]
    def memory(*_args):
        if clock[0] >= 60:
            memory_calls[0] += 1
        return (None, 'fixture stops at fill sample') if memory_calls[0] > 2 else (100, '')
    walk.collector_memory = memory
    applied = []
    cluster = SimpleNamespace(apply=lambda body: (applied.append(body) or SimpleNamespace(returncode=0)))
    result = walk.crash_case(walk.Report(), options, None, cluster,
                            {'writer_image': 'offline-only'}, True)
else:
    result = walk.wait_source_pickup(walk.Report(), options, None, baseline, lambda: True)
print('OBSERVED ' + json.dumps({'result': result, 'seconds': clock[0], 'calls': len(calls)}))
