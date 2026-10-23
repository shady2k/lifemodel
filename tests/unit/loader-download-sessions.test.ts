import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { LoaderDownloadSessions } from '../../src/storage/loader-download-sessions.js';

describe('fresh loader download session checks', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  it('forwards only current request cookies, never follows login redirects and fails closed on outage', async () => {
    let status = 200;
    let connections = 0;
    const seen: { cookie: string | undefined; method: string | undefined }[] = [];
    const server = createServer((req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      seen.push({
        cookie: req.headers.cookie,
        method: req.headers['x-forwarded-method'] as string | undefined,
      });
      res.writeHead(status, { location: 'https://invalid.example/login' }).end();
    });
    server.on('connection', (socket) => {
      connections += 1;
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('listener');
    const sessions = new LoaderDownloadSessions(
      'lifemodel',
      `http://127.0.0.1:${address.port}/_auth/verify`
    );
    cleanups.push(() => sessions.close());
    const signal = AbortSignal.timeout(2000);
    expect(await sessions.verify(undefined, signal)).toBe(false);
    expect(seen).toHaveLength(0);
    expect(await sessions.verify('__Host-lm_session=one', signal)).toBe(true);
    status = 401;
    expect(await sessions.verify('__Host-lm_session=two', signal)).toBe(false);
    status = 302;
    expect(await sessions.verify('__Host-lm_session=three', signal)).toBe(false);
    status = 503;
    await expect(sessions.verify('__Host-lm_session=four', signal)).rejects.toThrow(
      'owner_auth_unavailable'
    );
    expect(seen.map((value) => value.cookie)).toEqual([
      '__Host-lm_session=one',
      '__Host-lm_session=two',
      '__Host-lm_session=three',
      '__Host-lm_session=four',
    ]);
    expect(seen.every((value) => value.method === 'POST')).toBe(true);
    status = 200;
    for (let index = 0; index < 12; index += 1)
      expect(await sessions.verify('__Host-lm_session=keepalive', signal)).toBe(true);
    expect(connections).toBe(1);
  });
});
