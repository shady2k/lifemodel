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

    def logs_status(self, from_ms, to_ms):
        return {'state': 'ok', 'status': {}}

    def csrf(self):
        return 'scripted-csrf'

    def request(self, method, path, body=None, headers=None):
        self.requests.append({'method': method, 'path': path,
                              'body': (body or b'').decode('utf8', 'replace'),
                              'headers': dict(headers or {})})
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
        web_host='lifemodel.local', web_namespace='lifemodel', web_service='web',
        web_port=8080, slot_bound=2, stub_bound=2,
        stub_namespace='lifemodel-model-walk',
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


MODE_OPTIONS = options()


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


def level_plan(options):
    """Cumulative stub counts from the requests sent so far, per case."""
    plan = [[('walk-500', 1)], [('walk-400', 1)], [('walk-500', 1), ('walk-ok', 1)],
            [('walk-500', 2)]]
    sent = options['sent']
    total = {'walk-500': 0, 'walk-400': 0, 'walk-ok': 0}
    for step in range(sent):
        for model, count in plan[min(step, len(plan) - 1)]:
            total[model] += count
    return total


def case_levels_fixture(walk, statuses):
    report = walk.Report()
    loader = FakeLoader({'requestAnswers': [{'status': 200, 'body': {'ok': True}}] * 20})
    marker = {'sent': 0}

    def request(port, payload, session):
        index = min(marker['sent'], len(statuses) - 1)
        status = statuses[index]
        marker['sent'] += 1
        return status, ''

    walk.gateway_request = request
    walk.upstream_counts = lambda options: level_plan(marker)
    walk.wait_slots_live = lambda report, options, state, expected, what: True
    loader.log_answers = [
        {'state': 'ok', 'count': 1, 'records': [record('error', 'upstream_500', 's1')]},
        {'state': 'ok', 'count': 1, 'records': [record('error', 'upstream_400', 's2')]},
        {'state': 'ok', 'count': 1, 'records': [record('warn', 'upstream_500', 's3')]},
        {'state': 'ok', 'count': 2, 'records': [record('warn', 'upstream_500', 's4'),
                                                record('error', 'upstream_500', 's4')]},
    ] + [{'state': 'ok', 'count': 0, 'records': []}] * 20
    state = {'gateway_port': 1234, 'level_sessions': []}
    walk.case_levels(report, options(slot_bound=1), loader, 'token', state)
    print('SESSIONS ' + json.dumps(state['level_sessions']))
    return report


@mode('case-levels-wiring')
def case_levels_wiring(walk, fixture):
    """The four cases driven through a fake loader, gateway and stub counts."""
    return case_levels_fixture(walk, [500, 500, 200, 500])


@mode('level-success-status')
def level_success_status(walk, fixture):
    """The reserve that succeeds answers 200 and the case expects it; 500 there fails."""
    return case_levels_fixture(walk, [500, 500, 200, 500])


@mode('level-success-wrong')
def level_success_wrong(walk, fixture):
    """The reserve that succeeds answering 500 is a failure of that case."""
    return case_levels_fixture(walk, [500, 500, 500, 500])


@mode('slots-live-pass')
def slots_live_pass(walk, fixture):
    """The probe shows the new slots on the third try: the wait passes."""
    report = walk.Report()
    counts = [{'walk-500': 1}, {'walk-500': 1}, {'walk-500': 1}, {'walk-500': 2}]
    reads = {'count': 0}

    def upstream(options):
        index = min(reads['count'], len(counts) - 1)
        reads['count'] += 1
        return dict(counts[index])

    walk.upstream_counts = upstream
    walk.gateway_request = lambda port, payload, session: (500, '')
    state = {'gateway_port': 1234}
    ok = walk.wait_slots_live(report, options(slot_bound=1), state, {'walk-500': 1}, 'case')
    print('LIVE ' + json.dumps(ok))
    return report


