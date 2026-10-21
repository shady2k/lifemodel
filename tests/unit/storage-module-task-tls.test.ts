import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
/**
 * The storage module's TLS task listener (ADR-015 S-D1, ADR-012 Decision 3).
 *
 * The listener serves the instance CA's leaf for the module's in-cluster DNS
 * names. A client that trusts that CA reaches it; a client that does not is
 * refused at the handshake, and there is no plain listener on the task port.
 * The mounted leaf is re-read by a timer the test drives, so a renewal reaches
 * the next handshake without a restart and a failed read keeps the old one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest, type Server as StatusServer } from 'node:http';
import type { Server as SecureServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { STORAGE_MODULE_TLS_HOSTS } from '../../loader/src/pki.js';
import { STORAGE_BUCKET, type StorageS3Credentials } from '../../loader/src/storage-custody.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

const credentials: StorageS3Credentials = {
  accessKey: 'A1B2C3D4E5F60718293A',
  secretKey: 'c2VjcmV0LWtleS1mb3ItdGhlLXN0b3JhZ2UtbW9kdWxl',
};
/** The canonical in-cluster name of the module's Service. */
const host = STORAGE_MODULE_TLS_HOSTS[1];
let certificate: TestStorageCertificate;
let stores: TestStores;
const servers: Array<StatusServer | SecureServer> = [];
beforeAll(async () => {
  stores = await createTestStores();
  await applyTestMigrations(stores.postgres);
  certificate = await createStorageCertificate();
});
afterAll(async () => {
  certificate.cleanup();
  await stores.postgres.end();
  await stores.redis.quit();
});
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Timer callbacks the test fires itself: no wall clock in the reload path. */
function manualTimers() {
  const queued: Array<() => void> = [];
  return {
    timers: {
      set: (callback: () => void) => {
        queued.push(callback);
        return {} as ReturnType<typeof setTimeout>;
      },
      clear: () => undefined,
    },
    fire: () => {
      for (const callback of queued.splice(0)) callback();
    },
    pending: () => queued.length,
  };
}

/** Let the module's async work settle without waiting on a timer. */
async function settleUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

async function fixture(read?: () => Promise<{ cert: string; key: string }>) {
  const lines: RecordedLine[] = [];
  const clock = manualTimers();
  const app = createStorageModule({
    access: createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: createKubernetesStorageIdentity(),
    }),
    bucket: STORAGE_BUCKET,
    catalog: { check: () => Promise.resolve({ ok: true }) },
    custody: { read: () => Promise.resolve(credentials) },
    check: () => Promise.resolve({ ok: true }),
    logger: createRecordingLogger(lines),
    tls: {
      cert: certificate.cert,
      key: certificate.key,
      read: read ?? (() => Promise.resolve({ cert: certificate.cert, key: certificate.key })),
      reloadMs: 1_000,
      timers: clock.timers,
    },
  });
  servers.push(app.task.server, app.status);
  await new Promise<void>((resolve) => app.task.server.listen(0, '127.0.0.1', resolve));
  const address = app.task.server.address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return { app, lines, clock, port: address.port };
}

interface Answer {
  status: number;
  body: string;
  certificate: PeerCertificate;
}

function get(
  port: number,
  options: { ca?: string; path?: string; method?: string } = {}
): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/ping',
        method: options.method ?? 'GET',
        servername: host,
        // A one-off agent: a cached TLS session would resume the old
        // certificate and hide a reload.
        agent: false,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      },
      (response) => {
        // The socket is gone by the time the body ends; read the peer first.
        const certificate = response.socket.getPeerCertificate();
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body, certificate });
        });
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.end();
  });
}

