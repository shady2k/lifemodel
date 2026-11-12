"""Allocated root-filesystem evidence for WALK-LOGS-VOLUME-FLOOD (ADR-016 §5–6).

Call the baseline only after every walk pod is Running and image pulls have
finished. These are host measurements, not container image manifest sizes:
containerd includes image content, unpacked snapshots and writable snapshots.
Pod-log rotation is included; the walk's own writer pods' logs (current,
rotated and compressed) are their own category, so a residual cannot hide
inside the container-log total. The shared walk tree excludes its Postgres
tree. The log store's separate mounted volume is deliberately not a category
here.

A tree that cannot be read is recorded with its reason and left out of the
accounting; only an unreadable free-space reading for `/` itself withholds the
verdict. A residual is unattributed root growth, never proof that all root loss
was log flood data. Besides the walk's own trees, the k3s datastore, the
systemd journal and kubelet's directories are measured: they move on a shared
VM. When the residual exceeds the allowance, the top growing directories under
`/` between the two readings are printed (`du -x`, bounded depth and time), so
the next failure names its cause. Filesystem bookkeeping and writes outside
those trees remain in the residual and are compared with the caller's stated
allowance.
"""
import os
from pathlib import Path
import stat
import subprocess

IMAGE_PATH = Path('/var/lib/rancher/k3s/agent/containerd')
CONTAINER_LOG_PATH = Path('/var/log/pods')
K3S_DATASTORE_PATH = Path('/var/lib/rancher/k3s/server/db')
JOURNAL_PATH = Path('/var/log/journal')
KUBELET_PATH = Path('/var/lib/kubelet')
CATEGORIES = ('images', 'container_logs', 'walk_writer_logs', 'k3s_datastore',
              'journal', 'kubelet', 'postgres', 'walk_files')
LABELS = {
    'images': 'images (containerd content, unpacked and writable snapshots)',
    'container_logs': 'container_logs (every pod except the walk\'s own writers)',
    'walk_writer_logs': 'walk_writer_logs (the walk\'s own writer pods: current, rotated and compressed)',
    'k3s_datastore': 'k3s_datastore (/var/lib/rancher/k3s/server/db)',
    'journal': 'journal (/var/log/journal)',
    'kubelet': 'kubelet (/var/lib/kubelet)',
    'postgres': 'postgres',
    'walk_files': 'walk_files',
}
# The residual's cause: one bounded `du` per reading, one filesystem (`-x`).
TOP_DIRECTORY_DEPTH = 2
TOP_DIRECTORY_GROWTH = 10
TOP_DIRECTORY_SECONDS = 20
# POSIX st_blocks always counts 512-byte units, regardless of filesystem block size.
ALLOCATED_BLOCK_BYTES = 512
REASON_LIMIT = 200


def allocated_tree(path, root_device, seen, excluded=None):
    """Count directory and file allocation once, without following symlinks.

    A vanished or unreadable entry leaves this tree unreadable as a whole. The
    caller records that reason and judges the root growth on the trees it could
    read. A different filesystem cannot explain root loss.
    """
    path = Path(path)
    top = path.lstat()
    if not stat.S_ISDIR(top.st_mode):
        raise OSError('accounting root is not a directory')

    def visit(entry):
        if excluded is not None and entry == excluded:
            return 0
        info = entry.lstat()
        if info.st_dev != root_device:
            raise OSError('accounting tree leaves the root filesystem')
        identity = (info.st_dev, info.st_ino)
        if identity in seen:
            return 0
        seen.add(identity)
        total = info.st_blocks * ALLOCATED_BLOCK_BYTES
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(entry) as children:
                for child in children:
                    total += visit(Path(child.path))
        return total

    return visit(path)


def reason_of(error):
    """One bounded reason for an unreadable tree or root reading."""
    text = '%s: %s' % (type(error).__name__, error)
    return text if len(text) <= REASON_LIMIT else text[:REASON_LIMIT - 3] + '...'


