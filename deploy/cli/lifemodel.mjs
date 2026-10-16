#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

const stateDir = process.env.LIFEMODEL_STATE_DIR || '/var/lib/lifemodel';
const historyFile = process.env.LIFEMODEL_HISTORY || `${stateDir}/platform-history`;
const overrideFile = `${stateDir}/platform-override`;
const kubeconfig = '/etc/rancher/k3s/k3s.yaml';
const kubectl = (process.env.LIFEMODEL_KUBECTL || `k3s kubectl --kubeconfig ${kubeconfig}`).split(' ');
const script = fileURLToPath(import.meta.url);
const validRef = /^(?:tag=[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|digest=sha256:[a-f0-9]{64})$/;
function help() {
  console.log(`Usage: lifemodel doctor [--repin previous|clear]
       lifemodel --help

Diagnose Flux sources, Kustomizations, the lifemodel loader and core.
  --repin previous  Persist an override to the previous successfully applied ref and rerun bootstrap.
  --repin clear     Remove the override and rerun bootstrap.`);
}
function runKubectl(args, input) {
  try { return execFileSync(kubectl[0], [...kubectl.slice(1), ...args], { encoding: 'utf8', input }); }
  catch (error) { throw new Error(`kubectl ${args.join(' ')} failed: ${error?.stderr?.toString().trim() || error?.message || String(error)}`); }
}
function get(resource, namespace, name) { return JSON.parse(runKubectl(['get', resource, ...(name ? [name] : []), '-n', namespace, '-o', 'json'])); }
function getOptional(resource, namespace, name) {
  try { return get(resource, namespace, name); }
  catch (error) {
    if (/not found/i.test(error.message)) return null;
    throw error;
  }
}
function condition(item) { return (item.status?.conditions || []).find((entry) => entry.type === 'Ready') || {}; }
function clean(value) { return String(value ?? 'unknown').replace(/[\r\n\t]+/g, ' ').trim() || 'unknown'; }
function current(item) { return item.metadata?.generation != null && item.status?.observedGeneration === item.metadata.generation; }
function checkResources(kind, items, revisionFor) {
  if (!items.length) { console.log(`${kind}: none found`); return [`${kind} (none found)`]; }
  const failures = [];
  for (const item of items) {
    const name = item.metadata?.name || 'unnamed', ready = condition(item), revision = revisionFor(item);
    const generation = current(item);
    console.log(`${kind}/${name} Ready=${clean(ready.status)} generationCurrent=${generation ? 'yes' : 'no'} reason=${clean(ready.reason)} message=${clean(ready.message)} revision=${clean(revision)}`);
    if (ready.status !== 'True' || !generation) failures.push(`${kind}/${name}`);
  }
  return failures;
}
function readOverride() {
  if (!existsSync(overrideFile)) return null;
  const value = JSON.parse(readFileSync(overrideFile, 'utf8'));
  if (!value || !validRef.test(value.ref) || !validRef.test(value.configuredRef)) throw new Error('Corrupt platform override; refusing action.');
  return value;
}
function assertRootOwnership() {
  let root;
  try { root=JSON.parse(runKubectl(['get','ocirepository','platform','-n','flux-system','-o','json','--show-managed-fields'])); }
  catch(error) { if(/not found/i.test(error.message)) return; throw error; }
  const owned = (root.metadata?.managedFields || []).filter(entry => entry.manager !== 'lifemodel-bootstrap' && entry.fieldsV1?.['f:spec']?.['f:ref']).map(entry => clean(entry.manager));
  if(owned.length) throw new Error(`Root OCIRepository spec.ref is owned by ${[...new Set(owned)].join(', ')}. To reset ownership, delete the root object and let the writer recreate it: sudo kubectl --kubeconfig ${kubeconfig} delete ocirepository platform -n flux-system (Flux keeps its applied state).`);
}
function reportPki() {
  const volume = process.env.LIFEMODEL_LOADER_VOLUME || '/var/lib/loader';
  let identity = null, ca = null;
  try { identity = JSON.parse(readFileSync(`${volume}/instance.json`, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') console.log('PKI identity: invalid'); }
  try { ca = readFileSync(`${volume}/pki/ca.crt`, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') console.log('PKI CA: unreadable'); }
  let fingerprint = null, matching = false;
  if (ca) { try { fingerprint = execFileSync('openssl', ['x509', '-in', `${volume}/pki/ca.crt`, '-noout', '-fingerprint', '-sha256'], { encoding:'utf8' }).trim().replace(/^sha256 Fingerprint=/i,'').replaceAll(':','').toLowerCase(); matching = Boolean(identity && identity.version === 1 && identity.fingerprint === fingerprint); } catch { /* malformed CA is reported below */ } }
  console.log(`PKI identity=${identity ? 'present' : 'missing'} CA=${!ca ? 'missing' : matching ? 'present-matching' : 'mismatch-or-invalid'} fingerprint=${fingerprint || 'unknown'}`);
  if (identity && !ca) console.log('PKI leaf=unknown (CA missing with identity; do not regenerate)');
  try {
    const secret = JSON.parse(runKubectl(['get','secret','lifemodel-tls','-n','lifemodel-system','-o','json']));
    const cert = Buffer.from(secret.data?.['tls.crt'] || '', 'base64').toString();
    if (!cert) { console.log('PKI leaf=missing SANs=none'); return; }
    const decoded = execFileSync('openssl', ['x509','-in','/dev/stdin','-noout','-enddate','-ext','subjectAltName'], { input:cert, encoding:'utf8' });
    const expiry = decoded.match(/notAfter=(.+)/)?.[1] || 'unknown';
    const expiryMs=Date.parse(expiry), leafState=!Number.isFinite(expiryMs)?'invalid':expiryMs-Date.now()<=30*24*60*60*1000?'expiring':'valid';
    const sans = decoded.match(/DNS:[^,\s]+/g)?.map(value=>value.slice(4)) || [];
    console.log(`PKI leaf=${leafState} notAfter=${clean(expiry)} SANs=${sans.join(',') || 'none'}`);
  } catch (error) { console.log(`PKI leaf=unavailable (${clean(error?.message)})`); }
}

function reportOpenBao(failures) {
  let status;
  try { status = JSON.parse(execFileSync(kubectl[0], [...kubectl.slice(1), 'exec', '-n', 'openbao', 'openbao-0', '--', 'bao', 'status', '-format=json'], { encoding: 'utf8' })); }
  catch (error) {
    if (error?.status === 2 && error.stdout) {
      try { status = JSON.parse(error.stdout.toString()); }
      catch { failures.push('OpenBao status (invalid JSON)'); }
    } else failures.push('OpenBao status (unavailable)');
  }
  if (!status) return;
  if (typeof status.initialized !== 'boolean' || typeof status.sealed !== 'boolean') {
    failures.push('OpenBao status (missing initialized/sealed fields)');
    return;
  }
  if (!status.initialized) {
    console.log('OpenBao: uninitialised sealed=unknown');
    failures.push('OpenBao (uninitialised)');
  } else {
    const sealed = status.sealed === true;
    console.log(`OpenBao: initialized=yes sealed=${sealed ? 'yes' : 'no'}`);
    if (sealed) failures.push('OpenBao (sealed)');
  }
}
function reportCpuRequirement() {
  const cpuinfoPath = process.env.LIFEMODEL_CPUINFO || '/proc/cpuinfo';
  const cpuinfo = readFileSync(cpuinfoPath, 'utf8');
  const flagSets = [...cpuinfo.matchAll(/^flags\s*:\s*(.*)$/gm)].map(match => new Set(match[1].split(/\s+/)));
  const supported = flagSets.length > 0 && flagSets.every(flags => flags.has('sse4_2') && flags.has('popcnt'));
  if (!supported) console.warn('WARNING: CPU lacks x86-64-v2 flags (sse4_2, popcnt); the core image memory search may fail to load. Use x86-64-v2 or newer; for VMs set the vCPU type to host or an x86-64-v2 model.');
}
function report() {
  reportCpuRequirement();
  reportPki();
  const override = readOverride();
  if (override) console.log(`ACTIVE PLATFORM OVERRIDE: ${override.ref} (recorded against ${override.configuredRef})`);
  const failures = [];
  reportOpenBao(failures);
  for (const [resource, kind, revision] of [['ocirepositories','OCIRepository',i=>i.status?.artifact?.revision],['gitrepositories','GitRepository',i=>i.status?.artifact?.revision]]) {
    const items = get(resource, 'flux-system').items || [];
    if (kind === 'GitRepository' && !items.length) console.log('GitRepository: none (expected before the first loader start)');
    else failures.push(...checkResources(kind, items, revision));
  }
  failures.push(...checkResources('Kustomization', get('kustomizations','flux-system').items || [], i=>i.status?.lastAppliedRevision));
  const bootstrap = get('secrets', 'lifemodel-system', 'loader-bootstrap-state');
  let phaseRecord;
  let applicationResourcesRequired = false;
  let phaseLabel = 'not started';
  if (bootstrap.data?.phase === undefined) {
    console.log('Loader first start not started');
  } else {
    try { phaseRecord = JSON.parse(Buffer.from(bootstrap.data.phase, 'base64').toString('utf8')); }
    catch { phaseRecord = null; }
    const validPhase = phaseRecord && typeof phaseRecord.phase === 'string' && phaseRecord.phase.trim() && ['running', 'complete', 'failed'].includes(phaseRecord.status);
    if (!validPhase) {
      console.log('Loader first start phase record invalid');
      failures.push('Secret loader-bootstrap-state (invalid phase record)');
      applicationResourcesRequired = true;
      phaseLabel = 'phase record invalid';
    } else {
      phaseLabel = clean(phaseRecord.phase);
      console.log(`Loader first start phase=${phaseLabel} status=${clean(phaseRecord.status)}`);
      const finalPhaseComplete = phaseRecord.phase === 'gitea-application-kustomizations' && phaseRecord.status === 'complete';
      if (phaseRecord.status === 'failed') {
        failures.push(`Loader bootstrap phase ${phaseLabel} (failed)`);
        applicationResourcesRequired = true;
      } else if (finalPhaseComplete) {
        applicationResourcesRequired = true;
      } else {
        console.log(`Loader first start in progress at ${phaseLabel} (status=${clean(phaseRecord.status)})`);
      }
    }
  }
  const appChecks = [
    ['GitRepository', 'lifemodel', 'lifemodel'],
    ['GitRepository', 'lifemodel-motor', 'lifemodel-motor'],
    ['Kustomization', 'lifemodel', 'lifemodel'],
    ['Kustomization', 'lifemodel-motor', 'lifemodel-motor'],
  ];
  for (const [kind, namespace, name] of appChecks) {
    const resource = kind === 'GitRepository' ? 'gitrepositories' : 'kustomizations';
    const item = (get(resource, namespace).items || []).find(i => i.metadata?.name === name);
    if (!item) {
      if (applicationResourcesRequired) failures.push(`${kind}/${namespace}/${name} (missing)`);
      else console.log(`${kind}/${namespace}/${name}: missing (expected; first start ${phaseLabel === 'not started' ? 'not started' : `in progress at ${phaseLabel}`})`);
      continue;
    }
    const ready = condition(item), generation = current(item);
    console.log(`${kind}/${namespace}/${name} Ready=${clean(ready.status)} generationCurrent=${generation ? 'yes' : 'no'} reason=${clean(ready.reason)} message=${clean(ready.message)}`);
    if (ready.status !== 'True' || !generation) failures.push(`${kind}/${namespace}/${name}`);
  }
  const giteaDeployments = get('deployments', 'lifemodel-git').items || [];
  const gitea = giteaDeployments.find(i => i.metadata?.name === 'gitea');
  const giteaDesired = gitea?.spec?.replicas ?? 1;
  const giteaReady = Boolean(gitea && current(gitea) && giteaDesired > 0 && (gitea.status?.readyReplicas || 0) >= giteaDesired);
  console.log(`Deployment/gitea ready=${giteaReady ? 'yes' : 'no'} generationCurrent=${gitea && current(gitea) ? 'yes' : 'no'} desiredReplicas=${giteaDesired}`);
  if (!giteaReady) failures.push('Deployment/gitea');
  const deployments = get('deployments','lifemodel-system').items || [], loader = deployments.find(i=>i.metadata?.name==='loader');
  const pods = (get('pods','lifemodel-system').items || []).filter(p=>p.metadata?.labels?.['app.kubernetes.io/name']==='loader'||p.metadata?.labels?.app==='loader'||p.metadata?.name?.startsWith('loader-'));
  const statuses = pods.flatMap(p=>p.status?.containerStatuses||[]), desired = loader?.spec?.replicas ?? 1;
  const generation = Boolean(loader && current(loader));
  const ready = Boolean(loader && generation && desired > 0 && (loader.status?.readyReplicas||0)>0 && (loader.status?.readyReplicas||0)>=desired && pods.length>0 && pods.length>=desired && pods.every(p=>p.status?.phase==='Running'&&(p.status?.containerStatuses||[]).length>0&&(p.status?.containerStatuses||[]).every(c=>c.ready)));
  const restarts=statuses.reduce((n,s)=>n+(s.restartCount||0),0), allEvents=get('events','lifemodel-system').items||[];
  const eventTime=e=>Date.parse(e.eventTime||e.lastTimestamp||e.metadata?.creationTimestamp||0);
  for (const pod of pods) { const ps=pod.status?.containerStatuses||[], ok=pod.status?.phase==='Running'&&ps.length>0&&ps.every(s=>s.ready); const ev=allEvents.filter(e=>e.involvedObject?.name===pod.metadata?.name).sort((a,b)=>eventTime(a)-eventTime(b)); console.log(`Pod/${clean(pod.metadata?.name)} phase=${clean(pod.status?.phase)} ready=${ok?'yes':'no'} restarts=${ps.reduce((n,s)=>n+(s.restartCount||0),0)} lastEventReason=${clean(ev.at(-1)?.reason||'none')}`); }
  const events=allEvents.filter(e=>pods.some(p=>e.involvedObject?.name===p.metadata?.name)).sort((a,b)=>eventTime(a)-eventTime(b));
  console.log(`Deployment/loader ready=${ready?'yes':'no'} generationCurrent=${generation?'yes':'no'} desiredReplicas=${desired} restarts=${restarts} lastEventReason=${clean(events.at(-1)?.reason||'none')}`);
  if(!ready) failures.push('Deployment/loader');
  const coreStatefulSet = getOptional('statefulsets', 'lifemodel', 'core');
  if (!coreStatefulSet) {
    if (applicationResourcesRequired) {
      console.log('StatefulSet/core: missing (required after loader bootstrap failure or completion)');
      failures.push('StatefulSet/core (missing)');
    } else {
      console.log(`StatefulSet/core: missing (expected; first start ${phaseLabel === 'not started' ? 'not started' : `in progress at ${phaseLabel}`})`);
    }
  } else {
    const corePods = (get('pods', 'lifemodel').items || []).filter(p => p.metadata?.labels?.['app.kubernetes.io/name'] === 'core');
    const coreDesired = coreStatefulSet.spec?.replicas ?? 1;
    const coreGeneration = current(coreStatefulSet);
    const coreRestarts = corePods.flatMap(p => p.status?.containerStatuses || []).reduce((n, s) => n + (s.restartCount || 0), 0);
    const corePodReady = corePods.length === coreDesired && corePods.length > 0 && corePods.every(p => p.status?.phase === 'Running' && (p.status?.containerStatuses || []).length > 0 && (p.status?.containerStatuses || []).every(c => c.ready));
    const coreReady = coreGeneration && coreDesired === 1 && (coreStatefulSet.status?.readyReplicas || 0) === 1 && corePodReady;
    const coreRevision = corePods.map(p => p.metadata?.labels?.['controller-revision-hash']).filter(Boolean).join(',') || coreStatefulSet.status?.currentRevision || 'unknown';
    console.log(`StatefulSet/core ready=${coreReady ? 'yes' : 'no'} generationCurrent=${coreGeneration ? 'yes' : 'no'} desiredReplicas=${coreDesired} restarts=${coreRestarts} revision=${clean(coreRevision)} snapshotCommitAge=not-queried (database credentials are not read by doctor)`);
    for (const pod of corePods) console.log(`Pod/${clean(pod.metadata?.name)} phase=${clean(pod.status?.phase)} ready=${(pod.status?.containerStatuses || []).length > 0 && pod.status.containerStatuses.every(c => c.ready) ? 'yes' : 'no'} restarts=${(pod.status?.containerStatuses || []).reduce((n, s) => n + (s.restartCount || 0), 0)}`);
    if (!coreReady) failures.push('StatefulSet/core');
  }
  if(failures.length){console.error(`Not ready: ${failures.join(', ')}`);return 1;} return 0;
}
function readHistory() {
  if (!existsSync(historyFile)) return [];
  const lines=readFileSync(historyFile,'utf8').split(/\r?\n/).filter(Boolean);
  if(lines.length>2 || lines.some(line=>!validRef.test(line))) throw new Error('Corrupt platform history; refusing action.');
  return lines;
}
function durableWrite(path, data) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700}); const tmp=`${path}.${process.pid}.tmp`;
  const fd=openSync(tmp,'w',0o600); try { writeFileSync(fd,data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp,path); const dir=openSync(dirname(path),'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function durableUnlink(path) { unlinkSync(path); const dir=openSync(dirname(path),'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
function writeHistory(ref) { if(!validRef.test(ref)) throw new Error('Applied platform ref must be tag=<OCI tag> or digest=sha256:<64 hex>'); const history=[ref,...readHistory().filter(e=>e!==ref)].slice(0,2); durableWrite(historyFile,`${history.join('\n')}\n`); }
function reapply() {
  if(process.env.LIFEMODEL_NIXOS==='1') execFileSync('systemctl',['restart','--no-block','lifemodel-flux-bootstrap.service'],{stdio:'inherit'});
  else {
    const executable=process.env.LIFEMODEL_APPLY_SCRIPT, args=JSON.parse(process.env.LIFEMODEL_APPLY_ARGS||'[]');
    if(!executable || !Array.isArray(args)) throw new Error('Cannot rerun bootstrap: installer arguments are not configured.');
    const lockFd=Number(process.env.LIFEMODEL_LOCK_FD);
    const stdio=Number.isInteger(lockFd)&&lockFd>=3?Array(lockFd+1).fill('ignore'): 'inherit';
    if(Array.isArray(stdio)){stdio[0]='inherit';stdio[1]='inherit';stdio[2]='inherit';stdio[lockFd]=lockFd;}
    execFileSync(executable,args,{stdio,env:process.env});
  }
}
function repin(mode) {
  const history=readHistory(); const configured=process.env.LIFEMODEL_CONFIGURED_REF;
  if(!configured || !validRef.test(configured)) throw new Error('Configured platform ref is not available to doctor.');
  if(mode==='previous') { const previous=history[1]; if(!previous) throw new Error('No previous platform release is recorded; a second successful apply is needed before re-pinning.'); durableWrite(overrideFile,`${JSON.stringify({ref:previous,configuredRef:configured})}\n`); }
  else { if(existsSync(overrideFile)) { readOverride(); durableUnlink(overrideFile); } }
  console.log(mode==='clear'?'Cleared platform override and reran bootstrap.':`Requested bootstrap with platform override ${history[1]}.`);
  if(process.env.LIFEMODEL_NIXOS!=='1') reapply();
}
function renderRef(path, configured) {
  const ref=effectiveRef(configured); const [field,value]=ref.split('=');
  const yaml=readFileSync(path,'utf8'); const replacement=`  ref:\n    ${field}: ${field==='tag'?JSON.stringify(value):value}\n`;
  const refBlock=/^  ref:\n(?:    (?:tag|digest):.*\n)+/m;
  if(!refBlock.test(yaml)) throw new Error('Could not find the complete OCI spec.ref block to render.');
  process.stdout.write(yaml.replace(refBlock,replacement));
}
function effectiveRef(configured) {
  if(!validRef.test(configured)) throw new Error('Configured platform ref must be tag=<OCI tag> or digest=sha256:<64 hex>');
  const override=readOverride(); if(!override) return configured;
  if(override.configuredRef===configured) return override.ref;
  durableUnlink(overrideFile); return configured;
}
function locked(args) {
  if(process.env.LIFEMODEL_LOCK_HELD==='1' && /^\d+$/.test(process.env.LIFEMODEL_LOCK_FD||'')) return false;
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const result=spawnSync('flock',['-x',`${stateDir}/lock`,process.execPath,script,...args],{stdio:'inherit',env:{...process.env,LIFEMODEL_LOCK_FD:'3',LIFEMODEL_LOCK_HELD:'1'}});
  if(result.error) throw result.error;
  if(result.status === 0 && args[0] === 'doctor' && args[1] === '--repin' && process.env.LIFEMODEL_NIXOS==='1') reapply();
  process.exit(result.status ?? 1);
}
const args=process.argv.slice(2);
try {
  if(args.length===1&&(args[0]==='--help'||args[0]==='-h')){help();process.exit(0);}
  if(args[0]==='assert-root-ownership'&&args.length===1){locked(args);assertRootOwnership();process.exit(0);}
  if(args[0]==='record-applied'&&args.length===2){locked(args);writeHistory(args[1]);process.exit(0);}
  if(args[0]==='effective-ref'&&args.length===2){locked(args);console.log(effectiveRef(args[1]));process.exit(0);}
  if(args[0]==='render-ref'&&args.length===3){locked(args);renderRef(args[1],args[2]);process.exit(0);}
  if(args.length===1&&args[0]==='doctor'){locked(args);process.exit(report());}
  if(args.length===3&&args[0]==='doctor'&&args[1]==='--repin'&&['previous','clear'].includes(args[2])){locked(args);repin(args[2]);process.exit(0);}
  if(args.length===0){help();process.exit(0);} throw new Error(`Unknown command or option: ${args.join(' ')}`);
} catch(error){console.error(`lifemodel doctor: ${error.message}`);process.exit(1);}
