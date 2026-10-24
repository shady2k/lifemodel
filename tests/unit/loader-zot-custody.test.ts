/** Zot credentials survive interrupted bootstrap without rotation or plaintext projection. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, hash } from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createKubernetesZotIdentitySecret,
  createZotCustodyPhase,
  parseZotCredential,
  ZOT_CUSTODY_PATH,
  ZOT_IDENTITY_KEY,
  ZOT_IDENTITY_SECRET,
  ZotCustodyError,
  type ZotCredential,
} from '../../loader/src/zot-custody.js';

const credential: ZotCredential = { username: 'loader', password: 'a'.repeat(43) };
let validIdentity: string;
let wrongIdentity: string;
beforeAll(async () => {
  validIdentity = `loader:${await hash(credential.password, 12)}\n`;
  wrongIdentity = `loader:${await hash('wrong-password', 12)}\n`;
});

describe('Zot custody record', () => {
  it('names the one registry custody path and Secret', () => {
    expect(ZOT_CUSTODY_PATH).toBe('lifemodel/data/registry/zot');
    expect(ZOT_IDENTITY_SECRET).toBe('zot-htpasswd');
    expect(ZOT_IDENTITY_KEY).toBe('htpasswd');
  });

  it('accepts only the fixed loader user and exactly 43 base64url password characters', () => {
    expect(parseZotCredential(credential)).toEqual(credential);
    for (const value of [
      null,
      [],
      'secret',
      {},
      { username: 'loader' },
      { ...credential, username: 'admin' },
      { ...credential, password: 'a'.repeat(42) },
      { ...credential, password: 'a'.repeat(44) },
      { ...credential, password: `${'a'.repeat(42)}+` },
      { ...credential, password: `${'a'.repeat(43)}\n` },
      { ...credential, extra: true },
    ]) {
      expect(() => parseZotCredential(value)).toThrow(ZotCustodyError);
      expect(() => parseZotCredential(value)).toThrow('invalid');
    }
  });
});

function memory(initial: Record<string, unknown> | null = null, identity: string | null = null) {
  const state = { record: initial, identity };
  const bao = {
    read: vi.fn(async () => state.record),
    write: vi.fn(async (value: ZotCredential) => {
      state.record = { ...value };
    }),
  };
  const secret = {
    read: vi.fn(async () => state.identity),
    write: vi.fn(async (content: string) => {
      state.identity = content;
    }),
  };
  return { state, bao, identity: secret };
}

describe('Zot custody phase', () => {
  it('stores a random 32-byte password durably before projecting only its bcrypt hash', async () => {
    const deps = memory();
    const order: string[] = [];
    deps.bao.read.mockImplementation(async () => {
      order.push('bao-read');
      return deps.state.record;
    });
    deps.bao.write.mockImplementation(async (value) => {
      order.push('bao-write');
      deps.state.record = { ...value };
    });
    deps.identity.read.mockImplementation(async () => {
      order.push('secret-read');
      return deps.state.identity;
    });
    const phase = createZotCustodyPhase(deps);
    expect(phase.name).toBe('zot-custody');
    await phase.run();
    const saved = parseZotCredential(deps.state.record);
    expect(saved.username).toBe('loader');
    expect(saved.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(saved.password, 'base64url')).toHaveLength(32);
    expect(order.slice(0, 4)).toEqual(['bao-read', 'bao-write', 'bao-read', 'secret-read']);
    expect(deps.state.identity).toMatch(/^loader:\$2[aby]\$12\$[./A-Za-z0-9]{53}\n$/);
    expect(deps.state.identity).not.toContain(saved.password);
    expect(await compare(saved.password, deps.state.identity!.trim().slice(7))).toBe(true);
    const first = deps.state.identity;
    await createZotCustodyPhase(deps).run();
    expect(deps.state.identity).toBe(first);
    expect(deps.bao.write).toHaveBeenCalledTimes(1);
    expect(deps.identity.write).toHaveBeenCalledTimes(1);
  });

  it('reuses the Bao record after a crash immediately after the durable write', async () => {
    const deps = memory();
    deps.bao.write.mockImplementationOnce(async (value) => {
      deps.state.record = { ...value };
      throw new Error(`cut ${value.password}`);
    });
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
      message: 'unreachable',
    });
    const saved = { ...deps.state.record };
    expect(deps.identity.write).not.toHaveBeenCalled();
    await createZotCustodyPhase(deps).run();
    expect(deps.state.record).toEqual(saved);
    expect(deps.bao.write).toHaveBeenCalledTimes(1);
    expect(
      await compare(parseZotCredential(saved).password, deps.state.identity!.trim().slice(7))
    ).toBe(true);
  });

  it('reuses the exact hash after a crash immediately after Secret update', async () => {
    const deps = memory(credential);
    deps.identity.write.mockImplementationOnce(async (content) => {
      deps.state.identity = content;
      throw new Error(`cut ${credential.password}`);
    });
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
      message: 'unreachable',
    });
    const savedIdentity = deps.state.identity;
    await createZotCustodyPhase(deps).run();
    expect(deps.state.identity).toBe(savedIdentity);
    expect(deps.identity.write).toHaveBeenCalledTimes(1);
    expect(deps.bao.write).not.toHaveBeenCalled();
  });

  it('reuses an existing valid hash without rewriting either store', async () => {
    const deps = memory(credential, validIdentity);
    await createZotCustodyPhase(deps).run();
    expect(deps.identity.write).not.toHaveBeenCalled();
    expect(deps.bao.write).not.toHaveBeenCalled();
  });

  it.each(['wrong-password', 'extra-user', 'plaintext', 'malformed', 'expensive-hash'])(
    'replaces an invalid Secret (%s) with one sole-loader identity',
    async (kind) => {
      const content =
        kind === 'wrong-password'
          ? wrongIdentity
          : kind === 'extra-user'
            ? `${validIdentity}admin:hash\n`
            : kind === 'plaintext'
              ? `loader:${credential.password}\n`
              : kind === 'expensive-hash'
                ? validIdentity.replace('$12$', '$31$')
                : 'not htpasswd';
      const deps = memory(credential, content);
      await createZotCustodyPhase(deps).run();
      expect(deps.identity.write).toHaveBeenCalledTimes(1);
      expect(deps.state.identity).toMatch(/^loader:\$2[aby]\$12\$[./A-Za-z0-9]{53}\n$/);
      expect(deps.state.identity).not.toContain(credential.password);
      expect(await compare(credential.password, deps.state.identity!.trim().slice(7))).toBe(true);
    }
  );

  it('fails closed on an invalid existing record without rotating or touching the Secret', async () => {
    const deps = memory({ ...credential, username: 'admin' }, validIdentity);
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
      code: 'invalid',
      message: 'invalid',
    });
    expect(deps.bao.write).not.toHaveBeenCalled();
    expect(deps.identity.read).not.toHaveBeenCalled();
  });

  it.each(['missing', 'different'])(
    'does not project an unverified Bao write (%s readback)',
    async (kind) => {
      const deps = memory();
      deps.bao.read
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(kind === 'missing' ? null : credential);
      await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
        code: kind === 'missing' ? 'missing' : 'mismatch',
      });
      expect(deps.identity.read).not.toHaveBeenCalled();
    }
  );

  it('fails if the Secret readback is not the committed identity', async () => {
    const deps = memory(credential);
    deps.identity.write.mockResolvedValue(undefined);
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('never passes dependency messages or raw passwords into errors', async () => {
    const deps = memory(credential);
    deps.bao.read.mockRejectedValueOnce(new Error(`server said ${credential.password}`));
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
      message: 'unreachable',
    });
    deps.bao.read.mockRejectedValueOnce({ code: 'denied', message: credential.password });
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
      code: 'denied',
      message: 'denied',
    });
    deps.identity.read.mockRejectedValueOnce(new Error(credential.password));
    await expect(createZotCustodyPhase(deps).run()).rejects.toMatchObject({
      message: 'unreachable',
    });
  });
});

const directory = mkdtempSync(join(tmpdir(), 'zot-custody-'));
const tokenFile = join(directory, 'token');
const caFile = join(directory, 'ca');
writeFileSync(tokenFile, 'test-service-account-token\n');
writeFileSync(caFile, 'test-ca');
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const options = {
  tokenFile,
  caFile,
  namespace: 'lifemodel-system',
  apiServer: 'https://kubernetes.invalid',
};
function secretBody(content: string | null, resourceVersion: string | null = '17') {
  return JSON.stringify({
    metadata: resourceVersion === null ? {} : { resourceVersion },
    data: content === null ? {} : { htpasswd: Buffer.from(content).toString('base64') },
  });
}

describe('the bounded fixed-name Zot Secret client', () => {
  it('reads only the fixed Secret and updates it with resourceVersion CAS and the hash only', async () => {
    const request = vi.fn(
      async (_url: URL, method: string, _token: string, body: string | undefined) => {
        if (method === 'GET') return { status: 200, body: secretBody(null) };
        const submitted = JSON.parse(body!);
        expect(submitted).toMatchObject({
          metadata: { name: 'zot-htpasswd', namespace: 'lifemodel-system', resourceVersion: '17' },
          type: 'Opaque',
          data: { htpasswd: Buffer.from(validIdentity).toString('base64') },
        });
        expect(Object.keys(submitted.data)).toEqual(['htpasswd']);
        return { status: 200, body: '{}' };
      }
    );
    const client = createKubernetesZotIdentitySecret({ ...options, request });
    await expect(client.read()).resolves.toBeNull();
    await client.write(validIdentity);
    expect(request.mock.calls.map((call) => call[1])).toEqual(['GET', 'GET', 'PUT']);
    for (const [url, , token] of request.mock.calls) {
      expect(url.href).toBe(
        'https://kubernetes.invalid/api/v1/namespaces/lifemodel-system/secrets/zot-htpasswd'
      );
      expect(token).toBe('test-service-account-token');
    }
  });

  it('decodes an existing identity', async () => {
    const request = async () => ({ status: 200, body: secretBody(validIdentity) });
    await expect(createKubernetesZotIdentitySecret({ ...options, request }).read()).resolves.toBe(
      validIdentity
    );
  });

  it.each([404, 403, 500])('never creates a missing or unreadable Secret (%s)', async (status) => {
    const request = vi.fn(async () => ({ status, body: credential.password }));
    const client = createKubernetesZotIdentitySecret({ ...options, request });
    await expect(client.write(validIdentity)).rejects.toBeInstanceOf(ZotCustodyError);
    expect(request).toHaveBeenCalledTimes(1);
    if (status === 404) await expect(client.read()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects updates without resourceVersion and fails safely on CAS conflict', async () => {
    const missing = vi.fn(async () => ({ status: 200, body: secretBody(null, null) }));
    await expect(
      createKubernetesZotIdentitySecret({ ...options, request: missing }).write(validIdentity)
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(missing).toHaveBeenCalledTimes(1);
    const conflict = vi.fn(async (_url: URL, method: string) =>
      method === 'GET'
        ? { status: 200, body: secretBody(null) }
        : { status: 409, body: credential.password }
    );
    await expect(
      createKubernetesZotIdentitySecret({ ...options, request: conflict }).write(validIdentity)
    ).rejects.toMatchObject({ code: 'conflict', message: 'conflict' });
  });

  it.each(['bad-json', 'bad-data', 'bad-base64', 'oversize'])(
    'fails safely on %s responses',
    async (kind) => {
      const body =
        kind === 'bad-json'
          ? credential.password
          : kind === 'bad-data'
            ? JSON.stringify({ data: { htpasswd: 17 } })
            : kind === 'bad-base64'
              ? JSON.stringify({ data: { htpasswd: '%%%not base64' } })
              : 'x'.repeat(1024 * 1024 + 1);
      const request = async () => ({ status: 200, body });
      await expect(
        createKubernetesZotIdentitySecret({ ...options, request }).read()
      ).rejects.toMatchObject({
        message: kind === 'oversize' ? 'response_too_large' : 'invalid',
      });
    }
  );

  it('bounds a stalled request and sanitizes transport failures', async () => {
    const stalled = async (): Promise<{ status: number; body: string }> => new Promise(() => {});
    await expect(
      createKubernetesZotIdentitySecret({ ...options, request: stalled, timeoutMs: 20 }).read()
    ).rejects.toMatchObject({ code: 'timeout', message: 'timeout' });
    const broken = async () => {
      throw new Error(credential.password);
    };
    await expect(
      createKubernetesZotIdentitySecret({ ...options, request: broken }).read()
    ).rejects.toMatchObject({ message: 'unreachable' });
  });

  it('does not reset the total deadline between GET and PUT', async () => {
    vi.useFakeTimers();
    try {
      let enterGet!: () => void;
      let enterPut!: () => void;
      let completeGet!: (value: { status: number; body: string }) => void;
      const getEntered = new Promise<void>((resolve) => {
        enterGet = resolve;
      });
      const putEntered = new Promise<void>((resolve) => {
        enterPut = resolve;
      });
      const request = async (_url: URL, method: string) => {
        if (method === 'GET') {
          enterGet();
          return new Promise<{ status: number; body: string }>((resolve) => {
            completeGet = resolve;
          });
        }
        enterPut();
        return new Promise<{ status: number; body: string }>(() => {});
      };
      const client = createKubernetesZotIdentitySecret({ ...options, request, timeoutMs: 30 });
      const pending = client.write(validIdentity);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await getEntered;
      await vi.advanceTimersByTimeAsync(20);
      completeGet({ status: 200, body: secretBody(null) });
      await putEntered;
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one total deadline across GET and PUT and never PUTs after a timed-out GET', async () => {
    let release: ((value: { status: number; body: string }) => void) | undefined;
    const request = vi.fn(
      async () =>
        new Promise<{ status: number; body: string }>((resolve) => {
          release = resolve;
        })
    );
    const client = createKubernetesZotIdentitySecret({ ...options, request, timeoutMs: 30 });
    await expect(client.write(validIdentity)).rejects.toMatchObject({ code: 'timeout' });
    release?.({ status: 200, body: secretBody(null) });
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
