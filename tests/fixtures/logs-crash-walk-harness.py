"""Drives WALK-LOGS-CRASH's decisions against a fake cluster, metrics and API.

usage: logs-crash-walk-harness.py <mode> <walk.py> <fixture.json>
"""
import importlib.util
import json
import sys
import types


def load(path):
    spec = importlib.util.spec_from_file_location('walk_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Result:
    def __init__(self, returncode=0, stdout='', stderr=''):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeCluster:
    """crictl answers scripted per subcommand; everything else is a no-op."""

    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = []
        self.crictl = fixture.get('crictl') or {}

    def run(self, args, timeout=120, stdin=None):
        self.calls.append(' '.join(args))
        if 'ps' in args:
            return Result(0, self.crictl.get('ps', '{}'))
        if 'inspect' in args:
            return Result(0, self.crictl.get('inspect', '{}'))
        return Result(0)

    def json(self, args, timeout=120):
        return self.fixture.get('json')

    def pods(self, namespace, selector=None):
        return self.fixture.get('pods') or []

    def is_ready(self, namespace, name):
        return True


def options(**values):
    base = types.SimpleNamespace(
        password_file='', loader_host='boot-lifemodel.local', loader_port=443,
        origin_host='boot-lifemodel.local', ca_file=None, kubectl='k3s kubectl',
        namespace='lifemodel-system', store='logs-store', mount='/var/lib/lifemodel-logs',
        pv_path='/var/lib/lifemodel-logs/data', deadline_seconds=3600,
        collector_namespace='lifemodel-logs', collector='logs-collector',
        writer_namespace='lifemodel-logs-walk', metrics_port=9598, crictl='k3s crictl',
        fill_bound=2, recover_bound=2, writer_interval_ms=20, saturated_seconds=0,
        unsaturated_lines=10, settle_seconds=0,
    )
    for name, value in values.items():
        setattr(base, name, value)
    return base


MODES = {}


def mode(name):
    def register(function):
        MODES[name] = function
        return function
    return register


@mode('verdict-pass')
def verdict_pass(walk, fixture):
    report = walk.Report()
    written = list(range(1, 11))
    value = walk.crash_verdict(written, set(written), set(written), 2)
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-lost')
def verdict_lost(walk, fixture):
    report = walk.Report()
    written = list(range(1, 11))
    kubelet = set(written)
    delivered = set(written) - {7, 8}
    value = walk.crash_verdict(written, delivered, kubelet, 0)
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-rotated')
def verdict_rotated(walk, fixture):
    report = walk.Report()
    written = list(range(1, 11))
    value = walk.crash_verdict(written, set(range(4, 11)), set(range(4, 11)), 0)
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('not-valid-buffer')
def not_valid_buffer(walk, fixture):
    """No exporter: the gap names the configuration and the state is judged null."""
    report = walk.Report()
    state = walk.buffer_state({})
    print('GAP ' + json.dumps({'text': walk.collectors_metrics_gap('nothing answered port 9598'),
                               'saturated': walk.saturated(state)}))
    return report


@mode('not-valid-pid')
def not_valid_pid(walk, fixture):
    """crictl reports pid 1 (the pause container): nothing would be killed."""
    report = walk.Report()
    cluster = FakeCluster({
        'pods': [{'metadata': {'name': 'logs-collector-abc'},
                  'status': {'phase': 'Running'}}],
        'crictl': {
            'ps': json.dumps({'containers': [
                {'id': 'abc', 'labels': {'io.kubernetes.container.name': 'logs-collector'}}]}),
            'inspect': json.dumps({'info': {'pid': 1}}),
        },
    })
    pid, detail = walk.vector_pid(cluster, options())
    print('PID ' + json.dumps({'pid': pid, 'detail': detail}))
    return report


@mode('pid-real')
def pid_real(walk, fixture):
    report = walk.Report()
    cluster = FakeCluster({
        'pods': [{'metadata': {'name': 'logs-collector-abc'},
                  'status': {'phase': 'Running'}}],
        'crictl': {
            'ps': json.dumps({'containers': [
                {'id': 'abc', 'labels': {'io.kubernetes.container.name': 'logs-collector'}}]}),
            'inspect': json.dumps({'info': {'pid': 4242}}),
        },
    })
    pid, detail = walk.vector_pid(cluster, options())
    print('PID ' + json.dumps({'pid': pid, 'detail': detail}))
    return report


def run_mode(mode_name, walk_path, fixture_path):
    walk = load(walk_path)
    with open(fixture_path, encoding='utf8') as handle:
        fixture = json.load(handle)
    if mode_name not in MODES:
        raise SystemExit('unknown mode: ' + mode_name)
    report = MODES[mode_name](walk, fixture)
    return report.result()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    sys.exit(run_mode(sys.argv[1], sys.argv[2], sys.argv[3]))
