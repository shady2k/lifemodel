#!/usr/bin/env python3
"""The clients the ADR-016 stage-2 walks share (L06, L08, L14, L15, L16).

Five walks reach the same four places: the loader's login and its JSON routes,
the log store through a port-forward, `k3s kubectl`, and the log volume on the
host. A copy of each in every walk would drift apart, so they live here once.
Nothing in this file decides an assertion or prints a verdict: it reaches the
machine, and the walks say what that means.

The conventions every walk follows, and this file keeps where it can:

- the password is read from a file argument and is never printed, and the
  partition key is read into a variable and never printed (ADR-016 lesson 7);
- `k3s kubectl` is the cluster command, and the loader is reached over TLS at
  `boot-lifemodel.local` unless a walk is pointed at a port-forward;
- one PASS/FAIL line per assertion, a NOTE for something that is reported and
  not judged, and `TEST NOT VALID` for a walk that never reached the state it
  asserts on;
- the exit status is the failure count, never a printed line alone.

The store is reached over plain HTTP on a local port that
`kubectl port-forward deploy/logs-store <port>:9428` opens: port-forward is not
subject to the store's NetworkPolicy, and the forward's pid is kept so the walk
kills exactly the process it started, never a pattern match. A forward stays
bound to the pod it resolved, so it is replaced on a fresh port when a roll of
the store replaces that pod (`StoreForward`).
"""
import base64
import http.client
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

DEFAULT_LOADER_HOST = 'boot-lifemodel.local'
DEFAULT_LOADER_PORT = 443
DEFAULT_KUBECTL = 'k3s kubectl'
DEFAULT_STORE_NAMESPACE = 'lifemodel-system'
DEFAULT_STORE_DEPLOYMENT = 'logs-store'
DEFAULT_STORE_PORT = 9428
MIB = 1024 * 1024
GIB = 1024 * MIB
RESPONSE_LIMIT = 16 * 1024 * 1024
# The store's own margin is 25 % of the claim (ADR-016 §5); the read-only gauge
# is the signal the page's line comes from; and the filler is written in 32 MiB
# chunks as uid 1000, the store's own user.
MARGIN_SHARE = 0.25
READ_ONLY_GAUGE = 'vl_storage_is_read_only'
FILLER_CHUNK = 32 * 1024 * 1024
SUFFIXES = {
    'Ki': 1024, 'Mi': MIB, 'Gi': 1024 * MIB, 'Ti': 1024 * 1024 * MIB,
    'KiB': 1024, 'MiB': MIB, 'GiB': 1024 * MIB, 'TiB': 1024 * 1024 * MIB,
    'K': 1000, 'M': 1000 * 1000, 'G': 1000 * 1000 * 1000, 'T': 1000 * 1000 * 1000 * 1000,
    'k': 1000,
}

# The collector's own write protocol (ADR-016 §3): the message and the event
# time are the fields the sink names, so a walk's record is shaped like a real
# one instead of being whatever the store would do with a bare JSON object.
INSERT_PATH = (
    '/insert/jsonline?_stream_fields=module,namespace,level,untrusted'
    '&_msg_field=message&_time_field=timestamp'
)


class WalkError(Exception):
    """The machine did not answer in a way the walk can reason about."""


class Report:
    """The PASS/FAIL/NOTE lines, the failure count and the invalid marker."""

    def __init__(self):
        self.failures = 0
        self.invalid = 0

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

    def not_valid(self, text):
        """The state this walk asserts on was never reached: say so and fail.

        A walk that cannot reach, for example, a stopped collector has nothing
        to say about what the page shows then, so it does not report the
        assertion either way: it fails as a test that did not run.
        """
        self.invalid += 1
        self.failures += 1
        print('TEST NOT VALID ' + text)

    def result(self):
        print('RESULT %d assertion(s) failed, %d never reached their state' % (
            self.failures, self.invalid))
        return 1 if self.failures else 0


def now_ms():
    return int(time.time() * 1000)


def parse_ms(value):
    """An RFC 3339 time in milliseconds, or None when it is not one."""
    import calendar
    import re
    if not isinstance(value, str):
        return None
    match = re.match(
        r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$',
        value.strip(),
    )
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


