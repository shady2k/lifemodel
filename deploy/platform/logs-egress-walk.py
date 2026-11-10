#!/usr/bin/env python3
"""WALK-LOGS-EGRESS — ADR-016 §7, §8, L10, run as root on vm-lifemodel.

Policy reachability is not confinement: ANY TCP 6443 is allowed, and cluster
DNS can forward questions off-node. Separately observe real workload connections
for 600 seconds of operator-provided normal work. No policy is changed. conntrack
and tcpdump must be installed on the node; missing/lost evidence makes TEST NOT VALID.
Usage: sudo python3 deploy/platform/logs-egress-walk.py
Requires deployed logs-evictor (its Node image runs all three temporary pods).
The operator supplies ordinary application work throughout the stated window;
there is no policy removal, payload capture, Secret read, or synthetic workload
in that window. A successful run is evidence for that window, not future work.
"""
import argparse
import ipaddress
import json
import re
import subprocess
import tempfile
import time
import uuid
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from logs_walk_support import Cluster, Report, WalkError, wait_until

OBSERVATION_SECONDS = 600
POLICY_SETTLE_SECONDS = 5  # kube-router normally installs rules in about one second.
CONNECT = r"""
const net=require('net'), dns=require('dns');
const [host,port,protocol]=process.argv.slice(1);
const finish=(ok)=>{console.log(ok?'REACHABLE':'UNREACHABLE');process.exit(0)};
const timer=setTimeout(()=>finish(false),4000);
if(protocol==='udp') {
  const resolver=new dns.Resolver({timeout:3000,tries:1});
  resolver.setServers([host]);
  resolver.resolve4('kubernetes.default.svc.cluster.local',(error)=>{
    clearTimeout(timer);finish(!error||['ENOTFOUND','EREFUSED','ESERVFAIL','ENODATA','EFORMERR','ENOTIMP'].includes(error.code));
  });
} else {
  const socket=net.connect(Number(port),host,()=>{socket.destroy();finish(true)});
  socket.on('error',()=>finish(false));
}
"""
LISTEN = "const net=require('net'); for(const p of [443,6443,8080]) net.createServer(s=>s.end()).listen(p,'0.0.0.0');"


def check_matrix(report, connect, targets):
    for target in targets:
        if not target['open']:
            witness = connect('witness', target)
            if witness is not True:
                report.not_valid('witness cannot reach ' + target['name'])
                continue
        reached = connect('probe', target)
        if reached is None:
            report.not_valid('probe command unavailable for ' + target['name'])
        else:
            report.check(reached == target['open'], target['name'] +
                         (' is open' if target['open'] else ' is refused'))


def check_observation(report, text, collector_ips, store_ips, permitted):
    """Inspect ORIGINAL conntrack tuples only: reverse tuples are server replies."""
    seen = 0
    malformed = False
    unexpected = set()
    peers = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        source = re.search(r'\bsrc=(\S+)', line)
        if source and source.group(1) not in collector_ips | store_ips:
            continue
        proto = re.search(r'\b(tcp|udp)\s+\d+\s+', line)
        tuples = re.search(r'\bsrc=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)', line)
        groups = re.findall(r'\bsrc=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)', line)
        if not proto or not tuples or len(groups) != 2:
            malformed = True
            continue
        src, dst, _sport, port = tuples.groups()
        if src in collector_ips:
            seen += 1
            peers.add((proto.group(1), dst, port))
            if (proto.group(1), dst, int(port)) not in permitted:
                unexpected.add((proto.group(1), dst, port))
        elif src in store_ips:
            unexpected.add((proto.group(1), dst, port))
    if malformed:
        report.not_valid('connection observation contains unparsed records')
    if not seen:
        report.not_valid('no collector connections observed during normal work')
    report.check(not unexpected, 'normal-work collector and store use only permitted peers',
                 '%d unexpected destinations' % len(unexpected))
    for protocol, destination, port in sorted(peers | unexpected):
        try:
            address = str(ipaddress.ip_address(destination))
        except ValueError:
            report.not_valid('non-numeric connection destination')
            continue
        report.note('Observed destination %s %s:%s' % (protocol, address, port))
    report.note('Observed connections only, not an exfiltration barrier: TCP 6443 to any '
                'address and cluster DNS remain possible channels.')


