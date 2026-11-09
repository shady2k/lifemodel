#!/usr/bin/env python3
"""WALK-LOGS-SETTING: the retention setting reaches the store, and is proved
there or said to be pending (ADR-016 L08, §5).

What it proves
--------------
1. Two changes go through the page's own route, each with a session, the CSRF
   token of `/api/state` and the exact Origin: 14 days to 7, then 7 to 14 (when
   the setting the walk found is already 7 the two are swapped, and the RESTORE
   puts the found value back). Each answer is the page's shape: `applied` with no
   `pending`, or `pending` with one of the four reasons
   (`store_unavailable`, `rollout_timeout`, `forbidden`, `mismatch`). The walk
   reads the answer right after each PUT and waits for `applied` within
   --apply-bound seconds.
2. The store's own effective flags, read from `/flags` through a port-forward
   (the same request the loader's adapter makes), hold the desired values, which
   only happens when the VL_-prefixed ConfigMap keys reach the flags through
   `-envflag.enable -envflag.prefix=VL_`; and the ConfigMap
   `lifemodel-system/lifemodel-logs-settings` holds the same values under their
   VL_ keys with the desired revision. The read happens only after the rollout it
   waits for has finished (the Deployment's updated and available replicas equal
   its replicas), because a forward opened while `Recreate` replaces the store's
   pod binds the pod that is about to go and never answers again.
3. A repeated PUT of the identical body changes no revision: `desiredRevision`,
   the Deployment's generation and the store pod's uid and restartCount are all
   unchanged, so nothing restarted.
4. The state a crash between the ConfigMap write and the annotation leaves still
   converges. The walk produces that state deterministically: after a change was
   applied it rolls the Deployment's two revision annotations back to the
   previous revision (the ConfigMap keeps the new values and the new revision),
   reads the answer - `pending` with a reason, never `applied` - deletes the
   loader's pod before its 30 s reconcile loop can repair it, and asserts the
   replacement loader re-bumps the annotation, the store restarts, and `applied`
   returns with the flags read back as the desired values.
   The millisecond race between the loader's own two writes is not reproduced:
   both are HTTP round trips a few milliseconds apart and the walk cannot hold
   the loader between them. What is asserted is the recovery from the state the
   race leaves, which is the property L08 states.
5. A write without the CSRF token and without the exact Origin is refused with
   403, so the route's admission is not satisfied by a session alone.

Arguments (defaults are the test VM's)
-------------------------------------
  --password-file PATH   the loader's login password, read from this file and
                         never printed (required)
  --loader-host HOST     where the walk connects (default boot-lifemodel.local)
  --loader-port PORT     the loader's TLS port (default 443)
  --origin-host HOST     the host the loader answers on (default
                         boot-lifemodel.local); pass 127.0.0.1 with a
                         port-forward for --loader-host
  --ca-file PATH         verify the loader's certificate with this CA
  --kubectl COMMAND      default "k3s kubectl"
  --namespace NS         the store's namespace (default lifemodel-system)
  --store NAME           the store's Deployment (default logs-store)
  --loader-namespace NS  the loader's namespace (default lifemodel-system)
  --loader-selector SEL  the loader pods' label selector
                         (default app.kubernetes.io/name=loader)
  --days N               the first change's day count (default 7)
  --days-next N          the second change's day count, and the repeated PUT's
                         (default 14)
  --apply-bound N        bound on `applied` after each change, and on the
                         store's rollout before the flags are read (default
                         180 s)
  --loader-restart-bound N  bound on the replacement loader answering after the
                         crash case (default 300 s)
  --deadline-seconds N   the whole walk's bound (default 3600)

What it changes and restores
----------------------------
The retention setting: the walk PUTs --days, then --days-next, repeats the last
one, and puts the setting it found back in the `finally`, waiting for `applied`
there too. It deletes the loader's pod once (its Deployment recreates it) and
patches the store Deployment's two revision annotations twice (the rollback of
the crash case, and the loader's own re-bump). Nothing else is touched: not the
partition key, not a stored record, not the volume. The RESTORE line names the
setting restored and whether the store proved it.

What it does not cover
----------------------
L08's first-install half (`optional: true` on the loader's ConfigMap, the
defaults ConfigMap booting a store before the loader ever ran) is a rendered-
manifest property, asserted by `tests/unit/platform-logs-settings-manifests.test.ts`
and its admission tests, and cannot be produced on a store that has already run.
The admission lists, the loader's RBAC and the release manifest are repository
tests for the same reason. The partition-key half of the row (an empty Secret
written once, a non-empty key untouched) is also a unit test.

Exit status is non-zero when any assertion failed or a state was never reached.
"""
import argparse
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    Cluster,
    Loader,
    Report,
    WalkError,
    common_arguments,
    days_of,
    quantity,
    read_password,
    read_store_flags,
    wait_until,
)