@mode('slots-live-stale')
def slots_live_stale(walk, fixture):
    """The old slots keep serving: a FAIL and a not-valid, never a pass."""
    report = walk.Report()
    walk.upstream_counts = lambda options: {'walk-ok': 5}
    walk.gateway_request = lambda port, payload, session: (200, '')
    state = {'gateway_port': 1234}
    ok = walk.wait_slots_live(report, options(slot_bound=1), state, {'walk-500': 1}, 'case')
    print('LIVE ' + json.dumps(ok))
    return report


@mode('capture-readback')
def capture_readback(walk, fixture):
    """The capture is judged on the API's own answer after every PUT."""
    report = walk.Report()
    loader = FakeLoader({'requestAnswers': [{'status': 200, 'body': {'until': None}}],
                         'jsonAnswers': {'/api/model-capture': {'until': None}}})
    read = walk.put_capture_checked(report, loader, 'token', {'durationMs': None}, 'off')
    print('CAPTURE ' + json.dumps({'off': walk.capture_off(read),
                                   'on': walk.capture_on(read)}))
    loader.json_answers['/api/model-capture'] = {'mode': 'until-disabled'}
    read = walk.put_capture_checked(report, loader, 'token', {'durationMs': None}, 'off')
    print('CAPTURE ' + json.dumps({'off': walk.capture_off(read),
                                   'on': walk.capture_on(read)}))
    return report


@mode('delete-reserve')
def delete_reserve(walk, fixture):
    """The reserve is cleared with the endpoint's own content type and empty object."""
    report = walk.Report()
    loader = FakeLoader({'requestAnswers': [{'status': 200, 'body': {}}]})
    status = walk.delete_reserve(loader, 'token')
    print('DELETE ' + json.dumps({'status': status, 'request': loader.requests[0]}))
    return report


@mode('restore-compare')
def restore_compare(walk, fixture):
    """The read-back comparison names what differs, and passes when it does not."""
    report = walk.Report()
    saved = {'primary': {'kind': 'openai', 'baseUrl': 'http://192.168.0.122:18080/v1',
                         'model': 'walk-500', 'keySet': True},
             'reserve': None}
    same = {'primary': {'kind': 'openai', 'baseUrl': 'https://api.example.com/v1',
                        'model': 'gpt', 'keySet': True}, 'reserve': None}
    other = {'primary': {'kind': 'openai', 'baseUrl': 'https://api.example.com/v1',
                         'model': 'other', 'keySet': False},
             'reserve': {'kind': 'openai', 'baseUrl': 'https://api.example.com/v1',
                         'model': 'r', 'keySet': True}}
    print('COMPARE ' + json.dumps({'same': walk.slots_agree(same, {
        'primary': dict(same['primary']), 'reserve': None}),
        'keyOnly': walk.slots_agree(same, {
            'primary': {**same['primary'], 'keySet': False}, 'reserve': None}),
        'changed': walk.slots_agree(same, other)}))
    return report


@mode('chat-unreachable')
def chat_unreachable(walk, fixture):
    """A closed port names the URL and the exception type, never a silent status."""
    report = walk.Report()
    accepted, detail = walk.chat_intake(1, MODE_OPTIONS, 'walk message', 0)
    print('CHAT ' + json.dumps({'accepted': accepted, 'detail': detail}))
    return report


@mode('capture-restore')
def capture_restore(walk, fixture):
    """The read-back is judged in the API's own shape, until-disabled included."""
    report = walk.Report()
    now = 1_794_240_000_000
    cases = {
        'untilDisabled': ({"mode": "until-disabled"}, {"mode": "until-disabled"}),
        'untilDisabledMismatch': ({"mode": "until-disabled"}, {"until": None}),
        'off': ({"until": None}, {"until": None}),
        'offMismatch': ({"until": None}, {"mode": "until-disabled"}),
        'until': ({"until": "2026-11-10T05:00:00.000Z"},
                  {"until": "2026-11-10T05:00:01.000Z"}),
        'untilMismatch': ({"until": "2026-11-10T05:00:00.000Z"}, {"until": None}),
    }
    print('AGREE ' + json.dumps({
        name: walk.capture_agrees(saved, read, now) for name, (saved, read) in cases.items()
    }))
    return report