def pod_manifest(namespace, name, image, labels, listener=False):
    return {'apiVersion': 'v1', 'kind': 'Pod',
            'metadata': {'namespace': namespace, 'name': name, 'labels': labels},
            'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                     'securityContext': {'sysctls': [{'name': 'net.ipv4.ip_unprivileged_port_start', 'value': '0'}],
                                         'runAsNonRoot': True, 'runAsUser': 1000,
                                         'seccompProfile': {'type': 'RuntimeDefault'}},
                     'containers': [{'name': 'walk', 'image': image,
                                     'command': ['node', '-e', LISTEN if listener else
                                                 'setInterval(()=>{},60000)'],
                                     'securityContext': {'readOnlyRootFilesystem': True,
                                                         'allowPrivilegeEscalation': False,
                                                         'capabilities': {'drop': ['ALL']}}}]}}


def required(body, code):
    if not body:
        raise WalkError(code)
    return body


def addresses(pods):
    return {entry['ip'] for pod in pods for entry in pod.get('status', {}).get('podIPs', [])}


def workloads(cluster, namespace, selector):
    pods = cluster.pods(namespace, selector)
    if not pods or any(not pod.get('status', {}).get('podIPs') for pod in pods):
        raise WalkError('workload_addresses_unavailable')
    return pods


def check_packets(report, packet_text, connection_text, collector_ips, store_ips):
    """Quiet tcpdump prints numeric headers, never DNS names or log payloads.

    Conntrack ORIGINAL or reverse(REPLY) identifies initiated traffic across NAT;
    REPLY or reverse(ORIGINAL) identifies server replies. Unknown direction is not
    proof. Connection destinations are judged separately by check_observation.
    """
    forward, replies = set(), set()
    for line in connection_text.splitlines():
        protocol = re.search(r'\b(tcp|udp)\s+\d+\s+', line)
        tuples = re.findall(r'\bsrc=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)', line)
        if not protocol or len(tuples) != 2:
            continue
        original, reply = tuples
        def key(item):
            src, dst, sport, dport = item
            return protocol.group(1), src, sport, dst, dport
        def reverse(item):
            src, dst, sport, dport = item
            return dst, src, dport, sport
        forward.update((key(original), key(reverse(reply))))
        replies.update((key(reply), key(reverse(original))))
    active = False
    invalid = False
    unexpected_store = False
    packets = 0
    for line in packet_text.splitlines():
        if not line.strip():
            continue
        match = re.search(r'\bIP (\d+\.\d+\.\d+\.\d+)\.(\d+) > '
                          r'(\d+\.\d+\.\d+\.\d+)\.(\d+): (tcp|UDP)\b', line)
        if not match:
            invalid = True  # includes unsupported IPv6/ICMP, never silently discard
            continue
        src, sport, dst, dport, protocol = match.groups()
        packet = protocol.lower(), src, sport, dst, dport
        packets += 1
        if packet in forward:
            active |= src in collector_ips
            unexpected_store |= src in store_ips
        elif packet not in replies:
            invalid = True
    if invalid:
        report.not_valid('packet direction or protocol could not be attributed')
    if not active:
        report.not_valid('no actual collector traffic in normal-work window')
    report.check(not unexpected_store, 'store sends replies only, no initiated traffic')
    report.note('Normal-work numeric packet headers observed: %d' % packets)


