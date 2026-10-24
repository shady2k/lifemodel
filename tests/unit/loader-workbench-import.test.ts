import { createHash } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, globalAgent } from 'node:https';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchImportPhase } from '../../loader/src/workbench-import.js';
import { createWorkbenchImportTask } from '../../loader/src/workbench-task.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger } from '../../loader/src/logger.js';

const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const password = 'private-password-never-print';
const authorization = `Basic ${Buffer.from(`loader:${password}`).toString('base64')}`;
const cleanups: (() => Promise<void>)[] = [];
const tls = {
  key: readFileSync('tests/fixtures/workbench-registry.key'),
  cert: readFileSync('tests/fixtures/workbench-registry.crt'),
};
const originalCa = globalAgent.options.ca;
beforeEach(() => {
  // Trust only this test certificate. Production uses Node's normal verified TLS trust.
  globalAgent.options.ca = tls.cert;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  globalAgent.options.ca = originalCa;
});

function fixture(docker = false) {
  const imageType = docker ? 'application/vnd.docker.distribution.manifest.v2+json' : manifestType;
  const listType = docker ? 'application/vnd.docker.distribution.manifest.list.v2+json' : indexType;
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
          mediaType: imageType,
          config: {
            ...config,
            mediaType: docker
              ? 'application/vnd.docker.container.image.v1+json'
              : 'application/vnd.oci.image.config.v1+json',
          },
          layers: [
            {
              ...layer,
              mediaType: docker
                ? 'application/vnd.docker.image.rootfs.diff.tar.gzip'
                : 'application/vnd.oci.image.layer.v1.tar+gzip',
            },
          ],
        })
      ),
      mediaType: imageType,
      platform: { architecture, os: 'linux' },
    };
  });
  const root = add(manifests, json({ schemaVersion: 2, mediaType: listType, manifests: children }));
  return { blobs, manifests, root: root.digest };
}

