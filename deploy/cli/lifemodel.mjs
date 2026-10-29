#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  closeSync,
  fsyncSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

const stateDir = process.env.LIFEMODEL_STATE_DIR || '/var/lib/lifemodel';
const historyFile = process.env.LIFEMODEL_HISTORY || `${stateDir}/platform-history`;
const overrideFile = `${stateDir}/platform-override`;
const kubeconfig = '/etc/rancher/k3s/k3s.yaml';
const kubectl = (process.env.LIFEMODEL_KUBECTL || `k3s kubectl --kubeconfig ${kubeconfig}`).split(
  ' '
);
const script = fileURLToPath(import.meta.url);
const validRef = /^(?:tag=[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|digest=sha256:[a-f0-9]{64})$/;
function address() {
  const notReady = (reason) => {
    console.error(`lifemodel address: not ready (${reason}); run lifemodel doctor`);
    return 1;
  };
  let identity, caMap;
  try {
    identity = get('configmaps', 'flux-system', 'lifemodel-instance');
  } catch (error) {
    if (/\bnot found\b|\bNotFound\b/i.test(error.message)) {
      console.error('lifemodel address: not installed');
      return 1;
    }
    return notReady('identity unavailable');
  }
  const name = identity?.data?.LIFEMODEL_NAME;
  if (typeof name !== 'string' || !/^[a-z](?:[a-z0-9-]{0,55}[a-z0-9])?$/.test(name)) {
    return notReady('identity invalid');
  }
  try {
    caMap = get('configmaps', 'lifemodel-system', 'lifemodel-ca');
  } catch {
    return notReady('CA unavailable');
  }
  const pem = caMap?.data?.['ca.crt'];
  if (typeof pem !== 'string' || !pem.trim()) {
    return notReady('CA unavailable');
  }
  let fingerprint;
  try {
    fingerprint = new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
  } catch {
    return notReady('CA certificate invalid');
  }
  // This is public identity information, not a live health check. Doctor owns PKI
  // health; the installer's verified HTTPS wait owns first-start route readiness.
  console.log(`Address: https://${name}.local/`);
  console.log(`SHA-256 fingerprint of the CA certificate (DER): ${fingerprint}`);
  return 0;
}
function help() {
  console.log(`Usage: lifemodel doctor [--repin previous|clear]
       lifemodel doctor trace <trace_id | last [N]>
       lifemodel doctor llm [N]
       lifemodel doctor exchange <call_id | last [N]>
       lifemodel address
       lifemodel --help

Diagnose Flux sources, Kustomizations, the lifemodel loader and core.
  exchange  Read already-redacted model headers and bodies (conversation text).
            Use the call id printed by doctor llm; capture is off by default.
  --repin previous  Persist an override to the previous successfully applied ref and rerun bootstrap.
  --repin clear     Remove the override and rerun bootstrap.`);
}
function runKubectl(args, input) {
  try {
    return execFileSync(kubectl[0], [...kubectl.slice(1), ...args], { encoding: 'utf8', input });
  } catch (error) {
    throw new Error(
      `kubectl ${args.join(' ')} failed: ${error?.stderr?.toString().trim() || error?.message || String(error)}`
    );
  }
}
function get(resource, namespace, name) {
  return JSON.parse(
    runKubectl(['get', resource, ...(name ? [name] : []), '-n', namespace, '-o', 'json'])
  );
}
function getOptional(resource, namespace, name) {
  try {
    return get(resource, namespace, name);
  } catch (error) {
    if (/not found/i.test(error.message)) return null;
    throw error;
  }
}
function condition(item) {
  return (item.status?.conditions || []).find((entry) => entry.type === 'Ready') || {};
}
function clean(value) {
  return (
    String(value ?? 'unknown')
      .replace(/[\r\n\t]+/g, ' ')
      .trim() || 'unknown'
  );
}
function current(item) {
  return (
    item.metadata?.generation != null &&
    item.status?.observedGeneration === item.metadata.generation
  );
}
function checkResources(kind, items, revisionFor) {
  if (!items.length) {
    console.log(`${kind}: none found`);
    return [`${kind} (none found)`];
  }
  const failures = [];
  for (const item of items) {
    const name = item.metadata?.name || 'unnamed',
      ready = condition(item),
      revision = revisionFor(item);
    const generation = current(item);
    console.log(
      `${kind}/${name} Ready=${clean(ready.status)} generationCurrent=${generation ? 'yes' : 'no'} reason=${clean(ready.reason)} message=${clean(ready.message)} revision=${clean(revision)}`
    );
    if (ready.status !== 'True' || !generation) failures.push(`${kind}/${name}`);
  }
  return failures;
}
function readOverride() {
  if (!existsSync(overrideFile)) return null;
  const value = JSON.parse(readFileSync(overrideFile, 'utf8'));
  if (!value || !validRef.test(value.ref) || !validRef.test(value.configuredRef))
    throw new Error('Corrupt platform override; refusing action.');
  return value;
}
function assertRootOwnership() {
  let root;
  try {
    root = JSON.parse(
      runKubectl([
        'get',
        'ocirepository',
        'platform',
        '-n',
        'flux-system',
        '-o',
        'json',
        '--show-managed-fields',
      ])
    );
  } catch (error) {
    if (/not found/i.test(error.message)) return;
    throw error;
  }
  const owned = (root.metadata?.managedFields || [])
    .filter(
      (entry) => entry.manager !== 'lifemodel-bootstrap' && entry.fieldsV1?.['f:spec']?.['f:ref']
    )
    .map((entry) => clean(entry.manager));
  if (owned.length)
    throw new Error(
      `Root OCIRepository spec.ref is owned by ${[...new Set(owned)].join(', ')}. To reset ownership, delete the root object and let the writer recreate it: sudo kubectl --kubeconfig ${kubeconfig} delete ocirepository platform -n flux-system (Flux keeps its applied state).`
    );
}
function reportPki(failures) {
  const status = getOptional('configmaps', 'lifemodel-system', 'lifemodel-pki-status');
  const loader = getOptional('pods', 'lifemodel-system');
  const pods = (loader?.items || []).filter(
    (p) =>
      p.metadata?.labels?.['app.kubernetes.io/name'] === 'loader' ||
      p.metadata?.labels?.app === 'loader' ||
      p.metadata?.name?.startsWith('loader-')
  );
  const running = pods.some((p) => p.status?.phase === 'Running');
  const data = status?.data || {};
  const identity = data.identity || 'missing',
    ca = data.ca || 'missing',
    leaf = data.leaf || 'missing';
  console.log(
    `PKI loaderPod=${running ? 'running' : 'not-running'} identity=${clean(identity)} CA=${clean(ca)} fingerprint=${clean(data.caFingerprint || 'unknown')}`
  );
  if (data.error) console.log(`PKI error=${clean(data.error)}`);
  if (!running) failures.push('PKI loader pod (not running)');
  if (identity !== 'present') failures.push(`PKI identity (${clean(identity)})`);
  if (ca !== 'present-matching') failures.push(`PKI CA (${clean(ca)})`);
  if (!['valid'].includes(leaf)) failures.push(`PKI leaf (${clean(leaf)})`);
  let notAfter = data.leafNotAfter || 'unknown';
  let sans = (() => {
    try {
      return JSON.parse(data.leafSans || '[]');
    } catch {
      return [];
    }
  })();
  try {
    const tls = getOptional('secrets', 'lifemodel-system', 'lifemodel-tls');
    const certPem = Buffer.from(tls?.data?.['tls.crt'] || '', 'base64').toString('utf8');
    if (certPem) {
      const cert = new X509Certificate(certPem);
      notAfter = cert.validTo;
      sans = (cert.subjectAltName || '')
        .split(', ')
        .map((value) => value.replace(/^DNS:/, ''))
        .filter(Boolean);
      if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now())
        failures.push('PKI leaf (invalid validity)');
      const expectedSans = ['lifemodel.local', 'boot-lifemodel.local', 'vault-lifemodel.local'];
      if (
        sans.length !== expectedSans.length ||
        [...sans].sort().join('\0') !== [...expectedSans].sort().join('\0')
      )
        failures.push('PKI leaf (SAN mismatch)');
    }
  } catch {
    failures.push('PKI leaf (invalid certificate)');
  }
  console.log(
    `PKI leaf=${clean(leaf)} notAfter=${clean(notAfter)} SANs=${Array.isArray(sans) ? sans.map(clean).join(',') || 'none' : 'none'}`
  );
  if (status === null) failures.push('ConfigMap/lifemodel-pki-status (missing)');
}

