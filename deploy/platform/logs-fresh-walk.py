#!/usr/bin/env python3
"""WALK-LOGS-FRESH: the page never shows a healthy page for a stopped collector,
and says when it does not know (ADR-016 L14, §4).

What it proves
--------------
1. With the collector stopped and the store healthy, the API's own answer to the
   page's first request says `collection: stopped` with an age past the 90 s
   threshold, which is what makes the page print "collection stopped N minutes
   ago; results may be incomplete" above the results. The collector is stopped by
   giving its DaemonSet a nodeSelector that matches no node: a pod-template
   change, not a change to the collector's own config.
2. Restarting the collector returns the age below the threshold within
   --live-bound seconds: one heartbeat period plus the store's ingest lag.
3. A stalled pod-log reading with a healthy heartbeat is visible. The ADR's
   unreadable `/var/log/pods` is produced the nearest way the collector's
   manifest allows: its `pods` volume is replaced by an emptyDir for one run, so
   the collector keeps running and keeps writing its heartbeat through the store
   sink, but its pod-log file source has no file to read. The walk asserts the
   process heartbeat is fresh while the API says collection stopped, then
   restores the hostPath and asserts the API says live again.
4. With the store's free space below `-storage.minFreeDiskSpaceBytes` the store
   refuses a write (the write answers 429; that refusal is the state), and the
   same API answer says `storeReadOnly: true`, so the page names "the store is
   refusing writes (read-only)" instead of blaming the collector. The space is
   spent on the volume by a file written as uid 1000 (the store's own user) and
   removed again; the store accepts writes again without a restart.
5. The state before any heartbeat was ever stored: if the API answers
   `collection: unknown` the walk asserts it; otherwise it says in a NOTE why that
   state cannot be produced on a deployed build (the store already holds
   heartbeats and nothing but retention or the evictor removes them) and points
   at the loader's own unit test for that decision.

Every assertion reads the API's status (the first page answered with `status=1`),
never the screen, so the walk proves the answer the page draws from.

Arguments (defaults are the test VM's)
-------------------------------------
  --password-file PATH   the loader's login password, read from this file and
                         never printed (required)
  --loader-host HOST     where the walk connects (default boot-lifemodel.local)
  --loader-port PORT     the loader's TLS port (default 443)
  --origin-host HOST     the host the loader answers on, sent as Host and as the
                         login Origin (default boot-lifemodel.local); pass
                         127.0.0.1 with a port-forward for --loader-host
  --ca-file PATH         verify the loader's certificate with this CA; without
                         it the TLS chain is not verified
  --kubectl COMMAND      default "k3s kubectl"
  --namespace NS         the store's namespace (default lifemodel-system)
  --store NAME           the store's Deployment (default logs-store)
  --mount PATH           the host mount point (default /var/lib/lifemodel-logs)
  --pv-path PATH         the PV's path inside that mount
                         (default /var/lib/lifemodel-logs/data)
  --stop-label-key KEY   the nodeSelector key that no node carries
                         (default lifemodel.dev/walk-fresh-stop)
  --stopped-bound N      bound on the API saying stopped (default 120 s)
  --live-bound N         bound on the API saying live again (default 150 s)
  --ready-timeout N      bound on the collector or the store becoming Ready
                         (default 300 s)
  --fill-timeout N       bound on filling the volume below the store's margin
                         (default 300 s)
  --heartbeat-fresh N    how young the process heartbeat must be while the
                         pod-log reading is stalled, in seconds (default 60)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
Three cluster changes, each restored in a `finally` that runs after an assertion
fails too, and the RESTORE lines name what was done:
  - the collector DaemonSet's pod template gains a nodeSelector no node matches;
    the nodeSelector the walk found (absent on the test VM) is put back;
  - the collector's `pods` volume is replaced by an emptyDir and the original
    volume object is put back;
  - a filler directory on the log volume, written as uid 1000, is removed, and
    the walk waits for the store to accept writes again.
The setting, the partition key and every stored record are left alone. While the
collector is stopped nothing is collected: lines written in that window may be
lost, which is what stopping a collector does.

What it does not cover
----------------------
The page's wording is asserted on the drawn page by `logs-page-walk.mjs`, which
reads the same status area; this walk asserts the API answer the page draws from.
The collector-heartbeat wiring was never measured on a cluster before this walk
(ADR-016 §4, F9): if no heartbeat is ever stored the walk says so as TEST NOT
VALID, because there is then no freshness to assert.

Exit status is non-zero when any assertion failed or a state was never reached.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    Cluster,
    Loader,
    Report,
    Volume,
    WalkError,
    common_arguments,
    connect_store,
    now_ms,
    parse_ms,
    read_password,
    stamp,
    wait_until,
)

# ADR-016 §4: a heartbeat every 30 s, and the page warns past 90 s.
STOPPED_THRESHOLD_MS = 90_000
COLLECTOR_NAMESPACE = 'lifemodel-logs'
COLLECTOR = 'logs-collector'
STOP_VALUE = 'stop'
MARGIN_SHARE = 0.25
READ_ONLY_GAUGE = 'vl_storage_is_read_only'
HEARTBEAT_MODULE = 'collector-heartbeat'
FILLER_CHUNK = 32 * 1024 * 1024
MIB = 1024 * 1024


def window(seconds=3600):
    end = now_ms()
    return end - seconds * 1000, end


def collection_of(answer):
    return ((answer or {}).get('status') or {}).get('collection') or {}


def collection_state(answer):
    if (answer or {}).get('state') != 'ok':
        return 'unreadable'
    return collection_of(answer).get('state') or 'unreadable'


def stopped_for_ms(answer):
    value = collection_of(answer).get('stoppedForMs')
    return value if isinstance(value, int) else None


def read_only_of(answer):
    value = ((answer or {}).get('status') or {}).get('storeReadOnly')
    return value if isinstance(value, bool) else None


def describe(answer):
    """The state the API answered, in one line, without any record content."""
    if (answer or {}).get('state') != 'ok':
        return 'status unavailable (%s)' % (answer or {}).get('reason', 'unreadable')
    parts = ['collection=%s' % collection_state(answer)]
    age = stopped_for_ms(answer)
    if age is not None:
        parts.append('stoppedForMs=%d' % age)
    read_only = read_only_of(answer)
    if read_only is not None:
        parts.append('storeReadOnly=%s' % str(read_only).lower())
    return ', '.join(parts)


def collection_reached(answer, expected):
    if expected == 'stopped':
        age = stopped_for_ms(answer)
        return collection_state(answer) == 'stopped' and age is not None and age > STOPPED_THRESHOLD_MS
    return collection_state(answer) == 'live'


def watch_collection(report, loader, expected, name, bound_seconds, fresh_seconds=3600):
    """Wait for the API's own answer to show the collection state, or fail.

    `expected` is 'stopped' (with an age past the threshold, which is what makes
    the page print its line) or 'live'. This is an assertion, not a
    precondition: the caller has already stopped or started the collector.
    """
    started = time.monotonic()
    seen = {'answer': {}}

    def attempt():
        seen['answer'] = loader.logs_status(*window(fresh_seconds))
        return collection_reached(seen['answer'], expected)

    reached = wait_until(started + bound_seconds, 5, attempt)
    elapsed = time.monotonic() - started
    # The answer that decided the attempt, not one more request: a later request
    # would describe a state the walk did not judge.
    answer = seen['answer']
    if reached:
        report.pass_(name, describe(answer) + ', %.0f s after the change' % elapsed)
        return True
    report.fail(name, describe(answer) + ', %.0f s after the change' % elapsed)
    return False


def collector_state(cluster):
    """The collector's DaemonSet readiness and how many of its pods are Ready."""
    body = cluster.json(['-n', COLLECTOR_NAMESPACE, 'get', 'daemonset', COLLECTOR, '-o', 'json'])
    if body is None:
        return None
    status = body.get('status') or {}
    ready = int(status.get('numberReady') or 0)
    desired = int(status.get('desiredNumberScheduled') or 0)
    pods = cluster.pods(COLLECTOR_NAMESPACE, 'app.kubernetes.io/name=' + COLLECTOR)
    ready_pods = 0
    for pod in pods:
        if (pod.get('metadata') or {}).get('deletionTimestamp'):
            continue
        conditions = (pod.get('status') or {}).get('conditions') or []
        if any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in conditions):
            ready_pods += 1
    return {'ready': ready, 'desired': desired, 'pods': len(pods), 'readyPods': ready_pods}