async function registry(
  options: { auth?: boolean; data?: ReturnType<typeof fixture>; host?: string } = {}
) {
  const blobs = new Map(options.data?.blobs);
  const manifests = new Map(options.data?.manifests);
  const calls: {
    method: string;
    path: string;
    auth: string | undefined;
    cookie: string | undefined;
  }[] = [];
  let hook: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined;
  const server = createServer(tls, (req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const method = req.method ?? '';
      calls.push({ method, path, auth: req.headers.authorization, cookie: req.headers.cookie });
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
  await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test listener failed');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin: `https://${options.host ?? '127.0.0.1'}:${address.port}`,
    blobs,
    manifests,
    calls,
    intercept: (fn: typeof hook) => {
      hook = fn;
    },
  };
}

async function setup(docker = false) {
  const data = fixture(docker);
  const source = await registry({ data });
  const target = await registry({ auth: true });
  const temporary = await mkdtemp(join(tmpdir(), 'workbench-import-test-'));
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  const options = {
    pinnedDigest: data.root,
    readSource: async () => ({ registry: source.origin, repository: 'custom/team-workbench' }),
    destinationOrigin: target.origin,
    tempDirectory: temporary,
    readCredential: async () => ({ username: 'loader' as const, password }),
    requestTimeoutMs: 2_000,
  };
  return { data, source, target, options, temporary };
}

describe('workbench byte-identical OCI import', () => {
  it('retries the real HTTPS importer after an unreachable source is changed without restarting the task', async () => {
    const { options, source, target, data, temporary } = await setup();
    const replacement = await registry({ data });
    source.intercept((_req, res) => {
      res.writeHead(503);
      res.end(password);
      return true;
    });
    const fs = createNodeFileSystem();
    let selectedSource = source.origin;
    const entries: Parameters<typeof createRecordingLogger>[0] = [];
    const task = createWorkbenchImportTask({
      fs,
      config: { loaderDir: temporary },
      clock: { now: Date.now, sleep: () => new Promise(() => undefined) },
      logger: createRecordingLogger(entries),
      pinnedDigest: data.root,
      run: (signal) =>
        createWorkbenchImportPhase({
          ...options,
          // Import cleanup owns its own subdirectory, never the durable loader status.
          tempDirectory: join(temporary, 'downloads'),
          readSource: async () => ({
            registry: selectedSource,
            repository: 'custom/team-workbench',
          }),
          signal,
        }).run(),
    });
    cleanups.push(() => task.stop());
    await task.start();
    await vi.waitFor(() => expect(task.status().state).toBe('failed'));
    expect(task.status()).toMatchObject({ reason: 'unavailable' });
    expect(target.blobs.size + target.manifests.size).toBe(0);
    const savedFailure = await fs.readFile(join(temporary, 'workbench-import.json'));
    expect(JSON.parse(savedFailure)).toMatchObject({
      state: 'failed',
      pinnedDigest: data.root,
      reason: 'unavailable',
    });
    expect(savedFailure + JSON.stringify(entries)).not.toContain(password);
    selectedSource = replacement.origin;
    await task.trigger();
    await vi.waitFor(() => expect(task.status().state).toBe('ready'));
    expect(target.blobs).toEqual(data.blobs);
    expect(target.manifests).toEqual(data.manifests);
    expect(JSON.parse(await fs.readFile(join(temporary, 'workbench-import.json')))).toMatchObject({
      state: 'ready',
      pinnedDigest: data.root,
    });
    expect(replacement.calls.length).toBeGreaterThan(0);
  });

  it('resumes a real interrupted import with a fresh durable task instance and the same zot', async () => {
    const { options, source, target, data, temporary } = await setup();
    const fs = createNodeFileSystem();
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    target.intercept((req) => {
      if (req.method === 'POST' && target.blobs.size >= 1) {
        // Leave the upload unfinished. Cancelling the owner models the lost
        // process: no terminal state is written over its durable importing row.
        interrupt();
        return true;
      }
      return false;
    });
    const deps = {
      fs,
      config: { loaderDir: temporary },
      clock: { now: Date.now, sleep: () => new Promise<void>(() => undefined) },
      logger: createRecordingLogger([]),
      pinnedDigest: data.root,
      run: (signal: AbortSignal) =>
        createWorkbenchImportPhase({
          ...options,
          tempDirectory: join(temporary, 'downloads'),
          signal,
        }).run(),
    };
    const first = createWorkbenchImportTask(deps);
    cleanups.push(() => first.stop());
    await first.start();
    await interrupted;
    const retained = [...target.blobs.keys()];
    expect(retained.length).toBeGreaterThan(0);
    await first.stop();
    expect(JSON.parse(await fs.readFile(join(temporary, 'workbench-import.json')))).toMatchObject({
      state: 'importing',
      pinnedDigest: data.root,
    });
    // Killed import files can survive outside orderly shutdown; the new
    // importer must remove them while preserving its task's durable row.
    await mkdir(join(temporary, 'downloads', 'abandoned'), { recursive: true });
    await writeFile(join(temporary, 'downloads', 'abandoned', 'blob'), 'incomplete');
    target.intercept(undefined);
    source.calls.length = 0;
    target.calls.length = 0;
    const restarted = createWorkbenchImportTask(deps);
    cleanups.push(() => restarted.stop());
    await restarted.start();
    await vi.waitFor(() => expect(restarted.status().state).toBe('ready'));
    expect(target.blobs).toEqual(data.blobs);
    expect(target.manifests).toEqual(data.manifests);
    for (const key of retained) {
      expect(target.calls.some(({ method, path }) => method === 'GET' && path.endsWith(key))).toBe(
        true
      );
      expect(source.calls.some(({ path }) => path.endsWith(key))).toBe(false);
    }
    expect(await readdir(join(temporary, 'downloads'))).toEqual([]);
    expect(JSON.parse(await fs.readFile(join(temporary, 'workbench-import.json')))).toMatchObject({
      state: 'ready',
      pinnedDigest: data.root,
    });
  });

  it.each([false, true])(
    'copies raw multi-platform manifests including attestations, configs and shared layers (Docker: %s)',
    async (docker) => {
      const { data, target, options, temporary } = await setup(docker);
      const phase = createWorkbenchImportPhase(options);
      expect(phase.name).toBe('workbench-import');
      await phase.run();
      expect(target.manifests).toEqual(data.manifests);
      expect(target.blobs).toEqual(data.blobs);
      expect(await readdir(temporary)).toEqual([]);
      for (const [key, bytes] of [...target.manifests, ...target.blobs])
        expect(digest(bytes)).toBe(key);
    }
  );

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

  it.each([
    {
      method: 'PUT',
      path: '/manifests/',
      status: 415,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    },
    { method: 'PUT', path: '/uploads/', status: 422, mediaType: 'application/octet-stream' },
    { method: 'POST', path: '/blobs/uploads/', status: 400, mediaType: 'none' },
  ])(
    'records destination $method $status as rejected with safe HTTP metadata',
    async ({ method, path, status, mediaType }) => {
      const { options, target, data, temporary } = await setup(true);
      target.intercept((req, res) => {
        if (req.method !== method || !(req.url ?? '').includes(path)) return false;
        res.writeHead(status, { 'content-type': `text/plain; secret=${password}` });
        res.end(`${password} ${authorization} https://registry.example/?token=SECRET_CANARY`);
        return true;
      });
      const fs = createNodeFileSystem();
      const entries: Parameters<typeof createRecordingLogger>[0] = [];
      const task = createWorkbenchImportTask({
        fs,
        config: { loaderDir: temporary },
        clock: { now: Date.now, sleep: () => new Promise(() => undefined) },
        logger: createRecordingLogger(entries),
        pinnedDigest: data.root,
        run: (signal) =>
          createWorkbenchImportPhase({
            ...options,
            signal,
            tempDirectory: join(temporary, 'downloads'),
          }).run(),
      });
      cleanups.push(() => task.stop());
      await task.start();
      await vi.waitFor(() => expect(task.status().state).toBe('failed'));
      expect(task.status().reason).toBe('rejected');
      const saved = await fs.readFile(join(temporary, 'workbench-import.json'));
      expect(JSON.parse(saved)).toMatchObject({ state: 'failed', reason: 'rejected' });
      expect(entries).toContainEqual({
        level: 'warn',
        fields: { code: 'rejected', status, mediaType },
        message: 'workbench import failed; retrying',
      });
      expect(saved + JSON.stringify(entries)).not.toMatch(
        /SECRET_CANARY|https?:|private-password-never-print|Basic /
      );
    }
  );

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rejected'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('keeps the destination write status %s mapped to %s', async (status, reason) => {
    const { options, target } = await setup();
    target.intercept((req, res) => {
      if (req.method !== 'PUT') return false;
      res.writeHead(Number(status));
      res.end(password);
      return true;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      `workbench-import:${reason}`
    );
  });

  it('does not classify source read failures as destination rejections', async () => {
    const { options, source } = await setup();
    source.intercept((_req, res) => {
      res.writeHead(415);
      res.end(password);
      return true;
    });
    await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
      'workbench-import:unavailable'
    );
  });

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
          'repository:custom/team-workbench:pull'
        );
        res.writeHead(200);
        res.end(JSON.stringify({ token: 'public-pull-token' }));
        return true;
      }
      if (req.headers.authorization === 'Bearer public-pull-token') return false;
      res.writeHead(401, {
        'www-authenticate': `Bearer realm="${source.origin}/token",service="ghcr.io",scope="repository:custom/team-workbench:pull"`,
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
    await expect(
      createWorkbenchImportPhase({
        ...options,
        readSource: async () => ({
          ...(await options.readSource()),
          username: 'pull-user',
          password,
        }),
      }).run()
    ).rejects.toThrow('workbench-import:redirect');
    expect(observer.calls).toEqual([]);
  });

  it.each(['basic', 'bearer'])(
    'uses stored pull credentials only for same-origin %s authentication',
    async (kind) => {
      const { options, source, target, data } = await setup();
      const pullAuth = `Basic ${Buffer.from(`pull-user:${password}`).toString('base64')}`;
      let credentialReads = 0;
      source.intercept((req, res) => {
        if ((req.url ?? '').startsWith('/auth/token?')) {
          expect(req.headers.authorization).toBe(pullAuth);
          const query = new URL(req.url ?? '', source.origin).searchParams;
          expect(query.get('service')).toBe('custom-registry');
          expect(query.get('scope')).toBe('repository:custom/team-workbench:pull');
          res.end(JSON.stringify({ access_token: 'private-pull-token' }));
          return true;
        }
        if (
          req.headers.authorization === (kind === 'basic' ? pullAuth : 'Bearer private-pull-token')
        )
          return false;
        res.writeHead(401, {
          'www-authenticate':
            kind === 'basic'
              ? 'Basic realm="registry"'
              : `Bearer realm="${source.origin}/auth/token",service="custom-registry"`,
        });
        res.end(password);
        return true;
      });
      await createWorkbenchImportPhase({
        ...options,
        readSource: async () => {
          credentialReads++;
          return { ...(await options.readSource()), username: 'pull-user', password };
        },
      }).run();
      expect(credentialReads).toBeGreaterThan(1);
      expect(target.blobs).toEqual(data.blobs);
      expect(source.calls.some(({ auth }) => auth === pullAuth)).toBe(true);
      expect(source.calls.every(({ auth }) => auth !== authorization)).toBe(true);
    }
  );

  it('accepts a registry-named HTTPS realm anonymously without forwarding destination credentials', async () => {
    const { options, source } = await setup();
    const realm = await registry({ host: '127.0.0.2' });
    realm.intercept((req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      res.end(JSON.stringify({ token: 'anonymous-off-origin-token' }));
      return true;
    });
    source.intercept((req, res) => {
      if (req.headers.authorization === 'Bearer anonymous-off-origin-token') return false;
      res.writeHead(401, {
        'www-authenticate': `Bearer realm="${realm.origin}/token",service="custom-registry"`,
      });
      res.end();
      return true;
    });
    await createWorkbenchImportPhase(options).run();
    expect(realm.calls).toHaveLength(1);
  });

  it('follows GitHub-style off-host HTTPS blob redirects without auth or cookies and verifies bytes', async () => {
    const { options, source, target, data } = await setup();
    const mirror = await registry({ data, host: '127.0.0.2' });
    source.intercept((req, res) => {
      if (req.headers.authorization === undefined) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="source"' });
        res.end();
        return true;
      }
      if ((req.url ?? '').includes('/blobs/')) {
        res.writeHead(307, {
          location: `${mirror.origin}${req.url}`,
          'set-cookie': 'secret-source-cookie=canary',
        });
        res.end();
        return true;
      }
      return false;
    });
    const authenticated = {
      ...options,
      readSource: async () => ({
        ...(await options.readSource()),
        username: 'pull-user',
        password,
      }),
    };
    await createWorkbenchImportPhase(authenticated).run();
    expect(mirror.calls.length).toBe(data.blobs.size);
    expect(
      mirror.calls.every(({ auth, cookie }) => auth === undefined && cookie === undefined)
    ).toBe(true);
    expect(target.blobs).toEqual(data.blobs);
    target.blobs.clear();
    target.manifests.clear();
    mirror.intercept((_req, res) => {
      res.end('tampered redirected blob');
      return true;
    });
    await expect(createWorkbenchImportPhase(authenticated).run()).rejects.toThrow(
      'workbench-import:digest-mismatch'
    );
  });

  it.each([
    { registry: 'not a registry URL', repository: 'valid/repo' },
    { registry: 'http://registry.example', repository: 'valid/repo' },
    { registry: 'https://user:secret@registry.example', repository: 'valid/repo' },
    { registry: 'https://registry.example/path', repository: 'valid/repo' },
    { registry: 'https://registry.example?query', repository: 'valid/repo' },
    { registry: 'https://registry.example#fragment', repository: 'valid/repo' },
    { registry: 'https://registry.example', repository: '../escape' },
    { registry: 'https://registry.example', repository: '' },
    { registry: 'https://registry.example', repository: 'valid/repo', username: 'user' },
  ])('refuses invalid source configuration before making requests: %j', async (source) => {
    const { options, target } = await setup();
    await expect(
      createWorkbenchImportPhase({ ...options, readSource: async () => source }).run()
    ).rejects.toThrow('workbench-import:configuration');
    expect(target.calls).toEqual([]);
  });

  it('sanitizes source provider failures and bounds a stalled source read', async () => {
    const { options } = await setup();
    await expect(
      createWorkbenchImportPhase({
        ...options,
        readSource: async () => {
          throw new Error(password);
        },
      }).run()
    ).rejects.toThrow('workbench-import:credential');
    await expect(
      createWorkbenchImportPhase({
        ...options,
        phaseTimeoutMs: 30,
        readSource: () => new Promise(() => undefined),
      }).run()
    ).rejects.toThrow('workbench-import:deadline');
  });

  it('does not send a changed source secret to the source captured at run start', async () => {
    const { options, source } = await setup();
    source.intercept((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="source"' });
      res.end();
      return true;
    });
    let reads = 0;
    await expect(
      createWorkbenchImportPhase({
        ...options,
        readSource: async () => ({
          ...(await options.readSource()),
          registry: ++reads === 1 ? source.origin : 'https://changed-registry.example',
          username: 'changed-user',
          password,
        }),
      }).run()
    ).rejects.toThrow('workbench-import:configuration');
    expect(source.calls.every(({ auth }) => auth === undefined)).toBe(true);
  });

  it.each(['http:', 'userinfo', 'fragment', 'scope'])(
    'rejects an unsafe bearer challenge: %s',
    async (kind) => {
      const { options, source } = await setup();
      const realm = new URL('/token', source.origin);
      if (kind === 'http:') realm.protocol = 'http:';
      if (kind === 'userinfo') realm.username = 'attacker';
      if (kind === 'fragment') realm.hash = 'attacker';
      source.intercept((_req, res) => {
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="${realm.href}"${kind === 'scope' ? ',scope="repository:other/repo:pull"' : ''}`,
        });
        res.end();
        return true;
      });
      await expect(createWorkbenchImportPhase(options).run()).rejects.toThrow(
        kind === 'scope' ? 'workbench-import:unauthorized' : 'workbench-import:redirect'
      );
      expect(source.calls.some(({ path }) => path === '/token')).toBe(false);
    }
  );

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
    const phase = createWorkbenchImportPhase({ ...options, pinnedDigest: '' });
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
