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

    def pod(self, namespace, name):
        return self.fixture.get('pod')

    def pods(self, namespace, selector=None):
        return self.fixture.get('pods') or []

    def is_ready(self, namespace, name):
        return True


class FluxCluster(FakeCluster):
    """A fake cluster that answers the store Deployment, its Kustomizations and events.

    `json` routes by the object in the arguments, so one fake serves the store
    scale-down, the ownership chain reads/patches and the collector pod list. A
    patch to a Kustomization's suspend flag changes the object it answers next,
    the way the API server would. `kustomizations` keys the chain by name;
    `kustomization` is the single-level form.
    """

    def __init__(self, fixture):
        super().__init__(fixture)
        self.deployment = fixture.get('deployment')
        self.kustomization = fixture.get('kustomization')
        self.kustomizations = fixture.get('kustomizations')
        self.store_pods = list(fixture.get('storePods') or [])

    def body_for(self, name):
        if self.kustomizations is not None:
            return self.kustomizations.get(name)
        return self.kustomization

    def json(self, args, timeout=120):
        if 'pods' in args:
            selector = args[args.index('-l') + 1] if '-l' in args else ''
            if (self.fixture.get('store') or 'logs-store') in selector:
                return {'items': self.store_pods}
            return {'items': self.fixture.get('pods') or []}
        if 'kustomization' in args:
            return self.body_for(args[args.index('kustomization') + 1])
        if 'deployment' in args:
            return self.deployment
        return self.fixture.get('json')

    def pods(self, namespace, selector=None):
        if selector and 'logs-store' in selector:
            return self.store_pods
        return super().pods(namespace, selector)

    def refused(self, key, name):
        value = self.fixture.get(key)
        return value is True or (isinstance(value, list) and name in value)

    def run(self, args, timeout=120, stdin=None):
        if 'patch' in args and 'kustomization' in args:
            self.calls.append(' '.join(args))
            name = args[args.index('kustomization') + 1]
            payload = json.loads(args[args.index('-p') + 1])
            suspend = payload['spec']['suspend']
            if (suspend is True and self.refused('suspendRefused', name)) or (
                    suspend is False and self.refused('resumeRefused', name)):
                return Result(1, '', 'refused')
            body = self.body_for(name)
            if body is not None:
                body.setdefault('spec', {})['suspend'] = suspend
                if suspend is False:
                    body.setdefault('status', {})[
                        'lastAppliedRevision'] = 'main@sha256:fixture'
            return Result()
        if 'annotate' in args and 'kustomization' in args:
            self.calls.append(' '.join(args))
            if self.refused('annotateRefused', args[args.index('kustomization') + 1]):
                return Result(1)
            stamp = args[args.index('--overwrite') - 1].split('=', 1)[1]
            body = self.body_for(args[args.index('kustomization') + 1])
            if body is not None:
                body.setdefault('status', {})['lastHandledReconcileAt'] = stamp
            return Result()
        if 'events' in args:
            self.calls.append(' '.join(args))
            return Result(0, json.dumps({'items': self.fixture.get('events') or []}))
        if 'scale' in args and 'deployment' in args:
            self.calls.append(' '.join(args))
            replicas = int(next(entry for entry in args
                                if entry.startswith('--replicas=')).split('=')[1])
            if self.deployment is not None:
                self.deployment.setdefault('spec', {})['replicas'] = replicas
                self.deployment.setdefault('status', {})['replicas'] = replicas
                self.store_pods = ([] if replicas == 0
                                   else [{'metadata': {'name': 'logs-store-abc'}}])
            return Result()
        return super().run(args, timeout=timeout, stdin=stdin)