describe('the storage module TLS task listener', () => {
  it('answers a client that trusts the instance CA, on the module leaf', async () => {
    const f = await fixture();
    const answer = await get(f.port, { ca: certificate.ca });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ state: 'ok' });
    // The served certificate is the module's own leaf, not the edge leaf.
    expect(answer.certificate.subjectaltname).toContain(host);
    expect(answer.certificate.subjectaltname).not.toContain('home.local');
    // Neither a leaf nor a key reached the module's log.
    expect(JSON.stringify(f.lines)).not.toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(f.lines)).not.toContain('PRIVATE KEY');
  });

  it('refuses a client that does not trust the instance CA', async () => {
    const f = await fixture();
    await expect(get(f.port)).rejects.toThrow(/self.signed|unable to verify|certificate/i);
  });

  it('refuses a plain HTTP request on the task port', async () => {
    const f = await fixture();
    await expect(
      new Promise((resolve, reject) => {
        const request = httpRequest(
          { host: '127.0.0.1', port: f.port, path: '/ping' },
          (response) => resolve(response.statusCode)
        );
        request.on('error', reject);
        request.end();
      })
    ).rejects.toThrow();
  });

  it('answers only GET /ping over TLS', async () => {
    const f = await fixture();
    expect((await get(f.port, { ca: certificate.ca, path: '/status' })).status).toBe(404);
    expect((await get(f.port, { ca: certificate.ca, method: 'POST' })).status).toBe(404);
    expect((await get(f.port, { ca: certificate.ca })).status).toBe(200);
  });

  it('serves a renewed leaf only after its reload, from the same CA', async () => {
    let mounted = { cert: certificate.cert, key: certificate.key };
    const f = await fixture(() => Promise.resolve(mounted));
    const before = await get(f.port, { ca: certificate.ca });
    const renewed = await certificate.reissue();
    // The kubelet writes the renewed leaf into the mounted Secret.
    mounted = renewed;
    // Nothing serves it until the reload runs.
    expect((await get(f.port, { ca: certificate.ca })).certificate.serialNumber).toBe(
      before.certificate.serialNumber
    );
    await f.app.task.reload();
    const after = await get(f.port, { ca: certificate.ca });
    expect(after.status).toBe(200);
    expect(after.certificate.serialNumber).not.toBe(before.certificate.serialNumber);
    expect(after.certificate.subjectaltname).toContain(host);
    expect(f.lines.filter((line) => line.level === 'info')).toEqual([
      {
        level: 'info',
        fields: { code: 'task_certificate_reloaded' },
        message: expect.any(String),
      },
    ]);
  });

  it('re-reads the mounted leaf on its own timer', async () => {
    let mounted = { cert: certificate.cert, key: certificate.key };
    const f = await fixture(() => Promise.resolve(mounted));
    const before = await get(f.port, { ca: certificate.ca });
    mounted = await certificate.reissue();
    expect(f.clock.pending()).toBe(1);
    f.clock.fire();
    await settleUntil(() => f.clock.pending() === 1 && f.lines.length > 0);
    const after = await get(f.port, { ca: certificate.ca });
    expect(after.certificate.serialNumber).not.toBe(before.certificate.serialNumber);
  });

  it('keeps the last certificate when the mounted Secret cannot be re-read', async () => {
    let failing = false;
    const f = await fixture(() =>
      failing
        ? Promise.reject(new Error('injected read failure'))
        : Promise.resolve({ cert: certificate.cert, key: certificate.key })
    );
    failing = true;
    f.clock.fire();
    await settleUntil(() => f.lines.length > 0);
    const answer = await get(f.port, { ca: certificate.ca });
    expect(answer.status).toBe(200);
    expect(f.lines.filter((line) => line.level === 'warn')).toEqual([
      {
        level: 'warn',
        fields: { code: 'task_certificate_unreadable' },
        message: expect.any(String),
      },
    ]);
    // A second failure is the same state: it does not repeat the line.
    f.clock.fire();
    await settleUntil(() => f.clock.pending() === 1);
    expect(f.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    // Never the file's content and never the reason the read gave.
    expect(JSON.stringify(f.lines)).not.toContain('injected read failure');
  });
});
