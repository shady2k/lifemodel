# WALK-STORAGE-LOAD

Task: lifemodel-653.7.7. This is a procedure, not a deployed acceptance record.
The coordinator runs it on the disposable acceptance VM. Do not run it on an
owner instance or change its NetworkPolicies to make a test pass.

## Preconditions

1. Deploy this task's loader image through the existing platform pipeline.
   Record the image digest and the VM identity. Check storage-module readiness.
2. Use two live, gateway-bound task Pods for two different spaces. Their canonical
   intents must be active for the walk. Each Pod must have its projected
   `lifemodel-task-storage` token and the instance CA. A shell or a standalone
   service-account token is not a substitute for a Pod-bound Job identity.
3. Use a live core Pod with separate projected control and read tokens. Prepare
   one marked immutable object through the task API. Record its space and object
   ID. Core reads must use the read-audience token, not its API/control token.
4. Confirm Node is available in these caller Pods. Run from their existing
   network identities; do not mount a kubeconfig or storage credentials in them.
   Task-pod egress **must include DNS** for
   `storage-module.lifemodel-system.svc`, as task Pods do through
   `task-dns-egress` in `deploy/platform/d/network-policy.yaml`. Verify
   resolution from both task Pods; a Pod that can reach only the Service IP is
   not a usable fixture. Do not bypass DNS or relax NetworkPolicy for this walk.
   If these fixtures are not available, record **BLOCKED**. Use Jobs created by
   `src/core/task-launch.ts` and bound by `loader/src/task-identity.ts`; do not
   invent catalog bindings with ad-hoc SQL.

The isolated counterpart is:

```sh
lifemodel-heavy node scripts/test-isolated.mjs test -- tests/integration/storage-module-pressure.test.ts
```

It uses real disposable PostgreSQL, the SigV4-checking S3 fake, and a TLS
Kubernetes API fake. The VM walk below uses the same HTTP request shape and
limits against the deployed module. It does not replace deployed stores or
identity with fakes. The production API does not expose scheduler snapshots;
internal slot/buffer/queue peaks are asserted by the isolated integration test,
not inferred from VM RSS.

## Programs and local coordination

Save the three JavaScript blocks below on the coordinator host at their named
paths. They run with Node 24. Do not paste the caller program into a shell.
Caller tokens are read only from projected files inside the Pods. Output contains
counts, status codes and ISO timestamps, never bodies or credentials. All artifact
paths below are private. Use a new `WALK_DIR` for each run.

### `/tmp/storage-pressure-walk.mjs` — caller

Every HTTP attempt prints ISO start/end timestamps. Each caller also prints its
whole interval. The 1 s refusal measurement here starts at the client's request
creation, so it includes client/TLS/auth delay; it is stricter than the module's
arrival-to-response initial-admission bound. This walk uses single-chunk PUTs;
the deterministic integration test separately checks later-chunk refusal timing.