def options(**values):
    base = types.SimpleNamespace(
        password_file='', loader_host='boot-lifemodel.local', loader_port=443,
        origin_host='boot-lifemodel.local', ca_file=None, kubectl='k3s kubectl',
        namespace='lifemodel-system', store='logs-store', mount='/var/lib/lifemodel-logs',
        pv_path='/var/lib/lifemodel-logs/data', deadline_seconds=3600,
        collector_namespace='lifemodel-logs', collector='logs-collector',
        writer_namespace='lifemodel-logs-walk', metrics_port=9598, crictl='k3s crictl',
        fill_bound=2, fill_ceiling=2400, recover_bound=2, writer_interval_ms=20,
        saturated_seconds=0, writer_pods=1, memory_limit_bytes=300 * 1024 * 1024,
        unsaturated_lines=10, settle_seconds=0, writer_rate=1700, max_load=8.0,
        restore_bound=600, kustomization='platform-logs-store', flux_namespace='flux-system',
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
                {'id': 'abc', 'metadata': {'name': 'logs-collector'}}]}),
            'inspect': json.dumps({'info': {'pid': 1}}),
        },
    })
    walk.node_run = cluster.run
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
                {'id': 'abc', 'metadata': {'name': 'logs-collector'}}]}),
            'inspect': json.dumps({'info': {'pid': 4242}}),
        },
    })
    walk.node_run = cluster.run
    pid, detail = walk.vector_pid(cluster, options())
    print('PID ' + json.dumps({'pid': pid, 'detail': detail}))
    return report



@mode('writer-image')
def writer_image(walk, fixture):
    report = walk.Report()
    class Images(FakeCluster):
        def json(self, args, timeout=120):
            if 'cronjob' in args:
                return {'spec': {'jobTemplate': {'spec': {'template': {'spec': {
                    'containers': [{'image': 'loader-with-node@sha256:fixture'}]}}}}}}
            return {'spec': {'template': {'spec': {'containers': [{'image': 'vector-no-node'}]}}}}
    cluster = Images({})
    manifests = []
    cluster.apply = lambda body: (manifests.append(body) or Result())
    walk.read_metrics = lambda *args: ({}, '')
    walk.wait_until = lambda deadline, interval, probe: probe()
    walk.crash_case(report, options(), None, cluster, {}, True)
    print('IMAGE ' + json.dumps(manifests[0]['spec']['containers'][0]['image']))
    return report


@mode('writer-empty')
def writer_empty(walk, fixture):
    report = walk.Report()
    case = fixture['case']
    phase, state = {
        'image': ('Pending', {'waiting': {'reason': 'ImagePullBackOff'}}),
        'scheduling': ('Pending', {}),
        'admission': ('Pending', {}),
        'exited': ('Failed', {'terminated': {'reason': 'StartError', 'exitCode': 127}}),
        'read': ('Running', {'running': {}}),
        'silent': ('Running', {'running': {}}),
    }[case]
    class Writer(FakeCluster):
        def pod(self, namespace, name):
            return None if case == 'admission' else {'status': {
                'phase': phase, 'containerStatuses': [{'name': 'writer', 'state': state}]}}
        def run(self, args, timeout=120, stdin=None):
            self.calls.append(' '.join(args))
            if 'logs' in args:
                return Result(0 if case == 'silent' else 1, '',
                              '' if case == 'silent' else 'logs unavailable password is PRIVATE_TOKEN credential PRIVATE_VALUE')
            if 'events' in args:
                message = {
                    'scheduling': 'FailedScheduling', 'admission': 'FailedCreate restricted',
                    'image': 'FailedPull', 'exited': 'Failed node executable missing',
                    'read': 'Started', 'silent': 'Started'}[case]
                return Result(0, json.dumps({'items': [{'reason': 'Warning', 'message': message + ' credential PRIVATE_VALUE'}]}))
            return Result()
    cluster = Writer({})
    # A bounded startup wait gets one observation here, not three real minutes.
    walk.wait_until = lambda deadline, interval, probe: probe()
    ok = walk.wait_writer(report, options(), cluster, 'fixture')
    print('START ' + json.dumps({'ok': bool(ok), 'calls': cluster.calls}))
    return report