def day_of(milliseconds):
    """The store's partition day for a time, `YYYYMMDD`, in UTC."""
    return time.strftime('%Y%m%d', time.gmtime(milliseconds / 1000))


def day_bounds(day):
    """The first and last millisecond of a `YYYYMMDD` day, in UTC."""
    import calendar
    start = calendar.timegm(time.strptime(day, '%Y%m%d'))
    return start * 1000, start * 1000 + 86400 * 1000 - 1


EVICTOR_MODULE = 'logs-evictor'


def oldest_record_ms(store):
    """The oldest stored `_time` over the whole retention, as one aggregation.

    No lower bound: a dropped day can hold rows older than the walk's own
    window - the latency walk plants rows an hour back, into the previous UTC
    day - and a window that starts after them would never see the oldest row
    move.
    """
    rows = store.query('* | stats min(_time)')
    if len(rows) != 1:
        return None
    return parse_ms(rows[0].get('min(_time)'))


def evictor_records(loader, from_ms):
    """The evictor's own lines in a window, oldest first, through the API."""
    answer = loader.logs({'from': str(from_ms), 'to': str(now_ms()),
                          'module': EVICTOR_MODULE, 'limit': '50'})
    if answer is None or answer.get('state') != 'ok':
        return []
    records = [record for record in (answer.get('records') or [])
               if isinstance(record, dict) and isinstance(record.get('time'), str)]
    records.sort(key=lambda record: record['time'])
    return records


def drop_line(record):
    """One evictor line's day, bytes and reason, or None when it names no day."""
    try:
        body = json.loads(record.get('message') or '')
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    day = body.get('day')
    freed = body.get('freedBytes')
    if not isinstance(day, str) or not re.match(r'^\d{8}$', day):
        return None
    if not isinstance(freed, (int, float)) or freed <= 0:
        return None
    return {'time': parse_ms(record.get('time')), 'day': day, 'freedBytes': int(freed),
            'reason': body.get('reason')}


def wait_until(deadline, interval, predicate):
    """Poll until the predicate answers truthy or the monotonic deadline passes."""
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            return predicate()
        time.sleep(interval)


class Loader:
    """The loader's own login and JSON routes, over its TLS listener."""

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
        conn = http.client.HTTPSConnection(self.host, self.port, timeout=20, context=self.context)
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

    def csrf(self):
        """The token `PUT` demands, from the state route the page itself reads."""
        state = self.json('/api/state')
        token = (state or {}).get('csrfToken')
        return token if isinstance(token, str) and token else None

    def logs(self, params):
        """`GET /api/logs` with the page's own parameters; None when not 200."""
        status, value = self.logs_page(params)
        return value if status == 200 else None

    def logs_page(self, params):
        """`GET /api/logs` with its HTTP status, never losing a refusal."""
        status, data = self.request('GET', '/api/logs?' + urlencode(params))
        if status != 200:
            return status, None
        try:
            value = json.loads(data)
        except ValueError:
            return status, None
        return status, value if isinstance(value, dict) else None

    def logs_status(self, from_ms, to_ms):
        """The first page's answer with the freshness and store alarm (ADR-016 §4).

        One cheap page is enough: the status rides on the first page's answer,
        and the assertion reads it instead of the screen.
        """
        answer = self.logs({'from': str(from_ms), 'to': str(to_ms), 'limit': '1', 'status': '1'})
        if answer is None or answer.get('state') != 'ok':
            return {'state': 'unavailable', 'reason': (answer or {}).get('reason', 'http_or_invalid')}
        return answer

    def settings(self):
        answer = self.json('/api/logs/settings')
        return answer if isinstance(answer, dict) else None

    def put_settings(self, days, max_bytes, csrf, origin=None, content_type='application/json'):
        body = json.dumps({'days': days, 'maxBytes': max_bytes}).encode()
        status, data = self.request(
            'PUT',
            '/api/logs/settings',
            body,
            {
                'content-type': content_type,
                'origin': origin if origin is not None else 'https://' + self.origin_host,
                **({'x-csrf-token': csrf} if csrf else {}),
            },
        )
        try:
            value = json.loads(data)
        except ValueError:
            value = None
        return status, (value if isinstance(value, dict) else {'state': 'unreadable'})