MIB = 1024 * 1024
MARGIN_SHARE = 0.25
REVISION_ANNOTATION = 'lifemodel.dev/logs-settings-revision'
SETTINGS_CONFIGMAP = 'lifemodel-logs-settings'
PENDING_REASONS = ('store_unavailable', 'rollout_timeout', 'forbidden', 'mismatch')
def margin_bytes(volume_bytes):
    """The share of the volume the store keeps for its merges (ADR-016 §5)."""
    return int(math.ceil(volume_bytes * MARGIN_SHARE))


def desired_flags(days, max_bytes, volume_bytes):
    """The three ConfigMap keys (VL_ prefixed) as the store's flag values."""
    return {
        'VL_retentionPeriod': '%dd' % days,
        'VL_retention_maxDiskSpaceUsageBytes': str(max_bytes),
        'VL_storage_minFreeDiskSpaceBytes': str(margin_bytes(volume_bytes)),
    }


def flags_agree(flags, expected):
    """The store's `/flags` answer against the desired values (ADR-016 §5)."""
    observed = {
        'days': days_of(flags.get('retentionPeriod')),
        'maxBytes': quantity(flags.get('retention.maxDiskSpaceUsageBytes')),
        'minFreeBytes': quantity(flags.get('storage.minFreeDiskSpaceBytes')),
    }
    wanted = {
        'days': days_of(expected.get('VL_retentionPeriod')),
        'maxBytes': quantity(expected.get('VL_retention_maxDiskSpaceUsageBytes')),
        'minFreeBytes': quantity(expected.get('VL_storage_minFreeDiskSpaceBytes')),
    }
    return observed == wanted, observed, wanted


def settings_answer(loader):
    answer = loader.settings()
    if not isinstance(answer, dict) or answer.get('state') != 'ok':
        return None
    return answer


def wait_applied(loader, bound_seconds):
    started = time.monotonic()

    def attempt():
        answer = settings_answer(loader)
        return answer if answer is not None and answer.get('applied') is True else None

    applied = wait_until(started + bound_seconds, 2, attempt)
    return applied, time.monotonic() - started


def apply_change(report, loader, days, max_bytes, bound_seconds):
    """One PUT through the page's route, then the pending/applied answer."""
    status, answer = loader.put_settings(days, max_bytes, loader.csrf())
    if status != 200 or answer.get('state') != 'ok':
        report.fail('the change to %d days is accepted' % days,
                    'PUT /api/logs/settings answered %d, state %s'
                    % (status, answer.get('state', 'unreadable')))
        return None
    report.pass_('the change to %d days is accepted' % days,
                 'desiredRevision %s' % answer.get('desiredRevision'))
    if answer.get('applied') is True:
        report.note('the store proved the change inside the PUT before the walk could read a '
                    'pending answer: the rollout finished within the request')
    elif answer.get('pending') in PENDING_REASONS:
        report.pass_('the change is pending with a reason before it is applied',
                     'pending=%s' % answer.get('pending'))
    else:
        report.fail('the change is pending with a reason before it is applied',
                    'applied=%s pending=%s'
                    % (answer.get('applied'), answer.get('pending')))
    applied, elapsed = wait_applied(loader, bound_seconds)
    if applied is None:
        last = settings_answer(loader) or {}
        report.fail('the change is applied',
                    'still pending=%s after %.0f s' % (last.get('pending'), elapsed))
        return None
    report.pass_('the change is applied',
                 '%.0f s after the PUT, desiredRevision %s, appliedAt %s'
                 % (elapsed, applied.get('desiredRevision'), applied.get('appliedAt')))
    return applied


