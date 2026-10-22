/** Real child listeners, Kubernetes identity, SigV4 S3 and PostgreSQL retention boundary. */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { createTestStores, workerDatabaseUrl } from './test-stores.js';
import { applyTestMigrations } from './apply-test-migrations.js';
import { createSealIdentity } from './storage-seal-identity.js';
import { createSealS3 } from './storage-seal-s3.js';
import { createSealSqlProxy } from './storage-seal-sql-proxy.js';

export const DAY = 86_400_000;
export const TERMINAL = Date.UTC(2030, 0, 1);
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export type RetentionChild = {
  process: ChildProcess;
  ports: Record<'task' | 'control' | 'read', number>;
};
type Reply = { status: number; body: Buffer; json: any };
export type RetainedArtifact = {
  space: string;
  id: string;
  key: string;
  bytes: Buffer;
  task: string;
};

export async function createRetentionHarness(bucket = 'task-output') {
  const stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
  const sqlProxy = await createSealSqlProxy(workerDatabaseUrl());
  const identity = await createSealIdentity();
  const backend = await createSealS3({ bucket });
  const root = await mkdtemp(join(tmpdir(), 'storage-retention-'));
  await writeFile(join(root, 'tls.crt'), identity.certificate.cert);
  await writeFile(join(root, 'tls.key'), identity.certificate.key, {
    mode: 0o600,
  });
  await writeFile(
    join(root, 'entry-settings.json'),
    JSON.stringify({
      version: 1,
      revision: 1,
      values: { 'storage.retention': '90d', 'storage.warningLeadDays': 7 },
    })
  );
  const children = new Set<RetentionChild>();
  const releases: Array<() => void> = [];
  let current: RetentionChild;
  let now = TERMINAL;
  let settings: {
    retention: '90d' | 'forever';
    warningLeadDays: number;
    revision: number;
  } = {
    retention: '90d',
    warningLeadDays: 7,
    revision: 1,
  };
  let sequence = 0;
  async function start(entry?: { baoAddress: string; serviceAccount: string }) {
    const configFile = join(root, `config-${++sequence}.json`);
    await writeFile(
      configFile,
      JSON.stringify({
        connectionString: sqlProxy.connectionString,
        identity: identity.options,
        endpoint: backend.endpoint,
        credentials: backend.credentials,
        certificate: identity.certificate,
        now,
        settings,
        ...(entry ?? {}),
      }),
      { mode: 0o600 }
    );
    const processChild = fork(
      fileURLToPath(
        new URL(
          entry
            ? '../fixtures/storage-module-startup-child.ts'
            : '../fixtures/storage-retention-child.ts',
          import.meta.url
        )
      ),
      [configFile],
      {
        execArgv: ['--import', 'tsx'],
        env: entry
          ? {
              ...process.env,
              LIFEMODEL_OPENBAO_ADDRESS: entry.baoAddress,
              LIFEMODEL_STORAGE_S3_ENDPOINT: backend.endpoint,
              LIFEMODEL_STORAGE_BUCKET: 'lifemodel-storage',
              LIFEMODEL_DB_USERNAME: decodeURIComponent(
                new URL(sqlProxy.connectionString).username
              ),
              LIFEMODEL_DB_PASSWORD: decodeURIComponent(
                new URL(sqlProxy.connectionString).password
              ),
              LIFEMODEL_STORAGE_TLS_DIR: root,
              LIFEMODEL_STORAGE_SETTINGS_PATH: join(root, 'entry-settings.json'),
              KUBERNETES_SERVICE_HOST: 'localhost',
              KUBERNETES_SERVICE_PORT_HTTPS: new URL(identity.options.apiServer).port,
            }
          : process.env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }
    );
    processChild.on('error', () => undefined);
    processChild.stdout?.on('error', () => undefined);
    processChild.stderr?.on('error', () => undefined);
    let stderr = '';
    processChild.stderr?.on('data', (part) => {
      stderr = (stderr + String(part)).slice(-8192);
    });
    const child: RetentionChild = {
      process: processChild,
      ports: {} as RetentionChild['ports'],
    };
    children.add(child);
    processChild.once('exit', () => children.delete(child));
    const ports = await new Promise<RetentionChild['ports']>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('retention child startup deadline')), 15_000);
      processChild.once('message', (message: any) => {
        clearTimeout(timer);
        resolve(message.ready);
      });
      processChild.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(Error(`retention child exited ${code ?? signal}: ${stderr}`));
      });
      processChild.once('error', () => {
        clearTimeout(timer);
        reject(Error('retention child start failed'));
      });
    });
    child.ports = ports;
    current = child;
    return child;
  }
  async function kill(child = current) {
    if (!child || child.process.exitCode !== null || child.process.signalCode !== null) return;
    const exited = once(child.process, 'exit');
    expect(child.process.kill('SIGKILL')).toBe(true);
    const [, signal] = await exited;
    expect(signal).toBe('SIGKILL');
    children.delete(child);
  }
  async function ipc(command: string, value: unknown = {}, child = current) {
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        child.process.off('message', message);
        child.process.off('exit', exit);
      };
      const message = (reply: any) => {
        if (reply.id !== id) return;
        finish();
        if (reply.error) reject(Error(`retention IPC ${reply.error}`));
        else resolve(reply.result);
      };
      const exit = () => {
        finish();
        reject(Error('retention child exited during IPC'));
      };
      const timer = setTimeout(() => {
        finish();
        reject(Error('retention IPC deadline'));
      }, 15_000);
      child.process.on('message', message);
      child.process.once('exit', exit);
      child.process.send({ id, command, value }, (error) => {
        if (error) {
          finish();
          reject(error);
        }
      });
    });
  }
  async function clock(at: number, update: Partial<typeof settings> = {}) {
    now = at;
    settings = { ...settings, ...update };
    await Promise.all([...children].map((child) => ipc('clock', { now, settings }, child)));
  }
  async function call(
    listener: keyof RetentionChild['ports'],
    method: string,
    path: string,
    value?: unknown,
    token = listener === 'control' ? 'core' : listener === 'read' ? 'coreRead' : 'a',
    headers: Record<string, string> = {},
    child = current
  ): Promise<Reply> {
    const body = Buffer.isBuffer(value)
      ? value
      : value === undefined
        ? undefined
        : Buffer.from(JSON.stringify(value));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port: child.ports[listener],
          path,
          method,
          ca: identity.certificate.ca,
          agent: false,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-length': String(body.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          res.on('error', reject);
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            let json: any;
            try {
              json = JSON.parse(bytes.toString());
            } catch {
              /* object bytes */
            }
            resolve({ status: res.statusCode!, body: bytes, json });
          });
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', reject);
      req.setTimeout(15_000, () => req.destroy(Error('retention HTTP deadline')));
      req.end(body);
    });
  }
  async function prepare(task = 'a') {
    const allocated = await call('control', 'POST', '/allocate', {
      taskId: task,
      launchId: task,
      effectKey: `allocate-${task}`,
      retentionRevision: 'retention-1',
    });
    expect(allocated.status, JSON.stringify(allocated.json)).toBe(200);
    const space = allocated.json.space as string;
    await stores.postgres.query(
      `INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at)
      VALUES($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`,
      [task]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at,pod_name,job_name)
      SELECT task_id,attempt_id,launch_id,$2,$3,$4,0,0,'active',soft_due_at,hard_stop_at,$1,$2 FROM task_access.intents WHERE task_id=$1`,
      [task, `job-${task}`, `pod-${task}`, space]
    );
    const bound = await call('control', 'POST', '/bind', {
      space,
      taskId: task,
      attemptId: task,
      launchId: task,
      effectKey: `bind-${task}`,
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    return space;
  }
  async function upload(
    space: string,
    task = 'a',
    uploadId = 'output',
    bytes = Buffer.from('retained output')
  ) {
    const uploaded = await call(
      'task',
      'PUT',
      `/spaces/${space}/objects/${uploadId}`,
      bytes,
      task,
      {
        'x-storage-name': Buffer.from(`${task}/${uploadId}.txt`).toString('base64url'),
        'x-storage-length': String(bytes.length),
        'x-storage-sha256': sha256(bytes),
      }
    );
    expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(200);
    const id = uploaded.json.id as string;
    const marked = await call(
      'task',
      'POST',
      `/spaces/${space}/objects/${id}/mark`,
      { role: 'result' },
      task
    );
    expect(marked.status).toBe(200);
    const key = (
      await stores.postgres.query(
        `SELECT a.s3_key FROM storage.object_versions v
      JOIN storage.upload_attempts a ON a.id=v.attempt_id WHERE v.object_id=$1`,
        [id]
      )
    ).rows[0].s3_key as string;
    return { space, id, key, bytes, task };
  }
  async function seal(space: string, task = 'a') {
    const result = await call('control', 'POST', '/seal', {
      space,
      effectKey: `seal-${task}`,
      expectedRevision: '0',
      outcome: 'completed',
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json.state).toBe('sealed');
    return result.json;
  }
  async function artifact(task = 'a', bytes?: Buffer) {
    const space = await prepare(task);
    const result = await upload(space, task, 'output', bytes);
    await seal(space, task);
    return result;
  }
  /** Seed extra immutable metadata via the real publication SQL; no 100 HTTP PUTs. */
  async function batch(count = 100) {
    const space = await prepare();
    const first = await upload(space);
    const artifacts = [first];
    for (let n = 1; n < count; n++) {
      const id = randomUUID();
      const attempt = randomUUID();
      const key = `private/${attempt}`;
      const uploadId = `metadata-${n}`;
      const name = `a/${uploadId}.txt`;
      const digest = sha256(first.bytes);
      await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
        space,
        uploadId,
        id,
        name,
        first.bytes.length,
        digest,
      ]);
      await stores.postgres.query(
        'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
        [attempt, space, uploadId, key]
      );
      await stores.postgres.query('SELECT storage.complete_upload($1,$2,$3)', [
        space,
        uploadId,
        attempt,
      ]);
      await stores.postgres.query("UPDATE storage.objects SET mark='artifact' WHERE id=$1", [id]);
      await stores.postgres.query(
        `UPDATE storage.object_versions SET receipt=jsonb_set(receipt,'{mark}','"artifact"'::jsonb) WHERE object_id=$1`,
        [id]
      );
      backend.objects.set(key, { ...backend.objects.get(first.key)! });
      artifacts.push({ ...first, id, key });
    }
    await seal(space);
    return artifacts;
  }
  async function pending(query = '') {
    const response = await call('control', 'GET', `/retention/plans${query}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.json.plans).toEqual(expect.any(Array));
    expect(response.json.nextCursor === null || typeof response.json.nextCursor === 'string').toBe(
      true
    );
    return response.json as { plans: any[]; nextCursor: string | null };
  }
  async function warn(planId: string, messageId = 'owner-message') {
    return call('control', 'POST', '/retention/warningCommitted', {
      planId,
      messageId,
    });
  }
  async function policy(
    space: string,
    operation: 'pin' | 'unpin' | 'retention',
    expectedRevision = '0',
    effectKey = `${operation}-${space}`,
    retention?: '90d' | 'forever'
  ) {
    return call(
      'control',
      'POST',
      `/retention/${operation === 'retention' ? 'policy' : operation}`,
      {
        space,
        effectKey,
        expectedRevision,
        ...(retention ? { retention } : {}),
      }
    );
  }
  async function reset() {
    for (const child of [...children]) await kill(child);
    for (const release of releases.splice(0)) release();
    await stores.postgres.query(
      'TRUNCATE task_access.projections,task_access.intents,storage.spaces,storage.deletion_plans,storage.orphan_gc,storage.retention_receipts,storage.reclaim_receipts CASCADE'
    );
    await stores.postgres.query('UPDATE storage.instance_ledger SET used_bytes=0 WHERE id=true');
    await stores.postgres.query(
      "UPDATE storage.maintenance SET state='normal',purpose=NULL,generation=NULL,effect_key=NULL,cut_at=NULL WHERE id=true"
    );
    await stores.postgres.query('TRUNCATE storage.restore_progress');
    backend.reset();
    identity.deadPods.clear();
    identity.deadJobs.clear();
    now = TERMINAL;
    settings = { retention: '90d', warningLeadDays: 7, revision: 1 };
    sqlProxy.restore();
    await start();
  }
  async function cleanup() {
    for (const release of releases.splice(0)) release();
    for (const child of [...children]) await kill(child);
  }
  async function close() {
    await cleanup();
    await sqlProxy.close();
    await backend.close();
    await identity.close();
    await stores.postgres.end();
    await stores.redis.quit();
    await rm(root, { recursive: true, force: true });
  }
  return {
    stores,
    ipc,
    projection: (value: unknown) => ipc('projection', value),
    ownerClock: (value: number) => ipc('ownerClock', value),
    sqlProxy,
    backend,
    identity,
    releases,
    start,
    kill,
    clock,
    call,
    prepare,
    upload,
    seal,
    artifact,
    batch,
    pending,
    warn,
    policy,
    reset,
    cleanup,
    close,
    tick: (child?: RetentionChild) => ipc('tick', {}, child),
    child: () => current,
  };
}