@mode('writer-start-order')
def writer_start_order(walk, fixture):
    report = walk.Report()
    events = []
    class Writer(FakeCluster):
        def pod(self, namespace, name):
            events.append('pod')
            return {'status': {'phase': 'Running', 'containerStatuses': [
                {'name': 'writer', 'state': {'running': {}}}]}}
        def run(self, args, timeout=120, stdin=None):
            if 'logs' in args:
                events.append('logs')
                return Result(0, 'walk-crash fixture seq=1 t=1\n')
            return Result()
    walk.wait_until = lambda deadline, interval, probe: probe()
    ok = walk.wait_writer(report, options(), Writer({}), 'fixture')
    print('START ' + json.dumps({'ok': bool(ok), 'events': events}))
    return report



@mode('writer-gates-buffer')
def writer_gates_buffer(walk, fixture):
    report = walk.Report()
    events = []
    cluster = FakeCluster({})
    cluster.apply = lambda body: Result()
    walk.writer_image = lambda *args: 'loader-with-node'
    walk.wait_writer = lambda *args: (events.append('writer-ready') or False)
    walk.read_metrics = lambda *args: (events.append('buffer') or ({}, ''))
    walk.crash_case(report, options(), None, cluster, {}, True)
    print('ORDER ' + json.dumps(events))
    return report


@mode('slow-writer')
def slow_writer(walk, fixture):
    """The buffer never fills at the writer's rate: the state is not valid, not passed."""
    report = walk.Report()
    state = {'size': 0, 'max': 500000, 'received': 143}
    print('SLOW ' + json.dumps({'saturated': walk.saturated(state), 'state': state}))
    return report


@mode('metrics-scrape-fails')
def metrics_scrape_fails(walk, fixture):
    """No scrape: the gap says exactly that."""
    report = walk.Report()
    gap = walk.collectors_metrics_gap('nothing answered port 9598 on logs-collector-abc '
                                      '(nothing accepted 127.0.0.1:9555 within 20 s)')
    print('GAP ' + json.dumps({'text': gap}))
    return report


@mode('metrics-component')
def metrics_component(walk, fixture):
    """The logs-store series is picked by component_id, not the first of that name."""
    report = walk.Report()
    body = '\n'.join([
        'vector_buffer_size_events{component_id="metrics",component_kind="sink"} 3',
        'vector_buffer_size_events{component_id="logs-store",component_kind="sink"} 0',
        'vector_buffer_max_size_events{component_id="metrics",component_kind="sink"} 500',
        'vector_buffer_max_size_events{component_id="logs-store",component_kind="sink"} 500000',
        'vector_component_received_events_total{component_id="kubernetes"} 143',
    ])
    values = walk.parse_metrics(body, {'vector_buffer_size_events',
                                       'vector_buffer_max_size_events',
                                       'vector_component_received_events_total'})
    print('STATE ' + json.dumps(walk.buffer_state(values)))
    return report


@mode('metrics-no-store-series')
def metrics_no_store_series(walk, fixture):
    """An exporter without the logs-store series is a named reason."""
    report = walk.Report()
    gap = walk.collectors_metrics_gap('the exporter carries vector_buffer_size_events but none '
                                      'for component_id="logs-store"')
    print('GAP ' + json.dumps({'text': gap}))
    return report


@mode('oom-before-full')
def oom_before_full(walk, fixture):
    """The collector restarted before the buffer filled: its own FAIL, with the peak."""
    report = walk.Report()
    value = walk.memory_verdict(290 * 1024 * 1024, 300 * 1024 * 1024, 410000, 500000,
                                0, 1, 'OOMKilled (exit 137)')
    report.check(not value['restarted'],
                 'the collector\'s buffer cannot reach its maximum inside its memory limit',
                 value['detail'])
    counting = walk.crash_verdict(list(range(1, 11)), set(range(1, 9)), set(range(1, 11)), 0)
    report.note('still counting the unplanned crash: %s' % counting['detail'])
    print('OOM ' + json.dumps({'ok': value['ok'], 'detail': value['detail'],
                               'counting': counting['detail']}))
    return report