def store_rollout_finished(deployment):
    """The Deployment's rollout is done: every replica is updated and available."""
    if not isinstance(deployment, dict):
        return False
    spec = deployment.get('spec') or {}
    status = deployment.get('status') or {}
    try:
        replicas = int(spec.get('replicas', 1))
        updated = int(status.get('updatedReplicas') or 0)
        available = int(status.get('availableReplicas') or 0)
    except (TypeError, ValueError):
        return False
    return replicas > 0 and updated == replicas and available == replicas


def wait_store_rollout(report, cluster, options, bound_seconds, name):
    """Wait for the rollout the applied answer promised, before `/flags` is read.

    `applied` means the loader read the desired flags from a Ready pod of the new
    template, but that answer can still race the Deployment's own status, and a
    port-forward opened while `Recreate` is mid-rollout binds the pod that is
    about to go. Only a Deployment whose updated and available replicas equal its
    replicas is the state the flags are asserted on.
    """
    started = time.monotonic()

    def attempt():
        deployment = deploy_deployment(cluster, options)
        return deployment if store_rollout_finished(deployment) else None

    deployment = wait_until(started + bound_seconds, 2, attempt)
    if deployment is None:
        report.not_valid('the store\'s rollout did not finish within %d s: %s cannot be asserted'
                         % (bound_seconds, name))
        return False
    status = deployment.get('status') or {}
    report.pass_('the store\'s rollout finished before the flags are read',
                 '%s/%s replicas updated and available, %.0f s after the wait started'
                 % (status.get('updatedReplicas'), (deployment.get('spec') or {}).get('replicas'),
                    time.monotonic() - started))
    return True


def check_flags(report, options, cluster, expected, name):
    if not wait_store_rollout(report, cluster, options, options.apply_bound, name):
        return False
    flags = read_store_flags(report, options, cluster)
    if flags is None:
        return False
    agree, observed, wanted = flags_agree(flags, expected)
    report.check(agree, name,
                 '-retentionPeriod="%s" -retention.maxDiskSpaceUsageBytes="%s" '
                 '-storage.minFreeDiskSpaceBytes="%s"'
                 % (flags.get('retentionPeriod'), flags.get('retention.maxDiskSpaceUsageBytes'),
                    flags.get('storage.minFreeDiskSpaceBytes')))
    if not agree:
        report.note('the flags the walk wanted: %s' % wanted)
    return agree


def read_configmap(report, cluster, options):
    body = cluster.json(['-n', options.namespace, 'get', 'configmap', SETTINGS_CONFIGMAP, '-o', 'json'])
    if body is None:
        report.not_valid('the setting ConfigMap %s/%s exists' % (options.namespace, SETTINGS_CONFIGMAP))
        return None
    return body


def deploy_deployment(cluster, options):
    return cluster.json(['-n', options.namespace, 'get', 'deployment', options.store, '-o', 'json'])


def store_pod(cluster, options):
    pods = cluster.pods(options.namespace, 'app.kubernetes.io/name=' + options.store)
    if not pods:
        return None
    pod = pods[0]
    statuses = ((pod.get('status') or {}).get('containerStatuses') or [])
    restarts = sum(int(status.get('restartCount') or 0) for status in statuses)
    return {'uid': (pod.get('metadata') or {}).get('uid'), 'restarts': restarts}


def loader_pod(cluster, options):
    pods = cluster.pods(options.loader_namespace, options.loader_selector)
    for pod in pods:
        if (pod.get('metadata') or {}).get('deletionTimestamp'):
            continue
        conditions = (pod.get('status') or {}).get('conditions') or []
        if any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in conditions):
            return (pod.get('metadata') or {}).get('name')
    return None


def rollback_revision(cluster, options, revision):
    """Put an older revision on both annotation maps: the state a crash leaves."""
    result = cluster.run([
        '-n', options.namespace, 'patch', 'deployment', options.store, '--type=merge',
        '-p',
        '{"metadata":{"annotations":{"%s":"%s"}},"spec":{"template":{"metadata":'
        '{"annotations":{"%s":"%s"}}}}}'
        % (REVISION_ANNOTATION, revision, REVISION_ANNOTATION, revision),
    ])
    return result.returncode == 0


