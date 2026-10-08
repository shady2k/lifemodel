/**
 * The instance image and its front door (lifemodel-q4x.2.2).
 *
 * These tests build a real image and run a real container, so they are off
 * unless LIFEMODEL_DOCKER_TESTS=1 (they need docker, a few minutes and about
 * 600 MB of disk):
 *
 *   LIFEMODEL_DOCKER_TESTS=1 npx vitest run --maxWorkers=2 tests/integration/instance-image.test.ts
 *
 * They check what a person reaches through Caddy with Host headers, which is
 * how the stage's criterion is worded: boot.localhost is the loader, the root
 * host is lifemodel's own interface, vault.localhost is Agent Vault, and every
 * one of them is behind the loader's login.
 *
 * The loader itself is lifemodel-q4x.2.1's work and this branch does not have
 * it; the image builds whatever loader/ holds, so these tests build from a
 * throwaway clone of this checkout with tests/fixtures/stub-loader/ in its
 * place. The stub follows the same contract (its own README says which parts),
 * and it is never built into an image anyone runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Set LIFEMODEL_DOCKER_TESTS=1 to run these; nothing here is cheap. */
const enabled = process.env.LIFEMODEL_DOCKER_TESTS === '1';

/** This checkout, whose Dockerfile, Caddyfile and build script are under test. */
const checkout = fileURLToPath(new URL('../..', import.meta.url));

interface Run {
  status: number;
  out: string;
}

