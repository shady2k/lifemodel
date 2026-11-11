#!/usr/bin/env python3
"""WALK-LOGS-CRASH (ADR-016 L07, §6): measured collector crash losses.

What it proves
--------------
Store-down saturation uses the collector exporter on 127.0.0.1:9598 via a
port-forward. Disk buffers expose vector_buffer_size_bytes and
vector_buffer_max_size_bytes, vector_buffer_size_events, and received/sent
buffer event totals with component_id="logs-store", buffer_type="disk".
Vector 0.61 reserves 128 MiB of the configured 320 MiB for an outstanding
segment: require at least 95% of the 192 MiB writable bound (182.4 MiB).
Memory buffers retain vector_buffer_max_size_events and event-count saturation.
No maximum, counters or measured saturation means TEST NOT VALID.

Kill the actual Vector host pid with kill -9, never pid 1. Record cgroup memory
during fill, immediately before the kill, and after restart. Separately restart
the collector while the store stays down; observe its restart before bringing
the store back. Count every numbered line still in current/rotated files under
/var/log/pods for all writer pods and this run. Every retained line must arrive
at least once; duplicates are allowed. Any observed gap is FAIL, not excused by
the source's lack of acknowledgements. Passing a run does not prove a source
replay guarantee. The unsaturated crash remains informative, not a substitute.

What it changes and restores
----------------------------
The walk uses k3s kubectl for cluster changes, and node crictl for the host pid
and memory. It connects to boot-lifemodel.local by default; --password-file
names the credential file, whose contents are never printed.
Flux owns the store Deployment and re-applies it every ten minutes, which puts
`replicas: 1` back and ends the outage the walk needs. Suspending only the
Deployment's direct owner is not enough: the root reapplies that owner's object
and clears its `spec.suspend`. The walk therefore reads the whole ownership
chain upward from the Deployment's `kustomize.toolkit.fluxcd.io/name` and
`.../namespace` labels (the --kustomization/--flux-namespace defaults only when
the Deployment labels are absent; each Kustomization carries its own parent's
labels), refusing a loop or a chain deeper than CHAIN_DEPTH_LIMIT. Before
scaling the store to zero it suspends every level from the top down and verifies
each. While the store must stay down every reading checks that the Deployment
still has 0 replicas and no store pod exists, and that every suspended
Kustomization still reads `spec.suspend: true`: one that came back is TEST NOT
VALID naming it (for the Deployment, its managedFields read with
`--show-managed-fields`, and its events), never a pass. RESTORE resumes each
Kustomization the walk suspended, child first and then its parent so the
parent's reapply finds the child unsuspended, each verified, each reconcile
requested with `reconcile.fluxcd.io/requestedAt`, each waited for Ready=True on
the applied revision; a resume that fails is a RESTORE FAIL naming it, because a
Kustomization left suspended stops all later deploys.
The workload is paced and bounded by node load, fill/recovery deadlines and the
whole-walk deadline. The saturation clock is derived from the achieved source
rate and the writer line size when the fixed --fill-bound cannot reach the
writable byte bound (with --fill-ceiling as the stated ceiling), and a NOTE says
which bound is used. A watchdog interrupts blocked work at excess load. Finally,
retry deletion of writers, restore the original store replicas/readiness and the
Kustomization, delete the owned namespace and wait for the collector, even on
exceptions/timeouts.

What it does not cover
----------------------
Pre-buffer or unsynchronized data is not inherently durable; this strict walk
reports actual missing retained lines, not guaranteed checkpoint replay. It does
not change kubelet rotation or recover files removed with a deleted writer pod.
Use --help for arguments. Run on the node with crictl and kubelet-file access.
"""
import argparse
import http.client
import json
import math
import os
import re
import sys
import time
import signal
import threading
import shlex
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import (  # noqa: E402
    MIB,
    Cluster,
    Loader,
    PortForward,
    Report,
    WalkError,
    common_arguments,
    now_ms,
    read_password,
    wait_until,
)

WRITER_MODULE = 'walk-crash-writer'
WRITER_LINE = re.compile(r'walk-crash (\S+) seq=(\d+)')
WRITER_LINE_PREFIX = 'walk-crash '
BUFFER_SIZE = 'vector_buffer_size_events'
BUFFER_MAX = 'vector_buffer_max_size_events'
RECEIVED = 'vector_component_received_events_total'
SENT = 'vector_component_sent_events_total'
BUFFER_RECEIVED = 'vector_buffer_received_events_total'
BUFFER_SENT = 'vector_buffer_sent_events_total'
BUFFER_BYTES = 'vector_buffer_size_bytes'
BUFFER_MAX_BYTES = 'vector_buffer_max_size_bytes'
DISK_SEGMENT_RESERVATION = 128 * MIB
DISK_FILL_FRACTION = 0.95
FLUX_NAME_LABEL = 'kustomize.toolkit.fluxcd.io/name'
FLUX_NAMESPACE_LABEL = 'kustomize.toolkit.fluxcd.io/namespace'
DEFAULT_KUSTOMIZATION = 'platform-logs-store'
DEFAULT_FLUX_NAMESPACE = 'flux-system'
REQUESTED_AT = 'reconcile.fluxcd.io/requestedAt'
SATURATION_CEILING = 2400
CHAIN_DEPTH_LIMIT = 6
SATURATION_HEADROOM = 1.1
SATURATION_MARGIN_SECONDS = 60
WRITER_SCRIPT = (
    "const run=process.argv[1],seconds=Number(process.argv[2]),base=Number(process.argv[3]);"
    "const rate=Number(process.argv[4]),batch=Math.min(20,Math.max(1,Math.floor(rate/50)));"
    "let seq=base;const end=Date.now()+seconds*1000;"
    "function write(){if(Date.now()>=end)return;for(let n=0;n<batch;n++){seq+=1;"
    "process.stdout.write('walk-crash '+run+' seq='+seq+' t='+Date.now()+'\\n');}"
    "setTimeout(write,batch*1000/rate);}write();"
)

def writer_name(index):
    return 'walk-crash-writer' if index == 1 else 'walk-crash-writer-%d' % index


def writer_names(options):
    return [writer_name(index) for index in range(1, (options.writer_pods or 1) + 1)]