function reportOpenBao(failures) {
  let status;
  try {
    status = JSON.parse(
      execFileSync(
        kubectl[0],
        [
          ...kubectl.slice(1),
          'exec',
          '-n',
          'openbao',
          'openbao-0',
          '--',
          'bao',
          'status',
          '-format=json',
        ],
        { encoding: 'utf8' }
      )
    );
  } catch (error) {
    if (error?.status === 2 && error.stdout) {
      try {
        status = JSON.parse(error.stdout.toString());
      } catch {
        failures.push('OpenBao status (invalid JSON)');
      }
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
  const flagSets = [...cpuinfo.matchAll(/^flags\s*:\s*(.*)$/gm)].map(
    (match) => new Set(match[1].split(/\s+/))
  );
  const supported =
    flagSets.length > 0 && flagSets.every((flags) => flags.has('sse4_2') && flags.has('popcnt'));
  if (!supported)
    console.warn(
      'WARNING: CPU lacks x86-64-v2 flags (sse4_2, popcnt); the core image memory search may fail to load. Use x86-64-v2 or newer; for VMs set the vCPU type to host or an x86-64-v2 model.'
    );
}
function report() {
  reportCpuRequirement();
  const failures = [];
  reportPki(failures);
  const override = readOverride();
  if (override)
    console.log(
      `ACTIVE PLATFORM OVERRIDE: ${override.ref} (recorded against ${override.configuredRef})`
    );
  reportOpenBao(failures);
  for (const [resource, kind, revision] of [
    ['ocirepositories', 'OCIRepository', (i) => i.status?.artifact?.revision],
    ['gitrepositories', 'GitRepository', (i) => i.status?.artifact?.revision],
  ]) {
    const items = get(resource, 'flux-system').items || [];
    if (kind === 'GitRepository' && !items.length)
      console.log('GitRepository: none (expected before the first loader start)');
    else failures.push(...checkResources(kind, items, revision));
  }
  failures.push(
    ...checkResources(
      'Kustomization',
      get('kustomizations', 'flux-system').items || [],
      (i) => i.status?.lastAppliedRevision
    )
  );
  const bootstrap = get('secrets', 'lifemodel-system', 'loader-bootstrap-state');
  let phaseRecord;
  let applicationResourcesRequired = false;
  let phaseLabel = 'not started';
  if (bootstrap.data?.phase === undefined) {
    console.log('Loader first start not started');
  } else {
    try {
      phaseRecord = JSON.parse(Buffer.from(bootstrap.data.phase, 'base64').toString('utf8'));
    } catch {
      phaseRecord = null;
    }
    const validPhase =
      phaseRecord &&
      typeof phaseRecord.phase === 'string' &&
      phaseRecord.phase.trim() &&
      ['running', 'complete', 'failed'].includes(phaseRecord.status);
    if (!validPhase) {
      console.log('Loader first start phase record invalid');
      failures.push('Secret loader-bootstrap-state (invalid phase record)');
      applicationResourcesRequired = true;
      phaseLabel = 'phase record invalid';
    } else {
      phaseLabel = clean(phaseRecord.phase);
      console.log(`Loader first start phase=${phaseLabel} status=${clean(phaseRecord.status)}`);
      const finalPhaseComplete =
        phaseRecord.phase === 'gitea-application-kustomizations' &&
        phaseRecord.status === 'complete';
      if (phaseRecord.status === 'failed') {
        failures.push(`Loader bootstrap phase ${phaseLabel} (failed)`);
        applicationResourcesRequired = true;
      } else if (finalPhaseComplete) {
        applicationResourcesRequired = true;
      } else {
        console.log(
          `Loader first start in progress at ${phaseLabel} (status=${clean(phaseRecord.status)})`
        );
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
    const item = (get(resource, namespace).items || []).find((i) => i.metadata?.name === name);
    if (!item) {
      if (applicationResourcesRequired) failures.push(`${kind}/${namespace}/${name} (missing)`);
      else
        console.log(
          `${kind}/${namespace}/${name}: missing (expected; first start ${phaseLabel === 'not started' ? 'not started' : `in progress at ${phaseLabel}`})`
        );
      continue;
    }
    const ready = condition(item),
      generation = current(item);
    console.log(
      `${kind}/${namespace}/${name} Ready=${clean(ready.status)} generationCurrent=${generation ? 'yes' : 'no'} reason=${clean(ready.reason)} message=${clean(ready.message)}`
    );
    if (ready.status !== 'True' || !generation) failures.push(`${kind}/${namespace}/${name}`);
  }
  const giteaDeployments = get('deployments', 'lifemodel-git').items || [];
  const gitea = giteaDeployments.find((i) => i.metadata?.name === 'gitea');
  const giteaDesired = gitea?.spec?.replicas ?? 1;
  const giteaReady = Boolean(
    gitea &&
    current(gitea) &&
    giteaDesired > 0 &&
    (gitea.status?.readyReplicas || 0) >= giteaDesired
  );
  console.log(
    `Deployment/gitea ready=${giteaReady ? 'yes' : 'no'} generationCurrent=${gitea && current(gitea) ? 'yes' : 'no'} desiredReplicas=${giteaDesired}`
  );
  if (!giteaReady) failures.push('Deployment/gitea');
  const deployments = get('deployments', 'lifemodel-system').items || [],
    loader = deployments.find((i) => i.metadata?.name === 'loader');
  const pods = (get('pods', 'lifemodel-system').items || []).filter(
    (p) =>
      p.metadata?.labels?.['app.kubernetes.io/name'] === 'loader' ||
      p.metadata?.labels?.app === 'loader' ||
      p.metadata?.name?.startsWith('loader-')
  );
  const statuses = pods.flatMap((p) => p.status?.containerStatuses || []),
    desired = loader?.spec?.replicas ?? 1;
  const generation = Boolean(loader && current(loader));
  const ready = Boolean(
    loader &&
    generation &&
    desired > 0 &&
    (loader.status?.readyReplicas || 0) > 0 &&
    (loader.status?.readyReplicas || 0) >= desired &&
    pods.length > 0 &&
    pods.length >= desired &&
    pods.every(
      (p) =>
        p.status?.phase === 'Running' &&
        (p.status?.containerStatuses || []).length > 0 &&
        (p.status?.containerStatuses || []).every((c) => c.ready)
    )
  );
  const restarts = statuses.reduce((n, s) => n + (s.restartCount || 0), 0),
    allEvents = get('events', 'lifemodel-system').items || [];
  const eventTime = (e) =>
    Date.parse(e.eventTime || e.lastTimestamp || e.metadata?.creationTimestamp || 0);
  for (const pod of pods) {
    const ps = pod.status?.containerStatuses || [],
      ok = pod.status?.phase === 'Running' && ps.length > 0 && ps.every((s) => s.ready);
    const ev = allEvents
      .filter((e) => e.involvedObject?.name === pod.metadata?.name)
      .sort((a, b) => eventTime(a) - eventTime(b));
    console.log(
      `Pod/${clean(pod.metadata?.name)} phase=${clean(pod.status?.phase)} ready=${ok ? 'yes' : 'no'} restarts=${ps.reduce((n, s) => n + (s.restartCount || 0), 0)} lastEventReason=${clean(ev.at(-1)?.reason || 'none')}`
    );
  }
  const events = allEvents
    .filter((e) => pods.some((p) => e.involvedObject?.name === p.metadata?.name))
    .sort((a, b) => eventTime(a) - eventTime(b));
  console.log(
    `Deployment/loader ready=${ready ? 'yes' : 'no'} generationCurrent=${generation ? 'yes' : 'no'} desiredReplicas=${desired} restarts=${restarts} lastEventReason=${clean(events.at(-1)?.reason || 'none')}`
  );
  if (!ready) failures.push('Deployment/loader');
  const coreStatefulSet = getOptional('statefulsets', 'lifemodel', 'core');
  if (!coreStatefulSet) {
    if (applicationResourcesRequired) {
      console.log(
        'StatefulSet/core: missing (required after loader bootstrap failure or completion)'
      );
      failures.push('StatefulSet/core (missing)');
    } else {
      console.log(
        `StatefulSet/core: missing (expected; first start ${phaseLabel === 'not started' ? 'not started' : `in progress at ${phaseLabel}`})`
      );
    }
  } else {
    const corePods = (get('pods', 'lifemodel').items || []).filter(
      (p) => p.metadata?.labels?.['app.kubernetes.io/name'] === 'core'
    );
    const coreDesired = coreStatefulSet.spec?.replicas ?? 1;
    const coreGeneration = current(coreStatefulSet);
    const coreRestarts = corePods
      .flatMap((p) => p.status?.containerStatuses || [])
      .reduce((n, s) => n + (s.restartCount || 0), 0);
    const corePodReady =
      corePods.length === coreDesired &&
      corePods.length > 0 &&
      corePods.every(
        (p) =>
          p.status?.phase === 'Running' &&
          (p.status?.containerStatuses || []).length > 0 &&
          (p.status?.containerStatuses || []).every((c) => c.ready)
      );
    const coreReady =
      coreGeneration &&
      coreDesired === 1 &&
      (coreStatefulSet.status?.readyReplicas || 0) === 1 &&
      corePodReady;
    const coreRevision =
      corePods
        .map((p) => p.metadata?.labels?.['controller-revision-hash'])
        .filter(Boolean)
        .join(',') ||
      coreStatefulSet.status?.currentRevision ||
      'unknown';
    console.log(
      `StatefulSet/core ready=${coreReady ? 'yes' : 'no'} generationCurrent=${coreGeneration ? 'yes' : 'no'} desiredReplicas=${coreDesired} restarts=${coreRestarts} revision=${clean(coreRevision)} snapshotCommitAge=not-queried (database credentials are not read by doctor)`
    );
    for (const pod of corePods)
      console.log(
        `Pod/${clean(pod.metadata?.name)} phase=${clean(pod.status?.phase)} ready=${(pod.status?.containerStatuses || []).length > 0 && pod.status.containerStatuses.every((c) => c.ready) ? 'yes' : 'no'} restarts=${(pod.status?.containerStatuses || []).reduce((n, s) => n + (s.restartCount || 0), 0)}`
      );
    if (!coreReady) failures.push('StatefulSet/core');
  }
  if (failures.length) {
    console.error(`Not ready: ${failures.join(', ')}`);
    return 1;
  }
  return 0;
}
// Runs in the existing core container. Credentials stay in its environment and
// are never fetched as Kubernetes Secrets or printed by the operator command.
// Both readers share this prologue: a read-only transaction, a bound parameter
// and a fixed unavailable message; the body returns what it read.
function storeScript(body) {
  return `
import pg from 'pg';
const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const e = encodeURIComponent;
const connectionString = process.env.LIFEMODEL_DATABASE_URL ||
  ('postgresql://' + e(process.env.LIFEMODEL_DB_USERNAME) + ':' + e(process.env.LIFEMODEL_DB_PASSWORD) +
   '@lifemodel-rw.lifemodel-state.svc.cluster.local:5432/lifemodel');
const pool = new pg.Pool({connectionString, max:1, connectionTimeoutMillis:3000, query_timeout:5000});
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await (async (client, request) => {${body}})(client, request);
    await client.query('COMMIT');
    process.stdout.write(JSON.stringify(result));
  } finally { client.release(); }
} catch { process.stderr.write('store unavailable\\n'); process.exitCode=1; }
finally { await pool.end(); }
`;
}

const traceQuery = storeScript(`
    const ids = request.id ? [request.id] : (await client.query(
      'SELECT trace_id FROM (SELECT trace_id,started_at AS ts FROM observability.trace_spans UNION ALL SELECT trace_id,ts FROM observability.trace_events) records GROUP BY trace_id ORDER BY min(ts) DESC,trace_id DESC LIMIT $1',
      [request.last])).rows.map(r => r.trace_id);
    const traces = [];
    for (const id of ids) {
      const spans = (await client.query('SELECT * FROM observability.trace_spans WHERE trace_id=$1 ORDER BY started_at,span_id LIMIT 10001',[id])).rows;
      const events = (await client.query('SELECT * FROM observability.trace_events WHERE trace_id=$1 ORDER BY ts,record_id LIMIT 10001',[id])).rows;
      traces.push({id,spans:spans.slice(0,10000),events:events.slice(0,10000),truncated:spans.length>10000||events.length>10000});
    }
    return traces;
`);

// Recent model calls (lifemodel-d4t8), newest first. The span component and the
// call id are what make a row a model call; nothing else is guessed.
const llmQuery = storeScript(`
    return (await client.query(
      "SELECT trace_id,span_id,started_at,ended_at,status,attrs FROM observability.trace_spans WHERE component='llm' AND attrs ? 'lifemodel.call_id' ORDER BY started_at DESC,span_id DESC LIMIT $1",
      [request.limit])).rows;
`);

// The role can select only the age-filtered capture view, never append/prune.
const exchangeQuery = storeScript(`
    await client.query('SET LOCAL ROLE lifemodel_capture_reader');
    const rows = (await client.query(
      'SELECT * FROM observability.recent_model_exchanges WHERE ($1::text IS NULL OR call_id=$1) ORDER BY created_at DESC,call_id DESC,attempt DESC,slot DESC LIMIT $2',
      [request.id ?? null, request.limit + 1])).rows;
    return {
      truncated: rows.length > request.limit,
      rows: rows.slice(0, request.limit).map(({ exchange, ...row }) => {
        const text = JSON.stringify(exchange, null, 2);
        return { ...row, text: text.slice(0, 262144), truncated: text.length > 262144 };
      }),
    };
`);

function doctorExchange(args) {
  const print = (text) => writeFileSync(1, `${text}\n`);
  let request;
  if (args[0] === 'last' && args.length <= 2) {
    const limit = args[1] === undefined ? 1 : Number(args[1]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error('exchange last count must be an integer from 1 to 20');
    request = { limit };
  } else if (args.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0])) {
    request = { id: args[0], limit: 20 };
  } else throw new Error('Usage: lifemodel doctor exchange <call_id | last [N]>');
  let result;
  try {
    result = readStore(exchangeQuery, request);
  } catch {
    console.error('Exchange store unavailable. The core pod and capture schema must be available.');
    return 1;
  }
  if (!result.rows.length) {
    print('No model exchanges recorded (capture is off by default; retention is 24 hours).');
    return 0;
  }
  for (const row of result.rows) {
    print(
      `exchange call=${safe(row.call_id)} attempt=${safe(row.attempt)} slot=${safe(row.slot)} task=${dash(row.task_id)} session=${dash(row.session_id)} time=${safe(row.created_at)} bytes=${safe(row.size_bytes)}`
    );
    // Pretty JSON preserves body/header boundaries and escapes terminal control
    // sequences. Strip actual controls too; bound output to 256 KiB per row.
    print(
      String(row.text)
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ')
        .slice(0, 262144)
    );
    if (row.truncated) print('(exchange display truncated at 262144 characters)');
  }
  if (result.truncated) print('(exchange count truncated)');
  return 0;
}

function readStore(script, request) {
  return JSON.parse(
    execFileSync(
      kubectl[0],
      [
        ...kubectl.slice(1),
        'exec',
        '-n',
        'lifemodel',
        'core-0',
        '-c',
        'core',
        '--',
        'node',
        '--input-type=module',
        '-e',
        script,
        Buffer.from(JSON.stringify(request)).toString('base64'),
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  );
}

function storeUnavailable() {
  console.error(
    'Trace store unavailable. The core pod and observability schema must be available.'
  );
}

function safe(value) {
  return String(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .slice(0, 1000);
}

function fields(bag) {
  return Object.entries(bag || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${safe(key)}=${safe(JSON.stringify(value))}`)
    .join(' ');
}

// A model call's attribute names follow the GenAI semantic conventions plus
// lifemodel's own facts; the reader names them in the operator's words.
const LLM_FACTS = [
  ['name', 'span.name', true],
  ['role', 'lifemodel.role'],
  ['trigger', 'lifemodel.trigger_type'],
  ['model', 'gen_ai.request.model'],
  ['served', 'gen_ai.response.model'],
  ['slot', 'lifemodel.slot'],
  ['effort', 'lifemodel.request.reasoning_effort'],
  ['in', 'gen_ai.usage.input_tokens'],
  ['cached', 'gen_ai.usage.cache_read.input_tokens'],
  ['out', 'gen_ai.usage.output_tokens'],
  ['reasoning', 'gen_ai.usage.reasoning.output_tokens'],
  ['http', 'lifemodel.http.status'],
  ['attempt', 'lifemodel.attempt'],
  ['error', 'lifemodel.error_code'],
  ['call', 'lifemodel.call_id'],
];
const LLM_PREFIXES = ['system', 'tools', 'history', 'context'];

function dash(value) {
  return value === undefined || value === null
    ? '-'
    : safe(JSON.stringify(value)).replace(/^"|"$/g, '');
}

// "system=ab12cd34/4800": which part of the prompt, and how big it was. A
// dash means the part was not present, so a cache miss is read as "history
// changed" rather than guessed.
function llmPrefixes(attrs) {
  return LLM_PREFIXES.map((part) => {
    const hash = attrs[`lifemodel.prefix.${part}.hash`];
    const size = attrs[`lifemodel.prefix.${part}.size`];
    return `${part}=${hash === undefined ? '-' : safe(String(hash)).slice(0, 8)}/${dash(size)}`;
  }).join(' ');
}

function llmFacts(attrs) {
  return LLM_FACTS.map(([label, key, quoted]) => {
    const value = attrs[key];
    if (value === undefined || value === null) return `${label}=-`;
    return `${label}=${quoted ? safe(JSON.stringify(value)) : dash(value)}`;
  }).join(' ');
}

function llmTokens(attrs) {
  return [
    dash(attrs['gen_ai.usage.input_tokens']),
    dash(attrs['gen_ai.usage.cache_read.input_tokens']),
    dash(attrs['gen_ai.usage.output_tokens']),
    dash(attrs['gen_ai.usage.reasoning.output_tokens']),
  ].join('/');
}

function renderSpan(span, depth, trace, emitted) {
  const indent = '  '.repeat(Math.min(depth, 32));
  const status = span.ended_at && span.status ? span.status : 'incomplete';
  const duration = span.ended_at
    ? `${Math.max(0, Date.parse(span.ended_at) - Date.parse(span.started_at))}ms`
    : 'open';
  if (span.component === 'llm') {
    // A model call has more attributes than a line can hold: the facts an
    // operator asks for first, then which prefix part changed, then the rest.
    const attrs = span.attrs || {};
    console.log(
      `${indent}llm [${safe(status)}] ${duration} span=${safe(span.span_id)} ${llmFacts(attrs)}`.trimEnd()
    );
    console.log(`${indent}    prefix ${llmPrefixes(attrs)}`.trimEnd());
    const known = new Set([
      ...LLM_FACTS.map(([, key]) => key),
      'lifemodel.duration_ms',
      'lifemodel.message_count',
      'lifemodel.tool_count',
    ]);
    const rest = Object.fromEntries(
      Object.entries(attrs).filter(
        ([key]) => !known.has(key) && !key.startsWith('lifemodel.prefix.')
      )
    );
    if (Object.keys(rest).length) console.log(`${indent}    ${fields(rest)}`.trimEnd());
  } else {
    console.log(
      `${indent}${safe(span.component)} [${safe(status)}] ${duration} span=${safe(span.span_id)} ${fields(span.attrs)}`.trimEnd()
    );
  }
  for (const event of trace.events.filter((event) => event.span_id === span.span_id)) {
    emitted.add(event.record_id);
    console.log(`${indent}  · ${safe(event.event)} ${fields(event.fields)}`.trimEnd());
  }
}

function doctorTrace(args) {
  let request;
  if (args[0] === 'last' && args.length <= 2) {
    const count = args[1] === undefined ? 1 : Number(args[1]);
    if (!Number.isInteger(count) || count < 1 || count > 20)
      throw new Error('trace last count must be an integer from 1 to 20');
    request = { last: count };
  } else if (args.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0])) {
    request = { id: args[0] };
  } else throw new Error('Usage: lifemodel doctor trace <trace_id | last [N]>');
  let traces;
  try {
    traces = readStore(traceQuery, request);
  } catch {
    storeUnavailable();
    return 1;
  }
  if (!traces.length) {
    console.log('No traces recorded.');
    return 0;
  }
  for (const trace of traces) {
    console.log(`trace ${safe(trace.id)}`);
    if (!trace.spans.length && !trace.events.length) console.log('  (no spans or events recorded)');
    const nodes = new Map(trace.spans.map((span) => [span.span_id, span]));
    const visited = new Set();
    const emitted = new Set();
    // Iterative traversal also tolerates malformed cycles and very deep traces.
    const roots = trace.spans.filter((span) => !nodes.has(span.parent_span_id));
    const render = (root) => {
      const stack = [{ span: root, depth: 1 }];
      while (stack.length) {
        const { span, depth } = stack.pop();
        if (visited.has(span.span_id)) continue;
        visited.add(span.span_id);
        renderSpan(span, depth, trace, emitted);
        const children = trace.spans.filter((child) => child.parent_span_id === span.span_id);
        for (const child of children.reverse()) stack.push({ span: child, depth: depth + 1 });
      }
    };
    for (const span of roots) render(span);
    for (const span of trace.spans)
      if (!visited.has(span.span_id)) {
        console.log('  (unlinked/cyclic spans)');
        render(span);
      }
    for (const event of trace.events)
      if (!emitted.has(event.record_id))
        console.log(
          `  · ${safe(event.event)} (missing span ${safe(event.span_id)}) ${fields(event.fields)}`.trimEnd()
        );
    if (trace.truncated) console.log('  (display truncated at 10000 records per table)');
  }
  return 0;
}

// Recent model calls, newest first: what each cost, whether its input was
// cached, the effort that went out, the slot that answered and which part of
// the prompt changed (lifemodel-d4t8).
function doctorLlm(args) {
  let limit = 10;
  if (args.length === 1) {
    limit = Number(args[0]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('llm count must be an integer from 1 to 50');
  } else if (args.length > 1) throw new Error('Usage: lifemodel doctor llm [N]');
  let rows;
  try {
    rows = readStore(llmQuery, { limit });
  } catch {
    storeUnavailable();
    return 1;
  }
  if (!rows.length) {
    console.log('No model calls recorded.');
    return 0;
  }
  console.log(`recent model calls, newest first (${String(rows.length)})`);
  console.log('  time role model slot effort in/cached/out/reasoning duration status call');
  for (const row of rows) {
    const attrs = row.attrs || {};
    const status = row.ended_at && row.status ? row.status : 'incomplete';
    const duration = row.ended_at
      ? `${Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at))}ms`
      : 'open';
    console.log(
      [
        `  ${safe(new Date(row.started_at).toISOString())}`,
        dash(attrs['lifemodel.role']),
        dash(attrs['gen_ai.request.model']),
        dash(attrs['lifemodel.slot']),
        dash(attrs['lifemodel.request.reasoning_effort']),
        llmTokens(attrs),
        duration,
        safe(status),
        `call=${dash(attrs['lifemodel.call_id'])}`,
      ].join(' ')
    );
    console.log(
      `      http=${dash(attrs['lifemodel.http.status'])} attempt=${dash(attrs['lifemodel.attempt'])} error=${dash(attrs['lifemodel.error_code'])} trigger=${dash(attrs['lifemodel.trigger_type'])} served=${dash(attrs['gen_ai.response.model'])} prefix ${llmPrefixes(attrs)}`
    );
  }
  return 0;
}

function readHistory() {
  if (!existsSync(historyFile)) return [];
  const lines = readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length > 2 || lines.some((line) => !validRef.test(line)))
    throw new Error('Corrupt platform history; refusing action.');
  return lines;
}
function durableWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function durableUnlink(path) {
  unlinkSync(path);
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function writeHistory(ref) {
  if (!validRef.test(ref))
    throw new Error('Applied platform ref must be tag=<OCI tag> or digest=sha256:<64 hex>');
  const history = [ref, ...readHistory().filter((e) => e !== ref)].slice(0, 2);
  durableWrite(historyFile, `${history.join('\n')}\n`);
}
function reapply() {
  if (process.env.LIFEMODEL_NIXOS === '1')
    execFileSync('systemctl', ['restart', '--no-block', 'lifemodel-flux-bootstrap.service'], {
      stdio: 'inherit',
    });
  else {
    const executable = process.env.LIFEMODEL_APPLY_SCRIPT,
      args = JSON.parse(process.env.LIFEMODEL_APPLY_ARGS || '[]');
    if (!executable || !Array.isArray(args))
      throw new Error('Cannot rerun bootstrap: installer arguments are not configured.');
    const lockFd = Number(process.env.LIFEMODEL_LOCK_FD);
    const stdio =
      Number.isInteger(lockFd) && lockFd >= 3 ? Array(lockFd + 1).fill('ignore') : 'inherit';
    if (Array.isArray(stdio)) {
      stdio[0] = 'inherit';
      stdio[1] = 'inherit';
      stdio[2] = 'inherit';
      stdio[lockFd] = lockFd;
    }
    execFileSync(executable, args, { stdio, env: process.env });
  }
}
function repin(mode) {
  const history = readHistory();
  const configured = process.env.LIFEMODEL_CONFIGURED_REF;
  if (!configured || !validRef.test(configured))
    throw new Error('Configured platform ref is not available to doctor.');
  if (mode === 'previous') {
    const previous = history[1];
    if (!previous)
      throw new Error(
        'No previous platform release is recorded; a second successful apply is needed before re-pinning.'
      );
    durableWrite(overrideFile, `${JSON.stringify({ ref: previous, configuredRef: configured })}\n`);
  } else {
    if (existsSync(overrideFile)) {
      readOverride();
      durableUnlink(overrideFile);
    }
  }
  console.log(
    mode === 'clear'
      ? 'Cleared platform override and reran bootstrap.'
      : `Requested bootstrap with platform override ${history[1]}.`
  );
  if (process.env.LIFEMODEL_NIXOS !== '1') reapply();
}
function renderRef(path, configured) {
  const ref = effectiveRef(configured);
  const [field, value] = ref.split('=');
  const yaml = readFileSync(path, 'utf8');
  const replacement = `  ref:\n    ${field}: ${field === 'tag' ? JSON.stringify(value) : value}\n`;
  const refBlock = /^  ref:\n(?:    (?:tag|digest):.*\n)+/m;
  if (!refBlock.test(yaml))
    throw new Error('Could not find the complete OCI spec.ref block to render.');
  process.stdout.write(yaml.replace(refBlock, replacement));
}
function effectiveRef(configured) {
  if (!validRef.test(configured))
    throw new Error('Configured platform ref must be tag=<OCI tag> or digest=sha256:<64 hex>');
  const override = readOverride();
  if (!override) return configured;
  if (override.configuredRef === configured) return override.ref;
  durableUnlink(overrideFile);
  return configured;
}
function locked(args) {
  if (process.env.LIFEMODEL_LOCK_HELD === '1' && /^\d+$/.test(process.env.LIFEMODEL_LOCK_FD || ''))
    return false;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const result = spawnSync('flock', ['-x', `${stateDir}/lock`, process.execPath, script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, LIFEMODEL_LOCK_FD: '3', LIFEMODEL_LOCK_HELD: '1' },
  });
  if (result.error) throw result.error;
  if (
    result.status === 0 &&
    args[0] === 'doctor' &&
    args[1] === '--repin' &&
    process.env.LIFEMODEL_NIXOS === '1'
  )
    reapply();
  process.exit(result.status ?? 1);
}
const args = process.argv.slice(2);
try {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    help();
    process.exit(0);
  }
  if (args[0] === 'assert-root-ownership' && args.length === 1) {
    locked(args);
    assertRootOwnership();
    process.exit(0);
  }
  if (args[0] === 'record-applied' && args.length === 2) {
    locked(args);
    writeHistory(args[1]);
    process.exit(0);
  }
  if (args[0] === 'effective-ref' && args.length === 2) {
    locked(args);
    console.log(effectiveRef(args[1]));
    process.exit(0);
  }
  if (args[0] === 'render-ref' && args.length === 3) {
    locked(args);
    renderRef(args[1], args[2]);
    process.exit(0);
  }
  if (args.length === 1 && args[0] === 'address') {
    locked(args);
    process.exit(address());
  }
  if (args[0] === 'doctor' && args[1] === 'trace') {
    process.exit(doctorTrace(args.slice(2)));
  }
  if (args[0] === 'doctor' && args[1] === 'exchange') {
    process.exit(doctorExchange(args.slice(2)));
  }
  if (args[0] === 'doctor' && args[1] === 'llm') {
    process.exit(doctorLlm(args.slice(2)));
  }
  if (args.length === 1 && args[0] === 'doctor') {
    locked(args);
    process.exit(report());
  }
  if (
    args.length === 3 &&
    args[0] === 'doctor' &&
    args[1] === '--repin' &&
    ['previous', 'clear'].includes(args[2])
  ) {
    locked(args);
    repin(args[2]);
    process.exit(0);
  }
  if (args.length === 0) {
    help();
    process.exit(0);
  }
  throw new Error(`Unknown command or option: ${args.join(' ')}`);
} catch (error) {
  console.error(`lifemodel doctor: ${error.message}`);
  process.exit(1);
}
