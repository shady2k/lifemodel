import { randomUUID } from 'node:crypto';
import { getEventListeners, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  get,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../src/ports/message-attachment.js';
import { StorageTaskArtifactReader } from '../../src/storage/task-artifact-reader.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { CreatureStateStore } from '../../src/storage/creature-state-store.js';
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import { createWebServer } from '../../src/web/server.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createStorageCertificate } from '../helpers/storage-certificate.js';
import { createTestStores } from '../helpers/test-stores.js';
import { silentModelStatus } from '../helpers/model-status.js';

const TOKEN = 'test-web-artifact-service-token';
const LIMIT = 4 * 1024 * 1024;
const PREFIX = 16 * 1024;
const COOKIE_A = '__Host-lm_session=download-owner-a';
const COOKIE_B = '__Host-lm_session=download-owner-b';

type StoredArtifact = {
  bytes: Buffer;
  hold: boolean;
  unavailable: boolean;
  status?: number;
  headers?: Record<string, string>;
  opened: ReturnType<typeof Promise.withResolvers<ServerResponse>>;
  closed: ReturnType<typeof Promise.withResolvers<void>>;
};

type Download = {
  status: number;
  headers: IncomingHttpHeaders;
  firstByte: Promise<void>;
  done: Promise<{ bytes: Buffer; complete: boolean }>;
  response: IncomingMessage;
};

/** Real HTTP preserves malformed/encoded paths instead of normalizing them as fetch does. */
function download(base: string, path: string, cookie?: string, range?: string): Promise<Download> {
  return new Promise((resolve, reject) => {
    const request = get(`${base}${path}`, {
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(range === undefined ? {} : { range }),
      },
    });
    request.on('error', reject);
    request.once('response', (response) => {
      const first = Promise.withResolvers<void>();
      const done = Promise.withResolvers<{ bytes: Buffer; complete: boolean }>();
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        first.resolve();
      });
      const finish = () =>
        done.resolve({ bytes: Buffer.concat(chunks), complete: response.complete });
      response.on('end', finish);
      response.on('error', finish);
      response.on('close', finish);
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        firstByte: first.promise,
        done: done.promise,
        response,
      });
    });
  });
}