def core_failure_record(conversation, message):
    return {'time': '2026-11-10T09:37:02.000Z', 'message': message,
            'fields': {'module': 'core', 'level': 'error', 'pod': 'core-0',
                       'conversation_id': conversation}}


def stored_core_line(conversation):
    """The record as the collector stores it: the core's whole JSON line in `message`."""
    return json.dumps({'level': 50, 'time': 1794241022000,
                       'conversation_id': conversation, 'msg': 'COGNITION failed'})


@mode('marker-turn')
def marker_turn(walk, fixture):
    """The stored line is JSON whose `msg` names the failure: the wait finds it."""
    report = walk.Report()
    loader = FakeLoader({})
    loader.log_answers = [{'state': 'ok', 'count': 1,
                           'records': [core_failure_record('rcpt_x', stored_core_line('rcpt_x'))]}]
    found = walk.wait_marker_turn(report, options(core_bound=2), loader, 0,
                                  {'fields': {'conversation_id': 'rcpt_x'}}, 'a marker')
    print('TURN ' + json.dumps({'found': found, 'text': loader.log_calls[0].get('text')}))
    return report


@mode('marker-turn-other')
def marker_turn_other(walk, fixture):
    """A stored line whose msg is another event is not the final failure."""
    report = walk.Report()
    loader = FakeLoader({})
    other = json.dumps({'level': 50, 'msg': 'LLM request failed'})
    loader.log_answers = [{'state': 'ok', 'count': 1,
                           'records': [core_failure_record('rcpt_x', other)]}]
    found = walk.wait_marker_turn(report, options(core_bound=0), loader, 0,
                                  {'fields': {'conversation_id': 'rcpt_x'}}, 'a marker')
    print('TURN ' + json.dumps({'found': found}))
    return report


@mode('marker-turn-plain')
def marker_turn_plain(walk, fixture):
    """An older core logs plain text; the line is its own message."""
    report = walk.Report()
    loader = FakeLoader({})
    loader.log_answers = [{'state': 'ok', 'count': 1,
                           'records': [core_failure_record('rcpt_x', 'COGNITION failed')]}]
    found = walk.wait_marker_turn(report, options(core_bound=2), loader, 0,
                                  {'fields': {'conversation_id': 'rcpt_x'}}, 'a marker')
    print('TURN ' + json.dumps({'found': found}))
    return report


@mode('late-core')
def late_core(walk, fixture):
    """The core's lines arrive on a later poll: the wait finds them."""
    report = walk.Report()
    loader = FakeLoader({})
    loader.log_answers = [
        {'state': 'ok', 'count': 0, 'records': []},
        {'state': 'ok', 'count': 0, 'records': []},
        {'state': 'ok', 'count': 1,
         'records': [record('error', conversation='rcpt_x', module='core', pod='core-0')]},
    ]
    lines = walk.wait_core_lines(loader, 0, 'rcpt_x', 20)
    print('CORE ' + json.dumps({'lines': len(lines), 'polls': len(loader.log_calls)}))
    return report


@mode('never-core')
def never_core(walk, fixture):
    """The core never writes under the conversation: no lines, bounded."""
    report = walk.Report()
    loader = FakeLoader({'logAnswers': [{'state': 'ok', 'count': 0, 'records': []}]})
    lines = walk.wait_core_lines(loader, 0, 'rcpt_x', 1)
    print('CORE ' + json.dumps({'lines': len(lines), 'polls': len(loader.log_calls)}))
    return report


@mode('late-capture')
def late_capture(walk, fixture):
    """The reader holds the marker on a later poll: the wait finds it."""
    report = walk.Report()
    answers = ['exchange call=1 session=s time=t' + chr(10),
               '/tmp/x exchange call=1 ... walk-marker-a' + chr(10)]
    calls = {'count': 0}

    def reader(options, bound):
        index = min(calls['count'], len(answers) - 1)
        calls['count'] += 1
        return answers[index]

    walk.exchange_text = reader
    text, hits, exchanges = walk.wait_capture_text(options(marker_bound=20),
                                                   ['walk-marker-a'], 20)
    print('CAPTURE ' + json.dumps({'hits': hits, 'exchanges': exchanges,
                                   'polls': calls['count']}))
    return report


