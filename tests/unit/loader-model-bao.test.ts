import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRoleBaoClient,
  createCachedSlotReader,
  BaoStorageError,
} from '../../loader/src/model-bao.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { ModelSlot } from '../../loader/src/model.js';

const slot = (model = 'first'): ModelSlot => ({
  kind: 'openai',
  baseUrl: 'https://model.example/prefix/v1',
  model,
  key: 'slot-secret',
});
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bao-client-'));
  roots.push(root);
  const jwtFile = join(root, 'token');
  await writeFile(jwtFile, 'jwt-first');
  const logins: Array<{ role: string; jwt: string }> = [];
  const tokens: Array<string | undefined> = [];
  const paths: string[] = [];
  let status = 200,
    loginStatus = 200,
    rejected = 0,
    lease = 100,
    renewable = true,
    renewals = 0;
  let reply: unknown = { data: { data: slot(), metadata: {} } };
  let onRequest: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? '');
    if (onRequest?.(req, res)) return;
    if (req.url === '/v1/auth/kubernetes/login') {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      logins.push(JSON.parse(body));
      res.writeHead(loginStatus);
      res.end(
        loginStatus === 200
          ? JSON.stringify({
              auth: {
                client_token: `bao-token-${logins.length}`,
                lease_duration: lease,
                renewable,
              },
            })
          : 'PRIVATE BODY jwt-first bao-token-1'
      );
      return;
    }
    tokens.push(
      typeof req.headers['x-vault-token'] === 'string' ? req.headers['x-vault-token'] : undefined
    );
    if (req.url === '/v1/auth/token/renew-self') {
      renewals++;
      res.end(
        JSON.stringify({
          auth: { client_token: `bao-token-${logins.length}`, lease_duration: lease, renewable },
        })
      );
      return;
    }
    if (rejected > 0) {
      rejected--;
      res.writeHead(403);
      res.end('PRIVATE BODY jwt-first bao-token-1');
      return;
    }
    res.writeHead(status);
    res.end(status === 200 ? JSON.stringify(reply) : 'PRIVATE BODY jwt-first bao-token-1');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  let time = 0;
  const lines: RecordedLine[] = [];
  const client = createRoleBaoClient({
    address: `http://127.0.0.1:${address.port}`,
    role: 'model-gateway',
    jwtFile,
    now: () => time,
    logger: createRecordingLogger(lines),
    timeoutMs: 100,
  });
  return {
    client,
    logins,
    tokens,
    paths,
    jwtFile,
    lines,
    get renewals() {
      return renewals;
    },
    set time(value: number) {
      time = value;
    },
    set status(value: number) {
      status = value;
    },
    set loginStatus(value: number) {
      loginStatus = value;
    },
    set rejected(value: number) {
      rejected = value;
    },
    set renewable(value: boolean) {
      renewable = value;
    },
    set lease(value: number) {
      lease = value;
    },
    set reply(value: unknown) {
      reply = value;
    },
    set onRequest(value: (req: IncomingMessage, res: ServerResponse) => boolean) {
      onRequest = value;
    },
  };
}
describe('shared role Bao client over real HTTP', () => {
  it('falls back to one fresh login when renewal is rejected', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    f.onRequest = (req, res) => {
      if (req.url?.endsWith('/renew-self')) {
        res.writeHead(403);
        res.end('PRIVATE BODY');
        return true;
      }
      return false;
    };
    f.time = 70_000;
    await expect(f.client.readSlot('primary')).resolves.toEqual(slot());
    expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
    expect(f.paths.filter((p) => p.endsWith('/renew-self'))).toHaveLength(1);
  });
  it('coalesces concurrent first logins', async () => {
    const f = await fixture();
    await Promise.all([f.client.readSlot('primary'), f.client.readSlot('reserve')]);
    expect(f.logins).toHaveLength(1);
  });
  it('refreshes real KV slots and expires after five minutes of sealed refresh failures', async () => {
    const f = await fixture();
    let time = 0;
    const cache = createCachedSlotReader(f.client.readSlot, () => time);
    await expect(cache.read('primary')).resolves.toEqual(slot());
    f.reply = { data: { data: slot('rotated'), metadata: {} } };
    time = 30_000;
    await expect(cache.read('primary')).resolves.toEqual(slot('rotated'));
    f.status = 503;
    time = 60_000;
    await expect(cache.read('primary')).resolves.toEqual(slot('rotated'));
    time = 360_000;
    await expect(cache.read('primary')).rejects.toMatchObject({ code: 'storage_unavailable' });
    f.status = 200;
    await expect(cache.read('primary')).resolves.toEqual(slot('rotated'));
    cache.invalidate('primary');
    f.status = 503;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
  });
  it('logs in as the requested role and renews before expiry without another login', async () => {
    const f = await fixture();
    await expect(f.client.readSlot('primary')).resolves.toEqual(slot());
    expect(f.logins).toEqual([{ role: 'model-gateway', jwt: 'jwt-first' }]);
    f.time = 69_999;
    await f.client.readSlot('primary');
    expect(f.renewals).toBe(0);
    f.time = 70_000;
    await f.client.readSlot('primary');
    expect(f.renewals).toBe(1);
    expect(f.logins).toHaveLength(1);
    expect(f.tokens).toEqual(['bao-token-1', 'bao-token-1', 'bao-token-1', 'bao-token-1']);
  });
  it('re-reads the rotated JWT file after expiry, never renews an expired token', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    f.time = 100_000;
    await f.client.readSlot('primary');
    expect(f.logins).toEqual([
      { role: 'model-gateway', jwt: 'jwt-first' },
      { role: 'model-gateway', jwt: 'jwt-rotated' },
    ]);
    expect(f.tokens).toEqual(['bao-token-1', 'bao-token-2']);
    expect(f.renewals).toBe(0);
  });
  it('re-obtains a nonrenewable token before expiry', async () => {
    const f = await fixture();
    f.renewable = false;
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    f.time = 70_000;
    await f.client.readSlot('primary');
    expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
    expect(f.renewals).toBe(0);
  });
  it.each([401, 403])(
    'retries a rejected token (%s) exactly once with a freshly read JWT',
    async (status) => {
      const f = await fixture();
      await f.client.readSlot('primary');
      await writeFile(f.jwtFile, 'jwt-rotated');
      let rejects = 1;
      f.onRequest = (req, res) => {
        if (req.url?.includes('/data/') && rejects-- > 0) {
          res.writeHead(status);
          res.end('PRIVATE BODY');
          return true;
        }
        return false;
      };
      await expect(f.client.readSlot('primary')).resolves.toEqual(slot());
      expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
      expect(f.paths.filter((p) => p.includes('/data/'))).toHaveLength(3);
      expect(f.tokens.at(-1)).toBe('bao-token-2');
    }
  );
  it('bounds persistent rejection to two requests and one re-login, even for short leases', async () => {
    const f = await fixture();
    f.lease = 1;
    f.rejected = 10;
    await expect(f.client.readSlot('primary')).rejects.toMatchObject({ code: 'denied' });
    expect(f.logins).toHaveLength(2);
    expect(f.paths.filter((p) => p.includes('/data/'))).toHaveLength(2);
  });
  it.each([403, 503])(
    'types a login failure (%s) without leaking body, token, or JWT',
    async (status) => {
      const f = await fixture();
      f.loginStatus = status;
      let failure: unknown;
      try {
        await f.client.readSlot('primary');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BaoStorageError);
      expect(failure).toMatchObject({ code: status === 503 ? 'sealed' : 'denied' });
      expect(f.logins).toHaveLength(1);
      const recorded = JSON.stringify({
        failure,
        message: (failure as Error).message,
        lines: f.lines,
      });
      for (const secret of ['PRIVATE BODY', 'bao-token-1', 'jwt-first'])
        expect(recorded).not.toContain(secret);
      expect(f.lines).not.toHaveLength(0);
    }
  );
  it('recovers after seal/unseal and never interprets storage errors as unset', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    for (const [status, code] of [
      [503, 'sealed'],
      [500, 'unreachable'],
      [403, 'denied'],
    ] as const) {
      f.status = status;
      await expect(f.client.readSlot('primary')).rejects.toMatchObject({ code });
    }
    f.status = 200;
    await expect(f.client.readSlot('primary')).resolves.toEqual(slot());
  });
  it('treats only missing paths and deleted or destroyed latest versions as unset', async () => {
    const f = await fixture();
    f.status = 404;
    await expect(f.client.readSlot('reserve')).resolves.toBeNull();
    await expect(f.client.call('other/path')).rejects.toMatchObject({ code: 'not_found' });
    f.status = 200;
    for (const metadata of [{ deletion_time: '2026-10-18T00:00:00Z' }, { destroyed: true }]) {
      f.reply = { data: { data: null, metadata } };
      await expect(f.client.readSlot('reserve')).resolves.toBeNull();
    }
    for (const reply of [{}, { data: {} }, { data: { data: { key: 'secret' }, metadata: {} } }]) {
      f.reply = reply;
      await expect(f.client.readSlot('reserve')).rejects.toMatchObject({ code: 'unreachable' });
    }
  });
  it('bounds transport failures, redirects, truncated and malformed bodies with safe errors and logs', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    for (const mode of ['disconnect', 'timeout', 'malformed', 'redirect', 'oversized']) {
      f.onRequest = (_req, res) => {
        if (mode === 'disconnect') res.destroy();
        else if (mode === 'malformed') res.end('PRIVATE BODY jwt-first bao-token-1');
        else if (mode === 'redirect') {
          res.writeHead(302, { location: '/elsewhere' });
          res.end('PRIVATE BODY');
        } else if (mode === 'oversized') res.end('x'.repeat(1024 * 1024 + 1));
        return true;
      };
      let failure: unknown;
      try {
        await f.client.readSlot('primary');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BaoStorageError);
      expect(failure).toMatchObject({ code: 'unreachable' });
      const recorded = JSON.stringify({
        failure,
        message: (failure as Error).message,
        lines: f.lines,
      });
      for (const secret of ['PRIVATE BODY', 'bao-token-1', 'jwt-first'])
        expect(recorded).not.toContain(secret);
    }
    expect(f.paths).not.toContain('/elsewhere');
  });
});
describe('gateway slot cache', () => {
  it('does not resurrect credentials when invalidation races an in-flight refresh', async () => {
    let resolve!: (value: ModelSlot | null) => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const cache = createCachedSlotReader(() => {
      started();
      return new Promise<ModelSlot | null>((r) => {
        resolve = r;
      });
    });
    const pending = cache.read('primary');
    await entered;
    cache.invalidate('primary');
    resolve(slot());
    await expect(pending).rejects.toThrow('storage_unavailable');
  });
  it('refreshes at 30 seconds, caches unset, and invalidates only the selected slot', async () => {
    let time = 0,
      calls = 0,
      value: ModelSlot | null = slot();
    const cache = createCachedSlotReader(
      async () => {
        calls++;
        return value;
      },
      () => time
    );
    await expect(cache.read('primary')).resolves.toEqual(slot());
    time = 29_999;
    await cache.read('primary');
    expect(calls).toBe(1);
    value = slot('rotated');
    time = 30_000;
    await expect(cache.read('primary')).resolves.toEqual(slot('rotated'));
    expect(calls).toBe(2);
    value = null;
    cache.invalidate('reserve');
    await cache.read('primary');
    expect(calls).toBe(2);
    cache.invalidate('primary');
    await expect(cache.read('primary')).resolves.toBeNull();
    await expect(cache.read('primary')).resolves.toBeNull();
    expect(calls).toBe(3);
  });
  it('never returns unset on a cold read failure or failed invalidation', async () => {
    let fails = true;
    const cache = createCachedSlotReader(async () => {
      if (fails) throw new BaoStorageError('sealed');
      return slot();
    });
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
    fails = false;
    await cache.read('primary');
    fails = true;
    cache.invalidate('primary');
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
  });
  it('expires at five minutes of failed refreshes, never extends failure time, and recovers', async () => {
    let time = 0,
      fails = false,
      calls = 0;
    const cache = createCachedSlotReader(
      async () => {
        calls++;
        if (fails) throw new BaoStorageError('sealed');
        return slot();
      },
      () => time
    );
    await cache.read('primary');
    fails = true;
    time = 30_000;
    await expect(cache.read('primary')).resolves.toEqual(slot());
    time = 329_999;
    await expect(cache.read('primary')).resolves.toEqual(slot());
    time = 330_000;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
    time = 360_000;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
    fails = false;
    await expect(cache.read('primary')).resolves.toEqual(slot());
    time = 389_999;
    await cache.read('primary');
    expect(calls).toBe(6);
    time = 390_000;
    fails = true;
    await expect(cache.read('primary')).resolves.toEqual(slot());
  });
});