def pod_log_allocation(path, root_device, seen, writer_pods):
    """`/var/log/pods` split into other pods and the walk's own writers.

    Each pod directory is named `<namespace>_<pod>_<uid>`; a directory whose pod
    is the walk's own writer counts under `walk_writer_logs` (including its
    rotated and compressed files), every other pod under `container_logs`.
    """
    path = Path(path)
    top = path.lstat()
    if not stat.S_ISDIR(top.st_mode):
        raise OSError('accounting root is not a directory')
    identity = (top.st_dev, top.st_ino)
    total = top.st_blocks * ALLOCATED_BLOCK_BYTES
    if identity not in seen:
        seen.add(identity)
    other = total
    writer = 0
    writers = set(writer_pods or ())
    with os.scandir(path) as children:
        for child in children:
            entry = Path(child.path)
            info = entry.lstat()
            if info.st_dev != root_device:
                raise OSError('accounting tree leaves the root filesystem')
            identity = (info.st_dev, info.st_ino)
            if stat.S_ISDIR(info.st_mode):
                size = allocated_tree(entry, root_device, seen)
            elif identity in seen:
                size = 0
            else:
                seen.add(identity)
                size = info.st_blocks * ALLOCATED_BLOCK_BYTES
            pod = entry.name.split('_')[1] if entry.name.count('_') >= 2 else ''
            if pod in writers:
                writer += size
            else:
                other += size
    return other, writer


def accounting_snapshot(options, cluster, writer_pods=None):
    """Read the local host only; cluster is kept in the walk helper interface.

    The machine running the walk must be the node. No shell, image-list command
    or Kubernetes object is used as a substitute for allocated host bytes.
    Every tree is recorded as read (its allocated bytes) or unreadable with its
    reason; an unreadable tree does not invalidate the other trees or the root.
    """
    snapshot = {'root_free_bytes': None, 'root_error': None,
                'allocated_bytes': {}, 'unreadable': {}, 'top_dirs': None}
    root_device = None
    try:
        root_device = os.stat('/').st_dev
        usage = os.statvfs('/')
        snapshot['root_free_bytes'] = usage.f_bavail * usage.f_frsize
    except OSError as error:
        snapshot['root_error'] = reason_of(error)
        root_device = None
    shared = Path(os.path.abspath(options.shared_path))
    postgres = shared / 'pg'
    paths = {'images': Path(IMAGE_PATH), 'k3s_datastore': K3S_DATASTORE_PATH,
             'journal': JOURNAL_PATH, 'kubelet': KUBELET_PATH,
             'postgres': postgres, 'walk_files': shared}
    seen = set()
    for category in CATEGORIES:
        snapshot['allocated_bytes'][category] = None
    if root_device is not None:
        try:
            other, writer = pod_log_allocation(Path(CONTAINER_LOG_PATH), root_device,
                                               seen, writer_pods)
            snapshot['allocated_bytes']['container_logs'] = other
            snapshot['allocated_bytes']['walk_writer_logs'] = writer
        except OSError as error:
            snapshot['unreadable']['container_logs'] = reason_of(error)
            snapshot['unreadable']['walk_writer_logs'] = reason_of(error)
    for category, path in paths.items():
        if root_device is None:
            continue
        try:
            snapshot['allocated_bytes'][category] = allocated_tree(
                path, root_device, seen, postgres if category == 'walk_files' else None)
        except OSError as error:
            snapshot['unreadable'][category] = reason_of(error)
    snapshot['top_dirs'] = directory_usage()
    return snapshot


