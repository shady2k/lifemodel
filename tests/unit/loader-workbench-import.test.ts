import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchImportPhase } from '../../loader/src/workbench-import.js';

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const password = 'private-password-never-print';
const authorization = `Basic ${Buffer.from(`loader:${password}`).toString('base64')}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  const add = (map: Map<string, Buffer>, bytes: Buffer) => {
    map.set(digest(bytes), bytes);
    return { digest: digest(bytes), size: bytes.length };
  };
  const layer = add(blobs, Buffer.from('shared layer\0\n'));
  const children = ['amd64', 'arm64', 'attestation'].map((architecture) => {
    const config = add(blobs, json({ architecture }));
    return {
      ...add(
        manifests,
        json({
          schemaVersion: 2,
          mediaType: manifestType,
          config: { ...config, mediaType: 'application/vnd.oci.image.config.v1+json' },
          layers: [{ ...layer, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }],
        })
      ),
      mediaType: manifestType,
      platform: { architecture, os: 'linux' },
    };
  });
  const root = add(
    manifests,
    json({ schemaVersion: 2, mediaType: indexType, manifests: children })
  );
  return { blobs, manifests, root: root.digest };
}

async function registry(options: { auth?: boolean; data?: ReturnType<typeof fixture> } = {}) {
  const blobs = new Map(options.data?.blobs);
  const manifests = new Map(options.data?.manifests);
  const calls: { method: string; path: string; auth: string | undefined }[] = [];
  let hook: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const method = req.method ?? '';
      calls.push({ method, path, auth: req.headers.authorization });
      if (hook?.(req, res)) return;
      if (options.auth && req.headers.authorization !== authorization) {
        res.writeHead(401);
        res.end(password);
        return;
      }
      const key = path.split('/').at(-1) ?? '';
      const map = path.includes('/manifests/') ? manifests : blobs;
      if ((method === 'GET' || method === 'HEAD') && map.has(key)) {
        const bytes = map.get(key) as Buffer;
        res.writeHead(200, {
          'content-length': bytes.length,
          'content-type': path.includes('/manifests/')
            ? (JSON.parse(bytes.toString()).mediaType ?? manifestType)
            : 'application/octet-stream',
        });
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      if (method === 'POST' && path.endsWith('/blobs/uploads/')) {
        res.writeHead(202, { location: `${path}upload-1` });
        res.end();
        return;
      }
      if (method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
        const bytes = Buffer.concat(chunks);
        if (path.includes('/uploads/'))
          blobs.set(new URL(req.url ?? '', 'http://test').searchParams.get('digest') ?? '', bytes);
        else manifests.set(key, bytes);
        res.writeHead(201);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test listener failed');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    blobs,
    manifests,
    calls,
    intercept: (fn: typeof hook) => {
      hook = fn;
    },
  };
}

async function setup() {
  const data = fixture();
  const source = await registry({ data });
  const target = await registry({ auth: true });
  const temporary = await mkdtemp(join(tmpdir(), 'workbench-import-test-'));
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  const options = {
    originImage: `ghcr.io/shady2k/lifemodel-workbench@${data.root}`,
    originRegistry: source.origin,
    destinationOrigin: target.origin,
    tempDirectory: temporary,
    readCredential: async () => ({ username: 'loader' as const, password }),
    requestTimeoutMs: 2_000,
  };
  return { data, source, target, options, temporary };
}

describe('workbench byte-identical OCI import', () => {
  it('copies raw multi-platform manifests including attestations, configs and shared layers', async () => {
    const { data, target, options, temporary } = await setup();
    const phase = createWorkbenchImportPhase(options);
    expect(phase.name).toBe('workbench-import');
    await phase.run();
    expect(target.manifests).toEqual(data.manifests);
    expect(target.blobs).toEqual(data.blobs);
    expect(await readdir(temporary)).toEqual([]);
    for (const [key, bytes] of [...target.manifests, ...target.blobs])
      expect(digest(bytes)).toBe(key);
  });

  it('reruns without writes, but verifies every destination manifest and blob even when HEAD says present', async () => {
    const { data, source, target, options } = await setup();
    await createWorkbenchImportPhase(options).run();
    source.intercept((_req, res) => {
      res.writeHead(503);
      res.end();
      return true;
    });
    target.calls.length = 0;
    await createWorkbenchImportPhase(options).run();
    expect(target.calls.filter(({ method }) => method === 'PUT' || method === 'POST')).toEqual([]);
    expect(target.calls.filter(({ method }) => method === 'GET')).toHaveLength(
      data.blobs.size + data.manifests.size
    );
    const key = data.blobs.keys().next().value as string;
    target.blobs.set(key, Buffer.from('tampered after the first successful import'));
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:digest-mismatch'
    );
  });

  it('resumes a killed run using verified previously uploaded blobs', async () => {
    const { target, options, data } = await setup();
    const controller = new AbortController();
    target.intercept((req, res) => {
      if (req.method === 'POST' && target.blobs.size >= 1) {
        controller.abort();
        res.destroy();
        return true;
      }
      return false;
    });
    await expect(
      createWorkbenchImportPhase({ ...options, signal: controller.signal }).run()
    ).rejects.toThrow('workbench-import:aborted');
    const retained = [...target.blobs.keys()];
    expect(retained.length).toBeGreaterThan(0);
    target.intercept(undefined);
    target.calls.length = 0;
    await createWorkbenchImportPhase(options).run();
    expect(target.blobs).toEqual(data.blobs);
    for (const key of retained)
      expect(target.calls.some(({ method, path }) => method === 'GET' && path.endsWith(key))).toBe(
        true
      );
  });

  it.each(['', 'wrong-password'])(
    'refuses absent or wrong push password without exposing it: %s',
    async (wrong) => {
      const { options } = await setup();
      let error: unknown;
      try {
        await createWorkbenchImportPhase({
          ...options,
          readCredential: async () => ({ username: 'loader', password: wrong }),
        }).run();
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toMatch(/workbench-import:(credential|unauthorized)/);
      expect(String(error)).not.toContain(password);
      expect(String(error)).not.toContain(authorization);
      expect(String(error)).not.toContain('http');
    }
  );

  it('sanitizes credential provider failures', async () => {
    const { options } = await setup();
    await expect(
      createWorkbenchImportPhase({
        ...options,
        readCredential: async () => {
          throw new Error(password);
        },
      }).run()
    ).rejects.toThrow('workbench-import:credential');
  });

  it('rejects a wrong source digest before upload', async () => {
    const { options, data, source, target } = await setup();
    source.manifests.set(data.root, Buffer.from('{}'));
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:digest-mismatch'
    );
    expect(target.blobs.size + target.manifests.size).toBe(0);
  });

  it('rejects post-upload tampering instead of trusting success or digest headers', async () => {
    const { options, target } = await setup();
    target.intercept((req, res) => {
      const path = req.url ?? '';
      if (req.method === 'GET' && path.includes('/blobs/')) {
        res.writeHead(200, { 'docker-content-digest': path.split('/').at(-1) ?? '' });
        const original = target.blobs.get(path.split('/').at(-1) ?? '');
        if (original === undefined) throw new Error('test blob missing');
        // Same length: only the byte digest can detect this mutation.
        res.end(Buffer.alloc(original.length, 0x78));
        return true;
      }
      return false;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:digest-mismatch'
    );
  });

  it('bounds response sizes, aggregate bytes, and stalled requests', async () => {
    const { options, source } = await setup();
    await expect(
      createWorkbenchImportPhase({ ...options, maxManifestBytes: 10 }).run()
    ).rejects.toThrow('workbench-import:size-limit');
    await expect(createWorkbenchImportPhase({ ...options, maxBlobBytes: 1 }).run()).rejects.toThrow(
      'workbench-import:size-limit'
    );
    await expect(
      createWorkbenchImportPhase({ ...options, maxTotalBytes: 10 }).run()
    ).rejects.toThrow('workbench-import:size-limit');
    source.intercept((_req, res) => {
      res.writeHead(200);
      res.write('{');
      return true;
    });
    await expect(
      createWorkbenchImportPhase({ ...options, requestTimeoutMs: 30 }).run()
    ).rejects.toThrow('workbench-import:deadline');
  });

  it('bounds raw manifest memory retained by recursive traversal', async () => {
    const { options, data } = await setup();
    const root = data.manifests.get(data.root) as Buffer;
    // Each child fits the cap independently; retaining root plus child must fail.
    const limit = root.length + 1;
    expect([...data.manifests.values()].every((bytes) => bytes.length <= limit)).toBe(true);
    await expect(
      createWorkbenchImportPhase({ ...options, maxActiveManifestBytes: limit }).run()
    ).rejects.toThrow('workbench-import:size-limit');
  });

  it('authenticates public GHCR Bearer challenges without disclosing the destination credential', async () => {
    const { options, source } = await setup();
    source.intercept((req, res) => {
      if ((req.url ?? '').startsWith('/token?')) {
        expect(req.headers.authorization).toBeUndefined();
        expect(new URL(req.url ?? '', source.origin).searchParams.get('scope')).toBe(
          'repository:shady2k/lifemodel-workbench:pull'
        );
        res.writeHead(200);
        res.end(JSON.stringify({ token: 'public-pull-token' }));
        return true;
      }
      if (req.headers.authorization === 'Bearer public-pull-token') return false;
      res.writeHead(401, {
        'www-authenticate': `Bearer realm="${source.origin}/token",service="ghcr.io",scope="repository:shady2k/lifemodel-workbench:pull"`,
      });
      res.end(password);
      return true;
    });
    await createWorkbenchImportPhase(options).run();
    expect(
      source.calls.every(({ auth }) => auth === undefined || auth === 'Bearer public-pull-token')
    ).toBe(true);
    expect(source.calls.some(({ path }) => path === '/token')).toBe(true);
  });

  it('refuses untrusted token realms before requesting them', async () => {
    const { options, source } = await setup();
    const observer = await registry();
    source.intercept((_req, res) => {
      res.writeHead(401, {
        'www-authenticate': `Bearer realm="${observer.origin}/token",service="ghcr.io"`,
      });
      res.end();
      return true;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:redirect'
    );
    expect(observer.calls).toEqual([]);
  });

  it('removes abandoned layer files, rereads credentials, and bounds the whole phase', async () => {
    const { options, temporary } = await setup();
    await mkdir(join(temporary, 'abandoned-run'));
    await writeFile(join(temporary, 'abandoned-run', 'blob'), 'incomplete');
    let reads = 0;
    await createWorkbenchImportPhase({
      ...options,
      readCredential: async () => {
        reads++;
        return { username: 'loader', password };
      },
    }).run();
    expect(reads).toBeGreaterThan(10);
    expect(await readdir(temporary)).toEqual([]);
    await expect(
      createWorkbenchImportPhase({
        ...options,
        phaseTimeoutMs: 30,
        readCredential: () => new Promise(() => undefined),
      }).run()
    ).rejects.toThrow('workbench-import:deadline');
  });

  it('audits the whole graph after the root push rather than only each immediate upload', async () => {
    const { options, target, data } = await setup();
    target.intercept((req) => {
      if (req.method === 'PUT' && (req.url ?? '').endsWith(data.root)) {
        const key = data.blobs.keys().next().value as string;
        target.blobs.set(key, Buffer.alloc((data.blobs.get(key) as Buffer).length, 0x78));
      }
      return false;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:digest-mismatch'
    );
  });

  it('defers invalid pins to the retryable phase boundary', async () => {
    const { options } = await setup();
    const phase = createWorkbenchImportPhase({ ...options, originImage: '' });
    await expect(phase.run()).rejects.toThrow('workbench-import:configuration');
  });

  it('does not forward credentials to redirects or accept an untrusted upload location', async () => {
    const { options, source, target } = await setup();
    const observer = await registry();
    target.intercept((_req, res) => {
      res.writeHead(307, { location: `${observer.origin}/steal` });
      res.end();
      return true;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:redirect'
    );
    expect(observer.calls).toEqual([]);
    target.intercept((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(202, { location: `${observer.origin}/steal` });
        res.end();
        return true;
      }
      return false;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:redirect'
    );
    expect(observer.calls).toEqual([]);
    source.intercept((_req, res) => {
      res.writeHead(307, { location: `${observer.origin}/steal` });
      res.end();
      return true;
    });
    target.intercept(undefined);
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:redirect'
    );
    expect(observer.calls).toEqual([]);
  });
});