def wait_collector(cluster, options, ready):
    """Wait for the collector to be Ready (or to have no Ready pod, and none scheduled)."""
    def condition():
        state = collector_state(cluster)
        if state is None:
            return False
        if ready:
            return (state['desired'] >= 1 and state['ready'] == state['desired']
                    and state['readyPods'] >= 1)
        return state['readyPods'] == 0 and state['desired'] == 0

    return bool(wait_until(time.monotonic() + options.ready_timeout, 3, condition))


def collector_template(cluster):
    body = cluster.json(['-n', COLLECTOR_NAMESPACE, 'get', 'daemonset', COLLECTOR, '-o', 'json'])
    if body is None:
        raise WalkError('collector_daemonset_unreadable')
    return ((body.get('spec') or {}).get('template') or {}).get('spec') or {}


def patch_template(cluster, operations):
    return cluster.run(
        ['-n', COLLECTOR_NAMESPACE, 'patch', 'daemonset', COLLECTOR,
         '--type=json', '-p', json.dumps(operations)]
    ).returncode == 0


def stop_collector(cluster, options, state):
    """Give the pod template a nodeSelector no node carries; False when refused."""
    try:
        template = collector_template(cluster)
    except WalkError:
        return False
    state['nodeSelector'] = template.get('nodeSelector')
    wanted = dict(template.get('nodeSelector') or {})
    wanted[options.stop_label_key] = STOP_VALUE
    return cluster.run(
        ['-n', COLLECTOR_NAMESPACE, 'patch', 'daemonset', COLLECTOR, '--type=merge',
         '-p', json.dumps({'spec': {'template': {'spec': {'nodeSelector': wanted}}}})]
    ).returncode == 0


