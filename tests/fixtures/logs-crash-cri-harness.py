"""Actual crictl ps JSON shape and node argv; no external commands."""
import importlib.util
import json
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('crash_walk', sys.argv[1])
walk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walk)
commands = []
walk.collector_pod_name = lambda *args: 'logs-collector-5h28h'
def node(args):
    commands.append(args)
    if 'ps' in args:
        # crictl --name filters container metadata.name, NOT pod name.
        name = args[args.index('--name') + 1]
        containers = [] if name != 'logs-collector' else [{
            'id': '6f14c887f015d', 'metadata': {'name': 'logs-collector', 'attempt': 0},
            'state': 'CONTAINER_RUNNING', 'labels': {
                'io.kubernetes.pod.name': 'logs-collector-5h28h',
                'io.kubernetes.pod.namespace': 'lifemodel-logs'}}]
        body = {'containers': containers}
    elif 'inspect' in args:
        body = {'info': {'pid': 4242}}
    elif 'stats' in args:
        # crictl stops parsing flags at the first positional container ID.
        # Flags after that ID are ignored, leaving its default table output.
        stats_args = args[args.index('stats') + 1:]
        if stats_args != ['--output', 'json', '6f14c887f015d']:
            return SimpleNamespace(returncode=0,
                                   stdout='CONTAINER MEMORY\n6f14c887f015d 200MiB\n',
                                   stderr='')
        body = {'stats': [{'memory': {
            'workingSetBytes': {'value': '104857600'},
            'usageBytes': {'value': '209715200'}}}]}
    else:
        raise AssertionError('unexpected node argv: ' + repr(args))
    return SimpleNamespace(returncode=0, stdout=json.dumps(body), stderr='')
walk.node_run = node
options = SimpleNamespace(crictl=sys.argv[2], collector_namespace='lifemodel-logs')
pid, pid_reason = walk.vector_pid(None, options)
memory, memory_reason = walk.collector_memory(None, options)
print(json.dumps({'pid': pid, 'memory': memory, 'commands': commands,
                  'pidReason': pid_reason, 'memoryReason': memory_reason}))
