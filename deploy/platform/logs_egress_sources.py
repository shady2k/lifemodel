"""Metadata-only egress observation sources, with bounded tool startup."""
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path

from logs_walk_support import WalkError

STARTUP_SECONDS = 180  # Nix may fetch/build before the normal-work window starts.
POLL_SECONDS = 1


def command(options, tool, package):
    override = getattr(options, tool + '_command', None)
    if override is not None:
        try:
            argv = shlex.split(override)
        except ValueError:
            raise WalkError(tool + '_command_invalid') from None
        if not argv:
            raise WalkError(tool + '_command_empty')
        return argv
    if shutil.which(tool):
        return [tool]
    if shutil.which('nix'):
        return ['nix', '--extra-experimental-features', 'nix-command flakes',
                'run', 'nixpkgs#' + package, '--']
    return None


def source_label(options, tool, argv):
    if getattr(options, tool + '_command', None) is not None:
        return 'explicit command'
    return 'Nix' if argv and argv[0] == 'nix' else 'PATH'


def stop(process, capture=False):
    if process is None:
        return
    if process.poll() is not None:
        process.wait(timeout=10)
        return
    try:
        if capture:
            process.send_signal(2)
        else:
            process.terminate()
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def snapshot():
    try:
        return Path('/proc/net/nf_conntrack').read_text()
    except OSError:
        raise WalkError('connection_source_unavailable') from None


def collect(report, options, hosts):
    """Start sources first; only then count the operator's observation window."""
    environment = os.environ.copy()
    if getattr(options, 'nix_config', None) is not None:
        environment['NIX_CONFIG'] = options.nix_config
    ct = command(options, 'conntrack', 'conntrack-tools')
    dump = command(options, 'tcpdump', 'tcpdump')
    with ExitStack() as stack:
        output, errors, packets, capture_errors = [
            stack.enter_context(tempfile.TemporaryFile(mode='w+')) for _ in range(4)]
        process = capture = None
        try:
            baseline = None
            if ct:
                try:
                    initial = subprocess.run(ct + ['-L', '-o', 'extended'],
                                             capture_output=True, text=True,
                                             timeout=STARTUP_SECONDS, env=environment)
                    if initial.returncode == 0:
                        process = subprocess.Popen(ct + ['-E', '-o', 'extended'],
                                                   stdout=output, stderr=errors,
                                                   text=True, env=environment)
                        time.sleep(POLL_SECONDS)
                        if process.poll() is None:
                            baseline = initial.stdout
                except (OSError, subprocess.SubprocessError):
                    pass
            if baseline is None:
                stop(process)
                process = None
                baseline = snapshot()
                report.note('Connection source: /proc/net/nf_conntrack periodic snapshots '
                            '(1 second), not continuous event or packet capture; sampling '
                            'may miss short-lived flows.')
            else:
                report.note('Connection source: conntrack (%s), baseline, events and final snapshot.'
                            % source_label(options, 'conntrack', ct))
            if dump:
                try:
                    capture = subprocess.Popen(
                        dump + ['-i', 'any', '-nn', '-q', '-l', '-s', '96',
                                '-c', '1000000', hosts],
                        stdout=packets, stderr=capture_errors, text=True, env=environment)
                    deadline = time.monotonic() + STARTUP_SECONDS
                    ready = False
                    while time.monotonic() < deadline:
                        if capture.poll() is not None:
                            break
                        capture_errors.seek(0)
                        if re.search(r'\blistening on\b', capture_errors.read()):
                            ready = True
                            break
                        time.sleep(POLL_SECONDS)
                    if not ready:
                        stop(capture, True)
                        capture = None
                except (OSError, subprocess.SubprocessError):
                    stop(capture, True)
                    capture = None
            if capture is None:
                report.note('No packet capture: tcpdump unavailable at startup; '
                            'connection evidence only, no packet-direction corroboration.')
            else:
                report.note('Packet source: tcpdump (%s), numeric headers only.'
                            % source_label(options, 'tcpdump', dump))
            if process is not None:
                current = subprocess.run(ct + ['-L', '-o', 'extended'], capture_output=True,
                                         text=True, timeout=30, env=environment)
                if current.returncode:
                    raise WalkError('conntrack_baseline_unavailable')
                baseline = current.stdout
            else:
                baseline = snapshot()
            evidence = [baseline]
            deadline = time.monotonic() + options.observation_seconds
            while time.monotonic() < deadline:
                if ((process is not None and process.poll() is not None) or
                        (capture is not None and capture.poll() is not None)):
                    raise WalkError('connection_capture_stopped')
                time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))
                if process is None:
                    evidence.append(snapshot())
            if ((process is not None and process.poll() is not None) or
                    (capture is not None and capture.poll() is not None)):
                raise WalkError('connection_capture_stopped')
            if process is not None:
                final = subprocess.run(ct + ['-L', '-o', 'extended'], capture_output=True,
                                       text=True, timeout=30, env=environment)
                if final.returncode:
                    raise WalkError('conntrack_final_unavailable')
                stop(process)
                errors.seek(0)
                if any(line.strip() and not re.fullmatch(
                        r'conntrack v[^:]+: \d+ flow events have been shown\.', line.strip())
                        for line in errors.read().splitlines()):
                    raise WalkError('conntrack_evidence_lost')
                output.seek(0)
                evidence.extend([output.read(), final.stdout])
            packet_text = None
            if capture is not None:
                stop(capture, True)
                capture_errors.seek(0)
                if capture.returncode not in (0, -2) or not re.search(
                        r'\b0 packets dropped by kernel', capture_errors.read()):
                    raise WalkError('packet_capture_incomplete')
                packets.seek(0)
                packet_text = packets.read()
            return '\n'.join(evidence), packet_text
        finally:
            stop(capture, True)
            stop(process)