def network_snapshot(cluster, options):
    """Pin the live peer mappings and additive policies, without printing objects."""
    objects = []
    for namespace, resource, name in [
            (options.collector_namespace, 'networkpolicies', None),
            (options.namespace, 'networkpolicies', None),
            ('kube-system', 'service', 'kube-dns'),
            ('default', 'service', 'kubernetes'),
            ('default', 'endpoints', 'kubernetes'),
            (options.namespace, 'service', 'logs-store')]:
        args = ['-n', namespace, 'get', resource] + ([name] if name else []) + ['-o', 'json']
        body = required(cluster.json(args), 'network_snapshot_unavailable')
        entries = body.get('items', [body])
        objects.append([(entry.get('metadata', {}).get('uid'), entry.get('spec'),
                         entry.get('subsets')) for entry in entries])
    objects.append(sorted(addresses(workloads(cluster, 'kube-system', 'k8s-app=kube-dns'))))
    return objects


def observe(report, cluster, options, collector, store, permitted):
    report.note('Normal-work observation window: %d seconds. Keep normal work running; '
                'no synthetic probes run in this window.' % options.observation_seconds)
    network_before = network_snapshot(cluster, options)
    before = {(pod['metadata']['uid'], tuple(sorted(addresses([pod]))))
              for pod in collector + store}
    # A baseline includes long-lived connections; events include short-lived ones.
    # Files hold metadata only, not payloads, and are removed even after interruption.
    with tempfile.TemporaryFile(mode='w+') as output, tempfile.TemporaryFile(mode='w+') as errors, \
            tempfile.TemporaryFile(mode='w+') as packets, tempfile.TemporaryFile(mode='w+') as capture_errors:
        try:
            process = subprocess.Popen(['conntrack', '-E', '-o', 'extended'],
                                       stdout=output, stderr=errors, text=True)
        except OSError:
            raise WalkError('conntrack_unavailable') from None
        capture = None
        try:
            hosts = ' or '.join('host ' + str(ipaddress.ip_address(ip))
                                for ip in sorted(addresses(collector) | addresses(store)))
            capture = subprocess.Popen(['tcpdump', '-i', 'any', '-nn', '-q', '-l', '-s', '96',
                                        '-c', '1000000', hosts], stdout=packets,
                                       stderr=capture_errors, text=True)
            time.sleep(1)
            baseline = subprocess.run(['conntrack', '-L', '-o', 'extended'],
                                      capture_output=True, text=True, timeout=30)
            if baseline.returncode != 0 or process.poll() is not None or capture.poll() is not None:
                raise WalkError('conntrack_capture_unavailable')
            time.sleep(options.observation_seconds)
            if process.poll() is not None or capture.poll() is not None:
                raise WalkError('connection_capture_stopped')
            final = subprocess.run(['conntrack', '-L', '-o', 'extended'],
                                   capture_output=True, text=True, timeout=30)
            if final.returncode:
                raise WalkError('conntrack_final_unavailable')
        finally:
            if capture is not None:
                capture.send_signal(2)
                try:
                    capture.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    capture.kill()
                    capture.wait()
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        errors.seek(0)
        error_text = errors.read()
        if any(line.strip() and not re.fullmatch(r'conntrack v[^:]+: \d+ flow events have been shown\.', line.strip())
               for line in error_text.splitlines()):
            raise WalkError('conntrack_evidence_lost')
        output.seek(0)
        evidence = baseline.stdout + '\n' + output.read() + '\n' + final.stdout
        capture_errors.seek(0)
        capture_status = capture_errors.read()
        if capture.returncode not in (0, -2) or not re.search(r'\b0 packets dropped by kernel', capture_status):
            raise WalkError('packet_capture_incomplete')
        packets.seek(0)
        packet_text = packets.read()
    fresh_collector = workloads(cluster, options.collector_namespace,
                                'app.kubernetes.io/name=logs-collector')
    fresh_store = workloads(cluster, options.namespace, 'app.kubernetes.io/name=logs-store')
    if before != {(pod['metadata']['uid'], tuple(sorted(addresses([pod]))))
                  for pod in fresh_collector + fresh_store}:
        raise WalkError('workloads_changed_during_observation')
    if network_before != network_snapshot(cluster, options):
        raise WalkError('network_changed_during_observation')
    check_observation(report, evidence, addresses(collector), addresses(store), permitted)
    check_packets(report, packet_text, evidence, addresses(collector), addresses(store))