/** Runs a command and returns both streams, never throwing on a non-zero exit. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Run {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/** The same, for a command whose failure is a failed test with its output. */
function runOk(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): string {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with ${result.status}:\n${result.out}`);
  }
  return result.out;
}

function docker(args: string[], opts: Parameters<typeof run>[2] = {}): string {
  return runOk('docker', args, opts);
}

interface Reply {
  status: number;
  body: string;
}

/**
 * One request the way a browser makes it: the host is a header, not a DNS name,
 * and the port is the published one.
 */
function fetchThroughFrontDoor(
  port: number,
  host: string,
  path: string,
  opts: { cookie?: string; authorization?: string; method?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    if (opts.cookie !== undefined) {
      headers.Cookie = opts.cookie;
    }
    if (opts.authorization !== undefined) {
      headers.Authorization = opts.authorization;
    }
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** The session cookie the stub loader accepts (the real loader sets its own). */
const SESSION = 'lm_session=stub-session';

let buildDir = '';
let image = '';
let container = '';
let port = 0;

/** Waits for the event, not for a timer: the line the container logged. */
async function waitForLogLine(pattern: RegExp, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const logs = docker(['logs', container]);
    const line = logs.split('\n').find((candidate) => pattern.test(candidate));
    if (line !== undefined) {
      return line;
    }
    if (Date.now() > deadline) {
      throw new Error(`the container never logged ${String(pattern)}. Its log was:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!enabled)('the instance image', () => {
  beforeAll(() => {
    // A real clone with real history: build-image.sh refuses a shallow
    // checkout, and the seed bundle it makes must carry that history.
    buildDir = mkdtempSync(join(tmpdir(), 'lifemodel-image-'));
    const clone = join(buildDir, 'repo');
    runOk('git', ['clone', '--quiet', '--shared', checkout, clone], { cwd: buildDir });
    // The files under test, as this branch has them (the clone carries the
    // committed state of the branch, not the working tree).
    cpSync(join(checkout, 'docker/instance'), join(clone, 'docker/instance'), { recursive: true });
    cpSync(join(checkout, '.dockerignore'), join(clone, '.dockerignore'));
    cpSync(join(checkout, 'scripts/build-image.sh'), join(clone, 'scripts/build-image.sh'));
    // The stub loader, in the place the real one will be (lifemodel-q4x.2.1).
    cpSync(join(checkout, 'tests/fixtures/stub-loader'), join(clone, 'loader'), {
      recursive: true,
    });

    const tag = `test-${process.pid}`;
    runOk('sh', ['scripts/build-image.sh', tag], {
      cwd: clone,
      env: { ...process.env, LIFEMODEL_IMAGE: 'lifemodel-test' },
      timeoutMs: 20 * 60_000,
    });
    image = `lifemodel-test:${tag}`;

    container = `lifemodel-image-${process.pid}`;
    // The documented command's shape: the port published on loopback only, the
    // one capability the egress rule needs, a stop timeout longer than
    // lifemodel's 90 s drain.
    docker([
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      '127.0.0.1::80',
      '--cap-add',
      'NET_ADMIN',
      '--stop-timeout',
      '100',
      image,
    ]);
    const published = docker(['port', container, '80/tcp']).trim();
    const match = /:(?<port>\d+)$/.exec(published);
    if (match?.groups?.port === undefined) {
      throw new Error(`docker port printed no port for ${container}: ${published}`);
    }
    port = Number(match.groups.port);

    // The front door is up when the stub loader says Caddy answers on :80 —
    // the loader starts Caddy, so that line is the container being ready.
    return waitForLogLine(/component=loader event=caddy-listening port=80/);
  }, 20 * 60_000);

  afterAll(() => {
    if (container !== '') {
      run('docker', ['rm', '--force', '--volumes', container]);
    }
    if (image !== '') {
      run('docker', ['rmi', '--force', image]);
    }
    if (buildDir !== '') {
      rmSync(buildDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs the loader as the container's main process, under tini", () => {
    expect(docker(['exec', container, 'cat', '/proc/1/comm']).trim()).toBe('tini');
  });

  it('has a Caddyfile the pinned Caddy accepts', () => {
    const out = docker([
      'run',
      '--rm',
      '--entrypoint',
      '/usr/bin/caddy',
      image,
      'validate',
      '--config',
      '/etc/lifemodel/Caddyfile',
      '--adapter',
      'caddyfile',
    ]);
    expect(out).toContain('Valid configuration');
  });

  it("carries the repository's history in the seed bundle", () => {
    const expected = runOk('git', ['rev-list', '--count', 'HEAD'], { cwd: checkout }).trim();
    const out = docker([
      'run',
      '--rm',
      '--entrypoint',
      '/bin/sh',
      image,
      '-c',
      'git clone --quiet /opt/lifemodel/seed.bundle /tmp/instance 2>/dev/null && git -C /tmp/instance rev-list --count HEAD && git -C /tmp/instance rev-parse HEAD',
    ]);
    const [count, head] = out.trim().split('\n');
    expect(count).toBe(expected);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reaches the loader on the boot host without a login', async () => {
    const setup = await fetchThroughFrontDoor(port, 'boot.localhost', '/setup');
    expect(setup.status).toBe(200);
    expect(setup.body).toContain('stub-loader-setup');

    const login = await fetchThroughFrontDoor(port, 'boot.localhost', '/login');
    expect(login.status).toBe(200);
    expect(login.body).toContain('stub-loader-login');
  });

  it('refuses every other page on every host without the session cookie', async () => {
    for (const host of ['boot.localhost', 'localhost', 'vault.localhost']) {
      const reply = await fetchThroughFrontDoor(port, host, '/');
      expect(reply.status, `${host} without the cookie`).toBe(401);
    }
    // And the loader is the one that refused: it saw the checks.
    expect(await waitForLogLine(/component=loader event=auth .*status=401/)).toContain(
      'status=401'
    );
  });

  it("passes a request with the session cookie to the host's own backend", async () => {
    const boot = await fetchThroughFrontDoor(port, 'boot.localhost', '/', { cookie: SESSION });
    expect(boot.status).toBe(200);
    expect(boot.body).toContain('stub-loader');

    const root = await fetchThroughFrontDoor(port, 'localhost', '/', { cookie: SESSION });
    expect(root.status).toBe(200);
    expect(root.body).toContain('stub-lifemodel');
  });

  it('answers one plain line for a host whose backend is not up yet', async () => {
    const reply = await fetchThroughFrontDoor(port, 'vault.localhost', '/', { cookie: SESSION });
    expect(reply.status).toBe(502);
    expect(reply.body).toContain('Nothing is answering at this address yet.');
  });

  it('keeps the session cookie and any Authorization header out of the container log', async () => {
    const path = '/logged-secret-check';
    const authorization = 'Bearer not-a-real-key-KEEPMEOUT';
    await fetchThroughFrontDoor(port, 'localhost', path, {
      cookie: `lm_session=COOKIEMUSTNOTBELOGGED; other=1`,
      authorization,
    });

    // Wait for the front door's own access line for that request: the check
    // below is about a log that does have the request in it.
    const line = await waitForLogLine(new RegExp(`handled request.*${path}`));
    expect(line).toContain('handled request');

    const logs = docker(['logs', container]);
    expect(logs).toContain(path);
    expect(logs).not.toContain('COOKIEMUSTNOTBELOGGED');
    expect(logs).not.toContain('KEEPMEOUT');
  });
});