@mode('main-runtime-error')
def main_runtime_error(walk, fixture):
    """An ordinary unexpected exception still gets cleanup and a final verdict."""
    walk.Cluster = lambda *_args: FakeCluster({})
    walk.read_password = lambda _path: 'fixture-password'
    walk.Loader = lambda *_args: types.SimpleNamespace(login=lambda _secret: 200)
    walk.wait_until = lambda deadline, interval, probe: probe()
    def broken_run(report, options, loader, cluster, state):
        state.update(replicas=1, created_namespace=True)
        state['step'] = fixture.get('step', 'the settle before the delivery query')
        if fixture.get('walk'):
            raise walk.WalkError(fixture.get('error', 'node_load_bound'))
        raise RuntimeError('fixture stage failed')
    walk.run = broken_run
    walk.store_ready = lambda *_args: True
    walk.collector_running = lambda *_args: True
    status = walk.main(['--password-file', 'unused'])
    print('MAIN ' + json.dumps({'status': status}))
    raise SystemExit(status)


@mode('restore-timeouts')
def restore_timeouts(walk, fixture):
    """A command timeout retries; exhaustion cannot skip the other restore steps."""
    report = walk.Report()
    calls = []
    attempts = {}
    timeouts = []
    class RestoreCluster(FakeCluster):
        def run(self, args, timeout=120, stdin=None):
            if 'scale' in args:
                name = 'scale'
            elif 'delete' in args and 'pod' in args:
                name = args[args.index('pod') + 1]
            elif 'namespace' in args:
                name = 'namespace'
            else:
                raise AssertionError('unexpected restore command: ' + ' '.join(args))
            calls.append(name)
            attempts[name] = attempts.get(name, 0) + 1
            timeouts.append(timeout)
            if name in ('scale', 'walk-crash-writer') and (
                    fixture.get('exhausted') or attempts[name] == 1):
                if fixture.get('interrupt'):
                    raise KeyboardInterrupt('fixture restore interrupted')
                if fixture.get('interrupt'):
                    raise KeyboardInterrupt()
                raise walk.WalkError('fixture kubectl timed out')
            return Result()
    def wait(deadline, interval, probe):
        for _attempt in range(3):
            if probe():
                return True
        return False
    walk.wait_until = wait
    walk.store_ready = lambda *_args: (calls.append('store-ready') or True)
    walk.collector_running = lambda *_args: (calls.append('collector-ready') or True)
    walk.restore(report, options(writer_pods=3), None, RestoreCluster({}),
                 {'replicas': 1, 'created_namespace': True})
    print('CLEANUP ' + json.dumps({'calls': calls, 'attempts': attempts,
                                   'timeouts': timeouts}))
    return report


@mode('emitted-count')
def emitted_count(walk, fixture):
    report = walk.Report()
    class Cluster:
        def run(self, args, timeout=120):
            name = args[args.index('logs') + 1]
            index = walk.writer_names(options(writer_pods=3)).index(name)
            return Result(stdout='walk-crash fixture seq=%d t=0\n' % (index * 50_000_000 + 567))
    print('EMITTED ' + json.dumps(walk.emitted_count(Cluster(), options(writer_pods=3), 'fixture')))
    return report


@mode('writer-paced')
def writer_paced(walk, fixture):
    report = walk.Report()
    manifests = [walk.writer_manifest('node-fixture', options(writer_pods=3),
                                      'fixture', 60, index)
                 for index in range(1, 4)]
    print('COMMANDS ' + json.dumps([body['spec']['containers'][0]['command']
                                   for body in manifests]))
    return report


@mode('watch-load')
def watch_load(walk, fixture):
    """Drive the background monitor without threads, elapsed time or real signals."""
    report = walk.Report()
    waits = []
    signals = []
    class Stop:
        def wait(self, seconds):
            waits.append(seconds)
            return len(waits) > 1
    walk.guard_writers_writing()
    if fixture.get('released'):
        walk.guard_writers_stopped()
    walk.node_load = lambda: fixture.get('load', 9.0)
    original_kill = walk.os.kill
    try:
        walk.os.kill = lambda pid, sig: signals.append({
            'own_pid': pid == walk.os.getpid(), 'sigint': sig == walk.signal.SIGINT})
        walk.watch_load(report, options(), Stop())
    finally:
        walk.os.kill = original_kill
    print('WATCH ' + json.dumps({'waits': waits, 'signals': signals}))
    return report