def run(report, cluster, options):
    token = uuid.uuid4().hex[:10]
    temporary = 'walk-logs-egress-' + token
    probe = 'walk-egress-' + token
    made_namespace = False
    made_probe = False
    try:
        collector = workloads(cluster, options.collector_namespace,
                              'app.kubernetes.io/name=logs-collector')
        store = workloads(cluster, options.namespace, 'app.kubernetes.io/name=logs-store')
        nodes = required(cluster.json(['get', 'nodes', '-o', 'json']), 'nodes_unavailable')
        node_ips = {address['address'] for node in nodes['items']
                    if node['metadata']['name'] == options.node
                    for address in node.get('status', {}).get('addresses', [])
                    if address['type'] == 'InternalIP'}
        endpoints = required(cluster.json(['-n', 'default', 'get', 'endpoints', 'kubernetes',
                                            '-o', 'json']), 'api_endpoints_unavailable')
        api_peers = {(address['ip'], port['port']) for subset in endpoints.get('subsets', [])
                     for address in subset.get('addresses', []) for port in subset.get('ports', [])
                     if port.get('protocol', 'TCP') == 'TCP'}
        if not api_peers or not node_ips:
            raise WalkError('api_or_node_addresses_unavailable')
        if any(pod['spec']['nodeName'] != options.node for pod in collector + store):
            raise WalkError('workloads_not_on_observed_node')
        # Ensure this command really runs on the workload node, not an operator laptop.
        local = subprocess.run(['ip', '-j', 'address'], capture_output=True, text=True, timeout=10)
        if local.returncode or not node_ips.intersection(
                {a['local'] for link in json.loads(local.stdout) for a in link.get('addr_info', [])}):
            raise WalkError('capture_not_on_node')
        cron = required(cluster.json(['-n', options.namespace, 'get', 'cronjob',
                                      'logs-evictor', '-o', 'json']), 'node_image_unavailable')
        image = cron['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]['image']
        dns = required(cluster.json(['-n', 'kube-system', 'get', 'service', 'kube-dns', '-o', 'json']),
                       'dns_service_unavailable')['spec']['clusterIP']
        api = required(cluster.json(['-n', 'default', 'get', 'service', 'kubernetes', '-o', 'json']),
                       'api_service_unavailable')['spec']['clusterIP']
        store_service = required(cluster.json(['-n', options.namespace, 'get', 'service',
                                               'logs-store', '-o', 'json']),
                                 'store_service_unavailable')['spec']['clusterIP']
        dns_pods = workloads(cluster, 'kube-system', 'k8s-app=kube-dns')
        made_namespace = True  # cleanup even if apply timed out after creation
        if cluster.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {
                'name': temporary, 'labels': {'pod-security.kubernetes.io/enforce': 'restricted'}}}).returncode:
            raise WalkError('namespace_create_failed')
        for name, listener in [('witness', False), ('listener', True)]:
            fixture = pod_manifest(temporary, name, image, {}, listener)
            fixture['spec']['nodeName'] = options.node
            if cluster.apply(fixture).returncode:
                raise WalkError('fixture_create_failed')
        made_probe = True
        manifest = pod_manifest(options.collector_namespace, probe, image,
                                collector[0]['metadata']['labels'])
        manifest['spec']['nodeName'] = options.node
        manifest['metadata']['ownerReferences'] = [{
            'apiVersion': 'v1', 'kind': 'Pod', 'name': collector[0]['metadata']['name'],
            'uid': collector[0]['metadata']['uid'], 'controller': True}]
        if cluster.apply(manifest).returncode:
            raise WalkError('probe_create_failed')
        if not wait_until(time.monotonic() + 180, 2, lambda: all([
                cluster.is_ready(temporary, 'witness'), cluster.is_ready(temporary, 'listener'),
                cluster.is_ready(options.collector_namespace, probe)])):
            raise WalkError('fixture_not_ready')
        time.sleep(POLICY_SETTLE_SECONDS)
        foreign = cluster.pod(temporary, 'listener')['status']['podIP']
        targets = []
        def target(name, host, port, opened, protocol='tcp'):
            targets.append({'name': name, 'host': host, 'port': port,
                            'open': opened, 'protocol': protocol})
        target('store 9428', sorted(addresses(store))[0], 9428, True)
        target('cluster DNS UDP 53', dns, 53, True, 'udp')
        target('cluster DNS TCP 53', dns, 53, True)
        target('API Service 443', api, 443, True)
        target('node 6443', sorted(node_ips)[0], 6443, True)
        target('foreign pod 6443', foreign, 6443, True)
        target('foreign pod 8080', foreign, 8080, False)
        target('foreign pod 443', foreign, 443, False)
        target('public resolver 53', options.public_resolver, 53, False, 'udp')
        target('public resolver TCP 53', options.public_resolver, 53, False)
        target('public host 443', options.public_host, 443, False)
        def connect(role, destination):
            namespace, name = ((options.collector_namespace, probe) if role == 'probe'
                               else (temporary, 'witness'))
            result = cluster.run(['-n', namespace, 'exec', name, '--', 'node', '-e', CONNECT,
                                  destination['host'], str(destination['port']),
                                  destination['protocol']], timeout=15)
            if result.returncode != 0:
                return None
            outcome = result.stdout.strip()
            return {'REACHABLE': True, 'UNREACHABLE': False}.get(outcome)
        check_matrix(report, connect, targets)
        # Delete synthetic traffic sources BEFORE observing genuine normal work.
        if not cluster.ok(['-n', options.collector_namespace, 'delete', 'pod', probe, '--wait=true']):
            raise WalkError('probe_cleanup_failed')
        made_probe = False
        if not cluster.ok(['delete', 'namespace', temporary, '--wait=true'], timeout=180):
            raise WalkError('fixture_cleanup_failed')
        made_namespace = False
        permitted = {('tcp', address, 9428) for address in addresses(store) | {store_service}}
        permitted |= {(protocol, address, 53) for address in addresses(dns_pods) | {dns}
                      for protocol in ('tcp', 'udp')}
        permitted |= {('tcp', address, port) for address, port in api_peers}
        permitted.add(('tcp', api, 443))
        observe(report, cluster, options, collector, store, permitted)
    finally:
        report.note('RESTORE: remove every walk pod, listener and temporary namespace')
        if made_probe:
            report.check(cluster.ok(['-n', options.collector_namespace, 'delete', 'pod', probe,
                                     '--ignore-not-found', '--wait=true']), 'RESTORE probe removed')
        if made_namespace:
            report.check(cluster.ok(['delete', 'namespace', temporary, '--ignore-not-found',
                                     '--wait=true'], timeout=180), 'RESTORE namespace and listeners removed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kubectl', default='k3s kubectl')
    parser.add_argument('--namespace', default='lifemodel-system')
    parser.add_argument('--collector-namespace', default='lifemodel-logs')
    parser.add_argument('--node', default='vm-lifemodel')
    parser.add_argument('--observation-seconds', type=int, default=OBSERVATION_SECONDS)
    parser.add_argument('--public-resolver', default='1.1.1.1')
    parser.add_argument('--public-host', default='1.1.1.1')
    options = parser.parse_args()
    if options.observation_seconds < OBSERVATION_SECONDS:
        parser.error('normal-work observation must last at least 600 seconds')
    for value in (options.public_resolver, options.public_host):
        if not ipaddress.ip_address(value).is_global:
            parser.error('public destinations must be global IP addresses')
    report = Report()
    report.note('WALK-LOGS-EGRESS: policy reachability and normal-work observation are separate')
    try:
        run(report, Cluster(options.kubectl), options)
    except (WalkError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        report.not_valid(str(error) if isinstance(error, WalkError) else type(error).__name__)
    return report.result()


if __name__ == '__main__':
    raise SystemExit(main())
