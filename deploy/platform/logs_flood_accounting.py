"""Allocated root-filesystem evidence for WALK-LOGS-VOLUME-FLOOD (ADR-016 §5–6).

Call the baseline only after every walk pod is Running and image pulls have
finished. These are host measurements, not container image manifest sizes:
containerd includes image content, unpacked snapshots and writable snapshots.
Pod-log rotation is included. The shared walk tree excludes its Postgres tree.
The log store's separate mounted volume is deliberately not a category here.

A tree that cannot be read is recorded with its reason and left out of the
accounting; only an unreadable free-space reading for `/` itself withholds the
verdict. A residual is unattributed root growth, never proof that all root loss
was log flood data. Concurrent writes outside these trees and filesystem
bookkeeping remain in that residual and are compared with the caller's stated
allowance.
"""
import os
from pathlib import Path
import stat

IMAGE_PATH = Path('/var/lib/rancher/k3s/agent/containerd')
CONTAINER_LOG_PATH = Path('/var/log/pods')
CATEGORIES = ('images', 'container_logs', 'postgres', 'walk_files')
LABELS = {
    'images': 'images (containerd content, unpacked and writable snapshots)',
    'container_logs': 'container_logs',
    'postgres': 'postgres',
    'walk_files': 'walk_files',
}
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


def accounting_snapshot(options, cluster):
    """Read the local host only; cluster is kept in the walk helper interface.

    The machine running the walk must be the node. No shell, image-list command
    or Kubernetes object is used as a substitute for allocated host bytes.
    Every tree is recorded as read (its allocated bytes) or unreadable with its
    reason; an unreadable tree does not invalidate the other trees or the root.
    """
    snapshot = {'root_free_bytes': None, 'root_error': None,
                'allocated_bytes': {}, 'unreadable': {}}
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
    paths = {'images': Path(IMAGE_PATH), 'container_logs': Path(CONTAINER_LOG_PATH),
             'postgres': postgres, 'walk_files': shared}
    seen = set()
    for category, path in paths.items():
        snapshot['allocated_bytes'][category] = None
        if root_device is None:
            continue
        try:
            snapshot['allocated_bytes'][category] = allocated_tree(
                path, root_device, seen, postgres if category == 'walk_files' else None)
        except OSError as error:
            snapshot['unreadable'][category] = reason_of(error)
    return snapshot


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
                'the flood.' % (
                    total_before, total_after, total_after - total_before,
                    ('; excluded: ' + ', '.join(excluded)) if excluded else '',
                    accounted, dropped, residual, allowance))
    ok = residual <= allowance
    report.check(ok, 'unattributed root filesystem growth stays within the stated allowance',
                 '%d unattributed bytes <= %d allowance bytes' % (residual, allowance))
    return {'ok': ok, 'root_drop_bytes': dropped, 'category_deltas': deltas,
            'accounted_growth_bytes': accounted, 'unattributed_drop_bytes': residual,
            'allowance_bytes': allowance}