```js
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';

const [mode, tokenPath, caPath, space = '', object = ''] = process.argv.slice(2);
if (!['task', 'stall', 'put', 'control', 'read'].includes(mode) || !tokenPath || !caPath)
  throw Error('walk_arguments_required');
const startedAt = new Date().toISOString();
const emit = value => console.log(JSON.stringify({ mode, ...value }));
emit({ event: 'caller-start', startedAt });
const token = (await readFile(tokenPath, 'utf8')).trim();
const ca = await readFile(caPath);
const port = ['task', 'stall', 'put'].includes(mode) ? 8443 : mode === 'control' ? 8444 : 8445;
const bytes = Buffer.alloc(4 * 1024 * 1024, 120);
const digest = createHash('sha256').update(bytes).digest('hex');
const requests = new Set();
const run = randomUUID();
let sequence = 0, completed = 0, overload = 0, maxMs = 0;
const callerDeadline = setTimeout(() => {
  for (const req of requests) req.destroy(Error('walk_caller_deadline'));
}, 60000);
function call(method, path, body, headers = {}, partial = false) {
  const number = ++sequence;
  const start = performance.now(), requestStartedAt = new Date().toISOString();
  let req, deadline;
  const done = new Promise((resolve, reject) => {
    req = request({ hostname: 'storage-module.lifemodel-system.svc', port,
      ca, method, path, headers: { authorization: `Bearer ${token}`, ...headers } }, res => {
      res.on('error', () => reject(Error('walk_response_failed')));
      let length = 0;
      res.on('data', part => { length += part.length; });
      res.on('end', () => resolve({ status: res.statusCode, length,
        ms: performance.now() - start, retry: res.headers['retry-after'] }));
    });
    requests.add(req);
    req.on('socket', socket => socket.on('error', () => {}));
    req.on('error', () => partial ? resolve(null) : reject(Error('walk_transport_failed')));
    req.once('close', () => requests.delete(req));
    deadline = setTimeout(() => req.destroy(Error('walk_request_deadline')), 12000);
    if (partial) req.write(bytes.subarray(0, 1), () => {
      if (!req.destroyed) emit({ event: 'barrier', barrier: 'partial-body-sent',
        number, at: new Date().toISOString() });
    }); else req.end(body);
  }).finally(() => {
    clearTimeout(deadline);
    emit({ event: 'request-end', number, startedAt: requestStartedAt,
      endedAt: new Date().toISOString(), ms: performance.now() - start });
  });
  void done.catch(() => {});
  return { done };
}
try {
  if (mode === 'task' || mode === 'stall') {
    const pending = Array.from({ length: mode === 'stall' ? 1 : 10 }, (_, n) => call('PUT',
      `/spaces/${space}/objects/walk-${run}-${n}`, undefined, {
        'content-length': String(bytes.length), 'x-storage-length': String(bytes.length),
        'x-storage-sha256': digest,
        'x-storage-name': Buffer.from(`walk-${run}-${n}.txt`).toString('base64url'),
      }, true));
    if (mode === 'task') {
      const refusal = await Promise.any(pending.map(async item => {
        const result = await item.done;
        if (!result || result.status !== 429) throw Error('not_overload');
        return result;
      }));
      if (refusal.ms >= 1000 || !(Number(refusal.retry) > 0)) throw Error('overload_bound');
      overload++; maxMs = refusal.ms;
      emit({ event: 'barrier', barrier: 'overload', status: 429, maxMs,
        at: new Date().toISOString() });
    }
    await Promise.all(pending.map(item => item.done));
  } else {
    for (let n = 0; n < 20; n++) {
      const body = mode === 'put' ? bytes : mode === 'control' ? Buffer.from(JSON.stringify({
        taskId: `walk-${run}-${n}`, launchId: `walk-${run}-${n}`,
        effectKey: `walk-${run}-${n}`, retentionRevision: 'walk-1',
      })) : undefined;
      const headers = body ? { 'content-length': String(body.length) } : {};
      if (mode === 'put') Object.assign(headers, {
        'x-storage-length': String(bytes.length), 'x-storage-sha256': digest,
        'x-storage-name': Buffer.from(`walk-${run}-${n}.txt`).toString('base64url'),
      });
      const result = await call(mode === 'put' ? 'PUT' : mode === 'control' ? 'POST' : 'GET',
        mode === 'put' ? `/spaces/${space}/objects/walk-${run}-${n}` :
          mode === 'control' ? '/allocate' : `/spaces/${space}/objects/${object}`,
        body, headers).done;
      if (!result || result.status !== 200 || result.ms >= 2000) throw Error('ack_bound');
      if (mode === 'read' && result.length !== bytes.length) throw Error('read_length');
      completed++; maxMs = Math.max(maxMs, result.ms);
      emit({ event: 'ack', number: sequence, status: result.status, ms: result.ms,
        at: new Date().toISOString() });
    }
  }
} catch {
  process.exitCode = 1;
  emit({ event: 'failure', code: 'walk_caller_failed' });
} finally {
  clearTimeout(callerDeadline);
  await Promise.all([...requests].map(req => new Promise(resolve => {
    req.once('close', resolve);
    req.destroy();
  })));
  emit({ event: 'caller-end', startedAt, endedAt: new Date().toISOString(),
    completed, overload, maxMs, exitCode: process.exitCode ?? 0 });
}
```

### `/tmp/storage-pressure-rss.mjs` — continuous module RSS sampler

The module must be Node at PID 1 with the deployed storage-module entry point.
Node 24 can report `MainThread` in `/proc/1/comm`; check the NUL-separated
`/proc/1/cmdline` instead. This samples actual `VmRSS`, not the container limit.
The first RSS sample emits `ready`. Normal completion requires an explicit stdin
`stop` from the coordinator, after **all** callers in both phases have settled.
EOF, timeout, missing RSS or RSS above 524288 KiB fails; elapsed time is never a
successful stop condition. Keep every sample, not only the maximum.

