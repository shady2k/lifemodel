// Python is a pinned workbench prerequisite. A subreaper closes the orphan
// process window that process-group signalling alone cannot close: OpenCode's
// shell tools deliberately start separate process groups.
export const TASK_PROCESS_SUPERVISOR = String.raw`# Linux-only task supervisor. Reap all task-owned processes, including tools
# which call setsid(), before the wrapper exits. No owner UID-wide signalling.
import ctypes, os, signal, subprocess, sys
if sys.platform != "linux" or ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    sys.exit(125)
class Stop(Exception):
    pass
def stop(_signum, _frame):
    raise Stop()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
code = 125
try:
    child = subprocess.Popen(sys.argv[1:])
    code = child.wait()
except Stop:
    code = 143
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGALRM, lambda _s, _f: os._exit(124))
    signal.alarm(2)
    while True:
        # After a root dies, subreaper adoption makes its detached children
        # visible here. Kill roots then block on an actual child state change.
        try:
            children = open("/proc/self/task/%d/children" % os.getpid()).read().split()
        except OSError:
            os._exit(125)
        for pid in children:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            break
    signal.alarm(0)
sys.exit(code if code >= 0 else 128 - code)
`;
