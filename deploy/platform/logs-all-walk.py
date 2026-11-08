#!/usr/bin/env python3
"""WALK-LOGS-ALL: every pod's lines are in the log store, across a module restart (ADR-016 L01, L13).

What it proves
--------------
1. The loader's logs API answers after a login, and the module list names the
   module of the pod about to be restarted.
2. One module's pod (core-0 by default) is restarted. After it is Ready, its
   lines from *before* the restart are still found through `GET /api/logs`, by
   time window and module, and the records name the ADR's `pod` and `namespace`
   fields. They are not read with `kubectl logs`; the walk never calls it.
3. Every pod `k3s kubectl get pods -A` lists is found through the logs API by
   its `module` (the ADR's label chain: `app.kubernetes.io/name`, else `app`,
   else `k8s-app`, else `cnpg.io/cluster`, else `unknown`) and its `pod` field.
   Missing pods are listed one per line. Pods that are not Running (a completed
   Job pod, a pod still being created) are named as such and are not required:
   they may never have written a line.

The log workloads themselves (`logs-collector`, `logs-store`) are part of that
inventory, which is L13's evidence on a deployed build.

Arguments (defaults are the test VM's)
-------------------------------------
  --password-file PATH   the loader's login password, read from this file and
                         never printed (required)
  --loader-host HOST     where the walk connects (default boot-lifemodel.local)
  --loader-port PORT     the loader's TLS port (default 443)
  --origin-host HOST     the host the loader answers on; sent as Host and as the
                         Origin of the login (default boot-lifemodel.local).
                         Pass 127.0.0.1 with a port-forward for --loader-host.
  --ca-file PATH         verify the loader's certificate with this CA; without
                         it the TLS chain is not verified
  --kubectl COMMAND      default "k3s kubectl"
  --namespace NS         namespace of the restarted pod (default lifemodel)
  --pod NAME             the pod to restart (default core-0)
  --lookback-hours N     how far back the inventory scan may reach (default 336)
  --max-pages N          record pages read per module, 200 records each (default 40)
  --pre-minutes N        how far before the restart its kept lines are searched (default 60)
  --timeout SECONDS      bound on waiting for the restarted pod to be Ready (default 600)
  --wait-seconds SECONDS bound on re-scanning for a pod that has not appeared yet (default 90)

What it changes and restores
----------------------------
It deletes one pod; the pod's controller (the core StatefulSet by default)
recreates it under the same name, which the walk waits for. Pass a pod a
controller recreates with the same name (a StatefulSet pod); a Deployment's pod
gets a new name and the walk reports that it did not come back. The `finally`
block waits for the replacement to be Ready, also when an assertion fails, and
prints a RESTORE line. Nothing else is changed.

Exit status is non-zero when any assertion failed.
"""
import argparse
import calendar
import http.client
import json
import re
import shlex
import ssl
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

RESPONSE_LIMIT = 8 * 1024 * 1024
TIME = re.compile(
    r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$'
)
MODULE_LABELS = ('app.kubernetes.io/name', 'app', 'k8s-app', 'cnpg.io/cluster')


class WalkError(Exception):
    pass


class Report:
    def __init__(self):
        self.failures = 0

    def pass_(self, name, detail=''):
        print('PASS ' + name + ((' - ' + detail) if detail else ''))

    def fail(self, name, detail=''):
        self.failures += 1
        print('FAIL ' + name + ((' - ' + detail) if detail else ''))

    def check(self, ok, name, detail=''):
        (self.pass_ if ok else self.fail)(name, detail)
        return ok

    def note(self, text):
        print('NOTE ' + text)


def now_ms():
    return int(time.time() * 1000)