@mode('load-unavailable')
def load_unavailable(walk, fixture):
    report = walk.Report()
    def unavailable():
        raise ValueError('fixture loadavg is not a float')
    walk.node_load = unavailable
    ok = walk.safe_load(report, options())
    print('SAFE ' + json.dumps({'ok': ok}))
    return report


@mode('load-gate')
def load_gate(walk, fixture):
    report = walk.Report()
    events = []
    cluster = FakeCluster({})
    cluster.apply = lambda body: (events.append('apply') or Result())
    walk.node_load = lambda: fixture.get('load', 9.0)
    walk.writer_image = lambda *_args: 'node-fixture'
    walk.read_metrics = lambda *_args: ({}, '')
    walk.wait_writer = lambda *_args: (events.append('writer-ready') or False)
    walk.wait_until = lambda *_args: (events.append('wait') or False)
    walk.crash_case(report, options(), None, cluster, {}, True)
    print('LOAD ' + json.dumps(events))
    return report


def flux_labels():
    return {'kustomize.toolkit.fluxcd.io/name': 'platform-logs-store',
            'kustomize.toolkit.fluxcd.io/namespace': 'flux-system'}


def ready_deployment(replicas=1, ready=True):
    return {
        'metadata': {
            'labels': flux_labels(),
            'managedFields': [
                {'manager': 'kustomize-controller',
                 'fieldsV1': {'f:spec': {'f:replicas': {}}}},
                {'manager': 'k3s-kubectl-scale',
                 'fieldsV1': {'f:spec': {'f:replicas': {}}}},
            ],
        },
        'spec': {'replicas': replicas},
        'status': {'replicas': replicas,
                   'readyReplicas': replicas if ready else 0,
                   'availableReplicas': replicas if ready else 0,
                   'observedGeneration': 1},
        'metadata_generation': 1,
    }


def ready_kustomization(suspend=None, name='platform-logs-store', labels=None):
    body = {
        'metadata': {'name': name, 'namespace': 'flux-system', 'generation': 4,
                     'labels': labels or {}},
        'spec': {},
        'status': {'conditions': [{'type': 'Ready', 'status': 'True'}],
                   'observedGeneration': 4, 'lastAppliedRevision': 'main@sha256:fixture'},
    }
    if suspend is not None:
        body['spec']['suspend'] = suspend
    return body


def level_name(level):
    return 'platform-logs-store' if level == 0 else 'platform'


def chain_kustomizations(names=None, suspend=None):
    """Kustomization bodies level by level, each carrying its parent's owner labels."""
    names = list(names) if names else [level_name(level) for level in range(2)]
    bodies = {}
    for level, name in enumerate(names):
        labels = {}
        if level + 1 < len(names):
            labels = {'kustomize.toolkit.fluxcd.io/name': names[level + 1],
                      'kustomize.toolkit.fluxcd.io/namespace': 'flux-system'}
        bodies[name] = ready_kustomization(
            suspend=suspend if isinstance(suspend, list) and name in suspend
            else (True if suspend is True else None),
            name=name, labels=labels)
    return bodies


def chain_deployment(names, replicas=1, ready=True):
    deployment = ready_deployment(replicas=replicas, ready=ready)
    deployment['metadata']['labels'] = {
        'kustomize.toolkit.fluxcd.io/name': names[0],
        'kustomize.toolkit.fluxcd.io/namespace': 'flux-system'}
    return deployment


def owners(names):
    return [{'namespace': 'flux-system', 'name': name} for name in names]


@mode('deployment-args')
def deployment_args(walk, fixture):
    """The Deployment read asks for managedFields; kubectl omits them otherwise."""
    report = walk.Report()
    print('ARGS ' + json.dumps(walk.deployment_args(options())))
    return report


@mode('flux-owner')
def flux_owner(walk, fixture):
    """The owning Kustomization comes from the Deployment labels, defaults otherwise."""
    report = walk.Report()
    deployment = {'metadata': {'labels': fixture.get('labels') or {}}}
    owner = walk.flux_owner(FluxCluster({'deployment': deployment}), options())
    print('OWNER ' + json.dumps(owner))
    return report


