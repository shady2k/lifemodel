"""Drives the stage-2 ADR-016 walks against a fake node.

Each walk is an operator script for a deployed cluster. These modes hand one
walk's decision functions a fake loader, a fake store, a fake kubectl and a fake
volume, so the unit tests can hold what a reviewer cannot see on this box: the
PASS/FAIL split, the arithmetic, and the `TEST NOT VALID` exit for a walk that
never reached the state it asserts on.

usage: logs-walk-stage2-harness.py <mode> <walk.py> <fixture.json>
"""
import importlib.util
import json
import os
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


class FakeLoader:
    """Scripted answers: the last entry answers every later call."""

    def __init__(self, fixture):
        self.status_answers = fixture.get('statusAnswers', [])
        self.json_answers = fixture.get('jsonAnswers', {})
        self.put_answers = fixture.get('putAnswers', [])
        self.status_calls = 0
        self.json_calls = {}
        self.put_calls = []
        self.log_calls = []
        self.log_answers = fixture.get('logAnswers', [])
        self.settings_answers = fixture.get('settingsAnswers', [])
        self.settings_calls = 0
        self.logs_calls = 0

    def logs_status(self, from_ms, to_ms):
        index = min(self.status_calls, len(self.status_answers) - 1) if self.status_answers else 0
        self.status_calls += 1
        if not self.status_answers:
            return {'state': 'unavailable', 'reason': 'scripted_absent'}
        return self.status_answers[index]

    def json(self, path):
        answers = self.json_answers.get(path, [{}])
        index = self.json_calls.get(path, 0)
        self.json_calls[path] = index + 1
        return answers[min(index, len(answers) - 1)]

    def logs(self, params):
        index = min(self.logs_calls, len(self.log_answers) - 1) if self.log_answers else 0
        self.logs_calls += 1
        if not self.log_answers:
            return None
        return self.log_answers[index]

    def settings(self):
        index = min(self.settings_calls, len(self.settings_answers) - 1) if self.settings_answers else 0
        self.settings_calls += 1
        if not self.settings_answers:
            return None
        return self.settings_answers[index]

    def put_settings(self, days, max_bytes, csrf, origin=None, content_type='application/json'):
        index = min(len(self.put_calls), len(self.put_answers) - 1) if self.put_answers else 0
        self.put_calls.append({'days': days, 'maxBytes': max_bytes, 'csrf': csrf,
                               'origin': origin, 'contentType': content_type})
        if not self.put_answers:
            return 0, {'state': 'unreadable'}
        answer = self.put_answers[index]
        return answer.get('status', 200), answer.get('body', {})

    def login(self, secret):
        return 200

    def csrf(self):
        return 'scripted-csrf'


class FakeStore:
    """Scripted store: metrics, flags, insert statuses and query answers."""

    def __init__(self, fixture):
        self.metric_answers = fixture.get('metricAnswers', [{}])
        self.flags_answers = fixture.get('flagsAnswers', [{}])
        self.insert_statuses = fixture.get('insertStatuses', [200])
        self.query_answers = fixture.get('queryAnswers', [])
        self.detach_answers = fixture.get('detachAnswers', [{'status': 200, 'body': 'ok'}])
        self.partition_list_answers = fixture.get('partitionListAnswers', [{'status': 200, 'body': 'ok'}])
        self.inserts = []
        self.queries = []
        self.detaches = []
        self.partition_lists = 0

    def metrics(self):
        index = min(len(self.inserts), len(self.metric_answers) - 1)
        return self.metric_answers[index]

    def flags(self):
        index = min(len(self.detaches), len(self.flags_answers) - 1)
        return self.flags_answers[index]

    def insert(self, lines, timeout=120):
        index = min(len(self.inserts), len(self.insert_statuses) - 1)
        self.inserts.append(lines)
        return self.insert_statuses[index], b''

    def query(self, logsql, timeout=60):
        index = len(self.queries)
        self.queries.append(logsql)
        if not self.query_answers:
            return []
        return self.query_answers[min(index, len(self.query_answers) - 1)]

    def count(self, logsql, timeout=60):
        return len(self.query(logsql, timeout))

    def detach(self, day, key):
        index = min(len(self.detaches), len(self.detach_answers) - 1)
        self.detaches.append({'day': day, 'key': key})
        answer = self.detach_answers[index]
        return answer.get('status', 200), answer.get('body', '')

    def partition_list(self, key=None):
        index = min(self.partition_lists, len(self.partition_list_answers) - 1)
        self.partition_lists += 1
        answer = self.partition_list_answers[index]
        return answer.get('status', 200), answer.get('body', '')

    def close(self):
        return None


