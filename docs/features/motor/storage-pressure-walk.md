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
   If these fixtures are not available, record **BLOCKED**. Stage 3 owns real
   gateway/Job creation; do not invent catalog bindings with ad-hoc SQL.

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

## Bounded caller program

Save the following as `/tmp/storage-pressure-walk.mjs` on the coordinator host.
The script reads only the named token and CA files inside a caller Pod. It prints
counts, status codes and timings, never request/response bodies or credentials.

```js
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';

const [mode, tokenPath, caPath, space = '', object = ''] = process.argv.slice(2);
if (!['task', 'stall', 'put', 'control', 'read'].includes(mode) || !tokenPath || !caPath)
  throw Error('walk_arguments_required');
const token = (await readFile(tokenPath, 'utf8')).trim();
const ca = await readFile(caPath);
const port = ['task', 'stall', 'put'].includes(mode) ? 8443 : mode === 'control' ? 8444 : 8445;
const bytes = Buffer.alloc(4 * 1024 * 1024, 120);
const digest = createHash('sha256').update(bytes).digest('hex');
const requests = new Set();
const run = randomUUID();
function call(method, path, body, headers = {}, partial = false) {
  const start = performance.now();
  let req;
  const done = new Promise((resolve, reject) => {
    req = request({ hostname: 'storage-module.lifemodel-system.svc', port,
      ca, method, path, headers: { authorization: `Bearer ${token}`, ...headers } }, res => {
      res.on('error', reject);
      let length = 0;
      res.on('data', part => { length += part.length; });
      res.on('end', () => resolve({ status: res.statusCode, length,
        ms: performance.now() - start, retry: res.headers['retry-after'] }));
    });
    requests.add(req);
    req.on('socket', socket => socket.on('error', () => {}));
    req.on('error', () => partial ? resolve(null) : reject(Error('walk_transport_failed')));
    req.once('close', () => requests.delete(req));
    req.setTimeout(12000, () => req.destroy());
    if (partial) req.write(bytes.subarray(0, 1)); else req.end(body);
  });
  void done.catch(() => {});
  return { done, abort: () => req.destroy() };
}
let completed = 0, overload = 0, maxMs = 0;
try {
  if (mode === 'task' || mode === 'stall') {
    // Start this mode in BOTH task Pods at the same time: 20 attempted streams.
    const pending = Array.from({ length: mode === 'stall' ? 1 : 10 }, (_, n) => call('PUT',
      `/spaces/${space}/objects/walk-${run}-${n}`, undefined, {
        'content-length': String(bytes.length), 'x-storage-length': String(bytes.length),
        'x-storage-sha256': digest,
        'x-storage-name': Buffer.from(`walk-${run}-${n}.txt`).toString('base64url'),
      }, true));
    // A refusal is the barrier, not a guessed tick count. Partial streams remain
    // open while the independent control/read modes run.
    if (mode === 'task') {
      const refusal = await Promise.any(pending.map(async item => {
        const result = await item.done;
        if (!result || result.status !== 429) throw Error('not_overload');
        return result;
      }));
      if (refusal.ms >= 1000 || !(Number(refusal.retry) > 0)) throw Error('overload_bound');
      overload++; maxMs = refusal.ms;
      console.log(JSON.stringify({ mode, barrier: 'overload', status: 429, maxMs }));
    } else console.log(JSON.stringify({ mode, barrier: 'partial-body-sent' }));
    // Continue until the server's own no-progress deadline closes all streams.
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
    }
  }
  console.log(JSON.stringify({ mode, completed, overload, maxMs }));
} finally {
  for (const req of requests) req.destroy();
}
```

Set only non-secret locators in the coordinator shell. Token values never enter
shell arguments. Use actual projected-file paths in the three caller Pods:

```sh
umask 077
TASK_A=<task-pod-a>
TASK_B=<task-pod-b>
CORE=<core-pod>
SPACE_A=<first-space-id>
SPACE_B=<second-space-id>
READ_SPACE=<marked-object-space-id>
READ_OBJECT=<marked-four-MiB-object-id>
TASK_TOKEN=<projected-task-token-path>
CONTROL_TOKEN=<projected-control-token-path>
READ_TOKEN=<projected-read-token-path>
CA=<instance-ca-file-path-in-caller-pods>
POD=$(kubectl -n lifemodel-system get pod -l app.kubernetes.io/name=storage-module -o jsonpath='{.items[0].metadata.name}')
kubectl -n lifemodel-system wait --for=condition=Ready pod/"$POD" --timeout=60s
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

Start the RSS sampler before the callers. The deployed module runs Node as PID 1;
verify that process identity first. This samples actual `VmRSS`, not a request or
container memory limit. A missing sample or a value above 524288 KiB fails.

```sh
kubectl -n lifemodel-system exec "$POD" -- node --input-type=module -e '
import {readFile} from "node:fs/promises";
if (!(await readFile("/proc/1/comm","utf8")).trim().startsWith("node")) process.exit(2);
let samples=0,maxKiB=0;
const timer=setInterval(async()=>{
 const rss=/^VmRSS:\s+(\d+) kB$/m.exec(await readFile("/proc/1/status","utf8"));
 if(!rss) process.exit(3);
 samples++; maxKiB=Math.max(maxKiB,Number(rss[1]));
 if(maxKiB>524288) process.exit(4);
},100);
setTimeout(()=>{clearInterval(timer);console.log(JSON.stringify({samples,maxKiB}));process.exit(samples?0:5)},20000);
' > /tmp/storage-pressure-rss.json &
RSS_PID=$!
kubectl -n lifemodel-motor exec -i "$TASK_A" -- node --input-type=module - task "$TASK_TOKEN" "$CA" "$SPACE_A" < /tmp/storage-pressure-walk.mjs > /tmp/storage-pressure-a.jsonl &
A_PID=$!
kubectl -n lifemodel-motor exec -i "$TASK_B" -- node --input-type=module - task "$TASK_TOKEN" "$CA" "$SPACE_B" < /tmp/storage-pressure-walk.mjs > /tmp/storage-pressure-b.jsonl &
B_PID=$!
kubectl -n lifemodel exec -i "$CORE" -- node --input-type=module - control "$CONTROL_TOKEN" "$CA" < /tmp/storage-pressure-walk.mjs > /tmp/storage-pressure-control.jsonl &
CONTROL_PID=$!
kubectl -n lifemodel exec -i "$CORE" -- node --input-type=module - read "$READ_TOKEN" "$CA" "$READ_SPACE" "$READ_OBJECT" < /tmp/storage-pressure-walk.mjs > /tmp/storage-pressure-read.jsonl &
READ_PID=$!
wait "$A_PID"; A_STATUS=$?
wait "$B_PID"; B_STATUS=$?
wait "$CONTROL_PID"; CONTROL_STATUS=$?
wait "$READ_PID"; READ_STATUS=$?
wait "$RSS_PID"; RSS_STATUS=$?
printf 'taskA=%s taskB=%s control=%s read=%s rss=%s\n' "$A_STATUS" "$B_STATUS" "$CONTROL_STATUS" "$READ_STATUS" "$RSS_STATUS"
```

All five own exit statuses must be zero. Keep the summaries as acceptance
artifacts. Then run one stalled upload in A with twenty full 4 MiB PUTs in B;
each ACK must be under 2 seconds. Start the control and read modes again in
parallel with these callers. Do not count saturated queued partial uploads as
the second-task throughput proof.

```sh
kubectl -n lifemodel-motor exec -i "$TASK_A" -- node --input-type=module - stall "$TASK_TOKEN" "$CA" "$SPACE_A" < /tmp/storage-pressure-walk.mjs > /tmp/storage-pressure-stall.jsonl &
STALL_PID=$!
kubectl -n lifemodel-motor exec -i "$TASK_B" -- node --input-type=module - put "$TASK_TOKEN" "$CA" "$SPACE_B" < /tmp/storage-pressure-walk.mjs > /tmp/storage-pressure-put.jsonl &
PUT_PID=$!
wait "$PUT_PID"; PUT_STATUS=$?
wait "$STALL_PID"; STALL_STATUS=$?
printf 'put=%s stall=%s\n' "$PUT_STATUS" "$STALL_STATUS"
```

The `partial-body-sent` line is the VM-side send barrier, not proof of admission.
The isolated test observes admission directly and proves A still owns a worker
after all twenty B ACKs. Preserve timestamps to show the VM calls overlap; if
all B calls finish before A is admitted or after its deadline, repeat the walk.

## Diagnostics and recovery

Save logs privately; do not print them while looking for credentials. Scan field
names and credential-shaped markers and print only the count. Review any match
in the private artifact before accepting it; a zero regex count alone cannot
prove absence of arbitrary personal content.

```sh
kubectl -n lifemodel-system logs "$POD" --since-time="$START" > /tmp/storage-pressure-module.log
node --input-type=module -e '
import {readFile} from "node:fs/promises";
const text=await readFile("/tmp/storage-pressure-module.log","utf8");
const patterns=[/Bearer\s+[^\s"]+/g,/AWS4-HMAC-SHA256/g,/storageTestSecretKey/g,/"(?:body|content|authorization|secretKey|accessKey|connectionString|filename)"\s*:/gi];
const count=patterns.reduce((n,re)=>n+[...text.matchAll(re)].length,0);
console.log(JSON.stringify({suspiciousMatches:count}));process.exit(count?1:0);
'
kubectl -n lifemodel-system wait --for=condition=Ready pod/"$POD" --timeout=60s
```

Do not stop SeaweedFS/PostgreSQL on an owner instance. On the disposable VM only,
use its existing controlled failure/recovery procedure to stop and restore each
store, observe storage-module readiness down/up, and preserve those probe
outcomes. Liveness must remain up. This document does not invent a rollout or
store restart command. Record a blocked store-failure step rather than perform
an unapproved disruption. Delete disposable caller tasks and unretained walk
allocations through their normal lifecycle after evidence is saved.