class Store:
    """The log store's HTTP protocol on a local port-forward (ADR-016 §3).

    Every path is absolute: `http.client` sends the path as the request target,
    and the store answers 400 to `GET flags` where it answers 200 to `GET /flags`
    (measured on the VM).
    """

    def __init__(self, host='127.0.0.1', port=None, forward=None):
        self.host = host
        self.forward = forward
        self.port = port if port is not None else (
            forward.port if forward is not None else DEFAULT_STORE_PORT)
        self.connection = None

    def _connection(self, timeout):
        if self.connection is None:
            self.connection = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        return self.connection

    def _drop(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except OSError:
                pass
        self.connection = None

    def _renew_forward(self):
        """A fresh forward after the store's pod was replaced; False if it never came up."""
        if self.forward is None:
            return False
        if not self.forward.renew():
            return False
        self.port = self.forward.port
        return True

    def _forward_reason(self):
        """Why the renewal gave up, for the walk's failure line; empty when unknown."""
        if self.forward is None:
            return ''
        detail = self.forward.failure_detail()
        return (' - ' + detail) if detail else ''

    def _http(self, method, path, body=None, headers=None, timeout=60):
        merged = {'accept': '*/*'}
        merged.update(headers or {})
        for attempt in (0, 1):
            try:
                connection = self._connection(timeout)
                connection.request(method, path, body=body, headers=merged)
                response = connection.getresponse()
                data = response.read(RESPONSE_LIMIT)
                if response.will_close:
                    self._drop()
                return response.status, data
            except (OSError, http.client.HTTPException) as error:
                self._drop()
                if attempt:
                    raise WalkError('store_unreachable: ' + type(error).__name__) from None
                # A retention change (and the partition key, and anything else that
                # rolls the store) replaces the Deployment's pod, and a forward is
                # bound to the pod it resolved when it started: the retry needs a
                # new forward on a new port, or it fails against the dead one again.
                if not self._renew_forward():
                    raise WalkError('store_unreachable: forward' + self._forward_reason()) from None
        raise WalkError('store_unreachable')

    def query(self, logsql, timeout=60):
        status, data = self._http(
            'POST',
            '/select/logsql/query',
            urlencode({'query': logsql}).encode(),
            {'content-type': 'application/x-www-form-urlencoded'},
            timeout,
        )
        if status != 200:
            raise WalkError('store_query_%d' % status)
        records = []
        for line in data.decode('utf8', 'replace').split('\n'):
            if line.strip() == '':
                continue
            try:
                records.append(json.loads(line))
            except ValueError:
                raise WalkError('store_query_invalid_body') from None
        return records

    def count(self, logsql, timeout=60):
        records = self.query(logsql, timeout)
        if len(records) != 1:
            raise WalkError('store_count_shape')
        value = records[0].get('count(*)')
        try:
            return int(value)
        except (TypeError, ValueError):
            raise WalkError('store_count_value') from None

    def flags(self):
        """`/flags` as `name -> value`; the process's effective flags (ADR-016 §5)."""
        status, data = self._http('GET', '/flags')
        if status != 200:
            raise WalkError('store_flags_%d' % status)
        flags = {}
        for raw in data.decode('utf8', 'replace').split('\n'):
            line = raw.strip()
            if not line.startswith('-') or '=' not in line:
                continue
            name, _, value = line.partition('=')
            value = value.strip()
            if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            flags[name[1:]] = value
        return flags

    def metrics(self):
        """The store's gauges as `name -> float`, without the labels."""
        status, data = self._http('GET', '/metrics')
        if status != 200:
            raise WalkError('store_metrics_%d' % status)
        gauges = {}
        for raw in data.decode('utf8', 'replace').split('\n'):
            line = raw.strip()
            if line == '' or line.startswith('#'):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            name = parts[0].split('{')[0]
            try:
                gauges[name] = float(parts[1])
            except ValueError:
                continue
        return gauges

    def insert(self, lines, timeout=120):
        """Write records through the collector's own sink protocol; (status, body)."""
        body = ('\n'.join(json.dumps(line) for line in lines) + '\n').encode()
        return self._http(
            'POST',
            INSERT_PATH,
            body,
            {'content-type': 'application/stream+json'},
            timeout,
        )

    def detach(self, day, key):
        """The store's detach: it answers only after the readers of that day stop.

        The day and the key travel in an `application/x-www-form-urlencoded`
        POST body, never in the URL (ADR-016 §5): the store logs the full
        request URI on an error, and its error logging masks form keys but not
        query keys, so a refused detach would otherwise put the key into the
        collected logs. The handlers read `r.FormValue`, which takes these
        bodies.
        """
        fields = {'name': day} if not key else {'name': day, 'authKey': key}
        status, data = self._http(
            'POST',
            '/internal/partition/detach',
            urlencode(fields).encode(),
            {'content-type': 'application/x-www-form-urlencoded'},
        )
        return status, data.decode('utf8', 'replace')

    def partition_list(self, key=None):
        """The store's day list, its key in a form body (ADR-016 §5).

        A call with no key is the walk's refusal check: the store answers its
        own refusal, and the call itself carries nothing in its URL.
        """
        fields = {} if key is None else {'authKey': key}
        status, data = self._http(
            'POST',
            '/internal/partition/list',
            urlencode(fields).encode(),
            {'content-type': 'application/x-www-form-urlencoded'},
        )
        return status, data.decode('utf8', 'replace')

    def close(self):
        self._drop()


class PortForward:
    """`kubectl port-forward` as a process whose pid the walk owns and kills.

    Port-forward is not subject to the store's NetworkPolicy, which is why a
    walk reaches the store this way. It is killed by pid, never by a pattern
    that would match the walk's own command line.
    """

    def __init__(self, kubectl, namespace, target, local_port, remote_port=DEFAULT_STORE_PORT):
        self.argv = shlex.split(kubectl) + [
            '-n', namespace, 'port-forward', target,
            '%d:%d' % (local_port, remote_port),
        ]
        self.local_port = local_port
        self.process = None
        self.log_path = None
        self.death = None

    def start(self):
        handle, name = tempfile.mkstemp(prefix='logs-walk-portforward-', suffix='.log')
        os.close(handle)
        self.log_path = Path(name)
        with open(self.log_path, 'wb') as sink:
            self.process = subprocess.Popen(
                self.argv, stdout=sink, stderr=sink, start_new_session=True
            )
        return self

    def wait_ready(self, timeout=90):
        """True when the port accepts; False with `death` saying which way it failed."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                self.death = 'the process exited with code %s' % self.process.returncode
                return False
            try:
                with socket.create_connection(('127.0.0.1', self.local_port), timeout=2):
                    return True
            except OSError:
                time.sleep(0.5)
        self.death = 'nothing accepted 127.0.0.1:%d within %d s' % (self.local_port, timeout)
        return False

    def log_tail(self, count=20):
        """The forward's own last lines: kubectl's messages, never a secret."""
        if self.log_path is None:
            return []
        try:
            text = self.log_path.read_text(errors='replace')
        except OSError:
            return []
        return [line.rstrip() for line in text.splitlines() if line.strip()][-count:]

    def close(self, keep_log=False):
        """Stop the forward; keep its log when it died or never came up.

        The log is kubectl's own output and is the only evidence of why a start
        did not answer, so a failed start keeps it and `log_tail` can quote it.
        """
        if self.process is not None:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                try:
                    self.process.kill()
                    self.process.wait(timeout=5)
                except (OSError, subprocess.SubprocessError):
                    pass
            self.process = None
        if self.log_path is not None and not keep_log:
            try:
                self.log_path.unlink()
            except OSError:
                pass
            self.log_path = None


class StoreForward:
    """The port-forward a store client holds, and how it is replaced.

    A port-forward is bound to the pod it resolved when it started. Every roll of
    the store — a retention change, the partition key, a replaced pod — recreates
    that pod (`Recreate`), and the forward then logs `failed to find sandbox` or
    `lost connection to pod` and never answers again. So a store client opens its
    forward through this object: `renew()` closes the dead one and starts a new
    one on a fresh port.

    A start can also fail on its own for a moment — measured on vm-lifemodel: a
    renewal right after the store's pod was replaced never came up, and the same
    start worked three minutes later — so `open()` tries again a few times over a
    bounded interval before it gives up, and it keeps each failed start's log:
    `failure_detail()` reads back why they died.
    """

    def __init__(self, kubectl, namespace, target, forward_factory=None, ready_timeout=90,
                 start_attempts=3, retry_interval=15):
        self.kubectl = kubectl
        self.namespace = namespace
        self.target = target
        self.forward_factory = forward_factory or PortForward
        self.ready_timeout = ready_timeout
        self.start_attempts = start_attempts
        self.retry_interval = retry_interval
        self.forward = None
        self.port = None
        self.failures = []

    def open(self):
        """A forward on a free port; False when every start never answered.

        `start_attempts` starts, `retry_interval` seconds apart (three tries over
        30 s by default); a failed start keeps its log for `failure_detail()`.
        """
        self.close()
        self.failures = []
        for attempt in range(1, self.start_attempts + 1):
            port = free_port()
            forward = self.forward_factory(self.kubectl, self.namespace, self.target, port).start()
            if forward.wait_ready(self.ready_timeout):
                self.forward = forward
                self.port = port
                return True
            self.failures.append((forward.death or 'it never answered',
                                  list(forward.log_tail())))
            forward.close(keep_log=True)
            if attempt < self.start_attempts:
                time.sleep(self.retry_interval)
        return False

    def renew(self):
        return self.open()

    def failure_detail(self):
        """Why no start answered, in one line, with each start's own last words."""
        if not self.failures:
            return ''
        parts = []
        for number, (death, lines) in enumerate(self.failures, 1):
            text = '%d) %s' % (number, death)
            if lines:
                text += '; kubectl: ' + ' | '.join(lines[-5:])
            parts.append(text)
        return '%d start(s) %g s apart: %s' % (
            len(self.failures), self.retry_interval, '; '.join(parts))

    def close(self):
        if self.forward is not None:
            self.forward.close()
        self.forward = None
        self.port = None


def free_port():
    """A port nothing listens on yet, for the forward to bind."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class Cluster:
    """`k3s kubectl`: the one cluster command every walk uses."""

    def __init__(self, command=DEFAULT_KUBECTL):
        self.argv = shlex.split(command)

    def run(self, args, timeout=120, stdin=None):
        try:
            return subprocess.run(
                self.argv + args, capture_output=True, text=True, timeout=timeout, input=stdin
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise WalkError('kubectl_failed: ' + type(error).__name__) from None

    def ok(self, args, timeout=120):
        return self.run(args, timeout).returncode == 0

    def out(self, args, timeout=120):
        result = self.run(args, timeout)
        if result.returncode != 0:
            raise WalkError('kubectl_nonzero: ' + ' '.join(args[:3]))
        return result.stdout.strip()

    def json(self, args, timeout=120):
        result = self.run(args, timeout)
        if result.returncode != 0:
            return None
        try:
            return json.loads(result.stdout)
        except ValueError:
            return None

    def pod(self, namespace, name):
        return self.json(['-n', namespace, 'get', 'pod', name, '-o', 'json'])

    def pods(self, namespace, selector=None):
        args = ['-n', namespace, 'get', 'pods']
        if selector:
            args += ['-l', selector]
        body = self.json(args + ['-o', 'json'])
        return (body or {}).get('items', [])

    def apply(self, manifest, namespace=None):
        """Apply one object from a JSON manifest, the way the walk creates a pod."""
        return self.run(['apply', '-f', '-'], timeout=120, stdin=json.dumps(manifest))

    def is_ready(self, namespace, name):
        pod = self.pod(namespace, name)
        conditions = ((pod or {}).get('status') or {}).get('conditions') or []
        return any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in conditions)

    def restart_count(self, namespace, name):
        pod = self.pod(namespace, name) or {}
        statuses = ((pod.get('status') or {}).get('containerStatuses') or [])
        total = 0
        for status in statuses:
            try:
                total += int(status.get('restartCount') or 0)
            except (TypeError, ValueError):
                continue
        return total

    def secret_value(self, namespace, name, field):
        """A Secret's field, decoded, for a caller to hold in a variable.

        It is never printed: the partition key is the one value the ADR says
        travels nowhere else, and its own store log carries no line for it.
        """
        encoded = self.out(
            ['-n', namespace, 'get', 'secret', name, '-o',
             'jsonpath={.data.' + field + '}'],
        )
        if encoded == '':
            return ''
        try:
            return base64.b64decode(encoded).decode('utf8')
        except (ValueError, UnicodeDecodeError):
            raise WalkError('secret_unreadable') from None


class Volume:
    """The log volume as the host sees it, under the PV's own path."""

    def __init__(self, mount, pv_path, filler_name='walk-filler'):
        self.mount = mount
        self.pv_path = pv_path
        self.filler_dir = os.path.join(pv_path, filler_name)
        self.filler_file = os.path.join(self.filler_dir, 'filler.bin')

    def mounted(self):
        try:
            return os.path.ismount(self.mount)
        except OSError:
            return False

    def space(self):
        stats = os.statvfs(self.pv_path)
        return stats.f_bsize * stats.f_blocks, stats.f_bsize * stats.f_bavail

    def partitions(self):
        root = os.path.join(self.pv_path, 'partitions')
        try:
            return sorted(
                name for name in os.listdir(root)
                if len(name) == 8 and name.isdigit() and os.path.isdir(os.path.join(root, name))
            )
        except OSError:
            return []

    def remove_day(self, day):
        """Remove a day's directory; the caller detaches it from the store first."""
        import shutil
        shutil.rmtree(os.path.join(self.pv_path, 'partitions', day))

    def prepare_filler(self, uid=1000, gid=1000):
        os.makedirs(self.filler_dir, exist_ok=True)
        os.chown(self.filler_dir, uid, gid)
        os.chmod(self.filler_dir, 0o750)

    def write_filler(self, chunk_bytes, uid=1000, gid=1000):
        """Append one incompressible chunk as uid 1000: the store's own user.

        A second process drops to the store's uid before it opens the file, so
        the space is spent by the same identity that writes the logs.
        """
        data = os.urandom(chunk_bytes)
        pid = os.fork()
        if pid == 0:
            try:
                os.setgroups([])
                os.setgid(gid)
                os.setuid(uid)
                handle = os.open(self.filler_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
                with os.fdopen(handle, 'wb') as sink:
                    sink.write(data)
                os._exit(0)
            except BaseException:
                os._exit(1)
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status) == 0

    def clear_filler(self):
        import shutil
        try:
            shutil.rmtree(self.filler_dir)
            return True
        except OSError:
            return not os.path.exists(self.filler_dir)


RECORD_PAYLOAD_BYTES = 384
HEADROOM_BYTES = 768 * MIB


def threshold_bytes(total_bytes):
    """The evictor's threshold: the store's margin plus one minute of flood (ADR-016 §5)."""
    import math
    return int(math.ceil(total_bytes * MARGIN_SHARE)) + HEADROOM_BYTES


def flood_batch(count, moment_ms, run_id, kind, module='walk-flood'):
    """Incompressible records for one insert, shaped like the collector's own."""
    import base64
    import os
    moment = stamp(moment_ms)
    lines = []
    for sequence in range(count):
        lines.append({
            'timestamp': moment,
            'message': '%s %s %06d %s' % (run_id, kind, sequence,
                                          base64.b64encode(os.urandom(RECORD_PAYLOAD_BYTES))
                                          .decode('ascii')),
            'module': module,
            'namespace': 'walk',
            'pod': 'walk-flood',
            'container': 'walk',
            'stream': 'stdout',
            'level': 'info',
            'untrusted': False,
        })
    return lines


def write_burst(store, moment_ms, run_id, mib, kind, module='walk-flood'):
    """One insert of incompressible records; returns (status, line count)."""
    count = max(1, int(mib * MIB) // (RECORD_PAYLOAD_BYTES + 220))
    status, _body = store.insert(flood_batch(count, moment_ms, run_id, kind, module))
    return status, count


def refusal_windows(samples):
    """Consecutive 429 answers as windows, in seconds, from (moment, status) samples."""
    windows = []
    opened = None
    for moment, status in samples:
        if status == 429 and opened is None:
            opened = moment
        elif status != 429 and opened is not None:
            windows.append({'start': opened, 'end': moment,
                            'seconds': max(0.0, (moment - opened) / 1000.0)})
            opened = None
    if opened is not None:
        last = samples[-1][0] if samples else opened
        windows.append({'start': opened, 'end': last,
                        'seconds': max(0.0, (last - opened) / 1000.0)})
    return windows


def window(seconds=3600):
    """The last `seconds` for a status read: the page's own cheap page range."""
    end = now_ms()
    return end - seconds * 1000, end


def status_of(answer):
    return (answer or {}).get('status') or {}


def read_only_of(answer):
    value = status_of(answer).get('storeReadOnly')
    return value if isinstance(value, bool) else None


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


def margin_bytes(volume, store_margin=None):
    """The free space a walk fills past: the store's own margin, when it is readable.

    `-storage.minFreeDiskSpaceBytes` is 25 % of the *claim's* capacity, which is
    larger than the filesystem's own total (ext4 keeps its metadata), so a
    quarter of `statvfs`'s total can sit above the store's threshold and a fill
    to it would never make the store refuse. The flag is the number the store
    enforces, so it is the number the walk fills past.
    """
    if isinstance(store_margin, int) and store_margin > 0:
        return store_margin
    total, _avail = volume.space()
    return int(total * MARGIN_SHARE)


def fill_volume(report, options, volume, store, threshold):
    """Spend the volume's free space below the store's margin; True when reached.

    The chunk is written as uid 1000, the store's own user, on the filesystem the
    store reads. The filler lives in a directory of its own under the PV path,
    beside `partitions/`, which the store does not read.
    """
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


def wait_refused(report, store, bound_seconds, interval=1.0):
    """Probe until the store refuses a write; every answer, within the bound.

    Read-only is decided per insert request, but the free-space figure behind it
    is cached for two seconds per path, so the probe straight after the last
    filler write can still be accepted while the volume is already below the
    margin. Probing again is how the walk reaches the state the store itself
    reaches; it is not a retry of a failed assertion, and when the store never
    refuses the NOTE lists what it answered each time.
    """
    started = time.monotonic()
    answers = []
    while True:
        status, body = probe_write(store)
        answers.append(status)
        if status == 429:
            return status, body, answers
        if time.monotonic() - started >= bound_seconds:
            report.note('the store never refused a write in %d probe(s) over %d s: it answered %s'
                        % (len(answers), bound_seconds, ', '.join(str(s) for s in answers)))
            return status, body, answers
        time.sleep(interval)


def check_read_only_gauge(report, store):
    """The store's own read-only gauge, the signal the page's line comes from."""
    try:
        gauge = store.metrics().get(READ_ONLY_GAUGE)
    except WalkError:
        gauge = None
    if gauge is None:
        report.note('the store exports no %s gauge in this run; the page\'s read-only line '
                    'comes from it, so an API answer of storeReadOnly is the only evidence'
                    % READ_ONLY_GAUGE)
        return
    report.check(gauge == 1, 'the store\'s own %s gauge is 1 when it refuses a write'
                 % READ_ONLY_GAUGE, 'gauge=%s' % ('1' if gauge == 1 else str(gauge)))


def watch_read_only(report, loader, name, bound_seconds, free_bytes):
    """Wait for the API's answer to say the store refuses writes, or fail."""
    started = time.monotonic()

    def attempt():
        return read_only_of(loader.logs_status(*window())) is True

    reached = wait_until(started + bound_seconds, 3, attempt)
    elapsed = time.monotonic() - started
    if reached:
        report.pass_(name, 'storeReadOnly=true, %.0f s after the filler, %d MiB free'
                     % (elapsed, free_bytes // MIB))
    else:
        answer = loader.logs_status(*window())
        report.fail(name, 'storeReadOnly=%s, the API answered %s'
                    % (str(read_only_of(answer)).lower(), (answer or {}).get('state')))
    return reached


def common_arguments(parser):
    """The arguments every Python walk takes, with the test VM's defaults."""
    parser.add_argument('--password-file', required=True)
    parser.add_argument('--loader-host', default=DEFAULT_LOADER_HOST)
    parser.add_argument('--loader-port', type=int, default=DEFAULT_LOADER_PORT)
    parser.add_argument('--origin-host', default=DEFAULT_LOADER_HOST)
    parser.add_argument('--ca-file')
    parser.add_argument('--kubectl', default=DEFAULT_KUBECTL)
    parser.add_argument('--namespace', default=DEFAULT_STORE_NAMESPACE)
    parser.add_argument('--store', default=DEFAULT_STORE_DEPLOYMENT)
    parser.add_argument('--mount', default='/var/lib/lifemodel-logs')
    parser.add_argument('--pv-path', default='/var/lib/lifemodel-logs/data')
    parser.add_argument('--deadline-seconds', type=int, default=3600)
    return parser


def read_password(path):
    """The loader's password from its file; raises WalkError when unreadable."""
    try:
        secret = Path(path).read_text(encoding='utf8').rstrip('\r\n')
    except OSError:
        raise WalkError('credential_file_unreadable') from None
    if not secret:
        raise WalkError('credential_file_empty')
    return secret


def connect_store(report, options, cluster):
    """A store client on its own port-forward; the forward is returned for close.

    The client replaces the forward itself when the store's pod is replaced, so
    the handle returned here is what the walk closes when it is done.
    """
    forward = StoreForward(options.kubectl, options.namespace, 'deploy/' + options.store)
    if not forward.open():
        detail = forward.failure_detail()
        report.fail('the store answers its port-forward',
                    options.store + ((' - ' + detail) if detail else ''))
        return None, None
    return Store(forward=forward), forward


def quantity(text):
    """A byte quantity the way the store prints one: bytes, or a suffix form."""
    if not isinstance(text, str):
        return None
    value = text.strip()
    digits = ''
    suffix = ''
    for character in value:
        if character.isdigit() or (character == '.' and '.' not in digits and digits != ''):
            digits += character
        else:
            suffix += character
    if digits == '':
        return None
    try:
        number = float(digits)
    except ValueError:
        return None
    if suffix == '':
        factor = 1
    else:
        factor = SUFFIXES.get(suffix)
    if factor is None:
        return None
    return int(number * factor)


def days_of(period):
    """`14d` as 14; None for any other form."""
    if not isinstance(period, str) or not period.endswith('d'):
        return None
    try:
        return int(period[:-1])
    except ValueError:
        return None


def read_store_flags(report, options, cluster, what='the /flags read'):
    """`/flags` from the store pod through a port-forward of its own.

    A fresh forward for every read, opened after the walk waited for the rollout
    it is about to assert; if the store's pod is replaced while the read runs, the
    client renews the forward and asks again.
    """
    forward = StoreForward(options.kubectl, options.namespace, 'deploy/' + options.store,
                           ready_timeout=60)
    try:
        if not forward.open():
            report.not_valid('the store never answered its port-forward: %s cannot be asserted'
                             % what)
            return None
        store = Store(forward=forward)
        try:
            return store.flags()
        finally:
            store.close()
    except WalkError:
        report.not_valid('the store\'s /flags endpoint did not answer: %s cannot be asserted'
                         % what)
        return None
    finally:
        forward.close()


def start_task_writer(report, options, loader, cluster, run_id, rate, seconds, size=0, bound=180):
    """Ask the real core to launch a writer and prove its first collected task line."""
    from logs_task_writer import start_task_writer as launch
    return launch(report, options, loader, cluster, run_id, rate, seconds, size, bound)


def tail_lines(text, count):
    return '\n'.join(text.splitlines()[-count:])
