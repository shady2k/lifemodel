"""Drives logs-all-walk.py's inventory against a fake node.

The walk itself is an operator script for a deployed cluster. This harness hands
its `inventory` a fake kubectl, a fake logs API and a fake /var/log/pods tree, so
the unit test can hold the NOTE/FAIL split for a pod the logs API does not name.
"""
import importlib.util
import json
import sys
import time
import types

spec = importlib.util.spec_from_file_location('logs_all_walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)

with open(sys.argv[2], encoding='utf8') as handle:
    fixture = json.load(handle)


class FakeLoader:
    def records(self, start, end, module=None):
        return fixture['records'].get(module, [])


options = types.SimpleNamespace(
    kubectl=fixture['kubectl'],
    lookback_hours=fixture['lookbackHours'],
    max_pages=40,
    wait_seconds=0,
    log_root=fixture['logRoot'],
)

report = walk.Report()
walk.inventory(report, FakeLoader(), options, time.monotonic() + 60)
print('WALK FAILURES %d' % report.failures)
sys.exit(1 if report.failures else 0)
