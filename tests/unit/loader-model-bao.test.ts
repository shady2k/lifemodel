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
import type { ModelSlot, SlotRead } from '../../loader/src/model.js';

const slot = (model = 'first'): ModelSlot => ({
  kind: 'openai',
  baseUrl: 'https://model.example/prefix/v1',
  model,
  key: 'slot-secret',
});
/** A present slot read: the value with the KV version the read returned. */
const present = (model = 'first', version = 1): SlotRead => ({
  state: 'present',
  slot: slot(model),
  version,
});
const absent: SlotRead = { state: 'absent' };
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
  let reply: unknown = { data: { data: slot(), metadata: { version: 1 } } };
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
  it('re-logs in after rejection even when proactive renewal is in flight', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    let rejectOld!: () => void;
    let finishRenewal!: () => void;
    let oldStarted!: () => void;
    let renewalStarted!: () => void;
    const oldEntered = new Promise<void>((r) => {
      oldStarted = r;
    });
    const renewalEntered = new Promise<void>((r) => {
      renewalStarted = r;
    });
    let heldOld = false;
    f.onRequest = (req, res) => {
      if (req.url?.includes('/data/') && !heldOld) {
        heldOld = true;
        rejectOld = () => {
          res.writeHead(403);
          res.end('PRIVATE BODY');
        };
        oldStarted();
        return true;
      }
      if (req.url?.endsWith('/renew-self')) {
        finishRenewal = () =>
          res.end(
            JSON.stringify({
              auth: { client_token: 'bao-token-1', lease_duration: 100, renewable: true },
            })
          );
        renewalStarted();
        return true;
      }
      return false;
    };
    const oldRequest = f.client.readSlot('primary');
    await oldEntered;
    f.time = 70_000;
    const refreshingRequest = f.client.readSlot('reserve');
    await renewalEntered;
    const rejected = new Promise<void>((resolve) => {
      const push = f.lines.push.bind(f.lines);
      f.lines.push = (...lines) => {
        const length = push(...lines);
        if (lines.some((line) => line.fields['code'] === 'denied')) resolve();
        return length;
      };
    });
    rejectOld();
    await rejected;
    finishRenewal();
    await Promise.all([oldRequest, refreshingRequest]);
    expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
    expect(f.tokens.at(-1)).toBe('bao-token-2');
  });
  it('ignores a stale rejection that arrives after another request already re-logged in', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    let releaseFirst!: () => void;
    let releaseStale!: () => void;
    let enteredFirst!: () => void;
    let enteredStale!: () => void;
    const firstEntered = new Promise<void>((r) => {
      enteredFirst = r;
    });
    const staleEntered = new Promise<void>((r) => {
      enteredStale = r;
    });
    const heldTokens: Array<string | undefined> = [];
    f.onRequest = (req, res) => {
      const reject = () => {
        res.writeHead(403);
        res.end('PRIVATE BODY');
      };
      if (req.url?.includes('/data/') && heldTokens.length < 2) {
        const token = req.headers['x-vault-token'];
        heldTokens.push(typeof token === 'string' ? token : undefined);
        if (heldTokens.length === 1) {
          releaseFirst = reject;
          enteredFirst();
        } else {
          releaseStale = reject;
          enteredStale();
        }
        return true;
      }
      return false;
    };
    const first = f.client.readSlot('primary');
    await firstEntered;
    const stale = f.client.readSlot('reserve');
    await staleEntered;
    // Both requests were sent with the same token the server now refuses.
    expect(heldTokens).toEqual(['bao-token-1', 'bao-token-1']);
    releaseFirst();
    await expect(first).resolves.toEqual(present());
    // The second rejection is already stale: it must not force another login.
    releaseStale();
    await expect(stale).resolves.toEqual(present());
    expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
    // Two held requests plus exactly one retry each: no request is attempted a third time.
    expect(f.paths.filter((path) => path.includes('/data/'))).toHaveLength(5);
    expect(f.tokens.at(-1)).toBe('bao-token-2');
  });
  it('re-logs in once when a renewal held past the server lease returns an already rejected token', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    let finishRenewal!: () => void;
    let renewalStarted!: () => void;
    const renewalEntered = new Promise<void>((r) => {
      renewalStarted = r;
    });
    let rejectOldToken = false;
    f.onRequest = (req, res) => {
      if (req.url?.endsWith('/renew-self')) {
        finishRenewal = () =>
          res.end(
            JSON.stringify({
              auth: { client_token: 'bao-token-1', lease_duration: 100, renewable: true },
            })
          );
        renewalStarted();
        return true;
      }
      if (req.url?.includes('/data/') && rejectOldToken) {
        if (req.headers['x-vault-token'] === 'bao-token-1') {
          res.writeHead(403);
          res.end('PRIVATE BODY');
          return true;
        }
      }
      return false;
    };
    f.time = 70_000;
    const request = f.client.readSlot('primary');
    await renewalEntered;
    // The renewal response arrives after the token's server-side lease has run out.
    f.time = 200_000;
    rejectOldToken = true;
    finishRenewal();
    await expect(request).resolves.toEqual(present());
    expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
    expect(f.paths.filter((path) => path.endsWith('/renew-self'))).toHaveLength(1);
    expect(f.tokens.at(-1)).toBe('bao-token-2');
  });
  it('reads an unset reserve as a normal state without logging a storage error', async () => {
    const f = await fixture();
    f.status = 404;
    await expect(f.client.readSlot('reserve')).resolves.toEqual(absent);
    expect(f.lines.filter((line) => line.level === 'error')).toEqual([]);
    f.status = 503;
    await expect(f.client.readSlot('reserve')).rejects.toMatchObject({ code: 'sealed' });
    expect(f.lines.filter((line) => line.level === 'error')).not.toHaveLength(0);
    expect(JSON.stringify(f.lines)).not.toContain('PRIVATE BODY');
  });
  it('names an unreadable or empty projected JWT file in its log without its contents', async () => {
    for (const [state, code, message] of [
      ['missing', 'unreachable', /unreadable/],
      ['empty', 'denied', /empty/],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), 'bao-credential-'));
      roots.push(root);
      const jwtFile = join(root, 'token');
      if (state === 'empty') await writeFile(jwtFile, '  \n');
      const lines: RecordedLine[] = [];
      const client = createRoleBaoClient({
        address: 'http://127.0.0.1:1',
        role: 'loader',
        jwtFile,
        logger: createRecordingLogger(lines),
      });
      let failure: unknown;
      try {
        await client.readSlot('primary');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(BaoStorageError);
      expect(failure).toMatchObject({ code });
      const line = lines.find((entry) => message.test(entry.message));
      expect(line?.fields['file']).toBe(jwtFile);
      expect(line?.level).toBe('error');
      expect(JSON.stringify(lines)).not.toContain('jwt-');
    }
  });
  it('coalesces twenty rejections of the same stale token into one additional login', async () => {
    const f = await fixture();
    await f.client.readSlot('primary');
    await writeFile(f.jwtFile, 'jwt-rotated');
    const releases: Array<() => void> = [];
    let allHeld!: () => void;
    const allHeldPromise = new Promise<void>((r) => {
      allHeld = r;
    });
    f.onRequest = (req, res) => {
      if (req.url?.includes('/data/') && releases.length < 20) {
        releases.push(() => {
          res.writeHead(403);
          res.end('PRIVATE BODY');
        });
        if (releases.length === 20) allHeld();
        return true;
      }
      return false;
    };
    const requests = Array.from({ length: 20 }, () => f.client.readSlot('reserve'));
    await allHeldPromise;
    for (const release of releases) release();
    await expect(Promise.all(requests)).resolves.toHaveLength(20);
    expect(f.logins.map((l) => l.jwt)).toEqual(['jwt-first', 'jwt-rotated']);
    expect(f.tokens.at(-1)).toBe('bao-token-2');
  });
  it('never treats missing authentication endpoints as an unset model slot', async () => {
    const f = await fixture();
    f.loginStatus = 404;
    await expect(f.client.readSlot('primary')).rejects.toMatchObject({ code: 'unreachable' });
    f.loginStatus = 200;
    await f.client.readSlot('primary');
    f.onRequest = (req, res) => {
      if (req.url?.endsWith('/renew-self')) {
        res.writeHead(404);
        res.end('PRIVATE BODY');
        return true;
      }
      return false;
    };
    f.time = 70_000;
    await expect(f.client.readSlot('primary')).rejects.toMatchObject({ code: 'unreachable' });
  });
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
    await expect(f.client.readSlot('primary')).resolves.toEqual(present());
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
    await expect(cache.read('primary')).resolves.toEqual(present());
    f.reply = { data: { data: slot('rotated'), metadata: { version: 2 } } };
    time = 30_000;
    await expect(cache.read('primary')).resolves.toEqual(present('rotated', 2));
    f.status = 503;
    time = 60_000;
    await expect(cache.read('primary')).resolves.toEqual(present('rotated', 2));
    time = 360_000;
    await expect(cache.read('primary')).rejects.toMatchObject({ code: 'storage_unavailable' });
    f.status = 200;
    await expect(cache.read('primary')).resolves.toEqual(present('rotated', 2));
    cache.invalidate('primary');
    f.status = 503;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
  });
  it('logs in as the requested role and renews before expiry without another login', async () => {
    const f = await fixture();
    await expect(f.client.readSlot('primary')).resolves.toEqual(present());
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
      await expect(f.client.readSlot('primary')).resolves.toEqual(present());
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
    await expect(f.client.readSlot('primary')).resolves.toEqual(present());
  });
  it('treats only missing paths and deleted or destroyed latest versions as unset', async () => {
    const f = await fixture();
    f.status = 404;
    await expect(f.client.readSlot('reserve')).resolves.toEqual(absent);
    await expect(f.client.call('other/path')).rejects.toMatchObject({ code: 'not_found' });
    f.status = 200;
    for (const metadata of [{ deletion_time: '2026-10-18T00:00:00Z' }, { destroyed: true }]) {
      f.reply = { data: { data: null, metadata } };
      await expect(f.client.readSlot('reserve')).resolves.toEqual(absent);
    }
    for (const reply of [
      {},
      { data: {} },
      { data: { data: { key: 'secret' }, metadata: { version: 1 } } },
      // The read's own version is the slot's identity: a read without one is unusable.
      { data: { data: slot(), metadata: {} } },
    ]) {
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
    let resolve!: (value: SlotRead) => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const cache = createCachedSlotReader(() => {
      started();
      return new Promise<SlotRead>((r) => {
        resolve = r;
      });
    });
    const pending = cache.read('primary');
    await entered;
    cache.invalidate('primary');
    resolve(present());
    await expect(pending).rejects.toThrow('storage_unavailable');
  });
  it('refreshes at 30 seconds, caches unset, and invalidates only the selected slot', async () => {
    let time = 0,
      calls = 0,
      value: SlotRead = present();
    const cache = createCachedSlotReader(
      async () => {
        calls++;
        return value;
      },
      () => time
    );
    await expect(cache.read('primary')).resolves.toEqual(present());
    time = 29_999;
    await cache.read('primary');
    expect(calls).toBe(1);
    value = present('rotated', 2);
    time = 30_000;
    await expect(cache.read('primary')).resolves.toEqual(present('rotated', 2));
    expect(calls).toBe(2);
    value = absent;
    cache.invalidate('reserve');
    await cache.read('primary');
    expect(calls).toBe(2);
    cache.invalidate('primary');
    await expect(cache.read('primary')).resolves.toEqual(absent);
    await expect(cache.read('primary')).resolves.toEqual(absent);
    expect(calls).toBe(3);
  });
  it('reads a slot identity straight from Bao, never from the cache beneath it', async () => {
    let time = 0,
      calls = 0,
      value: SlotRead = present('first', 1);
    const cache = createCachedSlotReader(
      async () => {
        calls++;
        return value;
      },
      () => time
    );
    await expect(cache.read('primary')).resolves.toEqual(present());
    value = present('saved', 2);
    await expect(cache.read('primary')).resolves.toEqual(present());
    await expect(cache.identity('primary')).resolves.toEqual({ version: 2 });
    expect(calls).toBe(2);
    value = absent;
    await expect(cache.identity('primary')).resolves.toBe('absent');
    expect(calls).toBe(3);
  });
  it('never returns unset on a cold read failure or failed invalidation', async () => {
    let fails = true;
    const cache = createCachedSlotReader(async () => {
      if (fails) throw new BaoStorageError('sealed');
      return present();
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
        return present();
      },
      () => time
    );
    await cache.read('primary');
    fails = true;
    time = 30_000;
    await expect(cache.read('primary')).resolves.toEqual(present());
    time = 329_999;
    await expect(cache.read('primary')).resolves.toEqual(present());
    time = 330_000;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
    time = 360_000;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
    fails = false;
    await expect(cache.read('primary')).resolves.toEqual(present());
    time = 389_999;
    await cache.read('primary');
    expect(calls).toBe(6);
    time = 390_000;
    fails = true;
    await expect(cache.read('primary')).resolves.toEqual(present());
  });

  it('reads a stored header list and refuses a slot whose headers break the rule', async () => {
    const f = await fixture();
    const headers = [{ name: 'x-opencode-session', value: '{session}' }];
    f.reply = { data: { data: { ...slot(), headers }, metadata: { version: 3 } } };
    await expect(f.client.readSlot('primary')).resolves.toEqual({
      state: 'present',
      slot: { ...slot(), headers },
      version: 3,
    });
    for (const refused of [
      [{ name: 'authorization', value: 'Bearer x' }],
      [{ name: 'x-a', value: 'line\r\nbreak' }],
      [{ name: 'x-a', value: 'Привет' }],
      [{ name: 'x-a', value: 'del\u007f' }],
      [
        { name: 'x-a', value: '1' },
        { name: 'X-A', value: '2' },
      ],
      [{ name: 'x-a', value: 'v', extra: true }],
      'not-a-list',
      [{ name: 'x-a' }],
    ]) {
      f.reply = { data: { data: { ...slot(), headers: refused }, metadata: { version: 3 } } };
      await expect(f.client.readSlot('primary')).rejects.toMatchObject({ code: 'unreachable' });
    }
  });
  it('offers only the key: a header value is rendered and pinned by its own attempt', async () => {
    const cache = createCachedSlotReader(async () => ({
      state: 'present' as const,
      slot: {
        ...slot(),
        headers: [{ name: 'x-a', value: 'the-header-value' }],
      },
      version: 1,
    }));
    await cache.read('primary');
    expect(cache.keys()).toEqual(['slot-secret']);
  });
});