@mode('never-capture')
def never_capture(walk, fixture):
    """The reader never holds the marker: the exchange count says what it saw."""
    report = walk.Report()
    walk.exchange_text = lambda options, bound: 'exchange call=1 session=s time=t\n' \
        'exchange call=2 session=s time=t\n'
    text, hits, exchanges = walk.wait_capture_text(options(marker_bound=0),
                                                   ['walk-marker-a'], 0)
    print('CAPTURE ' + json.dumps({'hits': hits, 'exchanges': exchanges}))
    return report


class FakeForward:
    """A port-forward the mode scripts: it either answers or dies with kubectl's words."""

    def __init__(self, ready, death='', local_port=34567):
        self.ready = ready
        self.death = death
        self.local_port = local_port
        self.log_path = 'harness-forward.log'
        self.closed = False
        self.started = False

    def start(self):
        self.started = True
        return self

    def wait_ready(self, timeout=90):
        return self.ready

    def log_tail(self, count=20):
        return ['error: unable to forward port because pod is not running'] \
            if not self.ready else []

    def close(self, keep_log=False):
        self.closed = True


def early_exit_mode(walk, fixture):
    """Drive `run` through an early exit the mode scripts, and report both outcomes."""
    report = walk.Report()
    mode = fixture['mode']
    forwards = []
    if mode == 'stub-never':
        walk.stub_stats = lambda options: None
    else:
        walk.stub_stats = lambda options: {'counts': {}}

    class Scripted:
        def __call__(self, kubectl, namespace, target, local_port, remote_port):
            index = len(forwards)
            if mode == 'gateway-forward' and index == 0:
                forwards.append(FakeForward(False, 'nothing accepted 127.0.0.1:34567 within 90 s'))
            elif mode == 'web-forward' and index == 1:
                forwards.append(FakeForward(False, 'nothing accepted 127.0.0.1:34567 within 90 s'))
            else:
                forwards.append(FakeForward(True))
            return forwards[-1]

    walk.PortForward = Scripted()
    loader = FakeLoader({})
    if mode == 'no-csrf':
        loader.csrf = lambda: None
    ran = walk.run(report, options(stub_bound=0), loader, FakeCluster({}), {})
    print('RUN ' + json.dumps(ran))
    print('EXIT ' + json.dumps(walk.exit_code(report, ran)))
    return report


@mode('stub-never')
def stub_never(walk, fixture):
    return early_exit_mode(walk, {**fixture, 'mode': 'stub-never'})


@mode('gateway-forward')
def gateway_forward(walk, fixture):
    return early_exit_mode(walk, {**fixture, 'mode': 'gateway-forward'})


@mode('web-forward')
def web_forward(walk, fixture):
    return early_exit_mode(walk, {**fixture, 'mode': 'web-forward'})


@mode('no-csrf')
def no_csrf(walk, fixture):
    return early_exit_mode(walk, {**fixture, 'mode': 'no-csrf'})



@mode('reserve-preflight')
def reserve_preflight(walk, fixture):
    report = walk.Report()
    primary = {'kind': 'openai', 'baseUrl': 'https://owner.example/v1',
               'model': 'owner', 'keySet': True}
    loader = FakeLoader({'jsonAnswers': {'/api/model': {
        'primary': primary, 'reserve': dict(primary)}}})
    cluster = FakeCluster({})
    walk.Loader = lambda *args: loader
    walk.Cluster = lambda *args: cluster
    walk.read_password = lambda path: 'fixture-only'
    status = walk.main(['--password-file', 'fixture-only'])
    print('PREFLIGHT ' + json.dumps({'ok': status == 0, 'writes': loader.requests,
                                    'clusterWrites': cluster.calls}))
    report.failures = int(status != 0)
    return report


