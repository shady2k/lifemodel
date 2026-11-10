"""Observe the crash walk's baseline and bound before any monitored stage."""
import importlib.util
import json
import sys
import types


def main():
    spec = importlib.util.spec_from_file_location('crash_load_walk', sys.argv[1])
    walk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(walk)
    fixture = json.loads(sys.argv[2])
    events = []
    observed = {}

    def load():
        events.append('baseline')
        if fixture.get('missing_load'):
            raise OSError('unreadable loadavg')
        return fixture.get('baseline', 3.0)

    def cpus():
        events.append('cpus')
        return fixture.get('cpus', 4)

    class Monitor:
        def __init__(self, **kwargs):
            events.append('monitor-created')
        def start(self):
            events.append('monitor-started')
        def join(self):
            events.append('monitor-joined')

    def stage(report, options, loader, cluster, state):
        events.append('writers')
        observed['bound'] = options.max_load
        return True

    walk.node_load = load
    walk.os.cpu_count = cpus
    walk.threading.Thread = Monitor
    walk.Cluster = lambda *_args: None
    walk.read_password = lambda _path: 'fixture-only'
    walk.Loader = lambda *_args: types.SimpleNamespace(login=lambda _secret: 200)
    walk.run = stage
    walk.restore = lambda *_args: events.append('restore')
    status = walk.main(['--password-file', 'unused'] + fixture.get('args', []))
    print('OBSERVED ' + json.dumps({'status': status, 'events': events, **observed}))
    return status


if __name__ == '__main__':
    sys.exit(main())