```js
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const argv = (await readFile('/proc/1/cmdline', 'utf8')).split('\0').filter(Boolean);
if (!/(^|\/)node$/.test(argv[0] ?? '') ||
    argv[1] !== '/opt/lifemodel/loader/dist/storage-module.js') process.exit(2);
let samples = 0, maxKiB = 0, stop = false;
const startedAt = new Date().toISOString();
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', part => {
  input += part;
  if (input.includes('stop\n')) stop = true;
});
process.stdin.on('end', () => { stop = true; process.exitCode = 6; });
process.stdin.on('error', () => { stop = true; process.exitCode = 6; });
// This watchdog FAILS; elapsed time must never produce a successful early stop.
const deadline = setTimeout(() => { stop = true; process.exitCode = 7; }, 180000);
try {
  while (true) {
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(await readFile('/proc/1/status', 'utf8'));
    if (!rss) throw Error('rss_missing');
    samples++; maxKiB = Math.max(maxKiB, Number(rss[1]));
    if (maxKiB > 524288) throw Error('rss_limit');
    console.log(JSON.stringify({ event: samples === 1 ? 'ready' : 'sample',
      at: new Date().toISOString(), samples, rssKiB: Number(rss[1]), maxKiB }));
    if (stop) break;
    await delay(100);
  }
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  console.log(JSON.stringify({ event: 'sampler-end', startedAt,
    endedAt: new Date().toISOString(), samples, maxKiB, exitCode: process.exitCode ?? 0 }));
  process.stdin.destroy();
}
```

### `/tmp/storage-pressure-coordinate.mjs` — exact launch/wait/status commands

This program supplies every `kubectl exec` command for both phases. Each child
has a distinct `*.status.json` receipt with **that command's own** exit code,
signal and ISO start/end timestamps. It also writes private stdout/stderr. A local
watchdog kills a caller exec after 75 s and the sampler exec after 150 s;
`kubectl --request-timeout` alone does not bound an established exec stream. A
signal or any nonzero status fails the walk. No shell pipeline status substitutes
for a caller status.

