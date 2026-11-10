"""Real labelled exporter parser and writer-only source diagnostics, offline."""
import importlib.util
import json
import sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
mode = sys.argv[2]
options = SimpleNamespace(writer_namespace='walk-ns', writer_pods=3)
def values(counts):
    rows = ['vector_component_received_events_total{component_id="kubernetes",pod_namespace="kube-system",pod_name="coredns"} 88198',
            'vector_component_received_events_total{component_id="kubernetes",pod_namespace="other",pod_name="walk-crash-writer"} 999999',
            'vector_component_received_events_total{component_id="kubernetes",pod_namespace="walk-ns",pod_name="other"} 999999',
            'vector_component_received_events_total{component_id="normalize",pod_namespace="walk-ns",pod_name="walk-crash-writer"} 999999']
    for pod, count in zip(walk.writer_names(options), counts):
        if count is not None:
            rows.append('vector_component_received_events_total{pod_name="%s",component_kind="source",component_type="kubernetes_logs",component_id="kubernetes",pod_namespace="walk-ns"} %d' % (pod, count))
    return walk.parse_metrics('\n'.join(rows), {walk.RECEIVED})
before = walk.source_rate_sample(values([100, 200, 300]), '', options)
counts = [200, 400, 600]
if mode == 'missing': counts[1] = None
if mode == 'reset': counts = [99, 1000, 1000]
current = walk.source_rate_sample(values(counts), '', options)
if mode == 'baseline':
    before = walk.source_rate_sample(values([None, None, None]), '', options, before_writers=True)
rate = walk.source_rate_report(walk.Report(), before, current, 10, 1700)
print('OBSERVED ' + json.dumps({'before': before, 'current': current, 'rate': rate}))
