#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const historyFile = process.env.LIFEMODEL_HISTORY || '/var/lib/lifemodel/platform-history';
const kubeconfig = '/etc/rancher/k3s/k3s.yaml';
const kubectl = process.env.LIFEMODEL_KUBECTL;

function help() {
  console.log(`Usage: lifemodel doctor [--repin previous]
       lifemodel --help

Diagnose Flux sources, Kustomizations and the lifemodel loader.
  --repin previous  Restore the previous successfully applied platform ref and reconcile Flux.`);
}
function runKubectl(args) {
  try {
    const executable = kubectl || 'k3s';
    const prefix = kubectl ? [] : ['kubectl'];
    return execFileSync(executable, [...prefix, '--kubeconfig', kubeconfig, ...args], { encoding: 'utf8' });
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`kubectl ${args.join(' ')} failed: ${detail}`);
  }
}
function get(resource, namespace) {
  return JSON.parse(runKubectl(['get', resource, '-n', namespace, '-o', 'json']));
}
function condition(item) {
  return (item.status?.conditions || []).find((entry) => entry.type === 'Ready') || {};
}
function clean(value) { return String(value ?? 'unknown').replace(/[\r\n\t]+/g, ' ').trim() || 'unknown'; }
function checkResources(kind, items, revisionFor) {
  if (items.length === 0) {
    console.log(`${kind}: none found`);
    return [`${kind} (none found)`];
  }
  const failures = [];
  for (const item of items) {
    const name = item.metadata?.name || 'unnamed';
    const ready = condition(item);
    const revision = revisionFor(item);
    console.log(`${kind}/${name} Ready=${clean(ready.status)} reason=${clean(ready.reason)} message=${clean(ready.message)} revision=${clean(revision)}`);
    if (ready.status !== 'True') failures.push(`${kind}/${name}`);
  }
  return failures;
}
function report() {
  const failures = [];
  for (const [resource, kind, revision] of [
    ['ocirepositories', 'OCIRepository', (item) => item.status?.artifact?.revision],
    ['gitrepositories', 'GitRepository', (item) => item.status?.artifact?.revision],
  ]) {
    const items = get(resource, 'flux-system').items || [];
    if (kind === 'GitRepository' && items.length === 0) {
      console.log('GitRepository: none (expected before the first start)');
    } else {
      failures.push(...checkResources(kind, items, revision));
    }
  }
  const kustomizations = get('kustomizations', 'flux-system').items || [];
  failures.push(...checkResources('Kustomization', kustomizations, (item) => item.status?.lastAppliedRevision));

  const deployments = get('deployments', 'lifemodel-system').items || [];
  const loader = deployments.find((item) => item.metadata?.name === 'loader');
  const pods = (get('pods', 'lifemodel-system').items || []).filter((pod) =>
    pod.metadata?.labels?.['app.kubernetes.io/name'] === 'loader' || pod.metadata?.labels?.app === 'loader' || pod.metadata?.name?.startsWith('loader-'));
  const statuses = pods.flatMap((pod) => pod.status?.containerStatuses || []);
  const desiredReplicas = loader?.spec?.replicas ?? 1;
  const ready = Boolean(loader && (loader.status?.readyReplicas || 0) >= desiredReplicas && pods.length >= desiredReplicas &&
    pods.every((pod) => pod.status?.phase === 'Running' && (pod.status?.containerStatuses || []).length > 0 &&
      (pod.status?.containerStatuses || []).every((entry) => entry.ready)));
  const restarts = statuses.reduce((sum, entry) => sum + (entry.restartCount || 0), 0);
  const allEvents = get('events', 'lifemodel-system').items || [];
  const eventTime = (event) => Date.parse(event.eventTime || event.lastTimestamp || event.metadata?.creationTimestamp || 0);
  for (const pod of pods) {
    const podStatuses = pod.status?.containerStatuses || [];
    const podReady = pod.status?.phase === 'Running' && podStatuses.length > 0 && podStatuses.every((entry) => entry.ready);
    const podEvents = allEvents.filter((event) => event.involvedObject?.name === pod.metadata?.name).sort((a, b) => eventTime(a) - eventTime(b));
    const podRestarts = podStatuses.reduce((sum, entry) => sum + (entry.restartCount || 0), 0);
    console.log(`Pod/${clean(pod.metadata?.name)} phase=${clean(pod.status?.phase)} ready=${podReady ? 'yes' : 'no'} restarts=${podRestarts} lastEventReason=${clean(podEvents.at(-1)?.reason || 'none')}`);
  }
  const events = allEvents.filter((event) => pods.some((pod) => event.involvedObject?.name === pod.metadata?.name)).sort((a, b) => eventTime(a) - eventTime(b));
  const lastReason = events.at(-1)?.reason || 'none';
  console.log(`Deployment/loader ready=${ready ? 'yes' : 'no'} restarts=${restarts} lastEventReason=${clean(lastReason)}`);
  if (!ready) failures.push('Deployment/loader');
  if (failures.length) {
    console.error(`Not ready: ${failures.join(', ')}`);
    return 1;
  }
  return 0;
}
function readHistory() {
  if (!existsSync(historyFile)) return [];
  return readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 2);
}
function writeHistory(ref) {
  if (!/^(tag|digest)=.+$/.test(ref) || /[\r\n]/.test(ref)) throw new Error('Applied platform ref must be tag=<value> or digest=<value>');
  const history = [ref, ...readHistory().filter((entry) => entry !== ref)].slice(0, 2);
  mkdirSync(dirname(historyFile), { recursive: true, mode: 0o700 });
  const temporary = `${historyFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${history.join('\n')}\n`, { mode: 0o600 });
  renameSync(temporary, historyFile);
}
function repinPrevious() {
  const previous = readHistory()[1];
  if (!previous) throw new Error('No previous platform release is recorded; a second successful apply is needed before re-pinning.');
  const split = previous.indexOf('=');
  const field = previous.slice(0, split);
  const value = previous.slice(split + 1);
  const ref = { [field]: value };
  runKubectl(['patch', 'ocirepository', 'platform', '-n', 'flux-system', '--type=merge', '-p', JSON.stringify({ spec: { ref } })]);
  runKubectl(['annotate', 'ocirepository', 'platform', '-n', 'flux-system', `reconcile.fluxcd.io/requestedAt=${Date.now()}`, '--overwrite']);
  console.log(`Re-pinned platform to ${previous} and requested Flux reconciliation.`);
  if (field === 'digest') console.log(`To keep this after nixos-rebuild switch, set services.lifemodel.platform.digest = ${JSON.stringify(value)}; and remove services.lifemodel.platform.tag.`);
  else console.log(`To keep this after nixos-rebuild switch, set services.lifemodel.platform.tag = ${JSON.stringify(value)}; and set services.lifemodel.platform.digest = null.`);
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { help(); process.exit(0); }
  if (args.length === 2 && args[0] === 'record-applied') { writeHistory(args[1]); process.exit(0); }
  if (args.length === 1 && args[0] === 'doctor') process.exit(report());
  if (args.length === 3 && args[0] === 'doctor' && args[1] === '--repin' && args[2] === 'previous') { repinPrevious(); process.exit(0); }
  if (args.length === 0) { help(); process.exit(0); }
  throw new Error(`Unknown command or option: ${args.join(' ')}`);
} catch (error) {
  console.error(`lifemodel doctor: ${error.message}`);
  process.exit(1);
}