def parse_ms(value):
    """The record's time in milliseconds, or None when it is not RFC 3339."""
    if not isinstance(value, str):
        return None
    match = TIME.match(value.strip())
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    fraction = match.group(7) or ''
    millis = int((fraction + '000')[:3])
    zone = match.group(8) or 'Z'
    offset = 0
    if zone != 'Z':
        sign = -1 if zone[0] == '-' else 1
        offset = sign * (int(zone[1:3]) * 3600 + int(zone[4:6]) * 60)
    return (calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0)) - offset) * 1000 + millis


def stamp(milliseconds):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(milliseconds / 1000))


class Loader:
    """The loader's own login and logs routes, over its TLS listener."""

    def __init__(self, host, port, origin_host, ca_file):
        self.host = host
        self.port = port
        self.origin_host = origin_host
        self.cookies = {}
        if ca_file:
            self.context = ssl.create_default_context(cafile=ca_file)
        else:
            self.context = ssl.create_default_context()
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPSConnection(
            self.host, self.port, timeout=20, context=self.context
        )
        merged = {'Host': self.origin_host, 'accept': 'application/json'}
        if self.cookies:
            merged['cookie'] = '; '.join(name + '=' + value for name, value in self.cookies.items())
        merged.update(headers or {})
        try:
            conn.request(method, path, body=body, headers=merged)
            response = conn.getresponse()
            data = response.read(RESPONSE_LIMIT)
            if len(data) >= RESPONSE_LIMIT:
                raise WalkError('response_too_large')
            for raw in response.headers.get_all('set-cookie') or []:
                pair = raw.split(';')[0].strip()
                name, separator, value = pair.partition('=')
                if separator and value:
                    self.cookies[name] = value
            return response.status, data
        except (OSError, http.client.HTTPException) as error:
            raise WalkError('loader_unreachable: ' + type(error).__name__) from None
        finally:
            conn.close()

    def login(self, secret):
        body = json.dumps({'password': secret}).encode()
        status, _ = self.request(
            'POST',
            '/api/login',
            body,
            {'content-type': 'application/json', 'origin': 'https://' + self.origin_host},
        )
        return status

    def json(self, path):
        status, data = self.request('GET', path)
        if status != 200:
            return None
        try:
            value = json.loads(data)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def records(self, start, end, module=None):
        params = {'from': str(start), 'to': str(end)}
        if module:
            params['module'] = module
        answer = self.json('/api/logs?' + urlencode(params))
        if answer is None or answer.get('state') != 'ok':
            reason = 'http_or_invalid'
            if answer is not None:
                reason = str(answer.get('reason') or answer.get('state'))
            raise WalkError('logs_unavailable: ' + reason)
        records = answer.get('records')
        return records if isinstance(records, list) else []


def kubectl(args, options, timeout=60):
    command = shlex.split(options.kubectl) + args
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        raise WalkError('kubectl_failed: ' + type(error).__name__) from None


def pods(options):
    result = kubectl(['get', 'pods', '-A', '-o', 'json'], options, timeout=120)
    if result.returncode != 0:
        raise WalkError('kubectl_get_pods_failed')
    try:
        return json.loads(result.stdout).get('items', [])
    except ValueError:
        raise WalkError('kubectl_output_invalid') from None


def module_of(labels):
    if not isinstance(labels, dict):
        return 'unknown'
    for key in MODULE_LABELS:
        value = labels.get(key)
        if isinstance(value, str) and value:
            return value
    return 'unknown'


def is_ready(pod):
    conditions = pod.get('status', {}).get('conditions') or []
    return any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in conditions)


def phase_of(pod):
    return str(pod.get('status', {}).get('phase') or 'Unknown')


def find_pod(options, namespace, name):
    result = kubectl(['-n', namespace, 'get', 'pod', name, '-o', 'json'], options)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except ValueError:
        return None