@mode('stop-store')
def stop_store(walk, fixture):
    """Suspend top down before scale-down; a refusal anywhere never scales the store."""
    report = walk.Report()
    names = ['platform-logs-store', 'platform']
    bodies = chain_kustomizations(names=names)
    if fixture.get('cycle'):
        bodies[names[-1]]['metadata']['labels'] = {
            'kustomize.toolkit.fluxcd.io/name': names[0],
            'kustomize.toolkit.fluxcd.io/namespace': 'flux-system'}
    cluster = FluxCluster({
        'deployment': chain_deployment(names),
        'kustomizations': bodies,
        'suspendRefused': fixture.get('refuseSuspend'),
    })
    state = {'suspended': [], 'held': []}
    ok = walk.stop_store(report, options(), cluster, state)
    print('STOP ' + json.dumps({
        'ok': bool(ok), 'calls': cluster.calls,
        'suspended': [owner['name'] for owner in state.get('suspended') or []],
        'specSuspend': {name: (cluster.kustomizations[name].get('spec') or {}).get('suspend')
                        for name in names}}))
    return report


@mode('flux-chain')
def flux_chain(walk, fixture):
    """The ownership chain is read upward, and a cycle or excess depth is refused."""
    report = walk.Report()
    names = fixture.get('chain') or ['platform-logs-store', 'platform']
    bodies = chain_kustomizations(names=names)
    if fixture.get('cycle'):
        bodies[names[-1]]['metadata']['labels'] = {
            'kustomize.toolkit.fluxcd.io/name': names[0],
            'kustomize.toolkit.fluxcd.io/namespace': 'flux-system'}
    cluster = FluxCluster({'deployment': chain_deployment(names),
                           'kustomizations': bodies})
    chain = walk.flux_chain(cluster, options())
    print('CHAIN ' + json.dumps({
        'names': [owner['name'] for owner in chain['owners']],
        'error': chain['error']}))
    return report


@mode('owner-resumed')
def owner_resumed(walk, fixture):
    """A Kustomization whose suspend cleared during the outage is TEST NOT VALID."""
    report = walk.Report()
    names = ['platform-logs-store', 'platform']
    bodies = chain_kustomizations(names=names, suspend=True)
    bodies[fixture.get('resumed') or names[-1]]['spec']['suspend'] = False
    cluster = FluxCluster({'deployment': chain_deployment(names, replicas=0),
                           'kustomizations': bodies, 'storePods': []})
    ok = walk.require_store_down(report, options(), cluster,
                                 {'held': owners(names), 'suspended': []})
    print('HOLD ' + json.dumps({'ok': bool(ok)}))
    return report


@mode('store-restored')
def store_restored(walk, fixture):
    """A store that came back mid-outage is TEST NOT VALID, naming who restored it."""
    report = walk.Report()
    deployment = ready_deployment()
    cluster = FluxCluster({
        'deployment': deployment,
        'storePods': [{'metadata': {'name': 'logs-store-abc'}}],
        'events': [{'reason': 'ScalingReplicaSet',
                    'message': 'Scaled up replica set logs-store-abc to 1'}],
    })
    walk.wait_until = lambda deadline, interval, probe: probe()
    ok = walk.wait_store_down(report, options(), cluster, {'held': []})
    print('DOWN ' + json.dumps({'ok': bool(ok),
                                'managers': walk.store_replica_managers(cluster, options())}))
    return report


@mode('saturation-plan')
def saturation_plan(walk, fixture):
    """The clock is derived from the measured rate and line size when 600 s cannot reach."""
    report = walk.Report()
    opts = options(writer_pods=3, writer_rate=1700,
                   fill_bound=fixture.get('configuredBound', 600),
                   fill_ceiling=fixture.get('ceiling', 2400))
    line = walk.writer_line_bytes('walk-crash-saturated-1762812345678', 2120, opts)
    plan = walk.saturation_plan(fixture.get('rate', 1480), line,
                                fixture.get('writableMax', 201326592),
                                opts.fill_bound, opts.fill_ceiling)
    print('PLAN ' + json.dumps({'line': line, 'bound': plan['bound'],
                                'fromConfigured': plan['fromConfigured'],
                                'neededSeconds': plan['neededSeconds'],
                                'reachable': plan['reachable'],
                                'note': walk.saturation_note(plan)}))
    return report