class FakeCluster:
    """A fake kubectl: the DaemonSet JSON, pod lists, and scripted patch results.

    The collector's readiness follows the number of patches the walk applied, so
    a fixture says "Ready, then stopped by the first patch, then Ready again":
    that is the sequence a restart walks through, without counting polls.
    """

    def __init__(self, fixture):
        self.daemonset = fixture.get('daemonset')
        self.collector_states = fixture.get('collectorStates', [{'ready': 1, 'desired': 1,
                                                                 'readyPods': 1}])
        self.patch_script = fixture.get('patchScript', [])
        self.patches = []
        self.secret = fixture.get('secret', '')
        self.calls = []

    def run(self, args, timeout=120, stdin=None):
        joined = ' '.join(args)
        self.calls.append(joined)
        if 'patch' in args:
            payload = ''
            if '-p' in args:
                payload = args[args.index('-p') + 1]
            index = min(len(self.patches), len(self.patch_script) - 1)
            code = self.patch_script[index] if self.patch_script else 0
            self.patches.append(payload)
            return Result(returncode=code)
        return Result(returncode=0)

    def current_state(self):
        return self.collector_states[min(len(self.patches), len(self.collector_states) - 1)]

    def json(self, args, timeout=120):
        self.calls.append(' '.join(args))
        if 'daemonset' in args:
            body = json.loads(json.dumps(self.daemonset))
            state = self.current_state()
            body.setdefault('status', {})['numberReady'] = state.get('ready', 0)
            body['status']['desiredNumberScheduled'] = state.get('desired', 0)
            return body
        if 'pods' in args:
            return {'items': self.pods(None)}
        return None

    def pods(self, namespace, selector=None):
        state = self.current_state()
        items = []
        for _ in range(state.get('readyPods', 0)):
            items.append({'metadata': {'name': 'collector-pod'},
                          'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}})
        return items


class FakeVolume:
    def __init__(self, fixture):
        self.total = fixture.get('totalBytes', 3 * 1024**3)
        self.avail = fixture.get('availBytes', 2 * 1024**3)
        self.step = fixture.get('availStepBytes', 64 * 1024**2)
        self.floor = fixture.get('availFloorBytes', 0)
        self.is_mounted = fixture.get('mounted', True)
        self.days = fixture.get('partitions', [])
        self.writes = 0
        self.removed = []
        self.filler_cleared = False

    def mounted(self):
        return self.is_mounted

    def space(self):
        return self.total, self.avail

    def prepare_filler(self, uid=1000, gid=1000):
        return None

    def write_filler(self, chunk_bytes, uid=1000, gid=1000):
        self.writes += 1
        self.avail = max(self.floor, self.avail - self.step)
        return True

    def clear_filler(self):
        self.filler_cleared = True
        return True

    def partitions(self):
        return list(self.days)

    def remove_day(self, day):
        self.removed.append(day)


def options(**values):
    base = types.SimpleNamespace(
        password_file='', loader_host='boot-lifemodel.local', loader_port=443,
        origin_host='boot-lifemodel.local', ca_file=None, kubectl='k3s kubectl',
        namespace='lifemodel-system', store='logs-store', mount='/var/lib/lifemodel-logs',
        pv_path='/var/lib/lifemodel-logs/data', deadline_seconds=3600,
        stopped_bound=5, live_bound=5, ready_timeout=5, fill_timeout=5,
        heartbeat_fresh=60, stop_label_key='lifemodel.dev/walk-fresh-stop',
        byte_bound_mib=300, today_mib=1, old_day_mib=1, old_days=2, days_case=14,
        age_days=1, age_old_days_back=3, largest_max_bytes=None, largest_extra_bytes=1,
        loader_namespace='lifemodel-system', loader_selector='app.kubernetes.io/name=loader',
        apply_bound=5, flag_wait=5, flood_seconds=1, fill_bound=5, writer_rate=5,
        peak_bytes=0, index_poll=1, query_count=40, limit_ms=2500, page_limit=250,
        same_time_records=4, identical_records=2, window_minutes=60,
        ingest_mib_per_s=1, paging_minutes_back=3, keep_mib=0,
    )
    for name, value in values.items():
        setattr(base, name, value)
    return base


def status_answer(state='live', stopped_for_ms=None, read_only=None, evictions=None,
                  evictor_stale=None):
    return {
        'state': 'ok', 'records': [], 'count': 0, 'offset': 0, 'limit': 1,
        'incomplete': False,
        'status': {
            'collection': {'state': state, 'stoppedForMs': stopped_for_ms},
            'storeReadOnly': read_only,
            'evictor': {'lastSuccessAt': None, 'stale': evictor_stale},
            'evictions': evictions or [],
        },
    }


DAEMONSET = {
    'spec': {'template': {'spec': {
        'volumes': [
            {'name': 'pods', 'hostPath': {'path': '/var/log/pods', 'type': 'Directory'}},
            {'name': 'checkpoints', 'hostPath': {'path': '/var/lib/lifemodel-logs-collector'}},
            {'name': 'config', 'configMap': {'name': 'logs-collector-config'}},
        ],
    }}},
}

SETTING_APPLIED = {
    'state': 'ok', 'days': 7, 'maxBytes': 314572800, 'desiredRevision': '2-abcdef',
    'appliedRevision': '2-abcdef', 'appliedAt': '2026-11-09T00:00:00Z', 'applied': True,
    'pending': None, 'limits': {'volumeBytes': 3221225472, 'evictorThresholdBytes': 1610612736,
                                'largestMaxBytes': 1610612736},
    'fitsVolume': True,
}

SETTING_PENDING = dict(SETTING_APPLIED, applied=False, appliedRevision=None, appliedAt=None,
                       pending='store_unavailable')


MODES = {}


def mode(name):
    def register(function):
        MODES[name] = function
        return function
    return register


@mode('fresh-never-stopped')
def fresh_never_stopped(walk, fixture):
    report = walk.Report()
    cluster = FakeCluster({'daemonset': DAEMONSET,
                           'collectorStates': [{'ready': 1, 'desired': 1, 'readyPods': 1}],
                           'patchScript': [0]})
    loader = FakeLoader({'statusAnswers': [status_answer('live', read_only=False)]})
    walk.run(report, options(ready_timeout=1), loader, cluster, FakeStore({}), FakeVolume({}), {})
    return report


@mode('fresh-stopped')
def fresh_stopped(walk, fixture):
    report = walk.Report()
    cluster = FakeCluster({
        'daemonset': DAEMONSET,
        # preflight Ready, stopped after the patch, Ready again after the restore
        'collectorStates': [
            {'ready': 1, 'desired': 1, 'readyPods': 1},
            {'ready': 0, 'desired': 0, 'readyPods': 0},
            {'ready': 1, 'desired': 1, 'readyPods': 1},
        ],
        'patchScript': [0, 0, 1],
    })
    loader = FakeLoader({'statusAnswers': [
        status_answer('live', read_only=False),
        status_answer('stopped', stopped_for_ms=140000, read_only=False),
        status_answer('live', read_only=False),
    ]})
    walk.run(report, options(), loader, cluster, FakeStore({}), FakeVolume({}), {})
    return report


@mode('fresh-read-only')
def fresh_read_only(walk, fixture):
    report = walk.Report()
    store = FakeStore({'metricAnswers': [{'vl_storage_is_read_only': 1.0}]})
    loader = FakeLoader({'statusAnswers': [
        status_answer('live', read_only=False),
        status_answer('live', read_only=True),
    ]})
    walk.watch_read_only(report, loader, store,
                         'the API says the store is refusing writes (read-only)', 5, 700 * 1024**2)
    return report


@mode('fresh-read-only-never')
def fresh_read_only_never(walk, fixture):
    report = walk.Report()
    store = FakeStore({'metricAnswers': [{'vl_storage_is_read_only': 0.0}]})
    loader = FakeLoader({'statusAnswers': [status_answer('live', read_only=False)]})
    walk.watch_read_only(report, loader, store,
                         'the API says the store is refusing writes (read-only)', 1, 700 * 1024**2)
    return report


@mode('fresh-fill-never')
def fresh_fill_never(walk, fixture):
    report = walk.Report()
    volume = FakeVolume({'totalBytes': 3 * 1024**3, 'availBytes': 2 * 1024**3,
                         'availStepBytes': 0})
    reached, avail, threshold = walk.fill_volume(report, options(fill_timeout=1), volume,
                                                 FakeStore({}))
    print('REACHED %s %d %d' % (reached, avail, threshold))
    return report


@mode('setting-apply')
def setting_apply(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({
        'putAnswers': [{'status': 200, 'body': SETTING_PENDING}],
        'settingsAnswers': [SETTING_PENDING, SETTING_APPLIED],
    })
    walk.apply_change(report, loader, 7, 314572800, 5)
    return report


@mode('setting-never-applied')
def setting_never_applied(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({
        'putAnswers': [{'status': 200, 'body': SETTING_PENDING}],
        'settingsAnswers': [SETTING_PENDING],
    })
    walk.apply_change(report, loader, 7, 314572800, 1)
    return report


@mode('setting-refusal')
def setting_refusal(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({'putAnswers': [{'status': 403, 'body': {'state': 'refused'}},
                                        {'status': 403, 'body': {'state': 'refused'}}]})
    walk.check_refusals(report, loader, 7, 314572800)
    return report


@mode('setting-flags')
def setting_flags(walk, fixture):
    report = walk.Report()
    expected = walk.desired_flags(7, 300 * 1024 * 1024, 3 * 1024**3)
    agree, observed, wanted = walk.flags_agree({
        'retentionPeriod': '7d',
        'retention.maxDiskSpaceUsageBytes': '314572800',
        'storage.minFreeDiskSpaceBytes': '805306368',
    }, expected)
    print('FLAGS ' + json.dumps({'agree': agree, 'days': observed['days'],
                                 'maxBytes': observed['maxBytes'],
                                 'minFreeBytes': observed['minFreeBytes']}))
    return report


BOUND_LIMITS = {'volumeBytes': 3221225472, 'evictorThresholdBytes': 1610612736,
                'largestMaxBytes': 1610612736}

BOUND_REFUSED = {
    'status': 400,
    'body': {'state': 'refused', 'reason': 'above_volume', 'maxBytes': 1610612737,
             'largestMaxBytes': 1610612736, 'volumeBytes': 3221225472,
             'evictorThresholdBytes': 1610612736},
}

BOUND_ACCEPTED = {'status': 200, 'body': {'state': 'ok', 'applied': True, 'pending': None,
                                          'days': 14, 'maxBytes': 1610612736,
                                          'desiredRevision': '3-abcdef'}}


@mode('bound-refusal')
def bound_refusal(walk, fixture):
    report = walk.Report()
    walk.check_limits(report, BOUND_LIMITS)
    loader = FakeLoader({'putAnswers': [BOUND_REFUSED, BOUND_ACCEPTED, BOUND_ACCEPTED]})
    walk.check_refusals(report, options(), loader, 14, BOUND_LIMITS)
    return report


@mode('bound-refusal-accepted')
def bound_refusal_accepted(walk, fixture):
    report = walk.Report()
    walk.check_limits(report, BOUND_LIMITS)
    loader = FakeLoader({'putAnswers': [BOUND_ACCEPTED]})
    walk.check_refusals(report, options(), loader, 14, BOUND_LIMITS)
    return report


@mode('bound-days')
def bound_days(walk, fixture):
    report = walk.Report()
    aged = walk.only_older_days_removed(['20261030', '20261105', '20261109'], ['20261109'],
                                        '20261108')
    younger = walk.only_older_days_removed(['20261107', '20261109'], ['20261109'], '20261105')
    print('DAYS ' + json.dumps({'olderOnly': aged['olderOnly'],
                                'youngerRemoved': aged['youngerRemoved'],
                                'youngerCase': younger['youngerRemoved'],
                                'dropped': aged['dropped']}))
    return report


@mode('bound-canary-absent')
def bound_canary_absent(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({'logAnswers': [{'state': 'ok', 'count': 0}]})
    walk.require_records(report, loader, 0, 'walk-bound-1', 200,
                         'the canary 10 days back is stored before the flood')
    return report


@mode('bound-count')
def bound_count(walk, fixture):
    report = walk.Report()
    loader = FakeLoader({'logAnswers': [{'state': 'ok', 'count': 200}]})
    print('COUNT %d' % walk.records_in_window(loader, 0, 'walk-bound-1'))
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
