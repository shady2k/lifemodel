"""Offline source-rate evidence through the walk's real parser and reporting helpers."""
import importlib.util
import json
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('crash_rate_walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
fixture = json.loads(sys.argv[2])
config = Path(sys.argv[1]).parent / 'logs' / 'config' / 'vector.yaml'
source = re.search(r'^  ([\w-]+):\n    type: kubernetes_logs$',
                   config.read_text(), re.MULTILINE).group(1)


def sample(entry):
    if entry.get('error'):
        return walk.source_rate_sample(None, entry['error'])
    lines = [
        'vector_buffer_received_events_total{component_id="logs-store",buffer_type="disk"} %s'
        % entry.get('sink', 700),
        'vector_component_received_events_total{component_id="logs-store"} 9000',
        'vector_component_received_events_total{component_id="internal_metrics"} 8000',
        'vector_component_received_events_total{component_id="heartbeat"} 6000',
    ]
    if entry.get('source') is not None:
        lines.append('vector_component_received_events_total{component_id="%s",component_type="kubernetes_logs"} %s'
                     % (source, entry['source']))
    values = walk.parse_metrics('\n'.join(lines), {walk.RECEIVED, walk.BUFFER_RECEIVED})
    return walk.source_rate_sample(values, '')


if fixture.get('mode') == 'fill-loop':
    import types
    walk.safe_load = lambda *_args: True
    walk.wait_writer = lambda *_args: True
    walk.emitted_count = lambda *_args: 1000
    walk.collector_restarts = lambda *_args: 0
    walk.collector_memory = lambda *_args: (None, 'fixture stops after rate diagnostic')
    walk.restore_step = lambda *_args: True
    ticks = iter(range(100))
    walk.time.monotonic = lambda: next(ticks)
    readings = iter([1000, 1000, 1300])

    def read_metrics(*_args):
        count = next(readings)
        body = ('vector_component_received_events_total{component_id="%s"} %d\n'
                'vector_buffer_received_events_total{component_id="logs-store",buffer_type="disk"} 700\n'
                'vector_buffer_size_bytes{component_id="logs-store",buffer_type="disk"} 100\n'
                'vector_buffer_max_size_bytes{component_id="logs-store",buffer_type="disk"} 335544320'
                % (source, count))
        return walk.parse_metrics(body, {walk.RECEIVED, walk.BUFFER_RECEIVED,
                                        walk.BUFFER_BYTES, walk.BUFFER_MAX_BYTES}), ''

    walk.read_metrics = read_metrics
    cluster = types.SimpleNamespace(apply=lambda *_args: types.SimpleNamespace(returncode=0))
    options = types.SimpleNamespace(writer_namespace='walk', writer_pods=1,
        writer_rate=1700, fill_bound=30, saturated_seconds=0, restore_bound=180)
    ok = walk.crash_case(walk.Report(), options, None, cluster,
                         {'writer_image': 'offline-only'}, True)
    print('OBSERVED ' + json.dumps({'configured_source': source, 'ok': ok}))
else:
    before = sample(fixture.get('before', {'source': 1000}))
    current = sample(fixture.get('current', {'source': 1300}))
    rate = walk.source_rate_report(walk.Report(), before, current,
                                   fixture.get('elapsed', 10), fixture.get('target', 1700))
    print('OBSERVED ' + json.dumps({'configured_source': source, 'before': before,
                                   'current': current, 'rate': rate}))
