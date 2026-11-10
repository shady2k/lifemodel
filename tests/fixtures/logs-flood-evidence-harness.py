"""Flood evictor evidence: fake Jobs/logs, real temporary PV day directories."""
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    walk_path = sys.argv[1]
    data = json.load(sys.stdin)
    walk = load('flood_walk_evidence_under_test', walk_path)
    safety = load('flood_evidence_report', str(Path(__file__).with_name(
        'logs-volume-flood-safety-harness.py')))
    shared = load('flood_evidence_shared', str(Path(walk_path).with_name('logs_walk_support.py')))
    if data.get('integration'):
        safety.flood_integration(walk, shared, data)
        return
    since = shared.parse_ms('2026-11-10T12:00:00Z')
    report = safety.Report()
    calls = []
    frames = data['frames']
    current = frames[0]

    class Cluster:
        def json(self, args):
            calls.append(args)
            assert args == ['-n', 'lifemodel-system', 'get', 'jobs', '-o', 'json']
            return {'items': current.get('jobs', [])}

        def pods(self, namespace, selector):
            calls.append(['pods', namespace, selector])
            return [pod for pod in current.get('pods', [])
                    if selector == 'job-name=' + pod['metadata']['labels']['job-name']]

        def run(self, args, **kwargs):
            calls.append(args)
            assert args[:3] == ['-n', 'lifemodel-system', 'logs']
            value = current.get('logs', {}).get(args[3])
            return SimpleNamespace(returncode=0 if value is not None else 1,
                                   stdout=value or '', stderr='withheld')

    with tempfile.TemporaryDirectory() as directory:
        pv = Path(directory) / 'data'
        partitions = pv / 'partitions'
        partitions.mkdir(parents=True)
        volume = shared.Volume(directory, str(pv))
        evidence = walk.FloodEvictorEvidence(Cluster(), SimpleNamespace(
            namespace='lifemodel-system', cronjob='logs-evictor'), volume, since)
        for frame in frames:
            current = frame
            for day in list(partitions.iterdir()):
                if day.name not in frame.get('days', []) or frame.get('recreate'):
                    # Hold the old inode until the new directory is allocated.
                    retired = pv / ('retired-' + day.name)
                    day.rename(retired)
            for day in frame.get('days', []):
                (partitions / day).mkdir(exist_ok=True)
            evidence.poll()
        verified = evidence.verified(report)
    print(json.dumps({'verified': verified, 'events': report.events, 'calls': calls}))


if __name__ == '__main__':
    main()
