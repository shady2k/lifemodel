"""Offline source selection, process cleanup and CLI driver for the egress walk."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(sys.argv[1]).resolve().parent))
spec = importlib.util.spec_from_file_location('egress_walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
fixture = json.loads(Path(sys.argv[2]).read_text())
calls = []
output = io.StringIO()
if fixture.get('cli'):
    sys.argv = [sys.argv[1]] + fixture['cli']
    walk.run = lambda report, cluster, options: calls.append(['options', vars(options)])
    with contextlib.redirect_stdout(output):
        status = walk.main()
else:
    import logs_egress_sources as sources
    report = walk.Report()
    clock = [0.0]
    sources.time.monotonic = lambda: clock[0]
    sources.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
    sources.shutil.which = lambda name: '/bin/' + name if name in fixture.get('path', []) else None
    original_read = sources.Path.read_text
    def read(path, *args, **kwargs):
        if str(path) == '/proc/net/nf_conntrack':
            calls.append(['proc', clock[0]])
            if fixture.get('proc') is None or (fixture.get('proc_lost') and clock[0] > 1):
                raise OSError('PRIVATE STDERR CONFIG')
            return fixture['proc']
        return original_read(path, *args, **kwargs)
    sources.Path.read_text = read
    def tool(argv):
        return 'tcpdump' if any('tcpdump' in part for part in argv) else 'conntrack'
    list_reads = [0]
    def run(argv, **kwargs):
        list_reads[0] += 1
        calls.append(['run', argv, kwargs.get('env', {}).get('NIX_CONFIG'), kwargs.get('timeout')])
        if fixture.get('run_timeout'):
            raise sources.subprocess.TimeoutExpired(argv, 1)
        return SimpleNamespace(returncode=int(fixture.get('command_failed', False)),
                               stdout={1: 'PREFLIGHT', 2: 'BASELINE'}.get(list_reads[0], 'FINAL'))
    class Process:
        def __init__(self, argv, **kwargs):
            self.kind = tool(argv)
            self.returncode = None
            calls.append(['start', argv, kwargs.get('env', {}).get('NIX_CONFIG')])
            if fixture.get(self.kind + '_missing'):
                raise OSError('PRIVATE STDERR CONFIG')
            kwargs['stdout'].write('EVENT' if self.kind == 'conntrack' else 'PACKET')
            self.errors = kwargs['stderr']
            if self.kind == 'conntrack' and fixture.get('event_errors'):
                self.errors.write(fixture['event_errors'])
            if self.kind == 'tcpdump' and not fixture.get('capture_no_ready'):
                self.errors.write('tcpdump: listening on any\n')
                self.errors.flush()
        def poll(self):
            if fixture.get(self.kind + '_startup_failed') or (
                    fixture.get(self.kind + '_lost') and clock[0] >= 2):
                self.returncode = 1
            return self.returncode
        def terminate(self):
            calls.append(['stop', self.kind])
            self.returncode = 0
        def send_signal(self, signal):
            self.terminate()
            if self.kind == 'tcpdump':
                self.errors.write(str(fixture.get('dropped_packets', 0)) + ' packets dropped by kernel\n')
        def wait(self, timeout=None):
            calls.append(['wait', self.kind, timeout])
            return self.returncode
        def kill(self):
            self.terminate()
    sources.subprocess.run = run
    sources.subprocess.Popen = Process
    options = SimpleNamespace(observation_seconds=3, conntrack_command=fixture.get('conntrack_command'),
                              tcpdump_command=fixture.get('tcpdump_command'),
                              nix_config=fixture.get('nix_config'))
    with contextlib.redirect_stdout(output):
        try:
            evidence, packets = sources.collect(report, options, 'host 10.42.0.10')
            calls.append(['evidence', evidence, packets])
            if fixture.get('check_observation'):
                walk.check_observation(report, evidence, {'10.42.0.10'}, {'10.42.0.20'},
                                       {('tcp', '10.42.0.20', 9428)})
        except walk.WalkError as error:
            report.not_valid(str(error))
        status = report.result()
print(output.getvalue(), end='')
print('SUMMARY ' + json.dumps({'calls': calls, 'status': status, 'output': output.getvalue()}))
sys.exit(status)