def restore_collector_selector(cluster, state):
    if 'nodeSelector' not in state:
        return True
    original = state.get('nodeSelector')
    if original is None:
        operation = {'op': 'remove', 'path': '/spec/template/spec/nodeSelector'}
    else:
        operation = {'op': 'add', 'path': '/spec/template/spec/nodeSelector', 'value': original}
    state['nodeSelector'] = None
    return patch_template(cluster, [operation])


def volume_position(cluster, name):
    volumes = collector_template(cluster).get('volumes') or []
    for position, volume in enumerate(volumes):
        if volume.get('name') == name:
            return position
    return None


def stall_pod_logs(cluster, state):
    """Replace the collector's `pods` hostPath with an emptyDir for one run.

    That is the nearest equivalent of the ADR's unreadable `/var/log/pods` that
    the collector's manifest allows: the collector keeps running and keeps
    writing its own heartbeat through the store sink, but its file source has no
    file to read, so the heartbeat's pod-log copy stops.
    """
    try:
        position = volume_position(cluster, 'pods')
        volumes = collector_template(cluster).get('volumes') or []
    except WalkError:
        return False
    if position is None:
        return False
    state['podsVolume'] = volumes[position]
    return patch_template(cluster, [{
        'op': 'replace',
        'path': '/spec/template/spec/volumes/%d' % position,
        'value': {'name': 'pods', 'emptyDir': {}},
    }])


def restore_pod_logs(cluster, state):
    if 'podsVolume' not in state:
        return True
    position = volume_position(cluster, 'pods')
    if position is None:
        return False
    original = state.get('podsVolume')
    state['podsVolume'] = None
    return patch_template(cluster, [{
        'op': 'replace',
        'path': '/spec/template/spec/volumes/%d' % position,
        'value': original,
    }])


def process_heartbeat_ms(store):
    """The newest heartbeat the collector's own process wrote, in milliseconds."""
    records = store.query(
        'module:="%s" container:="%s" | sort by (_time desc) | limit 1'
        % (HEARTBEAT_MODULE, HEARTBEAT_MODULE)
    )
    if not records:
        return None
    return parse_ms(records[0].get('_time'))


def probe_write(store):
    """One tiny write through the collector's sink protocol: (status, body)."""
    status, body = store.insert([{
        'timestamp': stamp(now_ms()),
        'message': 'walk-fresh probe',
        'module': 'walk-fresh',
        'namespace': 'walk',
        'pod': 'walk-fresh',
        'container': 'walk',
        'stream': 'stdout',
        'level': 'info',
        'untrusted': False,
    }])
    return status, (body.decode('utf8', 'replace')[:200] if body else '')


def margin_bytes(volume):
    total, _avail = volume.space()
    return int(total * MARGIN_SHARE)


def fill_volume(report, options, volume, store):
    """Spend the volume's free space below the store's margin; True when reached.

    The chunk is written as uid 1000, the store's own user, on the filesystem the
    store reads. The filler lives in a directory of its own under the PV path,
    beside `partitions/`, which the store does not read.
    """
    threshold = margin_bytes(volume)
    deadline = time.monotonic() + options.fill_timeout
    volume.prepare_filler()
    while time.monotonic() < deadline:
        _total, avail = volume.space()
        if avail <= threshold:
            return True, avail, threshold
        chunk = min(FILLER_CHUNK, max(MIB, avail - threshold + 8 * MIB))
        if not volume.write_filler(chunk):
            report.fail('the volume is filled as uid 1000', 'the write as uid 1000 failed')
            return False, avail, threshold
        if probe_write(store)[0] == 429:
            return True, volume.space()[1], threshold
    _total, avail = volume.space()
    return False, avail, threshold