@mode('restore-resume')
def restore_resume(walk, fixture):
    """Resume runs child first even after a store step failed, and is verified."""
    report = walk.Report()
    names = ['platform-logs-store', 'platform'] if fixture.get('chain') else [
        'platform-logs-store']
    bodies = chain_kustomizations(names=names, suspend=True)
    cluster = FluxCluster({
        'deployment': chain_deployment(names, ready=False),
        'kustomizations': bodies,
        'pods': [{'metadata': {'name': 'logs-collector-abc'},
                  'status': {'phase': 'Running'}}],
        'resumeRefused': fixture.get('resumeRefused'),
    })
    # One probe per step: the retry path is what is under test, not a real wait.
    walk.wait_until = lambda deadline, interval, probe: probe()
    walk.restore(report, options(restore_bound=1), None, cluster,
                 {'replicas': 1, 'created_namespace': False,
                  'kustomizations': owners(names),
                  'suspended': owners(names), 'held': owners(names)})
    print('RESUMED ' + json.dumps({
        'calls': cluster.calls,
        'suspend': {name: (bodies[name].get('spec') or {}).get('suspend') for name in names},
        'handled': {name: bool((bodies[name].get('status') or {})
                               .get('lastHandledReconcileAt')) for name in names}}))
    return report


@mode('load-phase')
def load_phase(walk, fixture):
    """Before the crash an excess load stops the writers; after it, it is a NOTE."""
    report = walk.Report()
    walk.node_load = lambda: fixture.get('load', 9.0)
    walk.guard_writers_writing()
    before = walk.safe_load(report, options())
    walk.guard_writers_stopped(report)
    after = walk.safe_load(report, options())
    again = walk.safe_load(report, options())
    walk.node_load = lambda: 1.0
    back = walk.safe_load(report, options())
    print('LOAD ' + json.dumps({'before': before, 'after': after, 'again': again, 'back': back}))
    return report


@mode('crash-load-release')
def crash_load_release(walk, fixture):
    """The drain's load after the crash is a NOTE, and the loss count still runs."""
    report = walk.Report()
    walk.guard_writers_writing()
    walk.node_load = lambda: 9.0 if fixture.get('early') else 1.0
    walk.writer_image = lambda *args: 'image'
    walk.wait_writer = lambda *args: True
    walk.writer_lines = lambda *args: [1, 2]
    walk.collector_memory = lambda *args: (100 * walk.MIB, '')
    walk.require_store_down = lambda *args: True
    walk.set_replicas = lambda *args: True
    walk.recover_after_crash = lambda *args: True
    walk.store_ready = lambda *args: True
    walk.collector_restarts = lambda *args: 1
    walk.vector_pid = lambda *args: (42, 'pid 42')
    walk.kubelet_lines = lambda *args: {1, 2}
    walk.count_deliveries = lambda *args: {1: 2, 2: 1}
    walk.wait_until = lambda deadline, interval, probe: probe()
    walk.restore_step = lambda *args: True

    def node_run(args):
        if args[:1] == ['kill']:
            walk.node_load = lambda: fixture.get('load', 9.0)
        return types.SimpleNamespace(returncode=0)

    walk.node_run = node_run

    class Cluster:
        def apply(self, body):
            return types.SimpleNamespace(returncode=0)

        def run(self, args, timeout=120):
            return types.SimpleNamespace(returncode=0)

    state = {'replicas': 1, 'suspended': [], 'held': []}
    ok = walk.crash_case(report, options(unsaturated_lines=1), None, Cluster(), state, False)
    print('CRASH ' + json.dumps({'ok': bool(ok), 'step': state.get('step')}))
    return report


def run_mode(mode_name, walk_path, fixture_path):
    walk = load(walk_path)
    # The harness owns node conditions; never read its host's load average.
    walk.node_load = lambda: 0.0
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
