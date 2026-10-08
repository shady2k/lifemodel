/**
 * A first start in the real container, end to end (lifemodel-q4x.2.1 rework 1).
 *
 * The walk that found the two defects: an empty volume, POST /setup, and the
 * loader must seed the instance's repository from the code the image carries,
 * build the commit and start lifemodel - as uid 1000, from a repository that
 * belongs to uid 1000 while the loader runs as root (git refuses such a
 * repository as "dubious ownership" unless the loader names it safe).
 *
 * It builds a real image and runs a real container, and the first `npm ci`
 * inside the container takes minutes, so it is off unless
 * LIFEMODEL_DOCKER_TESTS=1:
 *
 *   LIFEMODEL_DOCKER_TESTS=1 npx vitest run --maxWorkers=2 tests/integration/instance-first-start.test.ts
 *
 * Unlike tests/integration/instance-image.test.ts, the image here carries the
 * REAL loader (taken from this checkout's working tree, so the branch's own
 * loader is what is run) and the instance is never handed a stub: everything
 * it asserts is what a person gets from `docker run` and `docker exec`.
 *
 * LIFEMODEL_TEST_IMAGE=<image:tag> boots an image that is already built
 * instead of building one: CI's image job sets it to the image it has just
 * built, so the image that is walked is the image that was built (rework 3,
 * review round 2 finding 3). The test then neither builds nor removes it.
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

/** An image already built (CI's own); unset, the test builds one from this checkout. */
const prebuiltImage = process.env.LIFEMODEL_TEST_IMAGE ?? '';

/** This checkout, whose loader, Dockerfile and build script are under test. */
const checkout = fileURLToPath(new URL('../..', import.meta.url));

/** The first start builds the instance inside the container: this is its ceiling. */
const FIRST_START_TIMEOUT_MS = 15 * 60_000;

interface Run {
  status: number;
  out: string;
}

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
  location?: string | undefined;
  setCookie?: string[] | undefined;
}

/** One request the way a browser makes it: the host is a header, not a DNS name. */
function fetchThroughFrontDoor(
  port: number,
  host: string,
  path: string,
  opts: { cookie?: string; form?: Record<string, string>; origin?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    // A browser sends the page it came from on a form post, and the loader
    // refuses a state change without it (rework 2, finding 5).
    if (opts.form !== undefined) headers.Origin = opts.origin ?? `http://${host}`;
    if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
    const body = opts.form === undefined ? undefined : new URLSearchParams(opts.form).toString();
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers,
      },
      (res) => {
        let answer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (answer += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: answer,
            location: res.headers.location,
            setCookie: res.headers['set-cookie'],
          })
        );
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let buildDir = '';
let image = '';
let container = '';
let volume = '';
let port = 0;

/**
 * Waits for the event, never for a timer: the line the container logged. The
 * first start is minutes long, so the caller says for how long.
 */
