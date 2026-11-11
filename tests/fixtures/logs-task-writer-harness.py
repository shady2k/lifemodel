"""Offline doubles for the real-task log writer handshake."""
import http.client
import importlib
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path('deploy/platform').resolve()))
import logs_walk_support as public

scenario = json.loads(Path(sys.argv[1]).read_text())
post_statuses = list(scenario.get('post_statuses') or [])
calls = []
output = []
clock = [0.0]
current = {'attempt': 0}
attempt_started = {}
deleted_jobs = set()
POD_DELAY = 10


def monotonic():
    clock[0] += 0.1
    return clock[0]


def sleep(seconds):
    clock[0] += seconds


def task_pod(name, uid, job):
    return {'metadata': {'name': name, 'uid': uid,
                         'namespace': 'lifemodel-motor',
                         'labels': {'app.kubernetes.io/name': 'task',
                                    'lifemodel.dev/launch-id': 'launch-' + uid,
                                    'job-name': job},
                         'ownerReferences': [{'kind': 'Job', 'name': job,
                                              'uid': 'job-uid-' + job,
                                              'controller': True}]},
            'spec': {'serviceAccountName': 'task', 'containers': [{'name': 'task'}]},
            'status': {'phase': 'Running'}}


old = {'metadata': {'name': 'task-old', 'uid': 'old'}}


class Report:
    def __getattr__(self, name):
        def record(*args):
            output.append(name + ' ' + ' '.join(map(str, args)))
            return True
        return record


class Cluster:
    n = 0

    def _active(self):
        pods = []
        if scenario.get('no_pod'):
            return pods
        for number, started in sorted(attempt_started.items()):
            if clock[0] - started < POD_DELAY:
                continue
            job = 'task-job-%d' % number
            if job in deleted_jobs:
                continue
            pods.append(task_pod('task-pod-%d' % number, 'uid-%d' % number, job))
        return pods

    def pods(self, namespace, selector=None):
        calls.append(['pods', namespace, selector])
        self.n += 1
        if self.n == 1:
            return [old]
        active = self._active()
        if selector is None:
            return [old] + active
        job = selector.split('=', 1)[1] if '=' in selector else ''
        return [pod for pod in active if pod['metadata']['labels']['job-name'] == job]

    def pod(self, namespace, name):
        for pod in self._active():
            if pod['metadata']['name'] == name:
                return pod
        return None

    def run(self, args, **kwargs):
        calls.append(['run'] + list(args))
        if (len(args) >= 5 and args[0] == '-n' and args[2] == 'delete'
                and args[3] == 'job'):
            deleted_jobs.add(args[4])
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        if (len(args) >= 4 and args[0] == '-n' and args[2] == 'delete'
                and args[3] == 'pod'):
            raise AssertionError('a task pod is never deleted')
        raise AssertionError('no task command or direct create allowed')

    def apply(self, *args, **kwargs):
        raise AssertionError('no direct task creation')


class Loader:
    def logs_page(self, params):
        calls.append(['logs', params])
        match = re.search(r'run-test-a(\d+)', str(params.get('text') or ''))
        number = int(match.group(1)) if match else 0
        if scenario.get('refuse'):
            return scenario['refuse'], None
        if scenario.get('no_pod') or scenario.get('no_marker'):
            return 200, {'state': 'ok', 'records': []}
        delay = scenario.get('marker_after_attempt', {}).get(
            str(number), scenario.get('marker_after', 12))
        if clock[0] - attempt_started.get(number, clock[0]) < delay:
            return 200, {'state': 'ok', 'records': []}
        fields = {'pod': 'task-pod-%d' % number, 'namespace': 'lifemodel-motor',
                  'module': 'task', 'untrusted': 'true', 'container': 'task'}
        changes = scenario.get('record', {}).copy()
        message = changes.pop('message', params.get('text')
                              or 'walk-task-writer run-test-a1 seq=1 ')
        fields.update(changes)
        record = {'time': '2026-11-10T00:00:00Z', 'message': message, 'fields': fields}
        return 200, {'state': 'ok', 'records': [record]}

    def logs(self, params):
        status, answer = self.logs_page(params)
        return answer if status == 200 else None


class Forward:
    def __init__(self, *args): self.local_port = 12345; calls.append(['forward', *args])

    def start(self): calls.append(['start'])

    def wait_ready(self, timeout): return not scenario.get('no_forward')

    def close(self, **kwargs): calls.append(['close'])


class Response:
    status = 200

    def __init__(self, method):
        self.status = (post_statuses.pop(0) if post_statuses
                       else scenario.get('post_status', 202)) if method == 'POST' else 200
        self.method = method

    def read(self, *args):
        if self.method == 'POST':
            return b'{"streamId":"1"}'
        return json.dumps({'cursor': '2', 'messages': [{'role': 'assistant',
               'text': 'PRIVATE REPLY task_task123'}]}).encode()


class Connection:
    def __init__(self, *args, **kwargs): self.method = ''

    def request(self, method, path, body=None, headers=None):
        self.method = method
        payload = json.loads(body) if body else None
        if method == 'POST' and isinstance(payload, dict):
            match = re.search(r'run-test-a(\d+)', str(payload.get('text') or ''))
            if match:
                current['attempt'] = int(match.group(1))
                attempt_started[current['attempt']] = clock[0]
        calls.append(['http', method, path, payload, headers])

    def getresponse(self): return Response(self.method)

    def close(self): pass


try:
    helper = importlib.import_module('logs_task_writer')
    helper.PortForward = Forward
    helper.http.client.HTTPConnection = Connection
    helper.time.monotonic = monotonic
    helper.time.sleep = sleep
    result = public.start_task_writer(Report(), SimpleNamespace(kubectl='kubectl'), Loader(),
                                      Cluster(), 'run-test', 1000, 60, size=20480,
                                      bound=helper.TASK_WRITER_BOUND)
    summary = {'result': result, 'calls': calls, 'output': '\n'.join(output),
               'deleted_jobs': sorted(deleted_jobs), 'clock': clock[0]}
except (ImportError, AttributeError) as error:
    summary = {'missing': type(error).__name__}
print('SUMMARY ' + json.dumps(summary))
