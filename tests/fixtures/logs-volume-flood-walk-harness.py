"""Drives WALK-LOGS-VOLUME-FLOOD's decisions against fake inputs.

usage: logs-volume-flood-walk-harness.py <mode> <walk.py> <fixture.json>
"""
import importlib.util
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch


def load(path):
    spec = importlib.util.spec_from_file_location('walk_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODES = {}


def mode(name):
    def register(function):
        MODES[name] = function
        return function
    return register


@mode('writer-image')
def writer_image(walk, fixture):
    from types import SimpleNamespace
    report = walk.Report()
    options = SimpleNamespace(writer_image=None, namespace='lifemodel-system', mount='/logs')
    class Cluster:
        def json(self, args):
            assert args == ['-n', options.namespace, 'get', 'cronjob', 'logs-evictor', '-o', 'json']
            return {'spec': {'jobTemplate': {'spec': {'template': {'spec': {
                'containers': [{'image': 'deployed-loader@sha256:fixture'}]}}}}}}
    class Volume:
        def mounted(self):
            return False
    walk.run(report, options, None, Cluster(), None, Volume(), {})
    manifest = walk.writer_manifest(options, 'walk', 'writer', 'module', 'run', 1, 1)
    print('IMAGE ' + json.dumps(manifest['spec']['containers'][0]['image']))
    return walk.Report()


@mode('missing-writer-image')
def missing_writer_image(walk, fixture):
    from types import SimpleNamespace
    report = walk.Report()
    options = SimpleNamespace(writer_image=None, namespace='lifemodel-system')
    class Cluster:
        def json(self, args):
            return None
    class Volume:
        def mounted(self):
            raise AssertionError('must resolve image before the walk writes anything')
    walk.run(report, options, None, Cluster(), None, Volume(), {})
    return report


@mode('commit-pass')
def commit_pass(walk, fixture):
    report = walk.Report()
    commits = [{'start': index * 200_000_000, 'end': index * 200_000_000 + 10_000_000,
                'result': 'ok'} for index in range(50)]
    value = walk.commit_verdict(commits)
    print('COMMIT ' + json.dumps({'ok': value['ok'], 'errors': value['errors'],
                                  'longest': value['longest']}))
    return report


@mode('commit-error')
def commit_error(walk, fixture):
    report = walk.Report()
    commits = [{'start': index * 200_000_000, 'end': index * 200_000_000 + 10_000_000,
                'result': 'ok' if index != 7 else 'error'} for index in range(20)]
    value = walk.commit_verdict(commits)
    print('COMMIT ' + json.dumps({'ok': value['ok'], 'errors': value['errors'],
                                  'detail': value['detail']}))
    return report


@mode('margin-breach')
def margin_breach(walk, fixture):
    report = walk.Report()
    volume = 3 * 1024**3
    margin = 805306368
    allowed = int(volume * 0.10)
    inside = walk.margin_verdict(margin, [{'free': margin - allowed // 2, 'merges': {'m': 1}}],
                                 volume)
    outside = walk.margin_verdict(margin, [{'free': margin - allowed - 1024, 'merges': {}}],
                                  volume)
    print('MARGIN ' + json.dumps({'inside': inside['ok'], 'outside': outside['ok'],
                                  'detail': outside['detail']}))
    return report


@mode('shared-move')
def shared_move(walk, fixture):
    report = walk.Report()
    quiet = walk.shared_verdict(10 * 1024**3, 10 * 1024**3 - 3 * 1024**2, 96 * 1024**2)
    flood = walk.shared_verdict(10 * 1024**3, 10 * 1024**3 - 1024**3, 96 * 1024**2)
    print('SHARED ' + json.dumps({'quiet': quiet['ok'], 'flood': flood['ok']}))
    return report


@mode('trusted-loss')
def trusted_loss(walk, fixture):
    report = walk.Report()
    written = list(range(1, 101))
    intact = walk.trusted_verdict(written, set(written))
    lost = walk.trusted_verdict(written, set(written) - {42, 43})
    print('TRUSTED ' + json.dumps({'intact': intact['ok'], 'lost': lost['ok'],
                                   'detail': lost['detail']}))
    return report


@mode('throttle-windows')
def throttle_windows(walk, fixture):
    report = walk.Report()
    good_entries = [
        {'pod': 'task-fast', 'window_start': 0, 'window_end': 6000, 'input': 400,
         'accepted': 60, 'collector_starts': {0}},
        {'pod': 'task-fast', 'window_start': 6000, 'window_end': 12000, 'input': 300,
         'accepted': 60, 'collector_starts': {0}},
    ]
    good = walk.throttle_counter_verdict(good_entries, {'task-fast': 120},
                                         lambda pod, first: 0)
    bad = walk.throttle_counter_verdict(
        [dict(good_entries[0], input=30, accepted=40)], {'task-fast': 40},
        lambda pod, first: 0)
    print('THROTTLE ' + json.dumps({'good': good['ok'], 'bad': bad['ok'],
                                    'detail': good['detail']}))
    return report


@mode('stored-counts')
def stored_counts(walk, fixture):
    queries = []

    class Store:
        def query(self, query):
            queries.append(query)
            return [{'count(*)': fixture.get('count', '42')}]

    total = walk.stored_task_lines(Store(), 'task-fast', 'fast-a2', 0, 6000)
    window = walk.stored_window_count(Store(), 'task-fast', 'fast-a2', 0)
    bad = None
    class Bad:
        def query(self, query):
            return [{'count(*)': 'nope'}]
    try:
        walk.stored_task_lines(Bad(), 'task-fast', 'fast-a2', 0, 6000)
    except walk.WalkError as error:
        bad = str(error)
    print('COUNTS ' + json.dumps({'total': total, 'window': window, 'bad': bad,
                                  'queries': queries}))
    return walk.Report()


@mode('readings')
def readings(walk, fixture):
    report = walk.Report()
    ok = walk.reading_verdict([{'state': 'ok'}])
    bad = walk.reading_verdict([{'state': 'ok'}, {'state': 'unavailable', 'reason': 'timeout'}])
    print('READINGS ' + json.dumps({'ok': ok['ok'], 'bad': bad['ok'],
                                    'detail': bad['detail']}))
    return report


@mode('loader-pages')
def loader_pages(walk, fixture):
    line = int(fixture.get('line_bytes', walk.LARGE_TASK_LINE_BYTES))
    total = int(fixture.get('total', 1200))
    limit = walk.loader_page_limit(line)
    records = [{'time': '2026-11-10T12:00:00Z', 'message': 'x' * line,
                'fields': {'module': 'walk-task-writer', 'pod': 'p'}}
               for _ in range(total)]
    pages = []

    refuse_offset = fixture.get('refuse_offset')
    refuse_status = fixture.get('refuse_status', 503)

    class Loader:
        def logs_page(self, params):
            size, offset = int(params['limit']), int(params['offset'])
            if refuse_offset is not None and offset >= int(refuse_offset):
                return refuse_status, None
            page = records[offset:offset + size]
            body = json.dumps({'state': 'ok', 'records': page})
            if len(body) >= walk.RESPONSE_LIMIT:
                raise walk.WalkError('response_too_large')
            pages.append({'records': len(page), 'bytes': len(body)})
            return 200, {'state': 'ok', 'records': page}

    collected, status = walk.loader_records(Loader(), {'from': '0', 'to': '1'}, limit)
    print('PAGES ' + json.dumps({
        'limit': limit, 'total': total, 'status': status,
        'collected': None if collected is None else len(collected),
        'max_bytes': max((page['bytes'] for page in pages), default=0),
        'response_limit': walk.RESPONSE_LIMIT, 'pages': pages}))
    return walk.Report()


@mode('plant')
def plant(walk, fixture):
    class Recorder:
        def __init__(self):
            self.events = []

        def pass_(self, name, detail=''):
            self.events.append({'kind': 'pass', 'name': name, 'detail': detail})

        def fail(self, name, detail=''):
            self.events.append({'kind': 'fail', 'name': name, 'detail': detail})

        def check(self, ok, name, detail=''):
            (self.pass_ if ok else self.fail)(name, detail)
            return ok

        def note(self, text):
            self.events.append({'kind': 'note', 'name': text})

        def not_valid(self, text):
            self.events.append({'kind': 'invalid', 'name': text})

    report = Recorder()
    options = SimpleNamespace(kubectl='kubectl', namespace='lifemodel-system',
                              store='logs-store')
    retention = fixture.get('retention', '14d')
    create = fixture.get('create', True)
    insert_status = fixture.get('insert_status', 200)
    state = {}
    days = set(fixture.get('partitions', []))
    writes = []

    class Store:
        def insert(self, lines):
            writes.append(lines)
            return (insert_status, b'')

    class Volume:
        def partitions(self):
            return sorted(days)

    class Cluster:
        pass

    real_burst = walk.write_burst

    def burst(store, moment, run_id, mib, kind, module='walk-flood'):
        status, count = real_burst(store, moment, run_id, mib, kind, module)
        if create and status in (200, 204):
            days.add(walk.day_of(moment))
        return status, count

    with patch.object(walk, 'read_store_flags',
                      lambda *args, **kwargs: {'retentionPeriod': retention}), \
         patch.object(walk, 'write_burst', burst), \
         patch.object(walk, 'wait_until',
                      lambda deadline, interval, predicate: predicate()):
        ok = walk.plant_past_days(report, options, Cluster(), Store(), Volume(), state,
                                  'flood')
    print('PLANT ' + json.dumps({'ok': ok, 'writes': len(writes),
                                 'days': state.get('planted_days'),
                                 'events': report.events}))
    return walk.Report()


def run_mode(mode_name, walk_path, fixture_path):
    walk = load(walk_path)
    with open(fixture_path, encoding='utf8') as handle:
        data = json.load(handle)
    if mode_name not in MODES:
        raise SystemExit('unknown mode: ' + mode_name)
    report = MODES[mode_name](walk, data)
    return report.result()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    sys.exit(run_mode(sys.argv[1], sys.argv[2], sys.argv[3]))
