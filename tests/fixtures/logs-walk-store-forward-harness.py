"""Drives the walks' store client through a forward the store's pod kills.

The walks reach the store through `kubectl port-forward deploy/logs-store`, and
a port-forward is bound to the pod it resolved when it started: a retention
change (and the partition key, and anything else that rolls the store) replaces
that pod, and the forward logs `failed to find sandbox` or `lost connection to
pod` and never answers again. This harness hands `logs_walk_support.StoreForward`
a fake forward factory whose forwards are local `/flags` endpoints, so the unit
test can hold the replacement without a cluster: the first forward answers one
request and closes its listener, the client opens a second one on a fresh port,
and the retried request is answered there.

usage: logs-walk-store-forward-harness.py <mode> <support.py>
"""
import importlib.util
import json
import socket
import sys
import threading
import time


def load(path):
    spec = importlib.util.spec_from_file_location('logs_walk_support', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeForward:
    """One forwarded `/flags` endpoint: a listener that can be closed mid-run."""

    def __init__(self, local_port, flags, requests_before_death):
        self.local_port = local_port
        self.flags = flags
        self.requests_before_death = requests_before_death
        self.requests = 0
        self.stopped = False
        self.closed = False
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
        body = ('/flags\n' + '\n'.join(self.flags) + '\n').encode()
        response = (
            b'HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\ncontent-length: '
            + str(len(body)).encode() + b'\r\n\r\n' + body
        )
        try:
            connection.sendall(response)
        except OSError:
            pass
        if self.requests >= self.requests_before_death:
            # The replaced pod: the forward is gone and the next connect is refused.
            self.stop()

    def wait_ready(self, timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.stopped:
                return False
            try:
                with socket.create_connection(('127.0.0.1', self.local_port), timeout=2):
                    return True
            except OSError:
                time.sleep(0.05)
        return False

    def stop(self):
        if self.stopped:
            return
        self.stopped = True
        try:
            self.listener.close()
        except OSError:
            pass

    def close(self):
        self.closed = True
        self.stop()


class FakeForwardFactory:
    """One fake forward per `start()`, scripted by the mode."""

    def __init__(self, script):
        self.script = script
        self.forwards = []

    def __call__(self, kubectl, namespace, target, local_port):
        entry = self.script[min(len(self.forwards), len(self.script) - 1)]
        forward = FakeForward(local_port, entry['flags'], entry['requests'])
        self.forwards.append(forward)
        return forward

    def report(self):
        return [{'port': forward.local_port, 'requests': forward.requests,
                 'stopped': forward.stopped, 'closed': forward.closed}
                for forward in self.forwards]


def flags_answer(days):
    return [
        '-retentionPeriod="%dd"' % days,
        '-retention.maxDiskSpaceUsageBytes="314572800"',
        '-storage.minFreeDiskSpaceBytes="805306368"',
    ]


MODES = {
    # The first forward dies after answering once; the second answers normally.
    'forward-replaced': [{'flags': flags_answer(7), 'requests': 1},
                         {'flags': flags_answer(14), 'requests': 1000}],
    # Every forward is gone: the renewal itself fails.
    'forward-never-replaced': [{'flags': flags_answer(7), 'requests': 1},
                               {'flags': flags_answer(14), 'requests': 0}],
}


def main(mode, support_path):
    support = load(support_path)
    factory = FakeForwardFactory(MODES[mode])
    tunnel = support.StoreForward('fake-kubectl', 'lifemodel-system', 'deploy/logs-store',
                                  forward_factory=factory)
    if not tunnel.open():
        print('FORWARD NOT OPEN')
        return 1
    store = support.Store(forward=tunnel)
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


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
