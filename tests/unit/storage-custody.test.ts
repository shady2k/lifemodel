/**
 * The SeaweedFS S3 custody record (ADR-015 S-D1).
 *
 * Trusted bootstrap generates the module's service credentials once, keeps
 * them in one named OpenBao record and projects them into the one Secret the
 * SeaweedFS pod mounts. The module reads that record in memory only and fails
 * closed: no credentials, no store.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCachedCustodyReader,
  createKubernetesS3IdentitySecret,
  createStorageCustodyPhase,
  generateStorageCredentials,
  parseStorageCredentials,
  readCustodyRecord,
  renderS3IdentityConfig,
  S3_IDENTITY_KEY,
  S3_IDENTITY_SECRET,
  STORAGE_BUCKET,
  STORAGE_CUSTODY_PATH,
  StorageCustodyError,
  type StorageS3Credentials,
} from '../../loader/src/storage-custody.js';

const credentials: StorageS3Credentials = {
  accessKey: 'A1B2C3D4E5F60718293A',
  secretKey: 'c2VjcmV0LWtleS1mb3ItdGhlLXN0b3JhZ2UtbW9kdWxl',
};

describe('the custody record shape', () => {
  it('accepts the generated pair and refuses every other shape', () => {
    expect(parseStorageCredentials(credentials)).toEqual(credentials);
    for (const value of [
      null,
      [],
      'string',
      {},
      { accessKey: credentials.accessKey },
      { accessKey: 'short', secretKey: credentials.secretKey },
      { accessKey: credentials.accessKey, secretKey: 'short' },
      { accessKey: credentials.accessKey, secretKey: credentials.secretKey, extra: 'x' },
    ])
      expect(() => parseStorageCredentials(value)).toThrow(StorageCustodyError);
  });

  it('generates an identity the record accepts on both sides', () => {
    let calls = 0;
    const generated = generateStorageCredentials((size) => {
      calls++;
      return Buffer.alloc(size, 0xab);
    });
    expect(calls).toBe(2);
    expect(generated.accessKey).toHaveLength(20);
    expect(generated.secretKey.length).toBeGreaterThanOrEqual(32);
    expect(parseStorageCredentials(generated)).toEqual(generated);
    expect(generateStorageCredentials()).not.toEqual(generateStorageCredentials());
  });

  it('scopes the Seaweed identity to the module bucket and no admin action', () => {
    const config = JSON.parse(renderS3IdentityConfig(credentials));
    expect(config).toEqual({
      identities: [
        {
          name: 'storage-module',
          credentials: [{ accessKey: credentials.accessKey, secretKey: credentials.secretKey }],
          actions: [`Read:${STORAGE_BUCKET}`, `Write:${STORAGE_BUCKET}`, `List:${STORAGE_BUCKET}`],
        },
      ],
    });
    // The file grants nothing beyond the one bucket, and no direct admin right.
    expect(JSON.stringify(config)).not.toMatch(/Admin|Group|policy/i);
    expect(renderS3IdentityConfig(credentials).endsWith('\n')).toBe(true);
  });
});

describe('the module custody reader', () => {
  it('reads at most once per interval and keeps the record in memory only', async () => {
    let reads = 0;
    let clock = 0;
    const reader = createCachedCustodyReader(
      async () => {
        reads++;
        return credentials;
      },
      { now: () => clock, refreshMs: 1_000 }
    );
    await expect(reader.read()).resolves.toEqual(credentials);
    clock = 500;
    await expect(reader.read()).resolves.toEqual(credentials);
    expect(reads).toBe(1);
    clock = 1_500;
    await expect(reader.read()).resolves.toEqual(credentials);
    expect(reads).toBe(2);
    reader.invalidate();
    await expect(reader.read()).resolves.toEqual(credentials);
    expect(reads).toBe(3);
  });

  it('fails closed: a failed refresh never serves the credential it had', async () => {
    let fail = false;
    const reader = createCachedCustodyReader(
      async () => {
        if (fail) throw new StorageCustodyError('sealed');
        return credentials;
      },
      { now: () => Date.now(), refreshMs: 0 }
    );
    await expect(reader.read()).resolves.toEqual(credentials);
    fail = true;
    await expect(reader.read()).rejects.toMatchObject({ code: 'sealed' });
  });

  it('reports an absent record as missing and a broken one as invalid', async () => {
    await expect(createCachedCustodyReader(async () => null).read()).rejects.toMatchObject({
      code: 'missing',
    });
    await expect(
      createCachedCustodyReader(async () => ({ accessKey: 'x', secretKey: 'y' })).read()
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps an unreadable store its own code and a foreign error unreachable', async () => {
    const rejecting = (error: unknown) => createCachedCustodyReader(() => Promise.reject(error));
    await expect(rejecting({ code: 'denied' }).read()).rejects.toMatchObject({ code: 'denied' });
    await expect(rejecting(new Error('socket hang up')).read()).rejects.toMatchObject({
      code: 'unreachable',
    });
  });
});

describe('the custody record transport', () => {
  it('reads KV v2, treats a deleted or absent version as absent and a bad body as an error', async () => {
    const answer = (body: Record<string, unknown>) => async () => body;
    await expect(
      readCustodyRecord(answer({ data: { data: credentials, metadata: { version: 1 } } }))
    ).resolves.toEqual(credentials);
    await expect(
      readCustodyRecord(
        answer({ data: { data: credentials, metadata: { deletion_time: '2026-10-20T00:00:00Z' } } })
      )
    ).resolves.toBeNull();
    await expect(
      readCustodyRecord(answer({ data: { data: credentials, metadata: { destroyed: true } } }))
    ).resolves.toBeNull();
    await expect(
      readCustodyRecord(() => Promise.reject(Object.assign(new Error('x'), { code: 'not_found' })))
    ).resolves.toBeNull();
    await expect(readCustodyRecord(answer({ data: 'not-an-object' }))).rejects.toMatchObject({
      code: 'unreachable',
    });
    await expect(readCustodyRecord(answer({ data: { data: [] } }))).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      readCustodyRecord(answer({ data: { data: credentials, metadata: { version: 2 } } }))
    ).resolves.toEqual(credentials);
  });

  it('asks for the one named record and nothing else', async () => {
    const asked: string[] = [];
    await readCustodyRecord(async (path) => {
      asked.push(path);
      return { data: { data: credentials, metadata: { version: 1 } } };
    });
    expect(asked).toEqual([STORAGE_CUSTODY_PATH]);
    expect(STORAGE_CUSTODY_PATH).toBe('lifemodel/data/storage/seaweed');
  });
});

describe('the trusted-bootstrap custody phase', () => {
  function fixture(
    options: {
      record?: Record<string, unknown> | null;
      secret?: string | null;
      crash?: boolean;
    } = {}
  ) {
    const events: string[] = [];
    let record = options.record === undefined ? null : options.record;
    let secret: string | null = options.secret === undefined ? null : options.secret;
    const phase = createStorageCustodyPhase({
      bao: {
        read: async () => {
          events.push('bao-read');
          return record;
        },
        write: async (value) => {
          events.push('bao-write');
          if (options.crash) throw new Error('lost write response');
          record = { ...value };
        },
      },
      identity: {
        read: async () => {
          events.push('secret-read');
          return secret;
        },
        write: async (content) => {
          events.push('secret-write');
          secret = content;
        },
      },
      generate: () => credentials,
    });
    return { phase, events, record: () => record, secret: () => secret };
  }

  it('generates once, keeps the record and projects the identity file', async () => {
    const f = fixture();
    await f.phase.run();
    expect(f.phase.name).toBe('storage-seaweed-custody');
    expect(f.record()).toEqual(credentials);
    expect(f.secret()).toBe(renderS3IdentityConfig(credentials));
    expect(f.events.filter((event) => event === 'bao-write')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'secret-write')).toHaveLength(1);
  });

  it('reuses an existing record instead of rotating it', async () => {
    const existing = { accessKey: 'Z9Y8X7W6V5U4T3S2R1Q0', secretKey: 'b'.repeat(40) };
    const f = fixture({ record: existing, secret: renderS3IdentityConfig(existing) });
    await f.phase.run();
    expect(f.record()).toEqual(existing);
    // The Secret already matches, so it is not rewritten.
    expect(f.events).not.toContain('bao-write');
    expect(f.events).not.toContain('secret-write');
  });

  it('refuses a broken record rather than replacing the identity Seaweed uses', async () => {
    const f = fixture({ record: { accessKey: 'only-a-key' } });
    await expect(f.phase.run()).rejects.toMatchObject({ code: 'invalid' });
    expect(f.events).not.toContain('bao-write');
  });

  it('fails closed when the record cannot be written or read back', async () => {
    const crashed = fixture({ crash: true });
    await expect(crashed.phase.run()).rejects.toThrow(/lost write response/);
    expect(crashed.secret()).toBeNull();

    const notWritten = createStorageCustodyPhase({
      bao: { read: async () => null, write: async () => {} },
      identity: { read: async () => null, write: async () => {} },
      generate: () => credentials,
    });
    await expect(notWritten.run()).rejects.toThrow(/absent after its write/);
  });

  it('fails when the identity Secret does not keep what the record says', async () => {
    const phase = createStorageCustodyPhase({
      bao: { read: async () => credentials, write: async () => {} },
      identity: {
        read: async () => 'something else entirely',
        write: async () => {},
      },
    });
    await expect(phase.run()).rejects.toThrow(/read-back did not match/);
  });
});

describe('the identity Secret writer', () => {
  it('reads the mounted file and updates the same Secret, never creating it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'storage-identity-'));
    try {
      const tokenFile = join(directory, 'token');
      writeFileSync(tokenFile, 'sa-token\n');
      const caFile = join(directory, 'absent-ca.crt');
      const writes: string[] = [];
      const secret = createKubernetesS3IdentitySecret({
        tokenFile,
        caFile,
        request: async (url, method, token, body) => {
          expect(token).toBe('sa-token');
          expect(url.pathname).toBe(
            `/api/v1/namespaces/lifemodel-system/secrets/${S3_IDENTITY_SECRET}`
          );
          if (method === 'GET')
            return {
              status: 200,
              body: JSON.stringify({
                data: { [S3_IDENTITY_KEY]: Buffer.from('old').toString('base64') },
                metadata: { resourceVersion: '7' },
              }),
            };
          writes.push(body ?? '');
          return { status: 200, body: '{}' };
        },
      });
      expect(await secret.read()).toBe('old');
      await secret.write('new content\n');
      expect(writes).toHaveLength(1);
      const put = JSON.parse(writes[0] ?? '{}');
      expect(put.metadata).toMatchObject({
        name: S3_IDENTITY_SECRET,
        namespace: 'lifemodel-system',
        resourceVersion: '7',
      });
      expect(Buffer.from(put.data[S3_IDENTITY_KEY], 'base64').toString('utf8')).toBe(
        'new content\n'
      );

      const absent = createKubernetesS3IdentitySecret({
        tokenFile,
        caFile,
        request: async () => ({ status: 404, body: '' }),
      });
      expect(await absent.read()).toBeNull();
      await expect(absent.write('x')).rejects.toThrow(/platform-created/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