def scan_module(loader, module, wanted, start, max_pages, deadline):
    """Walk one module's records newest first; return the pods it names."""
    found = {}
    pages = 0
    end = now_ms()
    while set(wanted) - set(found) and pages < max_pages and time.monotonic() < deadline:
        records = loader.records(start, end, module)
        pages += 1
        if not records:
            break
        times = []
        for record in records:
            fields = record.get('fields') if isinstance(record.get('fields'), dict) else {}
            pod = fields.get('pod')
            if pod in wanted and pod not in found:
                found[pod] = fields
            moment = parse_ms(record.get('time'))
            if moment is not None:
                times.append(moment)
        if not times:
            break
        oldest = min(times)
        if oldest <= start or oldest - 1 >= end:
            break
        end = oldest - 1
    return found, pages


def inventory(report, loader, options, deadline):
    items = pods(options)
    required = {}
    for pod in items:
        metadata = pod.get('metadata') or {}
        name = metadata.get('name')
        namespace = metadata.get('namespace')
        if not name or not namespace:
            continue
        if phase_of(pod) != 'Running' or metadata.get('deletionTimestamp'):
            report.note('%s/%s is %s and is not required to have a record' % (
                namespace, name, phase_of(pod)))
            continue
        required[(namespace, name)] = module_of(metadata.get('labels'))

    wanted_by_module = {}
    for (namespace, name), module in required.items():
        wanted_by_module.setdefault(module, set()).add(name)

    start = now_ms() - options.lookback_hours * 3600 * 1000
    found = {}
    pages = {}
    for module, names in sorted(wanted_by_module.items()):
        seen, count = scan_module(loader, module, names, start, options.max_pages, deadline)
        found.update(seen)
        pages[module] = count

    # A pod that started a moment ago may not be stored yet: look again, bounded.
    wait_until = min(deadline, time.monotonic() + options.wait_seconds)
    while True:
        missing = sorted(
            (namespace, name, module)
            for (namespace, name), module in required.items()
            if name not in found
        )
        if not missing or time.monotonic() >= wait_until:
            break
        time.sleep(10)
        start = now_ms() - options.lookback_hours * 3600 * 1000
        for module in sorted({item[2] for item in missing}):
            names = {item[1] for item in missing if item[2] == module}
            seen, count = scan_module(loader, module, names, start, options.max_pages, wait_until)
            found.update(seen)
            pages[module] = pages.get(module, 0) + count

    for namespace, name, module in missing:
        report.fail(
            'pod %s/%s (module %s) is found through the logs API' % (namespace, name, module),
            'no record in %d page(s) over the last %d hour(s)'
            % (pages.get(module, 0), options.lookback_hours),
        )
    if not missing:
        report.pass_(
            'every Running pod from k3s kubectl get pods -A is found through the logs API',
            '%d pods, at most %d page(s) per module' % (len(required), options.max_pages),
        )

    wrong = []
    for (namespace, name), module in sorted(required.items()):
        fields = found.get(name)
        if fields is None:
            continue
        if fields.get('module') != module or fields.get('namespace') != namespace:
            wrong.append('%s/%s names module=%r namespace=%r' % (
                namespace, name, fields.get('module'), fields.get('namespace')))
    report.check(
        not wrong,
        'every found record names its pod, its namespace and its label-chain module',
        '; '.join(wrong[:5]) + (' (and %d more)' % (len(wrong) - 5) if len(wrong) > 5 else ''),
    )
    return required


