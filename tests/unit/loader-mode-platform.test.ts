import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createLoaderApp, type LoaderApp } from '../../loader/src/app.js';
import { loadConfig } from '../../loader/src/config.js';
import { systemClock } from '../../loader/src/clock.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function appFor(
  options: {
    root?: string;
    runInitial?: () => Promise<void>;
    unseal?: () => Promise<void>;
    lines?: RecordedLine[];
  } = {}
): LoaderApp {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'platform-loader-'));
  if (!options.root) roots.push(root);
  const lines = options.lines ?? [];
  return createLoaderApp({
    config: {
      ...loadConfig({
        LIFEMODEL_VOLUME_ROOT: root,
        LIFEMODEL_HTTP_PORT: '0',
        LIFEMODEL_NAME: 'lifemodel',
      }),
      loaderDir: root,
    },
    fs: createNodeFileSystem(),
    runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    logger: createRecordingLogger(lines),
    clock: systemClock,
    exit: () => {},
    pki: {
      bootstrap: async () => {},
      report: async () => ({
        identity: 'present',
        ca: 'present-matching',
        leaf: 'valid',
        sans: [],
        fingerprint: 'x',
      }),
      caPem: async () => 'CA',
    },
    platformBootstrap: {
      runInitial: options.runInitial ?? (async () => {}),
      unsealIfSealed: options.unseal ?? (async () => {}),
    },
  });
}

describe('the platform loader', () => {
  it('sets up authentication and preserves it across a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-loader-'));
    roots.push(root);
    const first = appFor({ root });
    await first.start();
    const port = first.port();
    const setup = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=secret',
      redirect: 'manual',
    });
    expect(setup.status).toBe(303);
    const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
    const home = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { host: 'boot-lifemodel.local', cookie },
    });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Platform mode');
    expect(await first.shutdown('test')).toBe(0);
    const second = appFor({ root });
    await second.start();
    const login = await fetch(`http://127.0.0.1:${second.port()}/login`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${second.port()}`,
        host: `127.0.0.1:${second.port()}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=secret',
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(await second.shutdown('test')).toBe(0);
  });

  it('logs out with real filesystem state and revokes the prior session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-loader-logout-'));
    roots.push(root);
    const app = appFor({ root });
    await app.start();
    const port = app.port();
    const setup = await fetch(`http://127.0.0.1:${port}/setup`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=secret',
      redirect: 'manual',
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const home = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { host: `boot-lifemodel.local:${port}`, cookie },
    });
    const html = await home.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
    const logout = await fetch(`http://127.0.0.1:${port}/logout`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${encodeURIComponent(csrf)}`,
      redirect: 'manual',
    });
    expect(logout.status).toBe(303);
    const denied = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { host: `boot-lifemodel.local:${port}`, cookie },
    });
    expect(denied.status).toBe(401);
    expect(await app.shutdown('test')).toBe(0);
  });

  it('serves the instance CA certificate at /ca.crt on its boot host', async () => {
    const app = appFor();
    await app.start();
    const response = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: app.port(),
          path: '/ca.crt',
          headers: { host: `boot-lifemodel.local:${app.port()}` },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body,
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(response.status, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('pem');
    expect(response.body).toBe('CA');
    expect(await app.shutdown('test')).toBe(0);
  });

  it('does not expose instance controls or a CLI API', async () => {
    const app = appFor();
    await app.start();
    for (const path of ['/panic', '/resume', '/_api/status', '/_api/panic', '/_api/resume']) {
      const response = await fetch(`http://127.0.0.1:${app.port()}${path}`, {
        headers: { host: `boot-lifemodel.local:${app.port()}` },
      });
      expect(response.status, path).toBe(404);
    }
    expect(await app.shutdown('test')).toBe(0);
  });

  it('completes PKI bootstrap before HTTP starts and platform bootstrap runs', async () => {
    let app!: LoaderApp;
    const observed: string[] = [];
    const orderRoot = mkdtempSync(join(tmpdir(), 'pki-order-'));
    roots.push(orderRoot);
    app = createLoaderApp({
      config: {
        ...loadConfig({
          LIFEMODEL_NAME: 'lifemodel',
          LIFEMODEL_HTTP_PORT: '0',
          LIFEMODEL_VOLUME_ROOT: orderRoot,
        }),
        loaderDir: join(orderRoot, 'loader'),
      },
      fs: createNodeFileSystem(),
      runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      logger: createRecordingLogger([]),
      clock: systemClock,
      exit: () => {},
      pki: {
        bootstrap: async () => {
          observed.push(`pki:${app.host()}`);
        },
        report: async () => ({
          identity: 'present',
          ca: 'present-matching',
          leaf: 'valid',
          sans: [],
          fingerprint: 'x',
        }),
        caPem: async () => 'CA',
      },
      platformBootstrap: {
        runInitial: async () => {
          observed.push(`bootstrap:${app.host()}`);
        },
        unsealIfSealed: async () => {
          observed.push(`unseal:${app.host()}`);
        },
      },
    });
    await app.start();
    for (let i = 0; i < 20 && observed.length < 3; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(observed).toEqual(['pki:null', 'bootstrap:0.0.0.0', 'unseal:0.0.0.0']);
    expect(await app.shutdown('test')).toBe(0);
  });

  it('logs the failed platform phase before retrying', async () => {
    const lines: RecordedLine[] = [];
    let resolveLogged!: (line: RecordedLine) => void;
    const logged = new Promise<RecordedLine>((resolve) => {
      resolveLogged = resolve;
    });
    lines.push = ((...items: RecordedLine[]) => {
      const length = Array.prototype.push.apply(lines, items);
      const failure = items.find(
        (line) => line.level === 'error' && line.message.includes('platform bootstrap failed')
      );
      if (failure) resolveLogged(failure);
      return length;
    }) as typeof lines.push;
    const app = appFor({
      lines,
      runInitial: async () => {
        throw new Error('bootstrap broke');
      },
    });
    await app.start();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('timed out waiting for bootstrap failure log')),
        2_000
      );
    });
    try {
      await expect(Promise.race([logged, timeout])).resolves.toMatchObject({
        level: 'error',
        message: expect.stringContaining('platform bootstrap failed'),
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    expect(await app.shutdown('test')).toBe(0);
  });
});