Phase 1 waits for both task overload barriers before starting control/read.
Phase 2 waits for A's flushed partial-body barrier before starting B's twenty
full 4 MiB PUTs and fresh control/read callers. This is a send barrier, **not**
proof of module admission. A's stalled stream closes at its own **10 s**
no-progress deadline, and twenty sequential 4 MiB B PUTs take about that long on
a small VM, so the overlap rule below treats the request classes differently.
Check the timestamp artifacts for overlap as described below; the isolated test
observes admission directly.

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const env = name => {
  if (!process.env[name]) throw Error(`walk_missing_${name}`);
  return process.env[name];
};
const dir = env('WALK_DIR');
await mkdir(dir, { recursive: true, mode: 0o700 });
const caller = await readFile('/tmp/storage-pressure-walk.mjs', 'utf8');
const sampler = await readFile('/tmp/storage-pressure-rss.mjs', 'utf8');
const jobs = [];
function start(name, namespace, pod, args, source) {
  const startedAt = new Date().toISOString();
  const child = spawn('kubectl', ['--request-timeout=75s', '-n', namespace, 'exec', '-i', pod, '--', 'node', ...args],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const records = [], output = [], errors = [], waiters = [];
  let settled = false, timedOut = false;
  // kubectl request-timeout does not bound an established exec stream.
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, name === 'rss' ? 150000 : 75000);
  child.stdin.on('error', () => {});
  child.stderr.on('data', part => errors.push(part));
  createInterface({ input: child.stdout }).on('line', line => {
    output.push(line);
    try {
      const record = JSON.parse(line);
      records.push(record);
      for (const waiter of waiters) if (waiter.test(record)) waiter.resolve(record);
    } catch { /* Raw output stays in the private artifact, never the terminal. */ }
  });
  const done = new Promise(resolve => {
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    child.on('close', async (code, signal) => {
      clearTimeout(watchdog);
      settled = true;
      for (const waiter of waiters) waiter.reject(Error('walk_barrier_not_observed'));
      const result = { name, startedAt, endedAt: new Date().toISOString(),
        exitCode: spawnFailed ? 127 : code, signal, timedOut };
      try {
        await writeFile(join(dir, `${name}.jsonl`), output.join('\n') + '\n', { mode: 0o600 });
        await writeFile(join(dir, `${name}.stderr`), Buffer.concat(errors), { mode: 0o600 });
        await writeFile(join(dir, `${name}.status.json`), JSON.stringify(result) + '\n', { mode: 0o600 });
      } catch {
        process.exitCode = 1;
        result.artifactFailure = true;
      } finally {
        console.log(JSON.stringify({ event: 'command-end', ...result }));
        resolve(result);
      }
    });
  });
  const barrier = (event, value) => {
    const test = record => record.event === event && (!value || record.barrier === value);
    const found = records.find(test);
    if (found) return Promise.resolve(found);
    if (settled) return Promise.reject(Error('walk_barrier_not_observed'));
    return new Promise((resolve, reject) => { waiters.push({ test, resolve, reject }); });
  };
  if (source !== undefined) child.stdin.end(source);
  const job = { child, done, barrier, name, records };
  jobs.push(job);
  return job;
}
function launch(name, pod, mode, token, space = '', object = '') {
  return start(name, mode === 'read' || mode === 'control' ? 'lifemodel' : 'lifemodel-motor',
    pod, ['--input-type=module', '-', mode, token, env('CA'), space, object], caller);
}
async function accept(phase) {
  const results = await Promise.all(phase.map(job => job.done));
  if (results.some(result => result.exitCode !== 0 || result.signal ||
      result.timedOut || result.artifactFailure)) throw Error('walk_phase_failed');
}
let rss;
try {
  rss = start('rss', 'lifemodel-system', env('POD'), ['--input-type=module', '-e', sampler]);
  await rss.barrier('ready'); // First real /proc RSS observation, before ANY caller.
  const a = launch('phase1-task-a', env('TASK_A'), 'task', env('TASK_TOKEN'), env('SPACE_A'));
  const b = launch('phase1-task-b', env('TASK_B'), 'task', env('TASK_TOKEN'), env('SPACE_B'));
  await Promise.all([a.barrier('barrier', 'overload'), b.barrier('barrier', 'overload')]);
  const control1 = launch('phase1-control', env('CORE'), 'control', env('CONTROL_TOKEN'));
  const read1 = launch('phase1-read', env('CORE'), 'read', env('READ_TOKEN'), env('READ_SPACE'), env('READ_OBJECT'));
  await accept([a, b, control1, read1]);

  const stall = launch('phase2-stall', env('TASK_A'), 'stall', env('TASK_TOKEN'), env('SPACE_A'));
  await stall.barrier('barrier', 'partial-body-sent');
  const put = launch('phase2-put', env('TASK_B'), 'put', env('TASK_TOKEN'), env('SPACE_B'));
  const control2 = launch('phase2-control', env('CORE'), 'control', env('CONTROL_TOKEN'));
  const read2 = launch('phase2-read', env('CORE'), 'read', env('READ_TOKEN'), env('READ_SPACE'), env('READ_OBJECT'));
  await accept([stall, put, control2, read2]);
} catch {
  process.exitCode = 1;
  console.log(JSON.stringify({ event: 'failure', code: 'walk_coordination_failed' }));
} finally {
  // Even on failure, do not end sampling while a launched caller is unsettled.
  await Promise.all(jobs.filter(job => job !== rss).map(job => job.done));
  if (rss) {
    rss.child.stdin.write('stop\n');
    const result = await rss.done;
    const summary = rss.records.find(record => record.event === 'sampler-end');
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.artifactFailure ||
        !summary || !summary.samples ||
        summary.maxKiB > 524288) process.exitCode = 1;
  }
}
```

## Run both phases under one sampler

Set only non-secret locators in the coordinator shell. Replace the quoted
placeholders with real values. Token values never enter shell arguments. The
caller files must use the actual projected-file paths in the Pods. Save these
commands as a shell script, or run them in the same shell without `set -e`;
the `if` preserves the coordinator's own failure status.

```sh
umask 077
export TASK_A='replace-task-pod-a'
export TASK_B='replace-task-pod-b'
export CORE='replace-core-pod'
export SPACE_A='replace-first-space-id'
export SPACE_B='replace-second-space-id'
export READ_SPACE='replace-marked-object-space-id'
export READ_OBJECT='replace-marked-four-MiB-object-id'
export TASK_TOKEN='replace-projected-task-token-path'
export CONTROL_TOKEN='replace-projected-control-token-path'
export READ_TOKEN='replace-projected-read-token-path'
export CA='replace-instance-ca-file-path-in-caller-pods'
export WALK_DIR=$(mktemp -d /tmp/storage-pressure-walk.XXXXXX)
export POD=$(kubectl -n lifemodel-system get pod -l app.kubernetes.io/name=storage-module -o jsonpath='{.items[0].metadata.name}')
kubectl -n lifemodel-system wait --for=condition=Ready pod/"$POD" --timeout=60s
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if node /tmp/storage-pressure-coordinate.mjs > "$WALK_DIR/commands.jsonl" 2> "$WALK_DIR/coordinator.stderr"; then
  WALK_STATUS=0
