"""Drives the walks' store client through a fake forwarded endpoint.

The walks reach the store through `kubectl port-forward deploy/logs-store`, and
a port-forward is bound to the pod it resolved when it started: a retention
change (and the partition key, and anything else that rolls the store) replaces
that pod, and the forward logs `failed to find sandbox` or `lost connection to
pod` and never answers again. This harness hands `logs_walk_support.StoreForward`
a fake forward factory whose forwards are local HTTP listeners, so the unit test
can hold two things without a cluster:

- the replacement: the first forward answers one request and closes its
  listener, the client opens a second one on a fresh port, and the retried
  request is answered there;
- the request target: the fake store refuses a target that does not start with
  `/` with 400, exactly as the real store did (`GET flags` answered 400 where
  `GET /flags` answered 200), so a path that lost its slash fails the test.

usage: logs-walk-store-forward-harness.py <mode> <support.py>
"""
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time


def load(path):
    spec = importlib.util.spec_from_file_location('logs_walk_support', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def flags_answer(days):
    return '/flags\n' + '\n'.join([
        '-retentionPeriod="%dd"' % days,
        '-retention.maxDiskSpaceUsageBytes="314572800"',
        '-storage.minFreeDiskSpaceBytes="805306368"',
    ]) + '\n'


# The seam's operations (ADR-016 §3), each on its own absolute path.
STORE_ROUTES = {
    '/flags': flags_answer(14),
    '/metrics': 'vl_free_disk_space_bytes 2147483648\nvl_storage_is_read_only 0\n',
    '/select/logsql/query': '{"count(*)": 1}\n',
    '/insert/jsonline': '',
    '/internal/partition/detach': 'ok',
    '/internal/partition/list': '[]',
}


class FakeForward:
    """One forwarded endpoint: routes by path, refuses a target without a slash."""

    def __init__(self, local_port, routes, requests_before_death, death='', log=None):
        self.local_port = local_port
        self.routes = routes
        self.requests_before_death = requests_before_death
        self.death_text = death
        self.log_lines = list(log or [])
        self.death = None
        self.requests = 0
        self.targets = []
        self.stopped = False
        self.closed = False
        self.kept_log = False
        self.listener = None

    def start(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(('127.0.0.1', self.local_port))
        self.listener.listen(8)
        if self.requests_before_death <= 0:
            # A forward that never came up: `wait_ready` must say so.
            self.stop()
            return self
        threading.Thread(target=self._accept, daemon=True).start()
        return self

    def _accept(self):
        while not self.stopped:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            try:
                self._answer(connection)
            finally:
                connection.close()

    def _answer(self, connection):
        connection.settimeout(5)
        request = b''
        try:
            while b'\r\n\r\n' not in request and len(request) < 65536:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                request += chunk
        except OSError:
            return
        if not request:
            return
        self.requests += 1
        parts = request.split(b'\r\n', 1)[0].split()
        target = parts[1].decode('utf8', 'replace') if len(parts) > 1 else ''
        self.targets.append(target)
        if not target.startswith('/'):
            # `http.client` sends the path exactly as given, and the store
            # answers 400 to a request target that does not start with `/`.
            self._respond(connection, 400, b'Bad Request')
        else:
            body = self.routes.get(target.split('?')[0])
            if body is None:
                self._respond(connection, 404, b'Not Found')
            else:
                self._respond(connection, 200, body.encode())
        if self.requests >= self.requests_before_death:
            # The replaced pod: the forward is gone and the next connect is refused.
            self.stop()

    def _respond(self, connection, status, body):
        response = (
            ('HTTP/1.0 %d %s\r\ncontent-type: text/plain\r\ncontent-length: %d\r\n\r\n'
             % (status, b'OK' if status == 200 else body, len(body))).encode() + body
        )
        try:
            connection.sendall(response)
        except OSError:
            pass

    def wait_ready(self, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.stopped:
                self.death = self.death_text or 'the process exited with code 1'
                return False
            try:
                with socket.create_connection(('127.0.0.1', self.local_port), timeout=2):
                    return True
            except OSError:
                time.sleep(0.05)
        self.death = 'nothing accepted 127.0.0.1:%d within %d s' % (self.local_port, timeout)
        return False

    def log_tail(self, count=20):
        # The one message kubectl wrote for this start, as the walk would read it
        # from its own log file.
        return self.log_lines[-count:]

    def stop(self):
        if self.stopped:
            return
        self.stopped = True
        try:
            self.listener.close()
        except OSError:
            pass

    def close(self, keep_log=False):
        self.closed = True
        self.kept_log = keep_log
        self.stop()


class FakeForwardFactory:
    """One fake forward per `start()`, scripted by the mode."""

    def __init__(self, script):
        self.script = script
        self.forwards = []

    def __call__(self, kubectl, namespace, target, local_port):
        entry = self.script[min(len(self.forwards), len(self.script) - 1)]
        forward = FakeForward(local_port, entry['routes'], entry['requests'],
                              entry.get('death', ''), entry.get('log'))
        self.forwards.append(forward)
        return forward

    def report(self):
        return [{'port': forward.local_port, 'requests': forward.requests,
                 'stopped': forward.stopped, 'closed': forward.closed,
                 'keptLog': forward.kept_log,
                 'death': forward.death, 'log': forward.log_lines}
                for forward in self.forwards]


# kubectl's own words for a start that never came up (no secret).
SANDBOX_LOG = ['error: unable to forward port because pod is not running. Current status=Pending']
CONNECTION_LOG = ['E1109 12:00:00.000000 1 portforward.go:406] lost connection to pod']
NEVER_LOG = ['error: lost connection to pod']


MODES = {
    # The first forward dies after answering once; the second answers normally.
    'forward-replaced': [{'routes': {'/flags': flags_answer(7)}, 'requests': 1},
                         {'routes': {'/flags': flags_answer(14)}, 'requests': 1000}],
    # Every forward is gone: the renewal itself fails, and each start says why.
    'forward-never-replaced': [{'routes': {'/flags': flags_answer(7)}, 'requests': 1},
                               {'routes': {}, 'requests': 0,
                                'death': 'the process exited with code 1',
                                'log': NEVER_LOG}],
    # The store's pod is not serving yet: the first two starts never come up.
    'forward-retried': [
        {'routes': {}, 'requests': 0, 'death': 'the process exited with code 1',
         'log': SANDBOX_LOG},
        {'routes': {}, 'requests': 0,
         'death': 'nothing accepted 127.0.0.1:41777 within 1 s', 'log': CONNECTION_LOG},
        {'routes': {'/flags': flags_answer(14)}, 'requests': 1000},
    ],
    # Every operation of the seam once, on a store that refuses a relative target.
    'store-paths': [{'routes': STORE_ROUTES, 'requests': 1000}],
}


def open_store(support, script):
    factory = FakeForwardFactory(script)
    # The retries are a few milliseconds apart here; the walk's own default is
    # three tries 15 s apart, which the defaults mode reports.
    tunnel = support.StoreForward('fake-kubectl', 'lifemodel-system', 'deploy/logs-store',
                                  forward_factory=factory, start_attempts=3,
                                  retry_interval=0.001)
    if not tunnel.open():
        print('FORWARD NOT OPEN')
        return None, None, factory
    return support.Store(forward=tunnel), tunnel, factory


def read_flags_twice(support, mode):
    store, tunnel, factory = open_store(support, MODES[mode])
    if store is None:
        return 1
    reads = []
    try:
        for _ in range(2):
            try:
                reads.append(store.flags().get('retentionPeriod'))
            except support.WalkError as error:
                print('ERROR ' + str(error))
                break
    finally:
        store.close()
        tunnel.close()
    print('READS ' + json.dumps(reads))
    print('FORWARDS ' + json.dumps(factory.report()))
    return 0


def forward_retried(support):
    """The first two starts never come up; the third answers (transient failure)."""
    store, tunnel, factory = open_store(support, MODES['forward-retried'])
    if store is None:
        print('OPEN false')
        return 0
    try:
        first = store.flags().get('retentionPeriod')
    finally:
        store.close()
        tunnel.close()
    print('OPEN ' + json.dumps({'opened': True, 'flags': first}))
    print('FORWARDS ' + json.dumps(factory.report()))
    return 0


def forward_death_detail(support):
    """Every start fails: the detail names each death and kubectl's words."""
    factory = FakeForwardFactory(MODES['forward-never-replaced'][1:])
    tunnel = support.StoreForward('fake-kubectl', 'lifemodel-system', 'deploy/logs-store',
                                  forward_factory=factory, start_attempts=3,
                                  retry_interval=0.001)
    opened = tunnel.open()
    print('OPEN ' + json.dumps(opened))
    print('DETAIL ' + json.dumps(tunnel.failure_detail()))
    print('FORWARDS ' + json.dumps(factory.report()))
    return 0


def forward_defaults(support):
    tunnel = support.StoreForward('fake-kubectl', 'lifemodel-system', 'deploy/logs-store')
    print('DEFAULTS ' + json.dumps({'attempts': tunnel.start_attempts,
                                    'interval': tunnel.retry_interval}))
    return 0


def portforward_death(support):
    """A real start whose kubectl exits at once: death, its log, and the log kept."""
    directory = tempfile.mkdtemp(prefix='logs-walk-kubectl-')
    script = os.path.join(directory, 'kubectl-fails')
    with open(script, 'w', encoding='utf8') as handle:
        handle.write('#!/bin/sh\n'
                     'echo "error: unable to forward port because pod is not running" >&2\n'
                     'exit 1\n')
    os.chmod(script, 0o755)
    forward = support.PortForward(script, 'lifemodel-system', 'deploy/logs-store',
                                 support.free_port())
    forward.start()
    ready = forward.wait_ready(5)
    death = forward.death
    lines = forward.log_tail()
    path = str(forward.log_path)
    forward.close(keep_log=True)
    kept = os.path.exists(path)
    forward.close()
    gone = not os.path.exists(path)
    if os.path.exists(path):
        forward.close()
    print('DEATH ' + json.dumps({'ready': ready, 'death': death, 'lines': lines,
                                 'kept': kept, 'gone': gone}))
    return 0


def store_paths(support):
    store, tunnel, factory = open_store(support, MODES['store-paths'])
    if store is None:
        return 1
    results = {}

    def record(name, call):
        try:
            call()
            results[name] = 'ok'
        except support.WalkError as error:
            results[name] = str(error)

    try:
        record('flags', store.flags)
        record('metrics', store.metrics)
        record('query', lambda: store.query('*', timeout=20))
        record('count', lambda: store.count('*', timeout=20))
        record('insert', lambda: store.insert([{'timestamp': '2026-11-09T00:00:00Z',
                                                'message': 'walk store paths',
                                                'module': 'walk-store-paths'}], timeout=20))
        record('detach', lambda: store.detach('20261109', ''))
        record('partitionList', store.partition_list)
    finally:
        store.close()
        tunnel.close()
    print('TARGETS ' + json.dumps(factory.forwards[0].targets))
    print('RESULTS ' + json.dumps(results))
    return 0


def main(mode, support_path):
    support = load(support_path)
    if mode == 'store-paths':
        return store_paths(support)
    if mode == 'forward-retried':
        return forward_retried(support)
    if mode == 'forward-death-detail':
        return forward_death_detail(support)
    if mode == 'forward-defaults':
        return forward_defaults(support)
    if mode == 'portforward-death':
        return portforward_death(support)
    if mode in MODES:
        return read_flags_twice(support, mode)
    raise SystemExit('unknown mode: ' + mode)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
