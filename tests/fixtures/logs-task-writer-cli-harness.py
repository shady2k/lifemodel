"""Run the browser task CLI with a fake login and genuine-task helper seam."""
import json
import runpy
import sys
import types

mode, path = sys.argv[1:3]
support = types.ModuleType('logs_walk_support')
class Report:
    failures = 0
    def check(self, ok, *args):
        self.failures += not ok
        return ok
    def fail(self, *args):
        self.failures += 1
    def result(self):
        return int(bool(self.failures))
class Loader:
    def __init__(self, *args):
        pass
    def login(self, password):
        assert password == 'NEVER_PRINT_CREDENTIAL'
        return 200
support.Report = Report
support.Loader = Loader
support.Cluster = lambda *args: None
support.WalkError = type('WalkError', (Exception,), {})
support.read_password = lambda path: 'NEVER_PRINT_CREDENTIAL'
def common_arguments(parser):
    parser.add_argument('--password-file', required=True)
    parser.add_argument('--loader-host', default='localhost')
    parser.add_argument('--loader-port', type=int, default=443)
    parser.add_argument('--origin-host', default='localhost')
    parser.add_argument('--ca-file')
    parser.add_argument('--kubectl', default='kubectl')
support.common_arguments = common_arguments
helper = types.ModuleType('logs_task_writer')
def start_task_writer(report, *args, **kwargs):
    if mode == 'denied':
        report.fail('not launched')
        return None
    return ('task-owned-123', 'task', 'browser-proof-a1', 0)
helper.start_task_writer = start_task_writer
support.start_task_writer = start_task_writer
sys.modules['logs_walk_support'] = support
sys.modules['logs_task_writer'] = helper
sys.argv = [path, '--password-file', '/not-read', '--run-id',
            'unsafe run' if mode == 'unsafe' else 'browser-proof', '--rate', '5',
            '--seconds', '30', '--bound', '180']
runpy.run_path(path, run_name='__main__')