async function waitForLogLine(pattern: RegExp, timeoutMs: number): Promise<string> {
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

/** How many times the container logged one line. */
function logCount(pattern: RegExp): number {
  return docker(['logs', container])
    .split('\n')
    .filter((candidate) => pattern.test(candidate)).length;
}

/** Wait until the container logged a line one more time than it had (the event). */
async function waitForCount(pattern: RegExp, target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (logCount(pattern) < target) {
    if (Date.now() > deadline) {
      throw new Error(
        `the container never logged ${String(pattern)} ${String(target)} times:\n${docker(['logs', container])}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The event of a start: the loader's own line, the second time (or later). */
async function waitForStarts(target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (logCount(/"msg":"lifemodel started"/) < target) {
    if (Date.now() > deadline) {
      throw new Error(
        `the loader never started lifemodel ${String(target)} times:\n${docker(['logs', container])}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The container's log lines, from one line onwards (the rest is history). */
function logFrom(first: string): string[] {
  const lines = docker(['logs', container]).split('\n');
  const start = lines.findIndex((line) => line.includes(first));
  return start === -1 ? lines : lines.slice(start);
}

/** The loader's own status line for lifemodel, as the container printed it. */
function loaderLine(pattern: RegExp): string | undefined {
  return docker(['logs', container])
    .split('\n')
    .find((candidate) => pattern.test(candidate));
}

/**
 * Wait until the container has logged `pattern` at least `count` times. A
 * restart appends to the same log, so a line from the FIRST run must not
 * answer a wait for the second one.
 */
async function waitForLogLines(
  pattern: RegExp,
  count: number,
  timeoutMs: number
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = docker(['logs', container])
      .split('\n')
      .filter((candidate) => pattern.test(candidate));
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) {
      throw new Error(
        `the container never logged ${String(pattern)} ${String(count)} times. Its log was:\n${docker(['logs', container])}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The one cookie a reply set, as a browser would send it back. */
function cookieOf(reply: Reply): string {
  const header = reply.setCookie?.[0] ?? '';
  return header.split(';')[0] ?? '';
}

/** One file's owner and mode inside the container, as `stat` prints them. */
function ownership(path: string): string {
  return docker(['exec', container, 'stat', '-c', '%U %a', path]).trim();
}

describe.skipIf(!enabled)('a first start in the real container', () => {
  beforeAll(
    async () => {
      if (prebuiltImage !== '') {
        image = prebuiltImage;
      } else {
        buildImage();
      }
      startContainer();
      await afterStart();
    },
    FIRST_START_TIMEOUT_MS + 25 * 60_000
  );

  /** The image from this checkout, as build-image.sh makes it. */
  function buildImage(): void {
    // A real clone with real history: build-image.sh refuses a shallow
    // checkout, and the seed bundle it makes must carry that history.
    buildDir = mkdtempSync(join(tmpdir(), 'lifemodel-first-start-'));
    const clone = join(buildDir, 'repo');
    runOk('git', ['clone', '--quiet', '--shared', checkout, clone], { cwd: buildDir });
    // The files this test is about, as this branch has them: the clone carries
    // the committed state, and the loader under test is the one here.
    cpSync(join(checkout, 'loader'), join(clone, 'loader'), { recursive: true });
    cpSync(join(checkout, 'docker/instance'), join(clone, 'docker/instance'), { recursive: true });
    cpSync(join(checkout, '.dockerignore'), join(clone, '.dockerignore'));
    cpSync(join(checkout, 'scripts/build-image.sh'), join(clone, 'scripts/build-image.sh'));

    const tag = `test-${process.pid}`;
    runOk('sh', ['scripts/build-image.sh', tag], {
      cwd: clone,
      env: { ...process.env, LIFEMODEL_IMAGE: 'lifemodel-first-start' },
      timeoutMs: 20 * 60_000,
    });
    image = `lifemodel-first-start:${tag}`;
  }

  function startContainer(): void {
    container = `lifemodel-first-start-${process.pid}`;
    volume = `${container}-volume`;
    // An empty volume and the documented command's shape: the port published on
    // loopback only, the one capability the Agent Vault stage needs, and the
    // stop timeout the documented command gives the whole stop (the loader
    // spends at most 110 s of it on lifemodel's drain and on Caddy).
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
      '120',
      '--mount',
      `source=${volume},target=/var/lib/lifemodel`,
      image,
    ]);
    const published = docker(['port', container, '80/tcp']).trim();
    const match = /:(?<port>\d+)$/.exec(published);
    if (match?.groups?.port === undefined) {
      throw new Error(`docker port printed no port for ${container}: ${published}`);
    }
    port = Number(match.groups.port);
  }

  async function afterStart(): Promise<void> {
    // The loader's own line is the event: it is up before anything is asked.
    await waitForLogLine(/"msg":"the loader is up"/, 60_000);

    // The owner sets the password on boot.<host>; that is what starts the
    // instance (story S1).
    const setup = await fetchThroughFrontDoor(port, 'boot.localhost', '/setup', {
      form: { password: 'first-start-pass' },
    });
    if (setup.status !== 303) {
      throw new Error(`POST /setup answered ${setup.status}: ${setup.body}`);
    }

    // The loader says lifemodel runs. Never a timer: the first npm ci inside
    // the container takes minutes, so the ceiling is generous.
    await waitForLogLine(/"msg":"the instance is ready".*"started":true/, FIRST_START_TIMEOUT_MS);
  }

  afterAll(() => {
    if (container !== '') {
      run('docker', ['rm', '--force', '--volumes', container]);
    }
    if (volume !== '') {
      run('docker', ['volume', 'rm', '--force', volume]);
    }
    if (image !== '' && prebuiltImage === '') {
      run('docker', ['rmi', '--force', image]);
    }
    if (buildDir !== '') {
      rmSync(buildDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('seeds, builds and starts lifemodel: status says running on a 40-hex commit', () => {
    const status = docker(['exec', container, 'lifemodel', 'status']);
    expect(status).toMatch(/^running\n/);
    expect(status).toMatch(/^commit [0-9a-f]{40}$/m);
    expect(status).toContain('panic off');
  });

  it('runs lifemodel as uid 1000, from the repository the loader seeded', () => {
    // The pid comes from the loader's own line; /proc/<pid> is owned by the
    // user the process runs as (the image carries no ps, so this is `ps -o uid`
    // inside it: the same fact, read from procfs).
    const started = loaderLine(/"msg":"lifemodel started","pid":\d+/);
    expect(started).toBeDefined();
    const pid = /"pid":(?<pid>\d+)/.exec(started ?? '')?.groups?.pid;
    expect(pid).toBeDefined();

    expect(docker(['exec', container, 'stat', '-c', '%u', `/proc/${String(pid)}`]).trim()).toBe(
      '1000'
    );
    // And the instance's repository belongs to it, which is why git needed the
    // safe-directory: the commit above could not have been read otherwise.
    expect(docker(['exec', container, 'stat', '-c', '%u', '/var/lib/lifemodel/repo']).trim()).toBe(
      '1000'
    );
  });

  it('lets the loader read that repository as root, with git', () => {
    // The loader ran git as root on a uid-1000 repository and got the commit:
    // no "dubious ownership" reached its log.
    const logs = docker(['logs', container]);
    expect(logs).not.toContain('dubious ownership');
    expect(logs).not.toContain('has no readable commit');
    expect(logs).not.toContain('the instance did not come up');
  });

  it('sends a browser that opens any host without a session to the login (rework 3)', async () => {
    // What README tells a person to open, and the two other hosts: a page, not
    // a bare 401, and the way back carried along.
    const boot = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/');
    expect(boot.status).toBe(303);
    expect(boot.location).toBe(
      `http://boot.localhost:${String(port)}/login?next=${encodeURIComponent(`http://boot.localhost:${String(port)}/`)}`
    );
    const root = await fetchThroughFrontDoor(port, `localhost:${String(port)}`, '/');
    expect(root.status).toBe(303);
    expect(root.location).toContain(`http://boot.localhost:${String(port)}/login?next=`);
    const login = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/login');
    expect(login.status).toBe(200);
    expect(login.body).toContain('Log in');
  });

  describe('Agent Vault, the layer that holds the keys (lifemodel-q4x.3.1)', () => {
    it('keeps its passwordless store on the volume, root-only, and a CA lifemodel can read', () => {
      // Decision 4: the store is passwordless, so the directory's permissions
      // ARE its protection, and lifemodel's user can read none of it.
      expect(ownership('/var/lib/lifemodel/vault')).toBe('root 700');
      expect(docker(['exec', container, 'ls', '/var/lib/lifemodel/vault/.agent-vault'])).toContain(
        'agent-vault.db'
      );
      // The loader's own two records: the instance owner account and the token
      // lifemodel's process is given.
      expect(ownership('/var/lib/lifemodel/loader/vault-owner.json')).toBe('root 600');
      expect(ownership('/var/lib/lifemodel/loader/vault-proxy.json')).toBe('root 600');
      // The CA is the one thing of the vault lifemodel must read, and it must
      // not be able to write it.
      expect(ownership('/var/lib/lifemodel/vault-ca.pem')).toBe('root 644');
      expect(
        docker(['exec', container, 'head', '-1', '/var/lib/lifemodel/vault-ca.pem'])
      ).toContain('-----BEGIN CERTIFICATE-----');
      // The vault is up on both loopback listeners, and nothing is published
      // for them: the proxy answers as a forward proxy, its API answers health.
      expect(
        docker([
          'exec',
          container,
          'curl',
          '-sS',
          '-m',
          '5',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          'http://127.0.0.1:14321/health',
        ]).trim()
      ).toBe('200');
      expect(
        docker(['exec', container, 'curl', '-sS', '-m', '5', 'http://127.0.0.1:14322/'])
      ).toContain('HTTP forward proxy');
    }, 120_000);

    it('shows Agent Vault at vault.localhost, and only behind the loader login', async () => {
      // Without the loader's session, the browser is sent to the login on the
      // boot host - Agent Vault is never reached (story S2).
      const without = await fetchThroughFrontDoor(port, `vault.localhost:${String(port)}`, '/');
      expect(without.status).toBe(303);
      expect(without.location).toContain(`http://boot.localhost:${String(port)}/login?next=`);

      const login = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/login', {
        form: { password: 'first-start-pass' },
      });
      expect(login.status).toBe(303);
      const cookie = cookieOf(login);
      expect(cookie).toContain('lm_session=');

      // With it: Agent Vault's OWN interface, at the root of its host (its UI
      // uses absolute /v1 paths, so it cannot live under a subpath).
      const vault = await fetchThroughFrontDoor(port, `vault.localhost:${String(port)}`, '/', {
        cookie,
      });
      expect(vault.status).toBe(200);
      expect(vault.body).toContain('<title>Agent Vault</title>');
      expect(vault.body).toContain('/assets/');
    }, 120_000);

    it('reuses the store and the token when the container starts again', async () => {
      const tokenPath = '/var/lib/lifemodel/loader/vault-proxy.json';
      const caPath = '/var/lib/lifemodel/vault-ca.pem';
      const before = docker(['exec', container, 'cat', tokenPath]);
      const caBefore = docker(['exec', container, 'cat', caPath]);

      // `docker restart`: the loader comes up again on the same volume.
      docker(['restart', container], { timeoutMs: 180_000 });
      // The second run's own line, not the first one's (the log is appended).
      await waitForLogLines(/"msg":"Agent Vault is up:/, 2, 60_000);

      expect(docker(['exec', container, 'cat', tokenPath])).toBe(before);
      expect(docker(['exec', container, 'cat', caPath])).toBe(caBefore);
      expect(ownership('/var/lib/lifemodel/vault')).toBe('root 700');
      // Nothing was created a second time: the vault and the agent are the
      // first start's.
      const created = docker(['logs', container])
        .split('\n')
        .filter((line) => line.includes('is created'));
      expect(created).toHaveLength(2); // the vault and the agent, once, on the first start
    }, 300_000);
  });

  it("serves lifemodel's settings at the root host, and a save restarts it with them", async () => {
    // The owner logs in once (the loader's cookie covers every host) and opens
    // the root host: lifemodel's own interface, which needs no auth of its own.
    const login = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/login', {
      form: { password: 'first-start-pass' },
      origin: `http://boot.localhost:${String(port)}`,
    });
    expect(login.status).toBe(303);
    const cookie = cookieOf(login);
    expect(cookie).toContain('lm_session=');

    // lifemodel is still building its container for a moment after the loader
    // says it started: the event is its own line that the interface is up, not
    // a timer (the root host answers 502 until then). lifemodel's own lines are
    // pino-pretty, the loader's are JSON.
    await waitForLogLine(/settings interface is up/, 120_000);

    const before = await fetchThroughFrontDoor(port, `localhost:${String(port)}`, '/', { cookie });
    expect(before.status).toBe(200);
    expect(before.body).toContain('Save and restart lifemodel');
    // The first start of an instance has no config at all, and the page says so
    // instead of lifemodel crash-looping on it.
    expect(before.body).toContain('No model endpoint is configured yet');
    expect(before.body).toContain('value="__telegram_bot_token__"');
    // The link to the loader for keys and panic, on the port the browser used.
    expect(before.body).toContain(`http://boot.localhost:${String(port)}/`);

    const startsBefore = logCount(/"msg":"lifemodel started"/);
    const interfacesBefore = logCount(/settings interface is up/);

    const save = await fetchThroughFrontDoor(port, `localhost:${String(port)}`, '/settings', {
      cookie,
      origin: `http://localhost:${String(port)}`,
      form: {
        endpointBaseUrl: 'http://127.0.0.1:9/v1',
        fastModel: 'test-fast',
        smartModel: 'test-smart',
        motorModel: 'test-motor',
        telegramChatId: '4242',
        telegramBotToken: '__telegram_bot_token__',
      },
    });
    expect(save.status).toBe(200);
    expect(save.body).toContain('Saved.');

    // The save wrote lifemodel's config file, at the path the instance uses.
    const written = docker(['exec', container, 'cat', '/var/lib/lifemodel/data/config/agent.json']);
    expect(written).toContain('http://127.0.0.1:9/v1');
    expect(written).toContain('test-smart');

    // And the loader restarted it AT ONCE - its own line, no backoff.
    await waitForLogLine(/lifemodel asked to be restarted/, 60_000);
    await waitForStarts(startsBefore + 1, 120_000);
    const afterSave = logFrom('"msg":"lifemodel asked to be restarted"');
    expect(afterSave.some((line) => line.includes('after a backoff'))).toBe(false);

    // The restarted lifemodel builds its container again before it answers:
    // wait for ITS OWN line (the second one), not for a timer - the root host
    // answers 502 until then.
    await waitForCount(/settings interface is up/, interfacesBefore + 1, 120_000);

    // The running lifemodel reads the new settings: the page shows them.
    const after = await fetchThroughFrontDoor(port, `localhost:${String(port)}`, '/', { cookie });
    expect(after.status).toBe(200);
    expect(after.body).toContain('value="http://127.0.0.1:9/v1"');
    expect(after.body).toContain('value="test-fast"');
    expect(after.body).toContain('value="4242"');
    expect(after.body).not.toContain('No model endpoint is configured yet');
  }, 300_000);

  it('holds panic and resumes, from the command line in the container', () => {
    const panicked = docker(['exec', container, 'lifemodel', 'panic'], { timeoutMs: 180_000 });
    expect(panicked).toContain('panic on');
    expect(panicked).toMatch(/^stopped\n/);

    const resumed = docker(['exec', container, 'lifemodel', 'resume'], { timeoutMs: 180_000 });
    expect(resumed).toContain('panic off');
    expect(resumed).toMatch(/^running\n/);
  }, 240_000);
});
