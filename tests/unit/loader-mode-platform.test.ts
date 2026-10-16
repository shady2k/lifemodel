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
function requestWithHost(
  port: number,
  path: string,
  host: string,
  method = 'GET',
  body = '',
  cookie = ''
): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host,
          origin: `http://${host}`,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (response) => {
        let content = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (content += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: content })
        );
      }
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}
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
        LIFEMODEL_NAME: 'lifemodel',
        LIFEMODEL_VOLUME_ROOT: root,
        LIFEMODEL_HTTP_PORT: '0',
      }),
      loaderDir: root,
    },
    fs: createNodeFileSystem(),
    runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    logger: createRecordingLogger(lines),
    clock: systemClock,
    exit: () => {},
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
    const setup = await requestWithHost(
      port,
      '/setup',
      'boot-lifemodel.local',
      'POST',
      'password=secret'
    );
    expect(setup.status).toBe(303);
    const cookie =
      (Array.isArray(setup.headers['set-cookie'])
        ? setup.headers['set-cookie'][0]
        : setup.headers['set-cookie']
      )?.split(';')[0] ?? '';
    const home = await requestWithHost(port, '/', 'boot-lifemodel.local', 'GET', '', cookie);
    expect(home.status).toBe(200);
    expect(home.body).toContain('Platform mode');
    expect(await first.shutdown('test')).toBe(0);
    const second = appFor({ root });
    await second.start();
    const login = await requestWithHost(
      second.port(),
      '/login',
      'boot-lifemodel.local',
      'POST',
      'password=secret'
    );
    expect(login.status).toBe(303);
    expect(await second.shutdown('test')).toBe(0);
  });

  it('does not expose instance controls or a CLI API', async () => {
    const app = appFor();
    await app.start();
    for (const path of ['/panic', '/resume', '/_api/status', '/_api/panic', '/_api/resume']) {
      const response = await fetch(`http://127.0.0.1:${app.port()}${path}`, {
        headers: { host: 'boot-lifemodel.local' },
      });
      expect(response.status, path).toBe(404);
    }
    expect(await app.shutdown('test')).toBe(0);
  });

  it('starts platform bootstrap after the HTTP interface is listening', async () => {
    let app!: LoaderApp;
    const observed: string[] = [];
    app = appFor({
      runInitial: async () => {
        observed.push(`bootstrap:${app.host()}`);
      },
      unseal: async () => {
        observed.push(`unseal:${app.host()}`);
      },
    });
    await app.start();
    for (let i = 0; i < 20 && observed.length < 2; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(observed).toEqual(['bootstrap:0.0.0.0', 'unseal:0.0.0.0']);
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