def crash_case(report, loader, cluster, options, previous_revision, store_expected):
    """The state between the two writes, then the restart that must repair it."""
    if not previous_revision:
        report.not_valid('no previous revision was seen: the crash state cannot be produced')
        return False
    answer = {}
    for attempt in range(3):
        if not rollback_revision(cluster, options, previous_revision):
            report.not_valid('the Deployment annotation could not be rolled back: the crash state '
                             'was not produced')
            return False
        answer = settings_answer(loader) or {}
        if answer.get('applied') is not True:
            break
        # The loader's own 30 s reconcile repaired the annotation inside the read;
        # roll it back again and read once more.
        report.note('the loader reconciled the annotation before the read (attempt %d): '
                    'rolling it back again' % (attempt + 1))
    report.check(
        answer.get('applied') is not True and answer.get('pending') in PENDING_REASONS,
        'the state between the two writes reads pending, never applied',
        'applied=%s pending=%s' % (answer.get('applied'), answer.get('pending')),
    )
    pod = loader_pod(cluster, options)
    if pod is None:
        report.not_valid('no Ready loader pod to restart: the crash case cannot run')
        return False
    result = cluster.run(['-n', options.loader_namespace, 'delete', 'pod', pod,
                          '--wait=false'])
    if result.returncode != 0:
        report.fail('the loader is killed after the ConfigMap write', 'the delete was refused')
        return False
    report.pass_('the loader is killed after the ConfigMap write and before the annotation',
                 'pod %s deleted while the Deployment annotation is %s'
                 % (pod, previous_revision))

    def replacement():
        try:
            name = loader_pod(cluster, options)
            if name is None or name == pod:
                return None
            # A new pod: the session may not survive it, so the walk logs in again.
            return name if loader.login(loader.secret) == 200 else None
        except WalkError:
            # The replacement is not answering yet; the next poll asks again.
            return None

    name = wait_until(time.monotonic() + options.loader_restart_bound, 5, replacement)
    if name is None:
        report.fail('the replacement loader answers after the crash',
                    'not within %d s' % options.loader_restart_bound)
        return False
    report.pass_('the replacement loader answers after the crash', 'pod ' + name)
    applied, elapsed = wait_applied(loader, options.apply_bound)
    if applied is None:
        last = settings_answer(loader) or {}
        report.fail('the restarted loader converges to applied',
                    'still pending=%s after %.0f s' % (last.get('pending'), elapsed))
        return False
    report.pass_('the restarted loader converges to applied',
                 '%.0f s after its start, desiredRevision %s'
                 % (elapsed, applied.get('desiredRevision')))
    return check_flags(report, options, cluster, store_expected,
                       'the restarted store runs the desired flags after the crash')
def check_refusals(report, loader, days, max_bytes):
    """The route's admission: a session alone is not enough (ADR-016 §4, N8)."""
    refused = 0
    for label, kwargs in (
        ('without the CSRF token', {'csrf': None}),
        ('with another Origin', {'csrf': loader.csrf(), 'origin': 'https://not-the-loader.local'}),
    ):
        status, _answer = loader.put_settings(days, max_bytes, **kwargs)
        refused += 1 if status == 403 else 0
    report.check(refused == 2, 'the write demands the CSRF token and the exact Origin',
                 'both refused writes answered 403, %d of 2' % refused)