else
  WALK_STATUS=$?
fi
printf 'coordinator=%s artifacts=%s\n' "$WALK_STATUS" "$WALK_DIR"
```

Require coordinator exit 0 and **nine** zero own command exits: phase1-task-a,
phase1-task-b, phase1-control, phase1-read, phase2-stall, phase2-put,
phase2-control, phase2-read and rss. Both phases must finish before the sampler's
successful `sampler-end`. The sampler watchdog fails after 180 s; it does not
justify a partial successful measurement. If a run is interrupted or the sampler
fails, keep the failed artifacts and repeat the complete walk, not phase 2 alone.

Read only these non-secret JSONL/status receipts. Verify that the sampler's
`ready` precedes every caller start, and its end follows every caller end.
Verify that each phase-1 control/read request interval lies inside the task
pressure interval after the two overload barriers. In phase 2, A's stalled
stream closes at its own **10 s** no-progress deadline, which bounds A's
partial-body-to-settlement interval. Require inside that interval all **twenty
control** and all **twenty read** request intervals — 20/20 of each. Require each
of B's twenty sequential 4 MiB PUTs to ACK in under **2 s** (the caller bounds
each attempt at 2 s), and at least the **majority** of those twenty PUT intervals
to lie inside the same window; a late B attempt can outlast it on a small VM.
Verify caller clocks agree with coordinator timestamps. If a task settles before
the relevant operations start, a control or read interval falls outside A's
window, fewer than eleven of B's PUT intervals overlap it, or timestamp order is
ambiguous, record the overlap check **BLOCKED** and repeat. A send barrier and
timestamps cannot prove when A was admitted; do not claim that from VM evidence.
The isolated test (`tests/integration/storage-module-pressure.test.ts`) is the
20/20 proof that A holds a task worker throughout B's twenty PUTs. Do not count
saturated queued partial uploads as the second-task throughput proof.

## Diagnostics and recovery

Save logs privately; do not print them while looking for credentials. Scan field
names and credential-shaped markers and print only the count. Review any match
in the private artifact before accepting it; a zero regex count alone cannot
prove absence of arbitrary personal content.

```sh
kubectl -n lifemodel-system logs "$POD" --since-time="$START" > "$WALK_DIR/module.log"
node --input-type=module -e '
import {readFile} from "node:fs/promises";
const text=await readFile(process.argv[1],"utf8");
const patterns=[/Bearer\s+[^\s"]+/g,/AWS4-HMAC-SHA256/g,/storageTestSecretKey/g,/"(?:body|content|authorization|secretKey|accessKey|connectionString|filename)"\s*:/gi];
const count=patterns.reduce((n,re)=>n+[...text.matchAll(re)].length,0);
console.log(JSON.stringify({suspiciousMatches:count}));process.exit(count?1:0);
' "$WALK_DIR/module.log"
kubectl -n lifemodel-system wait --for=condition=Ready pod/"$POD" --timeout=60s
```

Do not stop SeaweedFS/PostgreSQL on an owner instance. On the disposable VM only,
use its existing controlled failure/recovery procedure to stop and restore each
store, observe storage-module readiness down/up, and preserve those probe
outcomes. Liveness must remain up. This document does not invent a rollout or
store restart command. Record a blocked store-failure step rather than perform
an unapproved disruption. Delete disposable caller tasks and unretained walk
allocations through their normal lifecycle after evidence is saved.
