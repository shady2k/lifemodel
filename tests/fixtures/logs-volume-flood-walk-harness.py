"""Drives WALK-LOGS-VOLUME-FLOOD's decisions against fake inputs.

usage: logs-volume-flood-walk-harness.py <mode> <walk.py> <fixture.json>
"""
import importlib.util
import json
import sys


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
    good = walk.throttle_verdict([{'pod': 'task-fast', 'input': 400, 'accepted': 60},
                                  {'pod': 'task-large', 'input': 30, 'accepted': 30}])
    bad = walk.throttle_verdict([{'pod': 'task-fast', 'input': 30, 'accepted': 40}])
    print('THROTTLE ' + json.dumps({'good': good['ok'], 'bad': bad['ok'],
                                    'detail': good['detail']}))
    return report


@mode('readings')
def readings(walk, fixture):
    report = walk.Report()
    ok = walk.reading_verdict([{'state': 'ok'}])
    bad = walk.reading_verdict([{'state': 'ok'}, {'state': 'unavailable', 'reason': 'timeout'}])
    print('READINGS ' + json.dumps({'ok': ok['ok'], 'bad': bad['ok'],
                                    'detail': bad['detail']}))
    return report


def run_mode(mode_name, walk_path, fixture_path):
    walk = load(walk_path)
    with open(fixture_path, encoding='utf8') as handle:
        json.load(handle)
    if mode_name not in MODES:
        raise SystemExit('unknown mode: ' + mode_name)
    report = MODES[mode_name](walk, None)
    return report.result()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    sys.exit(run_mode(sys.argv[1], sys.argv[2], sys.argv[3]))
