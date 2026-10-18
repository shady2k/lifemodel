import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRoleBaoClient, createCachedSlotReader } from '../../loader/src/model-bao.js';

async function withBao(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ) => void,
  run: (address: string) => Promise<void>
) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw Error('no address');
  try {
    await run(`http://127.0.0.1:${a.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
describe('role Bao client', () => {
  it('logs in with a freshly read JWT and retries one rejected token', async () => {
    let jwt = 'jwt-one',
      reads = 0,
      logins = 0,
      calls = 0;
    await withBao(
      (req, res) => {
        if (req.url?.endsWith('/login')) {
          logins++;
          res.end(
            JSON.stringify({ auth: { client_token: `token-${logins}`, lease_duration: 3600 } })
          );
          return;
        }
        calls++;
        if (calls === 1) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('secret response body');
          return;
        }
        res.end(
          JSON.stringify({
            data: { data: { kind: 'openai', baseUrl: 'https://m/v1', model: 'x' }, metadata: {} },
          })
        );
      },
      async (address) => {
        const c = createRoleBaoClient({
          address,
          role: 'model-gateway',
          readJwt: async () => {
            reads++;
            return jwt;
          },
        });
        await c.readSlot('primary');
        jwt = 'jwt-two';
        await expect(c.readSlot('primary')).resolves.toMatchObject({ model: 'x' });
        expect(reads).toBe(2);
        expect(logins).toBe(2);
      }
    );
  });
  it('distinguishes a deleted latest version, absent path, and unavailable storage', async () => {
    await withBao(
      (req, res) => {
        if (req.url?.endsWith('/login')) {
          res.end(JSON.stringify({ auth: { client_token: 'token', lease_duration: 3600 } }));
          return;
        }
        res.writeHead(404);
        res.end('private');
      },
      async (address) => {
        const c = createRoleBaoClient({ address, role: 'loader', readJwt: async () => 'jwt' });
        await expect(c.readSlot('reserve')).resolves.toBeNull();
      }
    );
  });
  it('hard expires stale data after five minutes of refresh failures and supports invalidation', async () => {
    let t = 0,
      calls = 0;
    const read = async () => {
      calls++;
      if (calls > 1) throw Error('down');
      return { kind: 'openai' as const, baseUrl: 'https://m/v1', model: 'x' };
    };
    const cache = createCachedSlotReader(read, () => t);
    await cache.read('primary');
    t = 30_000;
    await expect(cache.read('primary')).resolves.toMatchObject({ model: 'x' });
    t = 330_000;
    await expect(cache.read('primary')).rejects.toThrow('storage_unavailable');
    cache.invalidate('primary');
  });
});