def watch_read_only(report, loader, store, name, bound_seconds, free_bytes):
    """Wait for the API's answer to say the store refuses writes, or fail."""
    started = time.monotonic()

    def attempt():
        return read_only_of(loader.logs_status(*window())) is True

    reached = wait_until(started + bound_seconds, 3, attempt)
    elapsed = time.monotonic() - started
    answer = loader.logs_status(*window())
    if reached:
        report.pass_(name, 'storeReadOnly=true, %.0f s after the filler, %d MiB free'
                     % (elapsed, free_bytes // MIB))
    else:
        report.fail(name, describe(answer))
    try:
        gauge = store.metrics().get(READ_ONLY_GAUGE)
    except WalkError:
        gauge = None
    if gauge is None:
        report.note('the store exports no %s gauge in this run; the page\'s read-only line '
                    'comes from it, so the API answer above is the only evidence available'
                    % READ_ONLY_GAUGE)
    else:
        report.check(gauge == 1, 'the store\'s own %s gauge is 1 while it refuses writes'
                     % READ_ONLY_GAUGE, 'gauge=%s' % ('1' if gauge == 1 else str(gauge)))
    return reached


def unknown_case(report, loader):
    """L14's 'before any heartbeat was ever stored' state."""
    state = collection_state(loader.logs_status(*window()))
    if state == 'unknown':
        report.pass_('the API says collection status is unknown before any heartbeat was stored',
                     'the page shows "collection status unknown", never a healthy or empty answer')
        return
    report.note('the state before any heartbeat was stored cannot be produced on a deployed '
                'build: the store already holds heartbeats (collection state %s) and nothing but '
                'retention or the evictor removes them. The loader\'s decision for that state is '
                'held by tests/unit/logs-status.test.ts, so this walk does not assert it.' % state)


def run(report, options, loader, cluster, store, volume, state):
    """The four cases, with the volume case last so its recovery is the last word."""
    if not report.check(volume.mounted(), 'the log volume is mounted', options.mount):
        return False
    if not wait_collector(cluster, options, ready=True):
        report.not_valid('the collector was not Ready before the walk')
        return False

    unknown_case(report, loader)

    # Case 1: a stopped collector, with the store healthy; then the restart.
    if not stop_collector(cluster, options, state):
        report.fail('the collector is stopped by a nodeSelector no node matches',
                    'the patch was refused')
        report.not_valid('the collector could not be stopped')
        return False
    if not wait_collector(cluster, options, ready=False):
        report.fail('the collector is stopped', 'a Ready collector pod remains after %d s'
                    % options.ready_timeout)
        report.not_valid('the collector never stopped: there is no freshness state to assert')
        return False
    report.pass_('the collector is stopped', 'no Ready collector pod and none scheduled')
    watch_collection(report, loader, 'stopped',
                     'the API says collection stopped while the collector is stopped',
                     options.stopped_bound)
    if not restore_collector_selector(cluster, state):
        report.fail('the collector nodeSelector is restored', 'the patch was refused')
        return False
    if not wait_collector(cluster, options, ready=True):
        report.not_valid('the collector did not come back: the return below the threshold '
                         'cannot be asserted')
        return False
    report.pass_('the collector is Ready again', COLLECTOR)
    watch_collection(report, loader, 'live',
                     'the API says collection is live again within one heartbeat period',
                     options.live_bound)

    # Case 2: the pod-log reading stalled while the heartbeat is healthy.
    if not stall_pod_logs(cluster, state):
        report.fail('the pod-log reading is stalled for one run', 'the volume patch was refused')
        report.not_valid('the pod-log reading could not be stalled')
    else:
        if not wait_collector(cluster, options, ready=True):
            report.not_valid('the collector did not restart with the stalled mount')
        else:
            def fresh_heartbeat():
                moment = process_heartbeat_ms(store)
                return moment if moment and now_ms() - moment < options.heartbeat_fresh * 1000 else None

            heartbeat = wait_until(time.monotonic() + options.ready_timeout, 5, fresh_heartbeat)
            report.check(
                heartbeat is not None,
                'the collector\'s process heartbeat is fresh while its pod-log reading is stalled',
                'a heartbeat younger than %d s is stored through the store sink'
                % options.heartbeat_fresh,
            )
            if heartbeat is None:
                report.not_valid('no fresh process heartbeat: the heartbeat wiring is not proven, '
                                 'so a stall cannot be told apart from a stopped collector')
            else:
                watch_collection(report, loader, 'stopped',
                                 'the API says results may be incomplete while the pod-log '
                                 'reading is stalled', options.stopped_bound)
        if not restore_pod_logs(cluster, state):
            report.fail('the pod-log volume is restored', 'the volume patch was refused')
        elif wait_collector(cluster, options, ready=True):
            report.pass_('the collector is Ready with the pod-log mount restored',
                         '/var/log/pods read-only again')
            watch_collection(report, loader, 'live',
                             'the API says collection is live again after the pod-log mount returned',
                             options.live_bound)
        else:
            report.not_valid('the collector did not come back with its pod-log mount')

    # Case 3: a store that refuses writes, then recovers.
    status, _body = probe_write(store)
    report.check(status in (200, 204), 'the store accepts a write before the volume is filled',
                 'answered %d' % status)
    reached, avail, threshold = fill_volume(report, options, volume, store)
    if not reached:
        report.not_valid('the volume was never filled below the store\'s margin: no read-only '
                         'state to assert (%d MiB free, %d MiB needed)'
                         % (avail // MIB, threshold // MIB))
        volume.clear_filler()
        return False
    else:
        report.pass_('the volume is filled below the store\'s margin as uid 1000',
                     '%d MiB free, margin %d MiB' % (avail // MIB, threshold // MIB))
        refused, _body = probe_write(store)
        if refused != 429:
            report.not_valid('the store did not refuse a write with %d MiB free: the read-only '
                             'state was not reached' % (avail // MIB))
        else:
            report.pass_('the store refuses a write (429) with the volume below its margin',
                         'the refusal is the state the page must name')
            watch_read_only(report, loader, store,
                            'the API says the store is refusing writes (read-only)',
                            options.stopped_bound, avail)
    if not volume.clear_filler():
        report.fail('the filler is removed from the volume', volume.filler_dir)
    recovered = wait_until(time.monotonic() + options.ready_timeout, 5,
                           lambda: probe_write(store)[0] in (200, 204))
    report.check(recovered, 'the store accepts writes again after the filler is removed',
                 'no restart was needed')
    report.check(read_only_of(loader.logs_status(*window())) is False,
                 'the API says the store is not read-only after the filler is removed',
                 describe(loader.logs_status(*window())))
    return True


def restore(report, options, cluster, volume, state, forwarding):
    """Put back every change, then say what the machine looks like now."""
    restored = True
    try:
        restored = restore_collector_selector(cluster, state) and restored
        restored = restore_pod_logs(cluster, state) and restored
    except WalkError:
        restored = False
    if not volume.clear_filler():
        restored = False
    if forwarding is not None:
        forwarding.close()
    try:
        ready = wait_collector(cluster, options, ready=True)
    except WalkError:
        ready = False
    if restored and ready:
        print('RESTORE collector %s/%s Ready with the pod template the walk found, no filler on %s'
              % (COLLECTOR_NAMESPACE, COLLECTOR, options.mount))
    else:
        print('RESTORE incomplete: collector %s/%s is %s; check its pod template and %s by hand'
              % (COLLECTOR_NAMESPACE, COLLECTOR, 'Ready' if ready else 'NOT Ready', options.mount))


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-FRESH (ADR-016 L14)')
    common_arguments(parser)
    parser.add_argument('--stop-label-key', default='lifemodel.dev/walk-fresh-stop')
    parser.add_argument('--stopped-bound', type=int, default=120)
    parser.add_argument('--live-bound', type=int, default=150)
    parser.add_argument('--ready-timeout', type=int, default=300)
    parser.add_argument('--fill-timeout', type=int, default=300)
    parser.add_argument('--heartbeat-fresh', type=int, default=60)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    volume = Volume(options.mount, options.pv_path)
    state = {}
    forwarding = None
    try:
        try:
            secret = read_password(options.password_file)
        except WalkError as error:
            print('FAIL the credential file is readable - ' + str(error))
            return 1
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return 1
        store, forwarding = connect_store(report, options, cluster)
        if store is None:
            return 1
        run(report, options, loader, cluster, store, volume, state)
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        restore(report, options, cluster, volume, state, forwarding)
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