@mode('put-key-omitted')
def put_key_omitted(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({'requestAnswers': [{'status': 200}]})
    walk.put_slot(loader, 'token', 'primary', {
        'baseUrl': 'https://owner.example/v1', 'model': 'owner', 'keySet': True})
    print('BODY ' + loader.requests[0]['body'])
    return report


@mode('store-unavailable')
@mode('inventory-unavailable')
def store_unavailable(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({'jsonAnswers': {'/api/logs/modules':
        None if fixture.get('inventory') else {'state': 'ok', 'modules': ['core']}},
        'logAnswers': [{'state': 'unavailable'}]})
    counts = walk.store_counts_for(report, loader, ['marker'], 0)
    print('SEARCH ' + json.dumps({'counts': counts, 'calls': len(loader.log_calls)}))
    return report


@mode('marker-final-turn')
def marker_final_turn(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({})
    calls = []
    def logs(params):
        calls.append(dict(params))
        line = record('error', conversation=params.get('conversation_id'), module='core')
        line['message'] = ('Agentic loop failed' if len(calls) == 1
                           else 'COGNITION failed')
        return {'state': 'ok', 'records': [line]}
    loader.logs = logs
    walk.time.sleep = lambda seconds: None
    ok = walk.wait_marker_turn(report, options(core_bound=2), loader, 0,
                               record('error', 'bad_response', 'rcpt_x'), 'marker')
    print('TURN ' + json.dumps({'ok': ok, 'calls': calls}))
    return report


@mode('marker-reason-fields')
def marker_reason_fields(walk, fixture):
    report = walk.Report()
    line = record('error', 'bad_response', 'rcpt_x', reason='array')
    del line['fields']['reason_path']
    print('REASON ' + json.dumps(walk.reason_complete(line)))
    return report


@mode('marker-ordering')
def marker_ordering(walk, fixture):
    report = walk.Report()
    events = []
    walk.capture_setting = lambda loader: {'until': None}
    walk.put_capture_checked = lambda report, loader, token, body, what: (
        {'until': None} if what == 'off' else {'until': 'future'})
    walk.point_slots = lambda *args: (True, 'set')
    walk.wait_slots_live = lambda *args: True
    walk.upstream_count = lambda *args: 0
    walk.chat_intake = lambda *args: (True, 'accepted')
    walk.wait_planted = lambda *args: True
    sequence = {'n': 0}
    def gateway(loader, started, conversation, expected, bound):
        sequence['n'] += 1
        line = record('error', expected, 'turn-%d' % sequence['n'], reason='array')
        events.append('gateway')
        return line
    walk.wait_record = gateway
    def core(report, options, loader, started, line, label):
        events.append('core-final-' + line['fields']['conversation_id'])
        return True
    walk.wait_marker_turn = core
    def searches(report, loader, markers, started):
        events.append('search')
        return {'all:' + marker: 0 for marker in markers}
    walk.store_counts_for = searches
    walk.wait_capture_text = lambda *args: ('', [1, 1], 2)
    ok = walk.case_marker(report, options(markers={'non2xx': 'a', 'refused': 'b'}),
                          FakeLoader({}), 'token', FakeCluster({}), {'web_port': 1234})
    print('ORDER ' + json.dumps({'ok': ok, 'events': events}))
    return report

@mode('restore-key-lost')
def restore_key_lost(walk, fixture):
    report = walk.Report()
    primary = {'kind': 'openai', 'baseUrl': 'https://owner.example/v1',
               'model': 'owner', 'keySet': True}
    loader = FakeLoader({'requestAnswers': [{'status': 200}],
        'jsonAnswers': {'/api/model': {'primary': {**primary, 'keySet': False},
                                     'reserve': None}}})
    walk.restore(report, options(), loader, 'token', FakeCluster({}),
                 {'slots': {'primary': primary, 'reserve': None}, 'hadReserve': False})
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