describe('recipient-scoped task artifact downloads over HTTP and verified storage TLS', () => {
  let stores: Awaited<ReturnType<typeof createTestStores>>;
  let certificate: Awaited<ReturnType<typeof createStorageCertificate>>;
  let directory: string;
  let tls: HttpsServer;
  let endpoint: string;
  let reader: StorageTaskArtifactReader;
  const servers: ReturnType<typeof createWebServer>[] = [];
  const bases: string[] = [];
  const artifacts = new Map<string, StoredArtifact>();
  const requests: { path: string; authorization: string | undefined; range: string | undefined }[] =
    [];
  const liveResponses = new Set<ServerResponse>();
  let tlsConnections = 0;
  const downloads = new Set<Download>();
  const recipients = ['artifact-recipient-a', 'artifact-recipient-b'];
  const cookies = [COOKIE_A, COOKIE_B];
  const sessions = [
    { active: true, unavailable: false, denied: Promise.withResolvers<void>() },
    { active: true, unavailable: false, denied: Promise.withResolvers<void>() },
  ];

  const open = async (index: number, id: string, cookie = cookies[index], range?: string) => {
    const result = await download(bases[index]!, `/api/attachments/${id}`, cookie, range);
    downloads.add(result);
    return result;
  };

  async function seed(
    recipient = 0,
    options: { bytes?: Buffer; hold?: boolean; name?: string; contentType?: string } = {}
  ): Promise<{ attachment: MessageAttachment; stored: StoredArtifact }> {
    const artifactId = randomUUID();
    const bytes = options.bytes ?? Buffer.from('task output: private recipient bytes');
    const attachment: MessageAttachment = {
      artifactId,
      name: options.name ?? 'result.txt',
      size: bytes.length,
      contentType: options.contentType ?? 'text/plain',
    };
    const stored: StoredArtifact = {
      bytes,
      hold: options.hold ?? false,
      unavailable: false,
      opened: Promise.withResolvers<ServerResponse>(),
      closed: Promise.withResolvers<void>(),
    };
    artifacts.set(artifactId, stored);
    await new PostgresConversationStore(stores.postgres).save(
      `conversation:${recipients[recipient]}`,
      {
        messages: [
          {
            role: 'assistant',
            content: 'The task produced an attachment.',
            timestamp: new Date().toISOString(),
            messageId: randomUUID(),
            attachments: [attachment],
          },
        ],
      }
    );
    return { attachment, stored };
  }

  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-artifact-download-'));
    await writeFile(join(directory, 'token'), TOKEN, { mode: 0o600 });
    await writeFile(join(directory, 'ca.pem'), certificate.ca);
    tls = createServer({ cert: certificate.cert, key: certificate.key }, (request, response) => {
      request.on('error', () => undefined);
      response.on('error', () => undefined);
      liveResponses.add(response);
      response.once('close', () => liveResponses.delete(response));
      requests.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        range: request.headers.range,
      });
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const match = /^\/artifacts\/([0-9a-f-]{36})$/.exec(request.url ?? '');
      const stored = match ? artifacts.get(match[1]!) : undefined;
      if (!stored || stored.unavailable) {
        response.writeHead(404).end();
        return;
      }
      response.once('close', () => stored.closed.resolve());
      if (stored.status) {
        response.writeHead(stored.status).end();
        return;
      }
      const range = request.headers.range;
      const bounds = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      const start = bounds ? Number(bounds[1]) : 0;
      const end = bounds
        ? Math.min(Number(bounds[2]), stored.bytes.length - 1)
        : stored.bytes.length - 1;
      if (start >= stored.bytes.length) {
        response.writeHead(416).end();
        return;
      }
      const body = stored.bytes.subarray(start, end + 1);
      response.writeHead(range ? 206 : 200, {
        'content-length': String(body.length),
        'x-storage-size': String(stored.bytes.length),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${stored.bytes.length}` } : {}),
        ...stored.headers,
      });
      if (stored.hold) response.write(body.subarray(0, PREFIX));
      else response.end(body);
      stored.opened.resolve(response);
    });
    // Bind both loopback families: the HTTPS client may prefer IPv4 even when
    // localhost resolves first to IPv6 inside the isolated test container.
    tls.on('secureConnection', () => {
      tlsConnections += 1;
    });
    tls.listen({ port: 0, host: '::', ipv6Only: false });
    await once(tls, 'listening');
    const address = tls.address();
    if (!address || typeof address === 'string')
      throw new Error('Storage TLS listener did not start');
    endpoint = `https://localhost:${address.port}`;
    reader = new StorageTaskArtifactReader({
      endpoint,
      tokenFile: join(directory, 'token'),
      caFile: join(directory, 'ca.pem'),
      requestTimeoutMs: 10_000,
    });
    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index]!;
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipient);
      const server = createWebServer({
        allowedOrigin: 'https://lifemodel.local',
        instanceName: 'lifemodel',
        appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
        runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
        intake: new OwnerMessageIntake(stores.redis, recipient, { transcript }),
        transcript,
        creatureState: new CreatureStateStore(stores.redis),
        modelStatus: silentModelStatus(),
        logger: { info: vi.fn() },
        attachments: {
          authorizer: transcript,
          reader,
          sessions: {
            verify: async (cookie, signal) => {
              if (sessions[index]!.unavailable) {
                sessions[index]!.denied.resolve();
                throw new Error('loader_session_service_unavailable');
              }
              const valid = !signal.aborted && sessions[index]!.active && cookie === cookies[index];
              if (!sessions[index]!.active) sessions[index]!.denied.resolve();
              return valid;
            },
          },
          sessionCheckMs: 20,
        },
      });
      servers.push(server);
      await server.listen({ host: '127.0.0.1', port: 0 });
      const webAddress = server.server.address();
      if (!webAddress || typeof webAddress === 'string')
        throw new Error('Web HTTP listener did not start');
      bases.push(`http://127.0.0.1:${webAddress.port}`);
    }
  }, 30_000);

  afterEach(async () => {
    for (const result of downloads) result.response.destroy();
    downloads.clear();
    for (const response of liveResponses) response.destroy();
    for (const session of sessions) {
      session.active = true;
      session.unavailable = false;
      session.denied = Promise.withResolvers<void>();
    }
  });

  afterAll(async () => {
    for (const response of liveResponses) response.destroy();
    await Promise.all(servers.map((server) => server.close()));
    reader?.close();
    if (tls) {
      tls.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        tls.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await stores?.redis.quit();
    await stores?.postgres.end();
    certificate?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 15_000);

  it('requires a fresh owner session and scopes artifact IDs to the saved recipient', async () => {
    const first = await seed(0);
    const second = await seed(1);
    const before = requests.length;
    for (const cookie of ['', '__Host-lm_session=expired', COOKIE_B]) {
      const denied = await open(0, first.attachment.artifactId, cookie);
      expect(denied.status).toBe(401);
      expect((await denied.done).complete).toBe(true);
    }
    const foreign = await open(1, first.attachment.artifactId);
    expect(foreign.status).toBe(404);
    await foreign.done;
    expect(requests).toHaveLength(before);
    for (const [index, value] of [
      [0, first],
      [1, second],
    ] as const) {
      const accepted = await open(index, value.attachment.artifactId);
      expect(accepted.status).toBe(200);
      expect(await accepted.done).toEqual({ bytes: value.stored.bytes, complete: true });
      expect(requests.at(-1)).toEqual({
        path: `/artifacts/${value.attachment.artifactId}`,
        authorization: `Bearer ${TOKEN}`,
        range: undefined,
      });
    }
  });

  it('rejects encoded IDs, traversal, uppercase IDs, unknown IDs and query suffixes without opening storage', async () => {
    const { attachment } = await seed();
    const before = requests.length;
    for (const id of [
      '..%2f..%2fprivate',
      '%252e%252e%252fprivate',
      `%${attachment.artifactId.charCodeAt(0).toString(16)}${attachment.artifactId.slice(1)}`,
      attachment.artifactId.toUpperCase(),
      randomUUID(),
      `${attachment.artifactId}?path=private`,
    ]) {
      const result = await open(0, id);
      expect(result.status).toBe(404);
      await result.done;
    }
    expect(requests).toHaveLength(before);
  });

  it('escapes hostile filenames and forces active HTML into a private sandboxed download', async () => {
    const name = 'report";\r\nX-Evil: yes/../../<script>é.html';
    const { attachment, stored } = await seed(0, {
      name,
      contentType: 'text/html',
      bytes: Buffer.from('<script>parent.alert("unsafe")</script>'),
    });
    const result = await open(0, attachment.artifactId);
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/octet-stream');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-security-policy']).toBe('sandbox');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-evil']).toBeUndefined();
    const disposition = result.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment; filename="download"; filename\*=UTF-8''/);
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect(decodeURIComponent(disposition!.split("filename*=UTF-8''")[1]!)).toBe(name);
    expect(await result.done).toEqual({ bytes: stored.bytes, complete: true });
  });

  it('passes a single explicit range of at most 4 MiB and rejects ambiguous or oversized requests', async () => {
    const bytes = Buffer.alloc(LIMIT + 2, 0x61);
    bytes[17] = 0x62;
    const { attachment } = await seed(0, { bytes });
    const result = await open(0, attachment.artifactId, COOKIE_A, `bytes=0-${LIMIT - 1}`);
    expect(result.status).toBe(206);
    expect(result.headers['content-range']).toBe(`bytes 0-${LIMIT - 1}/${bytes.length}`);
    expect(result.headers['content-length']).toBe(String(LIMIT));
    expect(result.headers['accept-ranges']).toBe('bytes');
    const received = await result.done;
    expect(received.complete).toBe(true);
    expect(received.bytes.length).toBe(LIMIT);
    expect(received.bytes[16]).toBe(0x61);
    expect(received.bytes[17]).toBe(0x62);
    expect(received.bytes[18]).toBe(0x61);
    expect(received.bytes[LIMIT - 1]).toBe(0x61);
    expect(received.bytes.equals(bytes.subarray(0, LIMIT))).toBe(true);
    expect(requests.at(-1)?.range).toBe(`bytes=0-${LIMIT - 1}`);
    const before = requests.length;
    for (const range of [
      'bytes=0-',
      'bytes=-10',
      'bytes=1-0',
      'bytes=0-1,4-5',
      `bytes=0-${LIMIT}`,
      'bytes=9007199254740992-9007199254740993',
    ]) {
      const rejected = await open(0, attachment.artifactId, COOKIE_A, range);
      expect(rejected.status).toBe(416);
      await rejected.done;
    }
    expect(requests).toHaveLength(before);
  });

  it('releases the storage stream on a client drop and resumes exactly at the received byte offset', async () => {
    const bytes = Buffer.alloc(128 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const { attachment, stored } = await seed(0, { bytes, hold: true });
    const interrupted = await open(0, attachment.artifactId);
    await interrupted.firstByte;
    interrupted.response.destroy();
    const partial = await interrupted.done;
    expect(partial.complete).toBe(false);
    expect(partial.bytes.length).toBeGreaterThan(0);
    expect(partial.bytes.length).toBeLessThan(bytes.length);
    await stored.closed.promise;
    stored.hold = false;
    const resumed = await open(
      0,
      attachment.artifactId,
      COOKIE_A,
      `bytes=${partial.bytes.length}-${bytes.length - 1}`
    );
    expect(resumed.status).toBe(206);
    const remainder = await resumed.done;
    expect(remainder.complete).toBe(true);
    expect(Buffer.concat([partial.bytes, remainder.bytes])).toEqual(bytes);
  });

  it.each(['expired', 'tombstoned'])(
    'aborts an artifact that becomes %s midstream and refuses a resume',
    async () => {
      const { attachment, stored } = await seed(0, {
        bytes: Buffer.alloc(128 * 1024, 0x65),
        hold: true,
      });
      const result = await open(0, attachment.artifactId);
      await result.firstByte;
      const upstream = await stored.opened.promise;
      stored.unavailable = true;
      upstream.destroy(); // Storage's lifecycle watcher closes a no-longer-authorized object.
      const ended = await result.done;
      expect(ended.complete).toBe(false);
      expect(ended.bytes.length).toBeLessThan(attachment.size);
      await stored.closed.promise;
      const retry = await open(
        0,
        attachment.artifactId,
        COOKIE_A,
        `bytes=${ended.bytes.length}-${attachment.size - 1}`
      );
      expect(retry.status).toBe(404);
      await retry.done;
    }
  );

  it('ends an idle midstream transfer when its loader session is revoked', async () => {
    const { attachment, stored } = await seed(0, {
      bytes: Buffer.alloc(128 * 1024, 0x72),
      hold: true,
    });
    const result = await open(0, attachment.artifactId);
    await result.firstByte;
    sessions[0]!.active = false;
    await sessions[0]!.denied.promise;
    const ended = await result.done;
    expect(ended.complete).toBe(false);
    expect(ended.bytes.length).toBeLessThan(attachment.size);
    await stored.closed.promise;
    const retry = await open(0, attachment.artifactId);
    expect(retry.status).toBe(401);
    await retry.done;
  });

  it('fails closed before opening storage when the loader session service is unavailable', async () => {
    const { attachment } = await seed();
    const before = requests.length;
    sessions[0]!.unavailable = true;
    const result = await open(0, attachment.artifactId);
    await sessions[0]!.denied.promise;
    expect(result.status).toBe(503);
    const ended = await result.done;
    expect(ended.complete).toBe(true);
    expect(ended.bytes.toString()).not.toContain('private recipient bytes');
    expect(requests).toHaveLength(before);
  });

  it('does not forward another chunk when the loader session service fails midstream', async () => {
    const bytes = Buffer.alloc(128 * 1024, 0x6f);
    const { attachment, stored } = await seed(0, { bytes, hold: true });
    const result = await open(0, attachment.artifactId);
    await result.firstByte;
    const upstream = await stored.opened.promise;
    sessions[0]!.unavailable = true;
    upstream.end(bytes.subarray(PREFIX));
    await sessions[0]!.denied.promise;
    const ended = await result.done;
    expect(ended.complete).toBe(false);
    expect(ended.bytes).toEqual(bytes.subarray(0, PREFIX));
    await stored.closed.promise;
  });

  it('does not bless incomplete upstream bytes as a complete download', async () => {
    const { attachment, stored } = await seed(0, {
      bytes: Buffer.alloc(128 * 1024, 0x69),
      hold: true,
    });
    const result = await open(0, attachment.artifactId);
    await result.firstByte;
    (await stored.opened.promise).destroy();
    const ended = await result.done;
    expect(ended.complete).toBe(false);
    expect(ended.bytes.length).toBeLessThan(attachment.size);
  });

  it.each([
    { 'content-length': '999' },
    { 'x-storage-size': '999' },
    { 'content-range': 'bytes 1-9/36' },
    { 'content-encoding': 'gzip' },
  ])('rejects inconsistent storage framing %j before exposing bytes', async (headers) => {
    const { attachment, stored } = await seed();
    stored.headers = headers;
    const result = await open(0, attachment.artifactId, COOKIE_A, 'bytes=0-9');
    expect(result.status).toBe(503);
    const ended = await result.done;
    expect(ended.bytes.toString()).not.toContain('task output');
  });

  it('requires the configured CA and re-reads the projected service token for each request', async () => {
    const { attachment } = await seed();
    const otherCertificate = await createStorageCertificate(['localhost']);
    const wrongCa = join(directory, 'wrong-ca.pem');
    await writeFile(wrongCa, otherCertificate.ca);
    const untrusted = new StorageTaskArtifactReader({
      endpoint,
      tokenFile: join(directory, 'token'),
      caFile: wrongCa,
      requestTimeoutMs: 1_000,
    });
    try {
      await expect(
        untrusted.openTaskArtifact(attachment.artifactId, undefined, new AbortController().signal)
      ).rejects.toMatchObject({ status: 503 });
      await writeFile(join(directory, 'token'), 'revoked-service-token');
      const rejected = await open(0, attachment.artifactId);
      expect(rejected.status).toBe(503);
      await rejected.done;
      expect(requests.at(-1)?.authorization).toBe('Bearer revoked-service-token');
    } finally {
      untrusted.close();
      otherCertificate.cleanup();
      await writeFile(join(directory, 'token'), TOKEN, { mode: 0o600 });
    }
    const restored = await open(0, attachment.artifactId);
    expect(restored.status).toBe(200);
    expect((await restored.done).complete).toBe(true);
  });

  it('reuses bounded TLS connections without accumulating listeners across twelve ranges', async () => {
    const { attachment, stored } = await seed(0, { bytes: Buffer.alloc(128, 0x6c) });
    const controller = new AbortController();
    const baseline = tlsConnections;
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      for (let index = 0; index < 12; index += 1) {
        const opened = await reader.openTaskArtifact(
          attachment.artifactId,
          `bytes=${index}-${index + 9}`,
          controller.signal
        );
        const chunks: Buffer[] = [];
        for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).equals(stored.bytes.subarray(index, index + 10))).toBe(true);
      }
      // Node dispatches listener warnings on its next turn, not from socket.on itself.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warnings).toEqual([]);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(tlsConnections - baseline).toBeLessThanOrEqual(2);
    } finally {
      process.removeListener('warning', onWarning);
      controller.abort();
    }
  });

  it('rejects a reader body that was destroyed before the route could attach its handlers', async () => {
    const { attachment } = await seed();
    const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipients[0]!);
    const body = new PassThrough();
    body.destroy();
    const damaged = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: new OwnerMessageIntake(stores.redis, recipients[0]!, { transcript }),
      transcript,
      creatureState: new CreatureStateStore(stores.redis),
      modelStatus: silentModelStatus(),
      logger: { info: vi.fn() },
      attachments: {
        authorizer: transcript,
        reader: {
          openTaskArtifact: async () => ({
            body,
            size: attachment.size,
            start: 0,
            end: attachment.size - 1,
            partial: false,
          }),
        },
        sessions: { verify: async () => true },
      },
    });
    try {
      const response = await damaged.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.artifactId}`,
        headers: { cookie: COOKIE_A },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({ error: 'artifact_not_available' });
    } finally {
      await damaged.close();
    }
  });

  // Keep this last: it intentionally shuts down recipient A's shared HTTP listener.
  it('closes a held upstream transfer when the web server shuts down', async () => {
    const { attachment, stored } = await seed(0, {
      bytes: Buffer.alloc(128 * 1024, 0x63),
      hold: true,
    });
    const result = await open(0, attachment.artifactId);
    await result.firstByte;
    const closed = servers[0]!.close();
    const ended = await result.done;
    expect(ended.complete).toBe(false);
    expect(ended.bytes.length).toBe(PREFIX);
    await stored.closed.promise;
    await closed;
  });
});
