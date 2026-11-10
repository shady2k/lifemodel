"""Drives WALK-LOGS-FAILURE's decisions against a fake loader, store and cluster.

The walk is an operator script for a deployed build: this harness hands its
cases a fake loader API (the logs answers it asks for, scripted), a fake store
through the same API, a fake cluster and a fake chat, so the unit tests can hold
the pass/fail split a reviewer cannot see on this box.

usage: logs-failure-walk-harness.py <mode> <walk.py> <fixture.json>
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
    def __init__(self, returncode=0, stdout=''):
        self.returncode = returncode
        self.stdout = stdout


class FakeLoader:
    """Scripted answers: `logs` consumes its list, the rest answer once."""

    def __init__(self, fixture):
        self.log_answers = list(fixture.get('logAnswers') or [])
        self.log_calls = []
        self.json_answers = fixture.get('jsonAnswers') or {}
        self.requests = []
        self.request_answers = list(fixture.get('requestAnswers') or [])
        self.cookies = {}
        self.origin_host = 'boot-lifemodel.local'

    def logs(self, params):
        self.log_calls.append(dict(params))
        if not self.log_answers:
            return None
        index = min(len(self.log_calls) - 1, len(self.log_answers) - 1)
        answer = self.log_answers[index]
        if callable(answer):
            return answer(params)
        return answer

    def json(self, path):
        return self.json_answers.get(path)

    def csrf(self):
        return 'scripted-csrf'

    def request(self, method, path, body=None, headers=None):
        self.requests.append({'method': method, 'path': path,
                              'body': (body or b'').decode('utf8', 'replace')})
        if not self.request_answers:
            return 500, b''
        index = min(len(self.requests) - 1, len(self.request_answers) - 1)
        answer = self.request_answers[index]
        return answer.get('status', 200), json.dumps(answer.get('body', {})).encode()

    def login(self, secret):
        return 200


class FakeCluster:
    def __init__(self, fixture):
        self.fixture = fixture
        self.pods_answers = list(fixture.get('podsAnswers') or [])
        self.pods_calls = 0
        self.calls = []

    def pods(self, namespace, selector=None):
        self.pods_calls += 1
        if not self.pods_answers:
            return []
        index = min(self.pods_calls - 1, len(self.pods_answers) - 1)
        pods = self.pods_answers[index]
        return pods

    def is_ready(self, namespace, name):
        return True

    def run(self, args, timeout=120, stdin=None):
        self.calls.append(' '.join(args))
        return Result(returncode=0)

    def json(self, args, timeout=120):
        return None


def options(**values):
    base = types.SimpleNamespace(
        password_file='', loader_host='boot-lifemodel.local', loader_port=443,
        origin_host='boot-lifemodel.local', ca_file=None, kubectl='k3s kubectl',
        namespace='lifemodel-system', store='logs-store', mount='/var/lib/lifemodel-logs',
        pv_path='/var/lib/lifemodel-logs/data', deadline_seconds=3600,
        web_host='lifemodel.local', stub_namespace='lifemodel-model-walk',
        stub_port=18080, node_address='192.168.0.122', gateway='model-gateway',
        gateway_port=8080, doctor_command='lifemodel', found_bound=2, chat_bound=1,
        marker_bound=1, restart_bound=2, stub_image='loader:test',
    )
    for name, value in values.items():
        setattr(base, name, value)
    return base


def record(level, error_type=None, conversation=None, reason=None, pod='gateway-abc',
           module='model-gateway', error_check=None, error_path=None, error_got=None):
    fields = {'module': module, 'level': level, 'pod': pod}
    if error_type is not None:
        fields['error_type'] = error_type
    if conversation is not None:
        fields['conversation_id'] = conversation
    if reason is not None:
        fields['reason_check'] = reason
        fields['reason_path'] = error_path or 'choices'
        fields['reason_got'] = error_got or 'string'
    if error_check is not None:
        fields['reason_check'] = error_check
    return {'time': '2026-11-10T04:00:00.000Z', 'message': 'line', 'fields': fields}


MODES = {}


def mode(name):
    def register(function):
        MODES[name] = function
        return function
    return register


@mode('verdict-failure-pass')
def verdict_failure_pass(walk, fixture):
    report = walk.Report()
    gateway = [record('error', 'upstream_500', 'rcpt_x')]
    core = [record('info', conversation='rcpt_x', module='core', pod='core-0')]
    value = walk.failure_verdict(gateway, core, 'upstream_500')
    print('VERDICT ' + json.dumps(value['ok']))
    return report


@mode('verdict-failure-no-type')
def verdict_failure_no_type(walk, fixture):
    report = walk.Report()
    gateway = [record('error', None, 'rcpt_x')]
    core = [record('info', conversation='rcpt_x', module='core')]
    value = walk.failure_verdict(gateway, core, 'upstream_500')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-failure-no-core')
def verdict_failure_no_core(walk, fixture):
    report = walk.Report()
    gateway = [record('error', 'upstream_500', 'rcpt_x')]
    value = walk.failure_verdict(gateway, [], 'upstream_500')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-marker-pass')
def verdict_marker_pass(walk, fixture):
    report = walk.Report()
    value = walk.marker_verdict({'all:m': 0, 'core:m': 0}, 2, 'm')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-marker-in-store')
def verdict_marker_in_store(walk, fixture):
    report = walk.Report()
    value = walk.marker_verdict({'all:m': 1, 'core:m': 1}, 1, 'm')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-marker-no-capture')
def verdict_marker_no_capture(walk, fixture):
    report = walk.Report()
    value = walk.marker_verdict({'all:m': 0}, 0, 'm')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-levels')
def verdict_levels(walk, fixture):
    report = walk.Report()
    cases = {
        'error': ([record('error', 'upstream_500', 's1')], {'walk-500': 1}, 'error'),
        'no-retry': ([record('error', 'upstream_400', 's2')], {'walk-400': 1}, 'no-retry'),
        'warn': ([record('warn', 'upstream_500', 's3')], {'walk-500': 1, 'walk-ok': 1},
                 'warn-then-success'),
        'terminal': ([record('warn', 'upstream_500', 's4'),
                      record('error', 'upstream_500', 's4')],
                     {'walk-500': 2}, 'error'),
    }
    out = {}
    for name, (records, upstream, expected) in cases.items():
        out[name] = walk.level_verdict(records, upstream, expected)['ok']
    print('LEVELS ' + json.dumps(out))
    return report


@mode('verdict-level-retried-400')
def verdict_level_retried_400(walk, fixture):
    report = walk.Report()
    value = walk.level_verdict([record('warn', 'upstream_400', 's2')],
                               {'walk-400': 1, 'walk-ok': 1}, 'no-retry')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('verdict-level-warn-with-error')
def verdict_level_warn_with_error(walk, fixture):
    report = walk.Report()
    value = walk.level_verdict([record('warn', 'upstream_500', 's3'),
                                record('error', 'upstream_500', 's3')],
                               {'walk-500': 2}, 'warn-then-success')
    print('VERDICT ' + json.dumps({'ok': value['ok'], 'detail': value['detail']}))
    return report


@mode('case-levels-wiring')
def case_levels_wiring(walk, fixture):
    """The four cases driven through a fake loader, chat and counts."""
    report = walk.Report()
    loader = FakeLoader({'requestAnswers': [{'status': 200, 'body': {'ok': True}}] * 20})
    walk.gateway_request = lambda port, payload, session: (500, '{"error":{}}')
    # Before and after each case: one primary request, then the 400 with no retry,
    # then a reserve success, then a reserve failure.
    counts = [
        {'walk-500': 1},
        {'walk-500': 2},
        {'walk-400': 1},
        {'walk-400': 2},
        {'walk-500': 2, 'walk-400': 2},
        {'walk-500': 3, 'walk-400': 2, 'walk-ok': 1},
        {'walk-500': 3, 'walk-400': 2, 'walk-ok': 1},
        {'walk-500': 5, 'walk-400': 2, 'walk-ok': 1},
    ]
    reads = {'count': 0}

    def upstream(options):
        index = min(reads['count'], len(counts) - 1)
        reads['count'] += 1
        return dict(counts[index])

    walk.upstream_counts = upstream
    answers = []
    for session in ('s1', 's2', 's3', 's4'):
        if session in ('s2',):
            answers.append({'state': 'ok', 'count': 1,
                            'records': [record('error', 'upstream_400', session)]})
        elif session == 's3':
            answers.append({'state': 'ok', 'count': 1,
                            'records': [record('warn', 'upstream_500', session)]})
        elif session == 's4':
            answers.append({'state': 'ok', 'count': 2,
                            'records': [record('warn', 'upstream_500', session),
                                        record('error', 'upstream_500', session)]})
        else:
            answers.append({'state': 'ok', 'count': 1,
                            'records': [record('error', 'upstream_500', session)]})
    fallback = {'state': 'ok', 'count': 0, 'records': []}
    loader.log_answers = answers + [fallback] * 20
    state = {'gateway_port': 1234, 'level_sessions': []}
    walk.case_levels(report, options(), loader, 'token', state)
    print('SESSIONS ' + json.dumps(state['level_sessions']))
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
