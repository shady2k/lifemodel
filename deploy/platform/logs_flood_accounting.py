"""Allocated root-filesystem evidence for WALK-LOGS-VOLUME-FLOOD (ADR-016 §5–6).

Call the baseline only after every walk pod is Running and image pulls have
finished. These are host measurements, not container image manifest sizes:
containerd includes image content, unpacked snapshots and writable snapshots.
Pod-log rotation is included. The shared walk tree excludes its Postgres tree.
The log store's separate mounted volume is deliberately not a category here.

A residual is unattributed root growth, never proof that all root loss was log
flood data. Concurrent writes outside these trees and filesystem bookkeeping
remain in that residual and are compared with the caller's stated allowance.
"""
import os
from pathlib import Path
import stat

IMAGE_PATH = Path('/var/lib/rancher/k3s/agent/containerd')
CONTAINER_LOG_PATH = Path('/var/log/pods')
CATEGORIES = ('images', 'container_logs', 'postgres', 'walk_files')
# POSIX st_blocks always counts 512-byte units, regardless of filesystem block size.
ALLOCATED_BLOCK_BYTES = 512


def allocated_tree(path, root_device, seen, excluded=None):
    """Count directory and file allocation once, without following symlinks.

    A vanished or unreadable entry invalidates the tree instead of silently
    returning a partial total. A different filesystem cannot explain root loss.
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


def accounting_snapshot(options, cluster):
    """Read the local host only; cluster is kept in the walk helper interface.

    The machine running the walk must be the node. No shell, image-list command
    or Kubernetes object is used as a substitute for allocated host bytes.
    """
    snapshot = {'root_free_bytes': None, 'allocated_bytes': {}, 'errors': []}
    try:
        root_device = os.stat('/').st_dev
        usage = os.statvfs('/')
        snapshot['root_free_bytes'] = usage.f_bavail * usage.f_frsize
    except OSError as error:
        snapshot['errors'].append('root filesystem: ' + type(error).__name__)
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
            snapshot['errors'].append(category + ': ' + type(error).__name__)
    return snapshot


def byte_count(value):
    return type(value) is int and value >= 0


def valid_snapshot(value):
    if not isinstance(value, dict) or value.get('errors') != []:
        return False
    categories = value.get('allocated_bytes')
    return (byte_count(value.get('root_free_bytes')) and isinstance(categories, dict)
            and all(byte_count(categories.get(name)) for name in CATEGORIES))


def report_accounting(report, before, after, allowance):
    """Report exact evidence and judge only the unexplained positive residual.

    Signed category deltas are summed before clamping: a category shrinking
    cannot be ignored while another category's growth excuses root loss.
    Missing evidence is TEST NOT VALID, never zero bytes or an allowance pass.
    """
    if not valid_snapshot(before) or not valid_snapshot(after) or not byte_count(allowance):
        report.not_valid('root filesystem accounting is missing or unreadable; '
                         'no root-growth verdict is available')
        return None
    report.note('root free bytes %d -> %d (signed free-space change %+d)' % (
        before['root_free_bytes'], after['root_free_bytes'],
        after['root_free_bytes'] - before['root_free_bytes']))
    deltas = {}
    for name in CATEGORIES:
        start, end = before['allocated_bytes'][name], after['allocated_bytes'][name]
        deltas[name] = end - start
        label = ('images (containerd content, unpacked and writable snapshots)'
                 if name == 'images' else name)
        report.note('%s allocated bytes %d -> %d (net delta %+d)' % (
            label, start, end, deltas[name]))
    total_before = sum(before['allocated_bytes'][name] for name in CATEGORIES)
    total_after = sum(after['allocated_bytes'][name] for name in CATEGORIES)
    accounted = max(0, sum(deltas.values()))
    dropped = max(0, before['root_free_bytes'] - after['root_free_bytes'])
    residual = max(0, dropped - accounted)
    report.note('measured allocated total %d -> %d bytes (signed net delta %+d); '
                'positive accounted growth %d bytes; positive root free-space drop %d bytes; '
                'unattributed drop %d bytes; residual allowance %d bytes. '
                'The root drop is not all attributed to the flood.' % (
                    total_before, total_after, total_after - total_before,
                    accounted, dropped, residual, allowance))
    ok = residual <= allowance
    report.check(ok, 'unattributed root filesystem growth stays within the stated allowance',
                 '%d unattributed bytes <= %d allowance bytes' % (residual, allowance))
    return {'ok': ok, 'root_drop_bytes': dropped, 'category_deltas': deltas,
            'accounted_growth_bytes': accounted, 'unattributed_drop_bytes': residual,
            'allowance_bytes': allowance}