def writer_manifest(image, options, run_id, seconds, index=1, interval=20):
    return {
        'apiVersion': 'v1',
        'kind': 'Pod',
        'metadata': {'name': writer_name(index), 'namespace': options.writer_namespace,
                     'labels': {'app.kubernetes.io/name': WRITER_MODULE}},
        'spec': {
            'restartPolicy': 'Never',
            'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                                'seccompProfile': {'type': 'RuntimeDefault'}},
            'containers': [{
                'name': 'writer',
                'image': image,
                'command': ['node', '-e', WRITER_SCRIPT, run_id, str(seconds),
                            str((index - 1) * 50_000_000),
                            str(options.writer_rate / options.writer_pods)],
                'securityContext': {'readOnlyRootFilesystem': True,
                                    'allowPrivilegeEscalation': False,
                                    'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '20m', 'memory': '32Mi'}},
            }],
        },
    }


def writer_image(cluster, options):
    """The deployed Node-based image used by the working eviction writer."""
    body = cluster.json(['-n', options.namespace, 'get', 'cronjob', 'logs-evictor',
                         '-o', 'json']) or {}
    containers = (((body.get('spec') or {}).get('jobTemplate') or {}).get('spec') or {}) \
        .get('template', {}).get('spec', {}).get('containers') or []
    return containers[0].get('image') if containers else None


def collector_pod(cluster, options):
    pods = cluster.pods(options.collector_namespace,
                        'app.kubernetes.io/name=' + options.collector)
    return pods[0] if pods else None


def collector_pod_name(cluster, options):
    pod = collector_pod(cluster, options) or {}
    return (pod.get('metadata') or {}).get('name')


def parse_metrics(text, names):
    """The named gauges/counters from a Prometheus body, labels kept out of the key."""
    values = {}
    for raw in (text or '').splitlines():
        line = raw.strip()
        if line == '' or line.startswith('#'):
            continue
        sample = line.split(' ')
        if len(sample) < 2:
            continue
        name = sample[0].split('{')[0]
        if name not in names:
            continue
        try:
            value = float(sample[1])
        except ValueError:
            continue
        if not math.isfinite(value) or value < 0:
            continue
        labels = sample[0][len(name):]
        key = (name, labels)
        values[key] = values.get(key, 0.0) + value
    return values


def component_value(values, name, component):
    """One component's series, picked by its `component_id` label.

    The exporter carries every component's series - the `metrics` and
    `heartbeat-canary` sinks each have their own 500-event buffer - so the
    sink's gauge is the one whose `component_id` names it, never the first
    sample with that name.
    """
    for (sample, labels), value in values.items():
        if sample != name:
            continue
        parsed = dict((key, double or single)
                      for key, double, single in re.findall(
                          r"([a-zA-Z_][a-zA-Z_0-9]*)=(?:\"([^\"]*)\"|'([^']*)')", labels))
        if parsed.get('component_id') != component:
            continue
        if name in (BUFFER_BYTES, BUFFER_MAX_BYTES, BUFFER_RECEIVED, BUFFER_SENT) \
                and parsed.get('buffer_type') != 'disk':
            continue
        return int(value)
    return None


def read_metrics(options, cluster):
    """The collector's exporter, read through a port-forward: (values, reason)."""
    pod = collector_pod_name(cluster, options)
    if not pod:
        return None, 'the collector has no pod'
    forward = PortForward(options.kubectl, options.collector_namespace, 'pod/' + pod,
                          free_port(), options.metrics_port)
    forward.start()
    try:
        if not forward.wait_ready(20):
            return None, ('nothing answered port %d on %s (%s)'
                          % (options.metrics_port, pod, forward.death or 'never ready'))
        connection = http.client.HTTPConnection('127.0.0.1', forward.local_port, timeout=15)
        try:
            connection.request('GET', '/metrics')
            response = connection.getresponse()
            body = response.read(4 * 1024 * 1024).decode('utf8', 'replace')
            if response.status != 200:
                return None, 'GET /metrics answered %d' % response.status
        finally:
            connection.close()
    finally:
        forward.close()
    values = parse_metrics(body, {BUFFER_SIZE, BUFFER_MAX, BUFFER_BYTES, BUFFER_MAX_BYTES, RECEIVED, SENT, BUFFER_RECEIVED, BUFFER_SENT})
    if (component_value(values, BUFFER_SIZE, 'logs-store') is None
            and component_value(values, BUFFER_BYTES, 'logs-store') is None):
        return None, 'the exporter carries no buffer gauge for component_id="logs-store"'
    return values, 'HTTP 200'


def source_rate_sample(values, reason, options, before_writers=False):
    """Sum only this walk's pod-labelled Kubernetes source series."""
    counts = {pod: None for pod in writer_names(options)}
    if values is not None:
        for (name, labels), value in values.items():
            if name != RECEIVED:
                continue
            parsed = dict((key, double or single) for key, double, single in re.findall(
                r"([a-zA-Z_][a-zA-Z_0-9]*)=(?:\"([^\"]*)\"|'([^']*)')", labels))
            pod = parsed.get('pod_name')
            if (parsed.get('component_id') == 'kubernetes'
                    and parsed.get('pod_namespace') == options.writer_namespace and pod in counts):
                counts[pod] = (counts[pod] or 0) + int(value)
        if before_writers:
            counts = {pod: count if count is not None else 0 for pod, count in counts.items()}
    return {'metric': RECEIVED, 'component': 'kubernetes',
            'namespace': options.writer_namespace, 'per_writer': counts,
            'received': sum(counts.values()) if all(count is not None for count in counts.values())
                        else None,
            'status': (reason or 'HTTP 200') if values is not None
                      else (reason or 'scrape unavailable')}


def source_counter_reset(before, current):
    return any(count is not None and current['per_writer'].get(pod) is not None
               and current['per_writer'][pod] < count
               for pod, count in before['per_writer'].items())


def source_rate_report(report, before, current, elapsed, target):
    first, last = before['received'], current['received']
    report.note('source exporter before=%s current=%s; %s{component_id="%s"} '
                'before=%s current=%s'
                % (before['status'], current['status'], current['metric'],
                   current['component'], first, last))
    report.note('source writers pod_namespace=%s before=%s current=%s'
                % (current['namespace'], json.dumps(before['per_writer'], sort_keys=True),
                   json.dumps(current['per_writer'], sort_keys=True)))
    reset = source_counter_reset(before, current)
    if first is None or last is None or reset or elapsed <= 0:
        report.note('achieved source rate unavailable; target %.0f lines/s total%s'
                    % (target, '; counter reset' if reset else ''))
        return None
    rate = (last - first) / elapsed
    report.note('achieved source rate %.0f lines/s; target %.0f lines/s total'
                % (rate, target))
    return rate


SOURCE_PICKUP_BOUND = 120
SOURCE_PICKUP_SECONDS = 3


def writer_line_bytes(run_id, seconds, options):
    """One numbered writer line with its newline, at this run's largest sequence."""
    largest = (int(options.writer_rate / options.writer_pods * seconds)
               + (options.writer_pods - 1) * 50_000_000 + 1)
    return (len(WRITER_LINE_PREFIX) + len(run_id) + len(' seq=') + len(str(largest))
            + len(' t=') + len(str(now_ms())) + 1)


def saturation_plan(rate, line_bytes, writable_max, configured_bound,
                    ceiling=SATURATION_CEILING):
    """Seconds the writable byte bound needs at a measured rate, and the clock used.

    The writer's own line is what the collector buffers, so the byte rate is
    lines/s times the line's length. When the configured bound cannot cover the
    arithmetic, the bound is derived from it with headroom and a stated ceiling;
    the walk never waits past the ceiling either.
    """
    rate = max(0.0, float(rate or 0.0))
    needed = None
    if rate > 0 and line_bytes > 0 and isinstance(writable_max, int) and writable_max > 0:
        needed = writable_max / (rate * line_bytes)
    derived = None if needed is None else int(math.ceil(needed * SATURATION_HEADROOM)) \
        + SATURATION_MARGIN_SECONDS
    if derived is None:
        bound = min(configured_bound, ceiling)
    elif needed * SATURATION_HEADROOM + SATURATION_MARGIN_SECONDS <= configured_bound:
        bound = min(configured_bound, ceiling)
    else:
        bound = min(derived, ceiling)
    return {'rate': rate, 'lineBytes': line_bytes, 'writableMax': writable_max,
            'neededSeconds': needed, 'derivedBound': derived, 'bound': bound,
            'ceiling': ceiling, 'fromConfigured': derived is None or bound == configured_bound,
            'reachable': needed is not None and needed <= bound}


def saturation_note(plan):
    """The arithmetic in one NOTE: could the writable bound fill within the clock?"""
    if plan['neededSeconds'] is None:
        return ('saturation arithmetic unavailable (rate %.0f lines/s, %d bytes per line, '
                'writable bound %s); the %d s clock is used'
                % (plan['rate'], plan['lineBytes'], plan['writableMax'], plan['bound']))
    if plan['neededSeconds'] <= plan['ceiling']:
        reach = ('can be reached: %.0f s at %.0f lines/s and %d bytes per line, within the '
                 '%d s ceiling' % (plan['neededSeconds'], plan['rate'], plan['lineBytes'],
                                   plan['ceiling']))
    else:
        reach = ('cannot be reached within the %d s ceiling: %.0f s at %.0f lines/s and %d bytes '
                 'per line' % (plan['ceiling'], plan['neededSeconds'], plan['rate'],
                               plan['lineBytes']))
    used = ('the configured %d s bound already covers it' % plan['bound']
            if plan['fromConfigured']
            else ('the fixed bound does not, so the walk derives %d s from the rate and line '
                  'size (headroom %.1f, margin %d s, ceiling %d s)'
                  % (plan['bound'], SATURATION_HEADROOM, SATURATION_MARGIN_SECONDS,
                     plan['ceiling'])))
    return ('the %d-byte writable max %s; %s' % (plan['writableMax'] or 0, reach, used))


def wait_source_pickup(report, options, cluster, baseline, sample_memory, state=None):
    """Allow the default 60 s file glob scan without charging the fill clock."""
    target = math.ceil(options.writer_rate * SOURCE_PICKUP_SECONDS)
    report.note('waiting for source pickup: bound=%d s, required counter rise=%d '
                '(%.0f lines/s for %d s); product glob cooldown unchanged'
                % (SOURCE_PICKUP_BOUND, target, options.writer_rate, SOURCE_PICKUP_SECONDS))
    first = baseline['received']
    if first is None:
        report.not_valid('source pickup baseline unavailable: ' + baseline['status'])
        return None
    started = time.monotonic()
    deadline = started + SOURCE_PICKUP_BOUND
    while True:
        if not safe_load(report, options) or not sample_memory():
            return None
        if not require_store_down(report, options, cluster, state):
            return None
        values, reason = read_metrics(options, cluster)
        current = source_rate_sample(values, reason, options)
        received = current['received']
        elapsed = time.monotonic() - started
        report.note('source pickup elapsed=%.0f s exporter=%s before=%s current=%s required=%d'
                    % (elapsed, current['status'], first, received, target))
        report.note('source pickup writers pod_namespace=%s counts=%s'
                    % (current['namespace'], json.dumps(current['per_writer'], sort_keys=True)))
        if source_counter_reset(baseline, current):
            report.not_valid('source pickup counter reset; cannot establish discovery')
            return None
        if received is not None and received - first >= target:
            rate = (received - first) / max(0.001, elapsed)
            report.note('source picked up writer load after %.0f s at %.0f lines/s; starting rate '
                        'and saturation clocks' % (elapsed, rate))
            return {'sample': current, 'rate': rate, 'elapsed': elapsed}
        if time.monotonic() >= deadline:
            report.not_valid('source pickup did not reach %d lines within %d s; exporter=%s'
                             % (target, SOURCE_PICKUP_BOUND, current['status']))
            return None
        time.sleep(min(3, max(0, deadline - time.monotonic())))


def buffer_state(values):
    """Disk bytes or memory events; never compare event totals with bytes.

    Vector 0.61 disk_v2 reserves one 128 MiB segment from configured max_size
    for the outstanding reader file (common.rs get_max_buffer_size). Exported
    max_size remains the configured bound; size counts unacknowledged bytes.
    """
    maximum = component_value(values, BUFFER_MAX_BYTES, 'logs-store')
    if maximum is not None:
        return {
            'size': component_value(values, BUFFER_BYTES, 'logs-store'),
            'max': maximum, 'writable_max': maximum - DISK_SEGMENT_RESERVATION,
            'unit': 'bytes',
            'events': component_value(values, BUFFER_SIZE, 'logs-store'),
            'received': component_value(values, BUFFER_RECEIVED, 'logs-store'),
            'sent': component_value(values, BUFFER_SENT, 'logs-store'),
            'source_received': component_value(values, RECEIVED, 'kubernetes'),
        }
    return {
        'size': component_value(values, BUFFER_SIZE, 'logs-store'),
        'max': component_value(values, BUFFER_MAX, 'logs-store'),
        'received': component_value(values, RECEIVED, 'kubernetes'),
    }


def saturated(state):
    """Memory: full in events. Disk: within 5% of the writable byte bound."""
    size, maximum, received = state.get('size'), state.get('max'), state.get('received')
    if state.get('unit') == 'bytes':
        writable, sent = state.get('writable_max'), state.get('sent')
        events = state.get('events')
        return (size is not None and writable is not None and writable > 0
                and size >= writable * DISK_FILL_FRACTION and size <= maximum
                and received is not None and sent is not None and events is not None
                and events > 0 and received > sent)
    return (size is not None and maximum is not None and received is not None
            and size >= maximum and maximum > 0 and received > maximum)


def collectors_metrics_gap(reason):
    """Why the sink's buffer cannot be read, in the exporter's own words."""
    if 'nothing answered port' in (reason or ''):
        return ('the exporter cannot be scraped: %s. deploy/platform/logs/config/vector.yaml '
                'declares a `sources.internal_metrics` of `type: internal_metrics` and a '
                '`sinks.metrics` of `type: prometheus_exporter` on 127.0.0.1:9598 (ADR-016 §6), '
                'so the collector or the port-forward to it is at fault; the buffer state is '
                'not guessed.' % reason)
    return ("the exporter answered but the sink's buffer is not in it: %s; the buffer state is "
            'not guessed' % (reason or 'no reason'))

def deployment_args(options):
    return ['-n', options.namespace, 'get', 'deployment', options.store,
            '--show-managed-fields', '-o', 'json']


def deployment_body(cluster, options):
    """The store Deployment with managedFields: kubectl omits them without the flag."""
    return cluster.json(deployment_args(options)) or {}


def flux_label_owner(body, options):
    """The Kustomization named by an object's Flux owner labels, or None."""
    labels = ((body or {}).get('metadata') or {}).get('labels') or {}
    name = labels.get(FLUX_NAME_LABEL)
    namespace = labels.get(FLUX_NAMESPACE_LABEL)
    if not isinstance(name, str) or not name:
        return None
    return {'namespace': namespace if isinstance(namespace, str) and namespace
                          else options.flux_namespace,
            'name': name}


def flux_owner(cluster, options):
    """The Kustomization that applies the store Deployment.

    The Deployment's `kustomize.toolkit.fluxcd.io/name` and `.../namespace`
    labels are the ownership record Flux writes; the arguments are only defaults
    for a Deployment that carries neither, and the caller says which one it used.
    """
    owner = flux_label_owner(deployment_body(cluster, options), options)
    if owner is not None:
        owner['source'] = 'the store Deployment\'s %s label' % FLUX_NAME_LABEL
        return owner
    return {'namespace': options.flux_namespace, 'name': options.kustomization,
            'source': 'the --kustomization/--flux-namespace defaults; the store Deployment '
                      'carries no %s label' % FLUX_NAME_LABEL}


def flux_chain(cluster, options):
    """The ownership chain from the store Deployment up to the root: child first.

    Every object Flux applies carries the labels of the Kustomization that
    applies it, so the chain is read upward until an object has no owner label.
    Suspending only the direct owner is not enough: the root reapplies the
    child's object and clears `spec.suspend`. A loop, an unreadable object or a
    chain deeper than CHAIN_DEPTH_LIMIT is an error, never a guess.
    """
    owners = [flux_owner(cluster, options)]
    seen = {(owners[0]['namespace'], owners[0]['name'])}
    while True:
        current = owners[-1]
        body = kustomization_json(cluster, current)
        if body is None:
            return {'owners': owners,
                    'error': 'the Kustomization %s could not be read' % owner_label(current)}
        parent = flux_label_owner(body, options)
        if parent is None:
            return {'owners': owners, 'error': None}
        if len(owners) >= CHAIN_DEPTH_LIMIT:
            return {'owners': owners,
                    'error': 'the Flux ownership chain is deeper than %d levels; refusing to '
                             'follow it' % CHAIN_DEPTH_LIMIT}
        key = (parent['namespace'], parent['name'])
        if key in seen:
            return {'owners': owners,
                    'error': 'the Flux ownership chain loops back to %s' % owner_label(parent)}
        parent['source'] = 'the %s label on %s' % (FLUX_NAME_LABEL, owner_label(current))
        seen.add(key)
        owners.append(parent)


def kustomization_json(cluster, owner):
    return cluster.json(['-n', owner['namespace'], 'get', 'kustomization',
                         owner['name'], '-o', 'json'])


def kustomization_state(cluster, owner):
    """The Kustomization's suspend flag and applied revision, or `known` False."""
    body = kustomization_json(cluster, owner)
    if body is None:
        return {'known': False, 'suspend': None, 'ready': None, 'appliedRevision': None,
                'generation': None, 'observedGeneration': None, 'handledAt': None}
    spec = body.get('spec') or {}
    status = body.get('status') or {}
    metadata = body.get('metadata') or {}
    suspend = spec.get('suspend') if isinstance(spec.get('suspend'), bool) else None
    ready = next((condition.get('status') for condition in status.get('conditions') or []
                  if condition.get('type') == 'Ready'), None)
    return {'known': True, 'suspend': suspend, 'ready': ready,
            'appliedRevision': status.get('lastAppliedRevision'),
            'generation': metadata.get('generation'),
            'observedGeneration': status.get('observedGeneration'),
            'handledAt': status.get('lastHandledReconcileAt')}


def set_kustomization_suspend(cluster, owner, suspend):
    return cluster.run([
        '-n', owner['namespace'], 'patch', 'kustomization', owner['name'],
        '--type=merge', '-p', json.dumps({'spec': {'suspend': suspend}}),
    ]).returncode == 0


def annotate_kustomization(cluster, owner, stamp):
    return cluster.run([
        '-n', owner['namespace'], 'annotate', 'kustomization', owner['name'],
        REQUESTED_AT + '=' + stamp, '--overwrite',
    ]).returncode == 0


def owner_label(owner):
    return '%s/%s' % (owner['namespace'], owner['name'])


def chain_label(owners):
    return ' <- '.join(owner_label(owner) for owner in owners)


def suspend_one(report, options, cluster, owner, state):
    """Suspend one Kustomization from the chain, verify it, record what the walk changed."""
    before = kustomization_state(cluster, owner)
    if not before['known']:
        report.fail('the Flux Kustomization %s is readable' % owner_label(owner),
                    'the read was refused')
        report.not_valid('the store cannot be held scaled to zero: %s could not be read, so '
                         'the chain is not known to be suspended' % owner_label(owner))
        return False
    if before['suspend'] is True:
        state['held'].append(owner)
        report.note('%s is already suspended before the walk; the walk will not resume it'
                    % owner_label(owner))
        return True
    if not set_kustomization_suspend(cluster, owner, True):
        report.fail('the Flux Kustomization %s is suspended' % owner_label(owner),
                    'spec.suspend=true was refused')
        report.not_valid('the store cannot be held scaled to zero: the chain is not suspended')
        return False
    state['suspended'].append(owner)
    state['held'].append(owner)

    def suspended():
        return kustomization_state(cluster, owner)['suspend'] is True

    bound = min(60, options.recover_bound)
    if not wait_until(time.monotonic() + bound, 3, suspended):
        current = kustomization_state(cluster, owner)
        report.fail('the Flux Kustomization %s is suspended' % owner_label(owner),
                    'spec.suspend=%s after the patch'
                    % ('unknown' if current['suspend'] is None
                       else str(current['suspend']).lower()))
        report.not_valid('the store cannot be held scaled to zero: %s is not verified suspended'
                         % owner_label(owner))
        return False
    report.pass_('the Flux Kustomization %s that leads to the store is suspended'
                 % owner_label(owner),
                 'spec.suspend=true; RESTORE resumes it and reconciles it')
    return True


def suspend_store_owner(report, options, cluster, state):
    """Hold the store's whole Flux ownership chain still, top down.

    A suspended Kustomization applies nothing, so the store stays at the
    replicas the walk sets. The chain is suspended from the root down: a parent
    that reconciles after its child was suspended would reapply the child's
    object and clear `spec.suspend`, which is exactly how run r36 lost the
    outage. Only the suspensions the walk made are recorded for RESTORE.
    """
    chain = flux_chain(cluster, options)
    state['kustomizations'] = chain['owners']
    if chain['error']:
        report.fail('the Flux ownership chain above the store is known', chain['error'])
        report.not_valid('the store cannot be held scaled to zero: its Flux ownership chain '
                         'is unknown')
        return False
    owners = chain['owners']
    report.note('the store\'s Flux ownership chain, child first: %s' % chain_label(owners))
    for owner in reversed(owners):
        if not suspend_one(report, options, cluster, owner, state):
            return False
    return True


def resumed_kustomization(cluster, owner, stamp):
    """Resume, force a reconcile, and require Ready=True on the applied revision."""
    current = kustomization_state(cluster, owner)
    if not current['known']:
        return False
    if current['suspend'] is True:
        if not set_kustomization_suspend(cluster, owner, False):
            raise WalkError('kustomization_resume_refused')
        current = kustomization_state(cluster, owner)
        if not current['known'] or current['suspend'] is True:
            return False
    if not annotate_kustomization(cluster, owner, stamp):
        return False
    current = kustomization_state(cluster, owner)
    if not current['known'] or current['suspend'] is True:
        return False
    if current['ready'] != 'True' or not current['appliedRevision']:
        return False
    if current['handledAt'] != stamp:
        return False
    try:
        return int(current['observedGeneration'] or 0) >= int(current['generation'] or 0)
    except (TypeError, ValueError):
        return False


def store_replica_managers(cluster, options):
    """The field managers whose managedFields write `spec.replicas`."""
    body = deployment_body(cluster, options)
    managers = []
    for entry in (body.get('metadata') or {}).get('managedFields') or []:
        if not isinstance(entry, dict) or entry.get('subresource'):
            continue
        if 'replicas' not in json.dumps(entry.get('fieldsV1') or {}):
            continue
        manager = entry.get('manager')
        if isinstance(manager, str) and manager not in managers:
            managers.append(manager)
    return managers


def store_restorer(cluster, options):
    """Who put the store back: replica field managers and recent Deployment events."""
    managers = store_replica_managers(cluster, options)
    events = []
    result = cluster.run(['-n', options.namespace, 'get', 'events',
                          '--field-selector',
                          'involvedObject.kind=Deployment,involvedObject.name=' + options.store,
                          '--sort-by=.metadata.creationTimestamp', '-o', 'json'])
    try:
        items = json.loads(result.stdout).get('items', []) if result.returncode == 0 else []
    except ValueError:
        items = []
    for event in items[-3:]:
        events.append('reason=%s message=%s' % (
            diagnostic_tail(event.get('reason')), diagnostic_tail(event.get('message'))))
    return {'managers': managers, 'events': events}


def store_down_state(cluster, options):
    """Whether the store is down now, and the reading that says so."""
    body = cluster.json(deployment_args(options))
    if body is None:
        return {'known': False, 'down': False, 'detail': 'the store Deployment could not be read'}
    replicas = (body.get('spec') or {}).get('replicas')
    status = int((body.get('status') or {}).get('replicas') or 0)
    pods = [((pod.get('metadata') or {}).get('name') or '-')
            for pod in cluster.pods(options.namespace,
                                    'app.kubernetes.io/name=' + options.store)]
    return {'known': True,
            'down': replicas == 0 and status == 0 and not pods,
            'detail': 'spec.replicas=%s status.replicas=%d pod(s)=%s'
                      % (replicas, status, ', '.join(pods) or 'none')}


def require_store_down(report, options, cluster, state=None):
    """Every reading during the outage: the store is down and every hold still holds.

    A store that Flux scaled back to one ends the outage the case needs: the
    sink drains and the crash measures nothing. A Kustomization in the chain
    that no longer reads `spec.suspend=true` is the same loss one step earlier.
    Either is TEST NOT VALID naming what came back, never a pass and never a wait.
    """
    down = store_down_state(cluster, options)
    if not down['down']:
        restorer = store_restorer(cluster, options)
        report.not_valid(
            'the store came back while it had to stay down: %s; the outage never lasted, so '
            'nothing measured against it is valid. Put back by %s%s'
            % (down['detail'],
               ', '.join(restorer['managers']) or 'no field manager names spec.replicas',
               ('; latest Deployment event ' + '; '.join(restorer['events']))
               if restorer['events'] else ''))
        return False
    for owner in (state or {}).get('held') or []:
        current = kustomization_state(cluster, owner)
        if current['suspend'] is not True:
            report.not_valid(
                'the Flux Kustomization %s no longer reads spec.suspend=true (%s) while the '
                'store must stay down: its reconcile can scale the store back, so nothing '
                'measured against this outage is valid'
                % (owner_label(owner),
                   'unreadable' if not current['known']
                   else str(current['suspend']).lower()))
            return False
    return True


def store_replicas(cluster, options):
    body = cluster.json(['-n', options.namespace, 'get', 'deployment', options.store,
                         '-o', 'json']) or {}
    replicas = (body.get('spec') or {}).get('replicas')
    if not isinstance(replicas, int) or replicas < 0:
        raise WalkError('store_replicas_unavailable')
    return replicas


def set_replicas(cluster, options, replicas):
    return cluster.run([
        '-n', options.namespace, 'scale', 'deployment', options.store,
        '--replicas=%d' % replicas,
    ]).returncode == 0


def store_ready(cluster, options):
    body = cluster.json(['-n', options.namespace, 'get', 'deployment', options.store,
                         '-o', 'json']) or {}
    status = body.get('status') or {}
    desired = (body.get('spec') or {}).get('replicas') or 0
    return (int(status.get('readyReplicas') or 0) == int(desired)
            and int(status.get('availableReplicas') or 0) == int(desired)
            and int(status.get('observedGeneration') or 0)
            >= int((body.get('metadata') or {}).get('generation') or 0))


def collector_restarts(cluster, options):
    pod = collector_pod(cluster, options) or {}
    statuses = ((pod.get('status') or {}).get('containerStatuses') or [])
    return sum(int(status.get('restartCount') or 0) for status in statuses)


def collector_running(cluster, options):
    pod = collector_pod(cluster, options) or {}
    phase = (pod.get('status') or {}).get('phase')
    return phase == 'Running' and cluster.is_ready(options.collector_namespace,
                                                   (pod.get('metadata') or {}).get('name') or '')


def node_run(args):
    """Bounded node command, never routed through kubectl."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        raise WalkError('node_command_failed:' + type(error).__name__) from None


def vector_pid(cluster, options):
    """The vector process's host pid from `k3s crictl inspect`: (pid, detail)."""
    pod = collector_pod_name(cluster, options)
    if not pod:
        return None, 'the collector has no pod'
    listing = node_run(shlex.split(options.crictl) + [
        'ps', '--name', 'logs-collector',
        '--label', 'io.kubernetes.pod.name=' + pod,
        '--label', 'io.kubernetes.pod.namespace=' + options.collector_namespace,
        '--output', 'json'])
    if listing.returncode != 0:
        return None, 'crictl ps refused: %s' % tail(listing.stderr)
    try:
        containers = (json.loads(listing.stdout or '{}').get('containers') or [])
    except ValueError:
        return None, 'crictl ps answered no JSON'
    target = None
    for container in containers:
        names = (container.get('metadata') or {}).get('name')
        if names == 'logs-collector':
            target = container.get('id')
    if not target:
        return None, 'crictl ps lists no logs-collector container for %s' % pod
    inspected = node_run(shlex.split(options.crictl) + ['inspect', target])
    if inspected.returncode != 0:
        return None, 'crictl inspect refused: %s' % tail(inspected.stderr)
    try:
        info = (json.loads(inspected.stdout or '{}').get('info') or {})
    except ValueError:
        return None, 'crictl inspect answered no JSON'
    pid = info.get('pid')
    if not isinstance(pid, int) or pid <= 1:
        return None, ('the inspected pid is %s: pid 1 is the pause container, not vector, '
                      'so nothing would be killed' % (pid,))
    return pid, 'pid %d' % pid


def tail(text, count=160):
    return ' '.join((text or '').strip().splitlines()[-2:])[:count]


def diagnostic_tail(text):
    """A bounded public-word tail: unknown words/values are always redacted."""
    public = set(('error from server badrequest forbidden notfound unauthorized container pod '
                  'writer walk-crash-writer is waiting to start running pending failed terminated '
                  'image pull backoff imagepullbackoff errimagepull errimageneverpull '
                  'containercreating podinitializing crashloopbackoff createcontainerconfigerror '
                  'createcontainererror runcontainererror starterror oomkilled completed '
                  'failedscheduling failedcreate failedpull failed restricted started scheduled '
                  'pulled pulling backoff successfulcreate failedmount failedattachvolume '
                  'node executable missing logs unavailable no such file or directory '
                  'permission denied exec executable found in path unknown normal warning '
                  'scalingreplicaset scaled up down replica set to').split())
    words = tail(text, 500).split()
    return ' '.join(word if word.strip('.,:;()"').lower() in public else '[redacted]'
                    for word in words) or '-'


def writer_read(cluster, options, run_id):
    """Keep kubectl's outcome alongside numbered lines so failures explain themselves."""
    written = []
    result = None
    for name in writer_names(options):
        result = cluster.run(['-n', options.writer_namespace, 'logs', name,
                              '--tail=100000'], timeout=15)
        if result.returncode != 0:
            continue
        for line in result.stdout.splitlines():
            match = WRITER_LINE.search(line)
            if match and match.group(1) == run_id:
                written.append(int(match.group(2)))
    return written, result


def emitted_count(cluster, options, run_id):
    """Last sequence per pod is cumulative even when older kubelet lines rotated."""
    total = 0
    for index, name in enumerate(writer_names(options)):
        result = cluster.run(['-n', options.writer_namespace, 'logs', name, '--tail=1'], timeout=15)
        match = WRITER_LINE.search(result.stdout) if result.returncode == 0 else None
        if not match or match.group(1) != run_id:
            raise WalkError('writer_rate_unavailable')
        total += int(match.group(2)) - index * 50_000_000
    return total


def writer_lines(cluster, options, run_id):
    return writer_read(cluster, options, run_id)[0]


def writer_diagnostics(report, cluster, options, pod, result):
    status = (pod or {}).get('status') or {}
    report.note('writer phase=%s' % status.get('phase', 'absent'))
    statuses = status.get('containerStatuses') or []
    for container in statuses:
        state = container.get('state') or {}
        kind = next((name for name in ('waiting', 'running', 'terminated') if name in state),
                    'unknown')
        detail = state.get(kind) or {}
        report.note('writer container state=%s reason=%s exit=%s' % (
            kind, diagnostic_tail(detail.get('reason')), detail.get('exitCode', '-')))
    if not statuses:
        report.note('writer container state=unknown reason=unknown')
    events = cluster.run(['-n', options.writer_namespace, 'get', 'events',
                          '--sort-by=.metadata.creationTimestamp', '-o', 'json'])
    try:
        items = json.loads(events.stdout).get('items', []) if events.returncode == 0 else []
    except ValueError:
        items = []
    for event in items[-5:]:
        report.note('writer namespace event reason=%s message=%s' % (
            diagnostic_tail(event.get('reason')), diagnostic_tail(event.get('message'))))
    if not items:
        report.note('writer namespace events exit=%d tail=%s stderr=%s' % (
            events.returncode, diagnostic_tail(events.stdout), diagnostic_tail(events.stderr)))
    report.note('writer logs exit=%d stderr=%s' % (
        result.returncode, diagnostic_tail(result.stderr)))


def wait_writer(report, options, cluster, run_id):
    """Do not inspect the buffer until a Running writer has produced a numbered line."""
    observation = {'pod': None, 'read': None}
    def started():
        if not safe_load(report, options):
            raise WalkError('node_load_bound')
        pod = cluster.pod(options.writer_namespace, writer_name(1))
        observation['pod'] = pod
        if ((pod or {}).get('status') or {}).get('phase') != 'Running':
            return False
        written, result = writer_read(cluster, options, run_id)
        observation['read'] = result
        return bool(written)
    if wait_until(time.monotonic() + 180, 3, started):
        report.pass_('the writer is Running and its first numbered line is readable')
        return True
    result = observation['read']
    if result is None:
        _written, result = writer_read(cluster, options, run_id)
    writer_diagnostics(report, cluster, options, observation['pod'], result)
    report.not_valid('the writer pod wrote no numbered line the walk could read')
    return False


def kubelet_lines(pod_name, options, run_id=None, root=Path('/var/log/pods')):
    """Read current and rotated CRI files, scoped to namespace, pod and run."""
    sequences = set()
    try:
        pods = [path for path in Path(root).iterdir()
                if path.name.startswith(options.writer_namespace + '_' + pod_name + '_')]
        if not pods:
            return None
        for pod in pods:
            for container in pod.iterdir():
                for path in container.iterdir():
                    if '.log' not in path.name:
                        continue
                    with path.open('r', encoding='utf8', errors='replace') as handle:
                        for line in handle:
                            match = WRITER_LINE.search(line)
                            if match and (run_id is None or match.group(1) == run_id):
                                sequences.add(int(match.group(2)))
    except OSError:
        return None
    return sequences


def delivered_lines(loader, from_ms, run_id, bound=120):
    """The writer's numbered lines the loader's API returns, paginated."""
    deadline = time.monotonic() + bound
    while True:
        found = set()
        offset = 0
        while True:
            answer = loader.logs({'from': str(from_ms), 'to': str(now_ms()),
                                  'module': WRITER_MODULE, 'text': run_id,
                                  'offset': str(offset), 'limit': '1000'})
            if answer is None or answer.get('state') != 'ok':
                break
            records = answer.get('records') or []
            for record in records:
                match = WRITER_LINE.search(record.get('message') or '')
                if match and match.group(1) == run_id:
                    found.add(int(match.group(2)))
            if len(records) < 1000 or offset + 1000 > int(answer.get('count') or 0):
                break
            offset += 1000
        if found or time.monotonic() >= deadline:
            return found
        time.sleep(5)


def crash_verdict(written, delivered, kubelet, duplicated):
    """L07's verdict: nothing still in the kubelet's files may be lost."""
    if kubelet is None:
        return {'ok': False, 'detail': 'the kubelet\'s files were not read'}
    still_there = set(kubelet)
    missing = sorted(still_there - set(delivered))
    rotated = sorted(set(written) - set(delivered) - still_there)
    detail = ('%d written, %d delivered, %d duplicated, %d missing of which %d are still in '
              'the kubelet\'s files, %d rotated away'
              % (len(written), len(delivered), duplicated, len(missing) + len(rotated),
                 len(missing), len(rotated)))
    if missing:
        detail = 'lost while still in the kubelet\'s files: seq %s (%s)' % (
            sequence_ranges(missing), detail)
    return {'ok': not missing, 'detail': detail, 'missing': missing, 'rotated': rotated}


def sequence_ranges(sequences):
    """A sorted number list as ranges: `1, 3..5, 9`."""
    ordered = sorted(sequences)
    parts = []
    start = previous = None
    for value in ordered:
        if start is None:
            start = previous = value
        elif value == previous + 1:
            previous = value
        else:
            parts.append(str(start) if start == previous else '%d..%d' % (start, previous))
            start = previous = value
    if start is not None:
        parts.append(str(start) if start == previous else '%d..%d' % (start, previous))
    return ', '.join(parts)


def collector_memory(cluster, options):
    """The collector container's working set from crictl stats: (bytes, reason)."""
    pod = collector_pod_name(cluster, options)
    if not pod:
        return None, 'the collector has no pod'
    listing = node_run(shlex.split(options.crictl) + [
        'ps', '--name', 'logs-collector',
        '--label', 'io.kubernetes.pod.name=' + pod,
        '--label', 'io.kubernetes.pod.namespace=' + options.collector_namespace,
        '--output', 'json'])
    if listing.returncode != 0:
        return None, 'crictl ps refused'
    try:
        containers = json.loads(listing.stdout or '{}').get('containers') or []
    except ValueError:
        return None, 'crictl ps answered no JSON'
    target = next((container.get('id') for container in containers
                   if (container.get('metadata') or {}).get('name') == 'logs-collector'), None)
    if not target:
        return None, 'crictl ps lists no logs-collector container'
    stats = node_run(shlex.split(options.crictl) + ['stats', '--output', 'json', target])
    if stats.returncode != 0:
        return None, 'crictl stats refused'
    try:
        value = json.loads(stats.stdout or '{}')
    except ValueError:
        return None, 'crictl stats answered no JSON'
    entries = value.get('stats') if isinstance(value.get('stats'), list) else [value]
    for entry in entries:
        memory = (entry or {}).get('memory') or {}
        used = memory.get('workingSetBytes')
        if isinstance(used, dict):
            used = used.get('value')
        if isinstance(used, str) and used.isdigit():
            used = int(used)
        if isinstance(used, int) and not isinstance(used, bool) and used > 0:
            return used, ''
    return None, 'crictl stats carries no working-set memory figure'


def termination_reason(cluster, options):
    """How the collector's container last ended: OOMKilled, Error, or nothing."""
    pod = collector_pod(cluster, options) or {}
    for status in ((pod.get('status') or {}).get('containerStatuses') or []):
        last = (status.get('lastState') or {}).get('terminated') or {}
        reason = last.get('reason')
        if isinstance(reason, str):
            return '%s (exit %s)' % (reason, last.get('exitCode'))
    return ''


def memory_verdict(peak, limit, buffer_size, maximum, restarts_before, restarts_after, reason):
    """The buffer's maximum must fit the collector's memory limit (ADR-016 §6)."""
    restarted = restarts_after != restarts_before
    detail = ('peak memory %s, limit %s, buffer %d of %d, restarts %d -> %d%s'
              % (('%.1f MiB' % (peak / MIB)) if peak else 'unknown',
                 ('%.1f MiB' % (limit / MIB)) if limit else 'unknown',
                 buffer_size if buffer_size is not None else -1, maximum,
                 restarts_before, restarts_after,
                 (', last termination %s' % reason) if reason else ''))
    return {'ok': not restarted and peak is not None and 0 < peak <= limit,
            'restarted': restarted, 'detail': detail}


def node_load():
    """This operator walk runs on the node, as do its crictl and kubelet reads."""
    return float(Path('/proc/loadavg').read_text().split()[0])


def watch_load(report, options, stop):
    """Interrupt even a blocked staged command; main owns all restoration."""
    while not stop.wait(1):
        if not safe_load(report, options):
            os.kill(os.getpid(), signal.SIGINT)
            return


def require_safe_load(report, options):
    if not safe_load(report, options):
        raise WalkError('node_load_bound')
    return True


def safe_load(report, options):
    try:
        load = node_load()
    except (OSError, ValueError, IndexError):
        report.not_valid('node load average unavailable; stop writers to protect the VM')
        return False
    if not 0 <= load <= options.max_load:
        report.not_valid('node one-minute load %.2f exceeds bound %.2f; stopping writers'
                         % (load, options.max_load))
        return False
    return True


def crash_case(report, options, loader, cluster, state, saturated_case, store_down_restart=False):
    """One crash: write, kill, recover, count - saturated or informative."""
    if not safe_load(report, options):
        return False
    label = 'store-down-restart' if store_down_restart else ('saturated' if saturated_case else 'unsaturated')
    metrics, reason = read_metrics(options, cluster) if saturated_case else (None, '')
    state_ok = True
    if saturated_case:
        if metrics is None:
            report.not_valid(collectors_metrics_gap(reason))
            return False
        state_ok = False
    run_id = 'walk-crash-%s-%d' % (label, now_ms())
    state['run_id'] = run_id
    image = state.get('writer_image') or writer_image(cluster, options)
    if not image:
        report.not_valid('the evictor CronJob names no Node image: the writer cannot be created')
        return False
    seconds = (max(options.fill_bound, options.fill_ceiling) + options.saturated_seconds
               + 120 + SOURCE_PICKUP_BOUND)
    applied = cluster.apply(writer_manifest(image, options, run_id, seconds))
    for index in range(2, (options.writer_pods or 1) + 1):
        if cluster.apply(writer_manifest(image, options, run_id, seconds,
                                         index)).returncode != 0:
            report.not_valid('the writer pod %s was not created' % writer_name(index))
            return False
    if applied.returncode != 0:
        report.not_valid('the writer pod was not created: %s' % tail(applied.stderr))
        return False
    if not wait_writer(report, options, cluster, run_id):
        return False
    started = now_ms() - seconds * 1000
    peak = 0
    def sample_memory():
        nonlocal peak
        used, why = collector_memory(cluster, options)
        if used is None:
            report.not_valid('collector memory unavailable: ' + why)
            return False
        peak = max(peak, used)
        report.note('collector working set current=%d peak-observed=%d limit=%d bytes'
                    % (used, peak, options.memory_limit_bytes))
        return report.check(used <= options.memory_limit_bytes,
                            'collector observed memory stays within limit')
    try:
        oom = None
        if saturated_case:
            restarts_before = collector_restarts(cluster, options)
            def pickup_safety():
                if collector_restarts(cluster, options) != restarts_before:
                    report.not_valid('collector restarted during source pickup')
                    return False
                return sample_memory()
            pickup = wait_source_pickup(report, options, cluster,
                                        source_rate_sample(metrics, reason, options,
                                                           before_writers=True),
                                        pickup_safety, state)
            if pickup is None:
                return False
            source_before = pickup['sample']
            initial = buffer_state(metrics) if metrics is not None else {}
            plan = saturation_plan(pickup.get('rate') or options.writer_rate,
                                   writer_line_bytes(run_id, seconds, options),
                                   initial.get('writable_max'),
                                   options.fill_bound, options.fill_ceiling)
            report.note(saturation_note(plan))
            fill_deadline = time.monotonic() + plan['bound']
            last_memory = time.monotonic()
            emitted_before = emitted_count(cluster, options, run_id)
            started_fill = time.monotonic()
            while True:
                if not safe_load(report, options):
                    return False
                if not require_store_down(report, options, cluster, state):
                    return False
                metrics, reason = read_metrics(options, cluster)
                elapsed = max(1.0, time.monotonic() - started_fill)
                source_rate_report(report, source_before, source_rate_sample(metrics, reason, options),
                                   elapsed, options.writer_rate)
                state_now = buffer_state(metrics) if metrics is not None else {}
                if not sample_memory():
                    return False
                if metrics is not None and saturated(state_now):
                    emitted = emitted_count(cluster, options, run_id) - emitted_before
                    report.note('achieved writer rate %.0f lines/s total; target %.0f'
                                % (emitted / max(1, time.monotonic() - started_fill),
                                   options.writer_rate))
                    report.pass_('the sink buffer reached its stated saturation margin',
                                 json.dumps(state_now, sort_keys=True))
                    if state_now.get('unit') == 'bytes':
                        report.note('disk configured maximum=%d bytes; writable=%d bytes; '
                                    '128 MiB segment reservation plus 5%% writable fill tolerance '
                                    '(threshold=%.0f bytes), not 95%% of configured maximum'
                                    % (state_now['max'], state_now['writable_max'],
                                       state_now['writable_max'] * DISK_FILL_FRACTION))
                    break
                if time.monotonic() - last_memory >= 10:
                    last_memory = time.monotonic()
                    emitted = emitted_count(cluster, options, run_id) - emitted_before
                    report.note('achieved writer rate %.0f lines/s total; target %.0f'
                                % (emitted / max(1, time.monotonic() - started_fill),
                                   options.writer_rate))
                    used, _why = collector_memory(cluster, options)
                    if used is not None:
                        peak = max(peak, used)
                    restarts_now = collector_restarts(cluster, options)
                    if restarts_now != restarts_before:
                        oom = {'peak': peak, 'buffer': state_now.get('size'),
                               'max': state_now.get('max') or 0,
                               'restarts': (restarts_before, restarts_now),
                               'reason': termination_reason(cluster, options)}
                        break
                if time.monotonic() >= fill_deadline:
                    report.not_valid(
                        'the sink buffer never reached its maximum within the %d s saturation '
                        'clock at this write rate: the last reading was %s (%s); saturation is '
                        'never inferred from writer totals'
                        % (plan['bound'],
                           json.dumps(state_now) if state_now else 'none',
                           reason or 'the exporter answered'))
                    return False
                time.sleep(3)
            if oom is not None:
                verdict_memory = memory_verdict(oom['peak'], options.memory_limit_bytes,
                                                oom['buffer'], oom['max'], oom['restarts'][0],
                                                oom['restarts'][1], oom['reason'])
                report.fail('the collector\'s buffer cannot reach its maximum inside its '
                            'memory limit', verdict_memory['detail'])
                # The crash a full buffer really causes: count it as the crash.
                report.note('the collector restarted before the buffer was full; the crash '
                            'that follows is the unplanned one')
            else:
                # Keep writing past the full buffer, so the lines behind it are real.
                until = time.monotonic() + options.saturated_seconds
                while time.monotonic() < until:
                    if not safe_load(report, options):
                        return False
                    if not require_store_down(report, options, cluster, state):
                        return False
                    if not sample_memory():
                        return False
                    if collector_restarts(cluster, options) != restarts_before:
                        report.fail('collector restarted during saturated dwell',
                                    termination_reason(cluster, options))
                        return False
                    time.sleep(min(3, max(0, until - time.monotonic())))
        else:
            deadline = time.monotonic() + 60
            while len(writer_lines(cluster, options, run_id)) < options.unsaturated_lines:
                if not safe_load(report, options):
                    return False
                if not require_store_down(report, options, cluster, state):
                    return False
                if time.monotonic() >= deadline:
                    break
                time.sleep(3)
            report.note('the unsaturated case wrote %d line(s) with the buffer below its maximum'
                        % len(writer_lines(cluster, options, run_id)))
        if not safe_load(report, options):
            return False
        written = writer_lines(cluster, options, run_id)
        if not sample_memory():
            return False
        restarts_at_kill = collector_restarts(cluster, options)
        if saturated_case and oom is None and restarts_at_kill != restarts_before:
            report.fail('collector restarted before the intentional crash',
                        termination_reason(cluster, options))
            return False
        if store_down_restart and not wait_store_down(report, options, cluster, state):
            return False
        if oom is None:
            pid, detail = vector_pid(cluster, options)
            if pid is None:
                report.not_valid('nothing was killed: %s' % detail)
                return False
            killed = node_run(['kill', '-9', str(pid)]).returncode == 0
            report.check(killed, 'the vector process is killed by its host pid', detail)
            if not killed:
                return False
        if store_down_restart and not wait_until(time.monotonic() + options.recover_bound, 3,
                lambda: require_safe_load(report, options)
                and collector_restarts(cluster, options) > restarts_at_kill):
            report.not_valid('no actual collector restart observed while the store stayed down')
            return False
        if store_down_restart and not require_store_down(report, options, cluster, state):
            return False
        if not recover_after_crash(report, options, cluster, state, store_down_restart):
            return False
        if not sample_memory():
            return False
        # Freeze the evidence set before allowing backlog drain. Writers may
        # continue; this verdict covers only the retained snapshot, not later lines.
        written = writer_lines(cluster, options, run_id)
        kubelet = set()
        for name in writer_names(options):
            retained = kubelet_lines(name, options, run_id)
            if not retained:
                report.not_valid('no retained numbered lines read for writer ' + name)
                return False
            kubelet.update(retained)
        report.note('retained-kubelet snapshot taken before settling and delivery query')
        until = time.monotonic() + options.settle_seconds
        while time.monotonic() < until:
            require_safe_load(report, options)
            time.sleep(min(3, max(0, until - time.monotonic())))
        observation = {'counts': None}
        def target_delivered():
            require_safe_load(report, options)
            counts = count_deliveries(loader, started, run_id)
            observation['counts'] = counts
            return counts is not None and kubelet.issubset(counts)
        wait_until(time.monotonic() + options.recover_bound, 3, target_delivered)
        counts = observation['counts']
        if counts is None:
            report.not_valid('delivery query unavailable or incomplete; no valid counts')
            return False
        delivered = set(counts)
        duplicated = sum(max(0, count - 1) for count in counts.values())
        verdict = crash_verdict(written, delivered, kubelet, duplicated)
        if saturated_case or store_down_restart:
            report.note('retained-kubelet delivery is a measured strict verdict, not a source '
                        'acknowledgement or replay guarantee')
            report.check(verdict['ok'],
                         'every line still in the kubelet\'s files is delivered at least once',
                         verdict['detail'])
            report.note('the collector restarted %d time(s) across the crash'
                        % collector_restarts(cluster, options))
        else:
            report.note('unsaturated crash (informative): %s; after the kill the collector '
                        'restarted %d time(s)'
                        % (verdict['detail'], collector_restarts(cluster, options)))
        return verdict['ok'] if saturated_case or store_down_restart else True
    finally:
        for name in writer_names(options):
            restore_step(report, 'delete ' + name, lambda name=name: cluster.run(
                ['-n', options.writer_namespace, 'delete', 'pod', name,
                 '--ignore-not-found', '--grace-period=1', '--wait=true',
                 '--timeout=170s'], timeout=180).returncode == 0,
                options.restore_bound)


def recover_after_crash(report, options, cluster, state, store_down_restart=False):
    def collector_ready():
        return require_safe_load(report, options) and collector_running(cluster, options)
    if store_down_restart:
        if not wait_until(time.monotonic() + options.recover_bound, 3, collector_ready):
            report.not_valid('collector did not restart while store remained down')
            return False
        if not require_store_down(report, options, cluster, state):
            return False
        report.pass_('collector restarted before restoring the unavailable store')
    if not set_replicas(cluster, options, state['replicas']):
        report.fail('the store is scaled back up')
        return False
    if not store_down_restart and not wait_until(
            time.monotonic() + options.recover_bound, 3, collector_ready):
        report.not_valid('collector did not recover')
        return False
    return report.check(wait_until(time.monotonic() + options.recover_bound, 3,
        lambda: require_safe_load(report, options) and store_ready(cluster, options)),
        'the store answers again')


def count_deliveries(loader, from_ms, run_id):
    """One fixed-window, complete pagination attempt; None means retry it."""
    counts = {}
    offset = 0
    to_ms = str(now_ms())
    expected = None
    while True:
        query = {'from': str(from_ms), 'to': to_ms,
                 'module': WRITER_MODULE, 'text': run_id,
                 'offset': str(offset), 'limit': '1000'}
        if expected is not None:
            query['expected'] = str(expected)
        answer = loader.logs(query)
        if answer is None or answer.get('state') != 'ok' or answer.get('incomplete'):
            return None
        total = answer.get('count')
        if not isinstance(total, int) or isinstance(total, bool) or total < 0:
            return None
        if expected is None:
            expected = total
        elif expected != total:
            return None
        records = answer.get('records') or []
        for record in records:
            match = WRITER_LINE.search(record.get('message') or '')
            if match and match.group(1) == run_id:
                sequence = int(match.group(2))
                counts[sequence] = counts.get(sequence, 0) + 1
        offset += len(records)
        if offset == total:
            return counts
        if len(records) != 1000 or offset > total:
            return None


def ensure_namespace(report, cluster, options, state):
    body = cluster.json(['get', 'namespace', options.writer_namespace, '-o', 'json'])
    if body is not None:
        return True
    state['created_namespace'] = True  # A timed-out create may still have succeeded.
    result = cluster.run(['create', 'namespace', options.writer_namespace])
    if result.returncode != 0:
        report.not_valid('the walk\'s own namespace was not created: %s' % tail(result.stderr))
        return False
    return True


def free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def wait_store_down(report, options, cluster, state=None):
    """Wait for 0 replicas and no pod; a store that came back is TEST NOT VALID."""
    def stopped():
        require_safe_load(report, options)
        return store_down_state(cluster, options)['down']
    if wait_until(time.monotonic() + options.recover_bound, 3, stopped):
        report.pass_('the store has no running or terminating pods')
        return True
    return require_store_down(report, options, cluster, state)


def stop_store(report, options, cluster, state):
    """Suspend the whole Flux chain, scale the store to zero, and verify it.

    The suspension comes first and top down: a reconcile of any level after the
    scale-down would scale the store straight back, and the outage the walk
    needs would never begin.
    """
    state['replicas'] = store_replicas(cluster, options)
    report.note('the store runs %d replica(s) before the crash' % state['replicas'])
    if not suspend_store_owner(report, options, cluster, state):
        return False
    if not set_replicas(cluster, options, 0):
        report.not_valid('the store could not be scaled to zero: the sink never fills')
        return False
    if not wait_store_down(report, options, cluster, state):
        return False
    report.pass_('the store is scaled to zero', options.store)
    return True


def run(report, options, loader, cluster, state):
    if not safe_load(report, options):
        return False
    report.note('writers target %.0f lines/s total across %d pods; node load bound %.2f'
                % (options.writer_rate, options.writer_pods, options.max_load))
    state['writer_image'] = writer_image(cluster, options)
    if not report.check(bool(state['writer_image']), 'the evictor names the Node writer image',
                        'logs-evictor'):
        return False
    if not ensure_namespace(report, cluster, options, state):
        return False
    if not stop_store(report, options, cluster, state):
        return False
    saturated_ok = crash_case(report, options, loader, cluster, state, True)
    if saturated_ok:
        # Separately restart while the store remains unavailable, then recover it.
        wait_until(time.monotonic() + 120, 3, lambda: not cluster.pods(
            options.writer_namespace, 'app.kubernetes.io/name=' + WRITER_MODULE))
        if not set_replicas(cluster, options, 0):
            return False
        if not wait_store_down(report, options, cluster, state):
            return False
        if not crash_case(report, options, loader, cluster, state, False,
                          store_down_restart=True):
            return False
        if not set_replicas(cluster, options, 0):
            return False
        if not wait_store_down(report, options, cluster, state):
            return False
        crash_case(report, options, loader, cluster, state, False)
    return saturated_ok


def restore_step(report, name, action, bound):
    """A failed recovery command must not skip the remaining recovery steps."""
    def attempt():
        try:
            return bool(action())
        except BaseException as error:
            report.note('RESTORE retry %s: %s' % (name, type(error).__name__))
            return False
    deadline = time.monotonic() + bound
    while True:
        try:
            if wait_until(deadline, 5, attempt):
                return True
            break
        except BaseException as error:
            report.note('RESTORE interrupted %s: %s; continuing' % (name, type(error).__name__))
            if time.monotonic() >= deadline:
                break
    report.fail('RESTORE ' + name, 'incomplete after %d seconds; repair by hand' % bound)
    return False


def restore(report, options, loader, cluster, state):
    """Stop load first; retry each recovery step independently of the others."""
    bound = options.restore_bound
    def command(args):
        return cluster.run(args, timeout=180).returncode == 0
    restored = True
    for name in writer_names(options):
        restored = restore_step(report, 'delete ' + name, lambda name=name: command(
            ['-n', options.writer_namespace, 'delete', 'pod', name,
             '--ignore-not-found', '--grace-period=1', '--wait=true',
             '--timeout=170s']), bound) and restored
    if state.get('replicas') is not None:
        restored = restore_step(report, 'scale store', lambda: command(
            ['-n', options.namespace, 'scale', 'deployment', options.store,
             '--replicas=%d' % state['replicas']]), bound) and restored
        restored = restore_step(report, 'store Ready', lambda: store_ready(cluster, options),
                                bound) and restored
    # Child first, then its parent: the parent's reapply must find the child
    # already unsuspended, or it writes the child's old `spec.suspend` back.
    suspended = state.get('suspended') or []
    order = [owner for owner in state.get('kustomizations') or [] if owner in suspended]
    order += [owner for owner in suspended if owner not in order]
    resumed, failed = [], []
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    for owner in order:
        ok = restore_step(
            report, 'resume the Flux Kustomization %s and wait for Ready=True on the applied '
                    'revision' % owner_label(owner),
            lambda owner=owner: resumed_kustomization(cluster, owner, stamp), bound)
        if ok:
            final = kustomization_state(cluster, owner)
            report.pass_('the Flux Kustomization %s is resumed and reconciled'
                         % owner_label(owner),
                         'spec.suspend=%s Ready=%s revision=%s'
                         % ('absent' if final['suspend'] is None
                            else str(final['suspend']).lower(),
                            final['ready'], final['appliedRevision']))
            resumed.append(owner)
        else:
            failed.append(owner)
            report.fail('RESTORE the Flux Kustomization %s is still suspended'
                        % owner_label(owner),
                        'all later platform deploys stop until it is resumed: patch '
                        'spec.suspend=false and request a reconcile by hand')
        restored = ok and restored
    if state.get('created_namespace'):
        restored = restore_step(report, 'delete namespace', lambda: command(
            ['delete', 'namespace', options.writer_namespace, '--ignore-not-found',
             '--wait=true', '--timeout=170s']), bound) and restored
    restored = restore_step(report, 'collector Running',
                            lambda: collector_running(cluster, options), bound) and restored
    left = [owner for owner in state.get('held') or [] if owner not in resumed]
    parts = []
    if resumed:
        parts.append('resumed and reconciled: ' + ', '.join(owner_label(o) for o in resumed))
    if failed:
        parts.append('NOT RESUMED, resume by hand: ' + ', '.join(owner_label(o) for o in failed))
    left = [owner for owner in left if owner not in failed]
    if left:
        parts.append('left suspended as found: ' + ', '.join(owner_label(o) for o in left))
    flux_line = (', Flux Kustomizations ' + '; '.join(parts)) if parts else ''
    print('RESTORE complete=%s store replicas=%s%s; writer cleanup and readiness checked'
          % (str(restored).lower(), state.get('replicas'), flux_line))


def main(argv=None):
    parser = argparse.ArgumentParser(description='WALK-LOGS-CRASH (ADR-016 L07)')
    common_arguments(parser)
    parser.add_argument('--collector-namespace', default='lifemodel-logs')
    parser.add_argument('--collector', default='logs-collector')
    parser.add_argument('--writer-namespace', default='lifemodel-logs-walk')
    parser.add_argument('--metrics-port', type=int, default=9598)
    parser.add_argument('--crictl', default='k3s crictl')
    parser.add_argument('--fill-bound', type=int, default=600)
    parser.add_argument('--fill-ceiling', type=int, default=SATURATION_CEILING)
    parser.add_argument('--recover-bound', type=int, default=300)
    parser.add_argument('--writer-pods', type=int, default=3)
    parser.add_argument('--writer-rate', type=float, default=1700)
    parser.add_argument('--max-load', type=float)
    parser.add_argument('--restore-bound', type=int, default=600)
    parser.add_argument('--memory-limit-bytes', type=int, default=300 * 1024 * 1024)
    parser.add_argument('--saturated-seconds', type=int, default=15)
    parser.add_argument('--unsaturated-lines', type=int, default=5000)
    parser.add_argument('--settle-seconds', type=int, default=60)
    parser.add_argument('--kustomization', default=DEFAULT_KUSTOMIZATION)
    parser.add_argument('--flux-namespace', default=DEFAULT_FLUX_NAMESPACE)
    options = parser.parse_args(argv)
    if (options.writer_pods < 1 or not 0 < options.writer_rate <= 1700
            or (options.max_load is not None and
                (not math.isfinite(options.max_load) or options.max_load <= 0))
            or options.restore_bound < 180
            or options.fill_bound < 60 or options.fill_ceiling < 60):
        parser.error('require writer-pods >= 1, 0 < writer-rate <= 1700, '
                     'finite max-load > 0, restore-bound >= 180, fill-bound >= 60 '
                     'and fill-ceiling >= 60')

    report = Report()
    try:
        baseline = node_load()
        cpus = os.cpu_count()
        if not math.isfinite(baseline) or baseline < 0:
            raise ValueError('invalid baseline')
        if not isinstance(cpus, int) or cpus <= 0:
            raise ValueError('invalid CPU count')
    except (OSError, ValueError, IndexError):
        report.not_valid('node load baseline or CPU count unavailable; writers not started')
        return report.result()
    if options.max_load is None:
        options.max_load = max(baseline + 2 * cpus, 4 * cpus)
    report.note('node load baseline %.2f; CPUs %d; load bound %.2f'
                % (baseline, cpus, options.max_load))
    cluster = Cluster(options.kubectl)
    state = {'created_namespace': False, 'replicas': None, 'run_id': None,
             'kustomizations': None, 'suspended': [], 'held': []}
    loader = None
    ran = False

    def stage():
        nonlocal loader
        try:
            secret = read_password(options.password_file)
        except WalkError as error:
            print('FAIL the credential file is readable - ' + str(error))
            return False
        loader = Loader(options.loader_host, options.loader_port, options.origin_host,
                        options.ca_file)
        status = loader.login(secret)
        if not report.check(status == 200, 'the loader logs in',
                            'POST /api/login answered %d' % status):
            return False
        return run(report, options, loader, cluster, state)

    stop_monitor = threading.Event()
    monitor = threading.Thread(target=watch_load, args=(report, options, stop_monitor), daemon=True)
    try:
        monitor.start()
        ran = stage()
    except BaseException as error:
        report.fail('the walk runs to its end', type(error).__name__)
    finally:
        stop_monitor.set()
        try:
            monitor.join()
        except BaseException:
            pass  # Restoration still owns the exit, including an interrupted join.
        try:
            restore(report, options, loader, cluster, state)
        except BaseException as error:
            report.fail('RESTORE interrupted; repair by hand', type(error).__name__)
    if ran is not True and report.failures == 0 and report.invalid == 0:
        report.not_valid('the walk reached none of its cases')
    return report.result()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('walk interrupted', file=sys.stderr)
        sys.exit(130)
