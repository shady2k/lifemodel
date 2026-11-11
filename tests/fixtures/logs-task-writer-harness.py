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
pods = {}
removed = set()
current = {'attempt': 1}


def task_pod(name, uid):
    return {'metadata': {'name': name, 'uid': uid,
                         'namespace': 'lifemodel-motor',
                         'labels': {'app.kubernetes.io/name': 'task',
                                    'lifemodel.dev/launch-id': 'launch'},
                         'ownerReferences': [{'kind': 'Job', 'name': 'task-job',
                                              'uid': 'job', 'controller': True}]},
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

    def pods(self, namespace, selector=None):
        calls.append(['pods', namespace, selector])
        self.n += 1
        if self.n == 1 or scenario.get('no_pod'):
            return [old]
        name = 'task-pod-%d' % current['attempt']
        if name in removed:
            return [old]
        return [old, task_pod(name, 'uid-' + name)]

    def run(self, args, **kwargs):
        calls.append(['run'] + list(args))
        if (len(args) >= 5 and args[0] == '-n' and args[2] == 'delete'
                and args[3] == 'pod'):
            removed.add(args[4])
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        raise AssertionError('no task command or direct create allowed')

    def apply(self, *args, **kwargs):
        raise AssertionError('no direct task creation')


class Loader:
    def logs_page(self, params):
        calls.append(['logs', params])
        attempt = current['attempt']
        name = 'task-pod-%d' % attempt
        fields = {'pod': name, 'namespace': 'lifemodel-motor',
                  'module': 'task', 'untrusted': 'true', 'container': 'task'}
        changes = scenario.get('record', {}).copy()
        message = changes.pop('message', params.get('text')
                              or 'walk-task-writer run-test-a1 seq=1 ')
        fields.update(changes)
        record = {'time': '2026-11-10T00:00:00Z', 'message': message, 'fields': fields}
        if scenario.get('refuse'):
            return scenario['refuse'], None
        empty = scenario.get('no_marker') or (scenario.get('late_marker') and attempt == 1)
        return 200, {'state': 'ok', 'records': [] if empty else [record]}

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
        if self.method == 'POST': return b'{"streamId":"1"}'
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
        calls.append(['http', method, path, payload, headers])
    def getresponse(self): return Response(self.method)
    def close(self): pass
clock = [0]
def monotonic(): clock[0] += 0.1; return clock[0]
try:
    helper = importlib.import_module('logs_task_writer')
    helper.PortForward = Forward
    helper.http.client.HTTPConnection = Connection
    helper.time.monotonic = monotonic
    helper.time.sleep = lambda seconds: None
    result = public.start_task_writer(Report(), SimpleNamespace(kubectl='kubectl'), Loader(),
                                     Cluster(), 'run-test', 1000, 60, size=20480, bound=2)
    summary = {'result': result, 'calls': calls, 'output': '\n'.join(output)}
except (ImportError, AttributeError) as error:
    summary = {'missing': type(error).__name__}
print('SUMMARY ' + json.dumps(summary))
