"""Exercise only logs_flood_accounting.py; no cluster commands or host scans."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch


def load(path):
    spec = importlib.util.spec_from_file_location('accounting_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Report:
    def __init__(self):
        self.notes, self.checks, self.invalid = [], [], []

    def note(self, text):
        self.notes.append(text)

    def check(self, ok, name, detail=''):
        self.checks.append({'ok': ok, 'name': name, 'detail': detail})
        return ok

    def not_valid(self, text):
        self.invalid.append(text)


def snapshot(free, images=0, container_logs=0, postgres=0, walk_files=0,
             walk_writer_logs=0, k3s_datastore=0, journal=0, kubelet=0, top_dirs=None):
    return {'root_free_bytes': free, 'root_error': None, 'allocated_bytes': {
        'images': images, 'container_logs': container_logs,
        'walk_writer_logs': walk_writer_logs, 'k3s_datastore': k3s_datastore,
        'journal': journal, 'kubelet': kubelet,
        'postgres': postgres, 'walk_files': walk_files}, 'unreadable': {},
        'top_dirs': top_dirs}


def allocation(path, exclude=None):
    paths = [path] + list(path.rglob('*'))
    seen = set()
    total = 0
    for item in paths:
        if exclude is not None and (item == exclude or exclude in item.parents):
            continue
        value = item.lstat()
        identity = value.st_dev, value.st_ino
        if identity not in seen:
            total += value.st_blocks * 512
            seen.add(identity)
    return total


def tree_case(module, mode):
    with tempfile.TemporaryDirectory() as directory:
        base = Path(directory)
        images, logs, shared = [base / name for name in ('images', 'pods', 'shared')]
        k3s = base / 'k3s-db'
        journal = base / 'journal'
        kubelet = base / 'kubelet'
        pg = shared / 'pg'
        for path in (images, logs, pg, k3s, journal, kubelet):
            path.mkdir(parents=True)
        (images / 'layer').write_bytes(b'image' * 1000)
        (k3s / 'etcd').write_bytes(b'store' * 2000)
        (journal / 'system.journal').write_bytes(b'journal' * 1500)
        (kubelet / 'pods').mkdir()
        (kubelet / 'pods' / 'volume').write_bytes(b'kubelet' * 1200)
        (logs / '0.log').write_bytes(b'current' * 1000)
        (logs / '0.log.20261110.gz').write_bytes(b'rotated' * 1000)
        writer = logs / 'lifemodel-logs-walk_walk-throttle-fast_uid' / 'writer'
        writer.mkdir(parents=True)
        (writer / '0.log').write_bytes(b'current' * 2000)
        (writer / '0.log.20261110-000000.gz').write_bytes(b'rotated' * 3000)
        (logs / 'lifemodel-system_other_uid' / 'c').mkdir(parents=True)
        (logs / 'lifemodel-system_other_uid' / 'c' / '0.log').write_bytes(b'other' * 1000)
        (pg / 'relation').write_bytes(b'database' * 1000)
        (shared / 'manifest').write_bytes(b'walk' * 1000)
        # Apparent length is not allocated length.
        with (images / 'sparse').open('wb') as stream:
            stream.truncate(128 * 1024 * 1024)
        os.link(images / 'layer', images / 'same-layer')
        (shared / 'pg-link').symlink_to(pg, target_is_directory=True)
        original_scandir = os.scandir
        original_stat = os.stat

        def host_stat(path, *args, **kwargs):
            # The isolated suite keeps /tmp on tmpfs. Model a node whose root
            # device holds these fixture trees, without changing tree metadata.
            if str(path) == '/':
                return SimpleNamespace(st_dev=original_stat(base).st_dev)
            return original_stat(path, *args, **kwargs)

        def scandir(path):
            if mode == 'unreadable' and Path(path) == logs:
                raise PermissionError('fixture')
            return original_scandir(path)

        if mode == 'missing':
            import shutil
            shutil.rmtree(logs)
        writer_tree = logs / 'lifemodel-logs-walk_walk-throttle-fast_uid'
        expected = None if mode != 'tree' else {
            'images': allocation(images),
            'container_logs': allocation(logs) - allocation(writer_tree),
            'walk_writer_logs': allocation(writer_tree),
            'k3s_datastore': allocation(k3s), 'journal': allocation(journal),
            'kubelet': allocation(kubelet),
            'postgres': allocation(pg), 'walk_files': allocation(shared, pg)}
        with patch.object(module, 'IMAGE_PATH', images), \
                patch.object(module, 'CONTAINER_LOG_PATH', logs), \
                patch.object(module, 'K3S_DATASTORE_PATH', k3s), \
                patch.object(module, 'JOURNAL_PATH', journal), \
                patch.object(module, 'KUBELET_PATH', kubelet), \
                patch.object(module, 'directory_usage', lambda *args, **kwargs: {}), \
                patch.object(module.os, 'scandir', scandir), \
                patch.object(module.os, 'stat', host_stat), \
                patch.object(module.os, 'statvfs', return_value=SimpleNamespace(
                    f_bavail=123, f_frsize=4096)):
            actual = module.accounting_snapshot(SimpleNamespace(shared_path=str(shared)),
                                                object(), ('walk-throttle-fast',))
        return {'actual': actual, 'expected': expected}


def growth_case(module, mode):
    if mode == 'du':
        class Result:
            returncode = 0
            stdout = '4096\t/\n8192\t/var\n16384\t/var/log\n'
        with patch.object(module.subprocess, 'run', lambda *args, **kwargs: Result()):
            usage = module.directory_usage()
        def timeout(*args, **kwargs):
            raise module.subprocess.TimeoutExpired('du', 20)
        with patch.object(module.subprocess, 'run', timeout):
            timed_out = module.directory_usage()
        return {'usage': usage, 'timed_out': timed_out}
    before = {'top_dirs': {'/s%d' % index: 100 for index in range(12)}}
    after = {'top_dirs': {'/s%d' % index: 100 + index * 10 for index in range(12)}}
    return {'growth': module.top_growth(before, after)}


def main():
    mode, path = sys.argv[1:]
    module = load(path)
    if mode in ('du', 'growth'):
        result = growth_case(module, mode)
    elif mode in ('tree', 'missing', 'unreadable'):
        result = tree_case(module, mode)
    else:
        before = snapshot(10000, images=1000, container_logs=1000, postgres=1000,
                          walk_files=1000)
        after = snapshot(7000, images=2000, container_logs=1500, postgres=2000,
                         walk_files=1200)
        allowance = 300
        if mode == 'unexplained':
            after['root_free_bytes'] = 6000
            before['top_dirs'] = {'/var/lib': 100, '/var/log': 50, '/tmp': 10}
            after['top_dirs'] = {'/var/lib': 900, '/var/log': 60, '/tmp': 10,
                                 '/new': 5}
        elif mode == 'deletions':
            after = snapshot(9000, images=100, container_logs=1000, postgres=1900, walk_files=1000)
        elif mode == 'unknown':
            after['allocated_bytes']['images'] = None
        elif mode == 'negative':
            after['allocated_bytes']['postgres'] = -1
        elif mode == 'explained':
            after['allocated_bytes']['walk_writer_logs'] = 500
        elif mode == 'freed':
            after = snapshot(11000, images=1000, container_logs=1000, postgres=1000, walk_files=1000)
        elif mode == 'errors':
            after['allocated_bytes']['images'] = None
            after['unreadable']['images'] = 'PermissionError: fixture'
        elif mode == 'root-unknown':
            after['root_free_bytes'] = None
        elif mode == 'partial':
            after['allocated_bytes']['container_logs'] = None
            after['unreadable']['container_logs'] = 'PermissionError: fixture'
            allowance = 800
        elif mode != 'explained':
            raise ValueError(mode)
        report = Report()
        verdict = module.report_accounting(report, before, after, allowance)
        result = {'verdict': verdict, 'notes': report.notes,
                  'checks': report.checks, 'invalid': report.invalid}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