def run(report, options, loader, cluster):
    """The two changes, the repeat, the crash case and the refusal."""
    found = settings_answer(loader)
    if found is None:
        report.not_valid('GET /api/logs/settings did not answer: nothing to compare against')
        return False
    limits = found.get('limits') or {}
    volume = limits.get('volumeBytes')
    if not isinstance(volume, int) or volume <= 0:
        report.not_valid('the claim\'s capacity is unknown: the margin and the flags cannot '
                         'be asserted')
        return False
    found_days = int(found.get('days') or 0)
    found_max = int(found.get('maxBytes') or 0)
    report.note('the setting found: %d days, %d MiB, desiredRevision %s, applied=%s'
                % (found_days, found_max // MIB, found.get('desiredRevision'),
                   str(found.get('applied')).lower()))
    max_bytes = found_max

    check_refusals(report, loader, found_days, found_max)

    first, second = options.days, options.days_next
    if found_days == first:
        first, second = second, first
    previous = found.get('desiredRevision')
    if apply_change(report, loader, first, max_bytes, options.apply_bound) is None:
        report.not_valid('the first change never applied: the flags and the crash case need a '
                         'proved change')
        return False
    before_second = settings_answer(loader) or {}
    previous = before_second.get('desiredRevision')
    applied = apply_change(report, loader, second, max_bytes, options.apply_bound)
    if applied is None:
        report.not_valid('the second change never applied: the repeat and the crash case need it')
        return False
    store_expected = desired_flags(second, max_bytes, volume)
    check_flags(report, options, cluster, store_expected,
                'the store\'s own /flags hold the desired values (VL_ prefix)')
    configmap = read_configmap(report, cluster, options)
    if configmap is not None:
        data = configmap.get('data') or {}
        annotations = (configmap.get('metadata') or {}).get('annotations') or {}
        report.check(
            all(data.get(key) == value for key, value in store_expected.items()),
            'the setting ConfigMap holds the desired values under their VL_ keys',
            'revision %s' % annotations.get(REVISION_ANNOTATION),
        )

    # The identical repeated PUT: same revision, same generation, no restart.
    deployment_before = deploy_deployment(cluster, options)
    pod_before = store_pod(cluster, options)
    repeated = apply_change(report, loader, second, max_bytes, options.apply_bound)
    deployment_after = deploy_deployment(cluster, options)
    pod_after = store_pod(cluster, options)
    same_revision = (applied.get('desiredRevision') is not None
                     and (repeated or {}).get('desiredRevision') == applied.get('desiredRevision'))
    same_generation = ((deployment_before or {}).get('metadata') or {}).get('generation') == \
                      ((deployment_after or {}).get('metadata') or {}).get('generation')
    report.check(same_revision and same_generation and pod_before == pod_after,
                 'an identical repeated PUT changes no revision and restarts nothing',
                 'revision %s, generation %s, pod unchanged=%s'
                 % (applied.get('desiredRevision'),
                    ((deployment_after or {}).get('metadata') or {}).get('generation'),
                    str(pod_before == pod_after).lower()))

    crash_case(report, loader, cluster, options, previous, store_expected)
    return True


def restore(report, loader, options, found_days, found_max):
    """Put the setting the walk found back, and wait for it to be applied."""
    if found_days is None or found_max is None:
        print('RESTORE nothing to restore: the setting the walk found is unknown')
        return
    status, answer = loader.put_settings(found_days, found_max, loader.csrf())
    applied = None
    if status == 200 and answer.get('state') == 'ok':
        applied, _elapsed = wait_applied(loader, options.apply_bound)
    if applied is not None:
        print('RESTORE the setting found is back: %d days, %d MiB, applied=%s'
              % (found_days, found_max // MIB, str(applied.get('applied')).lower()))
    else:
        print('RESTORE incomplete: the setting was asked back (%d days, %d MiB) but the store '
              'did not prove it within %d s' % (found_days, found_max // MIB, options.apply_bound))


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-SETTING (ADR-016 L08)')
    common_arguments(parser)
    parser.add_argument('--loader-namespace', default='lifemodel-system')
    parser.add_argument('--loader-selector', default='app.kubernetes.io/name=loader')
    parser.add_argument('--days', type=int, default=7)
    parser.add_argument('--days-next', type=int, default=14)
    parser.add_argument('--apply-bound', type=int, default=180)
    parser.add_argument('--loader-restart-bound', type=int, default=300)
    options = parser.parse_args(argv)

    report = Report()
    cluster = Cluster(options.kubectl)
    found_days = None
    found_max = None
    loader = None
    try:
        try:
            secret = read_password(options.password_file)
        except WalkError as error:
            print('FAIL the credential file is readable - ' + str(error))
            return 1
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        loader.secret = secret
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return 1
        found = settings_answer(loader) or {}
        found_days = int(found.get('days')) if isinstance(found.get('days'), int) else None
        found_max = int(found.get('maxBytes')) if isinstance(found.get('maxBytes'), int) else None
        run(report, options, loader, cluster)
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        if loader is not None and found_days is not None and found_max is not None:
            try:
                if loader.login(read_password(options.password_file)) != 200:
                    print('RESTORE incomplete: the loader did not accept a login after the walk')
                else:
                    restore(report, loader, options, found_days, found_max)
            except WalkError:
                print('RESTORE incomplete: the loader did not answer; put %d days, %d MiB back '
                      'by hand' % (found_days, found_max // MIB))
        else:
            print('RESTORE nothing to restore: the setting the walk found is unknown')
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