def restart_and_find(report, loader, options, deadline):
    pod = find_pod(options, options.namespace, options.pod)
    if pod is None:
        report.fail('the pod to restart exists', '%s/%s not found' % (options.namespace, options.pod))
        return False
    if not report.check(is_ready(pod), 'the pod to restart is Ready before the walk',
                        '%s/%s' % (options.namespace, options.pod)):
        return False
    module = module_of((pod.get('metadata') or {}).get('labels'))
    old_uid = (pod.get('metadata') or {}).get('uid')

    modules = loader.json('/api/logs/modules')
    names = []
    if isinstance(modules, dict) and modules.get('state') == 'ok':
        names = [name for name in (modules.get('modules') or []) if isinstance(name, str)]
    report.check(module in names, 'GET /api/logs/modules names the module of the restarted pod',
                 'module ' + module)

    restart_at = now_ms()
    result = kubectl(['-n', options.namespace, 'delete', 'pod', options.pod, '--wait=false'], options)
    if result.returncode != 0:
        report.fail('the pod is deleted for the restart', 'kubectl delete returned non-zero')
        return False

    end = min(deadline, time.monotonic() + options.timeout)
    replacement = None
    while time.monotonic() < end:
        current = find_pod(options, options.namespace, options.pod)
        if current is not None and (current.get('metadata') or {}).get('uid') != old_uid:
            if is_ready(current):
                replacement = current
                break
        time.sleep(2)
    if replacement is None:
        report.fail('the restarted pod is Ready again', 'not Ready within %d s' % options.timeout)
        return False
    report.pass_('the restarted pod is Ready again',
                 '%s/%s after %s' % (options.namespace, options.pod, stamp(restart_at)))

    start = restart_at - options.pre_minutes * 60 * 1000
    records = loader.records(start, restart_at - 1, module)
    kept = [record for record in records
            if isinstance(record.get('fields'), dict) and record['fields'].get('pod') == options.pod]
    newest = max((parse_ms(record.get('time')) or 0 for record in kept), default=0)
    report.check(
        bool(kept),
        'the module\'s lines from before the restart are found by time and module',
        '%d line(s) of module %s for pod %s before %s'
        % (len(kept), module, options.pod, stamp(restart_at)),
    )
    report.check(
        newest < restart_at,
        'the kept lines are older than the restart',
        'newest kept line ' + (stamp(newest) if newest else 'none'),
    )
    report.check(
        all(record['fields'].get('namespace') == options.namespace for record in kept),
        'the kept lines name their namespace',
        'field namespace',
    )
    return True


def main():
    parser = argparse.ArgumentParser(description='WALK-LOGS-ALL (ADR-016 L01, L13)')
    parser.add_argument('--password-file', required=True)
    parser.add_argument('--loader-host', default='boot-lifemodel.local')
    parser.add_argument('--loader-port', type=int, default=443)
    parser.add_argument('--origin-host', default='boot-lifemodel.local')
    parser.add_argument('--ca-file')
    parser.add_argument('--kubectl', default='k3s kubectl')
    parser.add_argument('--namespace', default='lifemodel')
    parser.add_argument('--pod', default='core-0')
    parser.add_argument('--lookback-hours', type=int, default=336)
    parser.add_argument('--max-pages', type=int, default=40)
    parser.add_argument('--pre-minutes', type=int, default=60)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--wait-seconds', type=int, default=90)
    parser.add_argument('--deadline-seconds', type=int, default=1800)
    options = parser.parse_args()

    report = Report()
    deadline = time.monotonic() + options.deadline_seconds
    restarted = False
    try:
        try:
            secret = Path(options.password_file).read_text(encoding='utf8').rstrip('\r\n')
        except OSError:
            print('FAIL the credential file is readable')
            return 1
        if not secret:
            print('FAIL the credential file is not empty')
            return 1
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return 1
        restarted = True
        restart_and_find(report, loader, options, deadline)
        inventory(report, loader, options, min(deadline, time.monotonic() + options.timeout + 600))
    except WalkError as error:
        report.fail('the walk runs to its end', str(error))
    finally:
        # The controller recreates the deleted pod; wait for that, also on failure.
        end = time.monotonic() + options.timeout
        current = find_pod(options, options.namespace, options.pod) if restarted else None
        while restarted and (current is None or not is_ready(current)) and time.monotonic() < end:
            time.sleep(2)
            current = find_pod(options, options.namespace, options.pod)
        if restarted:
            print('RESTORE %s/%s is %s' % (
                options.namespace, options.pod,
                'Ready' if current is not None and is_ready(current) else 'NOT Ready'))
    print('RESULT %d assertion(s) failed' % report.failures)
    return 1 if report.failures else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
