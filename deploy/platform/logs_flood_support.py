"""Evidence and safe diagnostics for WALK-LOGS-VOLUME-FLOOD."""
import json
import re
import time

from logs_walk_support import wait_until


def check_commits(report, commits, start_ns, end_ns, bound):
    successful = sorted(entry['end'] for entry in commits if entry.get('result') == 'ok'
                        and start_ns <= entry['end'] <= end_ns)
    if not successful:
        report.not_valid('Postgres recorded zero successful commits during the flood window')
        return False
    errors = sum(1 for entry in commits if entry.get('result') != 'ok'
                 and start_ns <= entry['end'] <= end_ns)
    points = [start_ns] + successful + [end_ns]
    longest = max((second - first) / 1e9 for first, second in zip(points, points[1:]))
    return report.check(errors == 0 and longest <= bound,
                        'Postgres committed throughout with no error and bounded gaps',
                        '%d commits, %d errors, longest gap %.2f s (including window edges), '
                        'bound %s s' % (len(successful), errors, longest, bound))


def is_drop(record):
    if record.get('module') != 'logs-evictor':
        return False
    try:
        body = json.loads(record.get('message') or '')
    except (TypeError, ValueError):
        return False
    return (isinstance(body, dict) and body.get('reason') == 'below_threshold'
            and body.get('msg') == 'the oldest log day was removed'
            and re.fullmatch(r'[0-9]{8}', str(body.get('day') or '')) is not None
            and isinstance(body.get('freedBytes'), (int, float))
            and body['freedBytes'] > 0)


def refusal_verdict(report, samples, drops, bound=120):
    longest = 0
    since = None
    refusals = 0
    for moment, status in samples:
        if status == 429:
            refusals += 1
            if since is None:
                since = moment
        if since is not None:
            longest = max(longest, (moment - since) / 1000)
            if status in (200, 204):
                since = None
    if refusals:
        report.pass_('the store refuses a write under the flood',
                     '%d observed HTTP 429 responses' % refusals)
    elif any(is_drop(record) for record in drops):
        report.note('no HTTP 429 observed: evictor-first behavior; a verified oldest-day '
                    'drop freed space before a refusal was observed (ADR-016 §5)')
    else:
        report.not_valid('no HTTP 429 or verified evictor drop: store refusal was not exercised')
        return False
    if since is not None:
        report.not_valid('the last observed HTTP 429 window has no confirmed successful end')
        return False
    return report.check(longest <= bound, 'observed refusal duration stayed within its bound',
                        'longest observed %.2f s, bound %s s; samples do not prove '
                        'absence between requests' % (longest, bound))


# Only fixed diagnostic words are public. Never echo arbitrary API or client text.
DIAGNOSTICS = ('admission', 'task creator', 'task launcher', 'task owner', 'task identity',
               'task security', 'task launch', 'task environment', 'task volumes',
               'PodSecurity', 'Forbidden', 'AlreadyExists', 'Invalid', 'ResourceQuota',
               'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError',
               'CrashLoopBackOff', 'RunContainerError', 'FailedMount', 'permission denied',
               'role "root" does not exist', 'connection refused', 'could not connect',
               'database "root" does not exist', 'initdb', 'FATAL', 'ERROR')


def diagnostic_codes(text):
    return ', '.join(code for code in DIAGNOSTICS if code.lower() in (text or '').lower())         or 'unclassified (raw diagnostic withheld)'


def create_pod(report, cluster, manifest):
    metadata = manifest['metadata']
    result = cluster.apply(manifest, namespace=metadata['namespace'])
    if result.returncode == 0:
        return True
    report.not_valid('pod %s/%s API create failed (exit %s): %s'
                     % (metadata['namespace'], metadata['name'], result.returncode,
                        diagnostic_codes(result.stderr)))
    return False


def wait_running(cluster, namespace, name, bound=180):
    def running():
        pod = cluster.pod(namespace, name) or {}
        statuses = (pod.get('status') or {}).get('containerStatuses') or []
        return ((pod.get('status') or {}).get('phase') == 'Running' and statuses
                and all('running' in (entry.get('state') or {}) for entry in statuses))
    return bool(wait_until(time.monotonic() + bound, 1, running))


def pod_diagnostics(report, cluster, namespace, name):
    pod = cluster.pod(namespace, name) or {}
    status = pod.get('status') or {}
    states = []
    for entry in status.get('containerStatuses') or []:
        for kind, value in (entry.get('state') or {}).items():
            states.append('%s:%s' % (kind if kind in ('waiting', 'running', 'terminated')
                                    else 'unknown', diagnostic_codes(value.get('reason'))))
    logs = cluster.run(['-n', namespace, 'logs', name, '--tail=80'], timeout=30)
    errors = cluster.run(['-n', namespace, 'exec', name, '--', 'cat', '/tmp/walkerr'], timeout=30)
    report.note('pod %s/%s diagnostic: phase=%s, states=%s; logs(exit %s)=%s; '
                'client-errors(exit %s)=%s'
                % (namespace, name,
                   status.get('phase') if status.get('phase') in
                   ('Pending', 'Running', 'Succeeded', 'Failed', 'Unknown') else 'unknown',
                   ', '.join(states) or 'none', logs.returncode,
                   diagnostic_codes(logs.stdout + logs.stderr), errors.returncode,
                   diagnostic_codes(errors.stdout + errors.stderr)))