def directory_usage(depth=TOP_DIRECTORY_DEPTH, timeout=TOP_DIRECTORY_SECONDS):
    """Allocated bytes per directory under `/`, one filesystem and bounded time.

    `du -x` stays on the root filesystem; a missing `du`, a failed run or the
    time bound leaves the growth scan unavailable rather than blocking the
    verdict.
    """
    try:
        result = subprocess.run(['du', '-x', '-B1', '--max-depth=%d' % depth, '/'],
                                capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    usage = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            usage[parts[1].strip()] = int(parts[0])
        except ValueError:
            continue
    return usage


def top_growth(before, after, limit=TOP_DIRECTORY_GROWTH):
    """The largest positive directory growth between two readings, largest first."""
    start = (before or {}).get('top_dirs') or {}
    end = (after or {}).get('top_dirs') or {}
    growth = [(path, end[path] - start.get(path, 0)) for path in end
              if end[path] - start.get(path, 0) > 0]
    return sorted(growth, key=lambda item: (-item[1], item[0]))[:limit]


def byte_count(value):
    return type(value) is int and value >= 0


def root_readable(value):
    return isinstance(value, dict) and byte_count(value.get('root_free_bytes'))


def report_accounting(report, before, after, allowance):
    """Report every tree, and judge the unexplained positive residual.

    Only `/`'s own free-space reading withholds the verdict: a tree that could
    not be read is printed with its reason and left out of the accounted growth.
    Signed category deltas are summed before clamping: a category shrinking
    cannot be ignored while another category's growth excuses root loss.
    """
    reasons = []
    for label, snapshot in (('before', before), ('after', after)):
        if not root_readable(snapshot):
            reason = (snapshot.get('root_error')
                      if isinstance(snapshot, dict) else None)
            reasons.append('%s: %s' % (label, reason or 'free space unreadable'))
    if not byte_count(allowance):
        reasons.append('allowance is not a byte count')
    if reasons:
        report.not_valid('root filesystem accounting has no free-space reading (%s); '
                         'no root-growth verdict is available' % '; '.join(reasons))
        return None
    report.note('root free bytes %d -> %d (signed free-space change %+d)' % (
        before['root_free_bytes'], after['root_free_bytes'],
        after['root_free_bytes'] - before['root_free_bytes']))
    read = {}
    for name in CATEGORIES:
        start = (before.get('allocated_bytes') or {}).get(name)
        end = (after.get('allocated_bytes') or {}).get(name)
        if not byte_count(start) or not byte_count(end):
            reason = ((after.get('unreadable') or {}).get(name)
                      or (before.get('unreadable') or {}).get(name)
                      or 'no reading')
            report.note('%s: unreadable (%s); excluded from the root-growth accounting'
                        % (LABELS[name], reason))
            continue
        read[name] = (start, end)
        report.note('%s allocated bytes %d -> %d (net delta %+d)' % (
            LABELS[name], start, end, end - start))
    deltas = {name: end - start for name, (start, end) in read.items()}
    total_before = sum(start for start, _end in read.values())
    total_after = sum(end for _start, end in read.values())
    accounted = max(0, sum(deltas.values()))
    dropped = max(0, before['root_free_bytes'] - after['root_free_bytes'])
    residual = max(0, dropped - accounted)
    excluded = [name for name in CATEGORIES if name not in read]
    report.note('measured allocated total over the trees read %d -> %d bytes '
                '(signed net delta %+d)%s; positive accounted growth %d bytes; '
                'positive root free-space drop %d bytes; unattributed drop %d bytes; '
                'residual allowance %d bytes. The root drop is not all attributed to '
                'the walk.' % (
                    total_before, total_after, total_after - total_before,
                    ('; excluded: ' + ', '.join(excluded)) if excluded else '',
                    accounted, dropped, residual, allowance))
    ok = residual <= allowance
    report.check(ok, 'unattributed root filesystem growth stays within the stated allowance',
                 '%d unattributed bytes <= %d allowance bytes' % (residual, allowance))
    if not ok:
        growth = top_growth(before, after)
        if growth:
            report.note('top growing directories under / between the two readings '
                        '(du -x, depth %d): %s'
                        % (TOP_DIRECTORY_DEPTH,
                           ', '.join('%s +%d' % entry for entry in growth)))
        else:
            report.note('no directory growth above / was read for this residual: '
                        'du -x was unavailable, timed out or nothing grew')
    return {'ok': ok, 'root_drop_bytes': dropped, 'category_deltas': deltas,
            'accounted_growth_bytes': accounted, 'unattributed_drop_bytes': residual,
            'allowance_bytes': allowance}
