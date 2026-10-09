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
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartWithSettingsReady } from './helpers/restart-with-settings-ready.js';

/** Set LIFEMODEL_DOCKER_TESTS=1 to run these; nothing here is cheap. */
const enabled = process.env.LIFEMODEL_DOCKER_TESTS === '1';

/** An image already built (CI's own); unset, the test builds one from this checkout. */
const prebuiltImage = process.env.LIFEMODEL_TEST_IMAGE ?? '';

/** This checkout, whose loader, Dockerfile and build script are under test. */
const checkout = fileURLToPath(new URL('../..', import.meta.url));

/** The first start builds the instance inside the container: this is its ceiling. */
const FIRST_START_TIMEOUT_MS = 15 * 60_000;

/**
 * The stub OpenAI-compatible endpoint (lifemodel-q4x.3.2): a second container
 * on the same Docker network as the instance, so lifemodel's user can reach it
 * only through Agent Vault's proxy. It answers a fixed completion and appends
 * every request it gets - method, URL, headers, body - to a file in its own
 * /tmp, which the test reads with `docker exec`.
 */
const STUB_PORT = 8080;

/** The name the stub is reachable under, inside the container network. */
const STUB_HOST = 'q4x32-stub.local';

const STUB_SCRIPT = `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    appendFileSync(
      '/tmp/q4x32-requests.jsonl',
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }) + '\\n'
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-q4x32',
        object: 'chat.completion',
        created: 0,
        model: 'q4x32-stub',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'a fixed completion from the stub' },
            finish_reason: 'stop',
          },
        ],
      })
    );
  });
}).listen(${String(STUB_PORT)}, '0.0.0.0', () => {
  // One line of its own, so a stub that cannot listen is not a silent wait.
  console.log('q4x32 stub listening on ${String(STUB_PORT)}');
});
`;

interface Run {
  status: number;
  out: string;
}

function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** One line on the command's standard input (Agent Vault's `--password-stdin`). */
    input?: string;
  } = {}
): Run {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.input === undefined ? {} : { input: opts.input }),
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
/** The stub, its own directory and the network the instance shares with it. */
let stubDir = '';
let stubContainer = '';
let network = '';

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
      await startStub();
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

  /**
   * The stub endpoint, as a second container from the same image on a network
   * of its own. `docker create` + `docker cp` + `docker start`: the image
   * carries no test fixture, and the container is the stub's own home.
   */
  async function startStub(): Promise<void> {
    network = `q4x32-first-start-net-${process.pid}`;
    stubContainer = `q4x32-stub-${process.pid}`;
    stubDir = mkdtempSync(join(tmpdir(), 'q4x32-stub-'));
    const script = join(stubDir, 'stub.mjs');
    writeFileSync(script, STUB_SCRIPT);
    docker(['network', 'create', network]);
    docker([
      'create',
      '--name',
      stubContainer,
      '--network',
      network,
      // A service host in Agent Vault must be a real hostname (one dot at
      // least, a letters-only TLD), so the stub answers to this one name.
      '--network-alias',
      STUB_HOST,
      '--entrypoint',
      'node',
      image,
      '/tmp/q4x32-stub.mjs',
    ]);
    docker(['cp', script, `${stubContainer}:/tmp/q4x32-stub.mjs`]);
    docker(['start', stubContainer]);
    // The stub's own line is the event: it is listening before anything asks.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (docker(['logs', stubContainer]).includes('q4x32 stub listening')) return;
      if (Date.now() > deadline) {
        throw new Error(`the stub never listened: ${docker(['logs', stubContainer])}`);
      }
      // A bounded wait, never a timer of its own: the stub's line is the event.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** The port Docker gave the published front door, read when it is needed. */
  function publishedPort(): number {
    const published = docker(['port', container, '80/tcp']).trim();
    const match = /:(?<port>\d+)$/.exec(published);
    if (match?.groups?.port === undefined) {
      throw new Error(`docker port printed no port for ${container}: ${published}`);
    }
    return Number(match.groups.port);
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
      '--network',
      network,
      // The stub is a container on this network, so it has a private address
      // (172.x), and Agent Vault's proxy refuses private ranges by default.
      // `AGENT_VAULT_ALLOW_PRIVATE_RANGES` is the documented way to open them
      // for an instance whose endpoint is on the owner's own network - which
      // is exactly what a local model server or this stub is. Cloud metadata
      // endpoints stay blocked either way.
      '--env',
      'AGENT_VAULT_ALLOW_PRIVATE_RANGES=true',
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
    port = publishedPort();
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
    if (stubContainer !== '') {
      run('docker', ['rm', '--force', stubContainer]);
    }
    if (stubDir !== '') {
      rmSync(stubDir, { recursive: true, force: true });
    }
    if (container !== '') {
      run('docker', ['rm', '--force', '--volumes', container]);
    }
    if (network !== '') {
      run('docker', ['network', 'rm', '--force', network]);
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
      await restartWithSettingsReady({
        logCount,
        waitForLogLines,
        restart: () => {
          docker(['restart', container], { timeoutMs: 180_000 });
        },
        refreshPort: () => {
          port = publishedPort();
        },
      });

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

    // The preceding vault restart waited for its fresh settings-listener event.
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
    const written = docker([
      'exec',
      container,
      'cat',
      '/var/lib/lifemodel/data/config/agent.json',
    ]);
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


  describe("lifemodel's traffic, and the key on the way out (lifemodel-q4x.3.2)", () => {
    /** The made-up credential values the stub's services use: no real key. */
    const MODEL_KEY = 'q4x32-made-up-model-key-0001';
    const BOT_TOKEN = 'q4x32-made-up-bot-token-0002';

    /**
     * The services of the stub's host: the model endpoint with bearer auth,
     * and a Telegram-shaped path with the token substituted into the path.
     * Written as the YAML the CLI takes (`substitutions` are file-only).
     */
    const servicesYaml = `services:
  - name: q4x32-model
    host: q4x32-stub.local:8080/v1/*
    auth:
      type: bearer
      token: Q4X32_MODEL_KEY
  - name: q4x32-telegram
    host: q4x32-stub.local:8080/bot/*
    auth:
      type: api-key
      key: Q4X32_BOT_TOKEN
      header: X-Q4X32-Bot
    substitutions:
      - key: Q4X32_BOT_TOKEN
        placeholder: __bot_token__
        in: [path]
`;

    interface StubRecord {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    }

    /** The loader's page, fetched as the owner: the session every host shares. */
    async function loaderPage(): Promise<{ cookie: string; body: string }> {
      const login = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/login', {
        form: { password: 'first-start-pass' },
      });
      if (login.status !== 303) throw new Error(`POST /login answered ${String(login.status)}`);
      const cookie = cookieOf(login);
      const page = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/', {
        cookie,
      });
      if (page.status !== 200) throw new Error(`GET / answered ${String(page.status)}`);
      return { cookie, body: page.body };
    }

    /** The account Agent Vault's own interface needs, as the loader page shows it. */
    function accountFromPage(body: string): { email: string; password: string } {
      const email = /<dt>owner<\/dt><dd>([^<]*)<\/dd>/.exec(body)?.[1];
      const password = /<dt>password<\/dt><dd>([^<]*)<\/dd>/.exec(body)?.[1];
      if (email === undefined || password === undefined) {
        throw new Error(`the loader page showed no Agent Vault account:\n${body}`);
      }
      return { email, password };
    }

    /** One Agent Vault CLI call inside the container, with the store's own HOME. */
    function vaultCli(args: string[], input?: string): string {
      return runOk(
        'docker',
        ['exec', '-i', '-e', 'HOME=/var/lib/lifemodel/vault', container, 'agent-vault', ...args],
        input === undefined ? {} : { input }
      );
    }

    /**
     * lifemodel's own environment, read from its own process: the variables
     * the probe below is run with are exactly these, not a test's guess.
     */
    function lifemodelEnvironment(): Record<string, string> {
      const started = docker(['logs', container])
        .split('\n')
        .filter((line) => /"msg":"lifemodel started","pid":\d+/.test(line))
        .at(-1);
      const pid = /"pid":(?<pid>\d+)/.exec(started ?? '')?.groups?.pid;
      if (pid === undefined) throw new Error('the loader never said lifemodel started');
      // Read as lifemodel's OWN user: root without CAP_SYS_PTRACE may not read
      // another user's environ, and this is the environment the criterion is
      // about anyway.
      const raw = docker(['exec', '-u', '1000', container, 'cat', `/proc/${pid}/environ`]);
      const environment: Record<string, string> = {};
      for (const entry of raw.split('\u0000')) {
        const separator = entry.indexOf('=');
        if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
      return environment;
    }

    /** The proxy environment lifemodel really has, and nothing else. */
    const PROXY_NAMES = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'NODE_USE_ENV_PROXY',
      'NODE_EXTRA_CA_CERTS',
    ];

    /**
     * One request as lifemodel's user, through the proxy lifemodel was given:
     * the probe runs with the environment its own process holds. `--proxy`
     * names that value explicitly because curl takes the LOWER-case name for
     * an `http://` target, while lifemodel's environment carries the standard
     * `HTTP_PROXY`/`HTTPS_PROXY` that Node and npm read - one value, two
     * spellings. The stub speaks plain HTTP, which is the forward-proxy path
     * of Agent Vault's listener (an https upstream goes through CONNECT and a
     * certificate the proxy re-signs; the injection is the same code).
     */
    function probeAsLifemodel(url: string, env: Record<string, string>, extra: string[] = []): Run {
      const args = ['exec', '-u', '1000'];
      for (const name of PROXY_NAMES) {
        const value = env[name];
        if (value !== undefined) args.push('-e', `${name}=${value}`);
      }
      args.push(
        container,
        'curl',
        '-sS',
        '-m',
        '15',
        '--proxy',
        env['HTTPS_PROXY'] ?? '',
        ...extra,
        url
      );
      return run('docker', args, { timeoutMs: 60_000 });
    }

    /**
     * One request as lifemodel's user with NO proxy in the environment: what a
     * bypass looks like. The container's own variables are cleared, so a
     * machine that passes its own proxy into containers cannot decide this.
     */
    function directAsLifemodel(url: string): { result: Run; ms: number } {
      const started = Date.now();
      const result = run(
        'docker',
        [
          'exec',
          '-u',
          '1000',
          '-e',
          'HTTP_PROXY=',
          '-e',
          'HTTPS_PROXY=',
          '-e',
          'http_proxy=',
          '-e',
          'https_proxy=',
          container,
          'curl',
          '-sS',
          '-m',
          '10',
          '-o',
          '/dev/null',
          url,
        ],
        { timeoutMs: 30_000 }
      );
      return { result, ms: Date.now() - started };
    }

    /** Every request the stub has recorded so far. */
    function stubRecords(): StubRecord[] {
      const raw = run('docker', ['exec', stubContainer, 'cat', '/tmp/q4x32-requests.jsonl']);
      if (raw.status !== 0) return [];
      return raw.out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as StubRecord);
    }

    /** The stub's record of one request: the event, waited for, never a timer. */
    async function stubRequestFor(urlPart: string, since: number): Promise<StubRecord> {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const records = stubRecords();
        const found = records.slice(since).find((record) => record.url.includes(urlPart));
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `the stub recorded no request for ${urlPart}: ${JSON.stringify(records.slice(since))}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    /** One request through the front door, on Agent Vault's own host. */
    function vaultApi(
      path: string,
      cookie: string,
      body: unknown
    ): Promise<Reply> {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {
              Host: `vault.localhost:${String(port)}`,
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(payload)),
              cookie,
            },
          },
          (res) => {
            let answer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (answer += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: answer, setCookie: res.headers['set-cookie'] })
            );
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    }

    /**
     * The fixture: the stub's host carries a service with the model key
     * (bearer) and the Telegram-shaped path, set up as the OWNER would set
     * them up (decision 12, story S3) - with the account the loader's own page
     * hands over, and the CLI session the loader's store keeps.
     */
    beforeAll(async () => {
      // A restart of the container re-publishes the front door on a NEW host
      // port (the documented command asks Docker for one), so the port the
      // tests above used is not the port this describe talks to.
      port = publishedPort();
      const page = await loaderPage();
      const account = accountFromPage(page.body);
      vaultCli(
        [
          'auth',
          'login',
          '--address',
          'http://127.0.0.1:14321',
          '--email',
          account.email,
          '--password-stdin',
        ],
        `${account.password}\n`
      );
      vaultCli([
        'vault',
        'credential',
        'set',
        `Q4X32_MODEL_KEY=${MODEL_KEY}`,
        `Q4X32_BOT_TOKEN=${BOT_TOKEN}`,
        '--vault',
        'lifemodel',
      ]);
      // `substitutions` are file-only in Agent Vault's CLI: this is the file.
      const services = join(stubDir, 'services.yaml');
      writeFileSync(services, servicesYaml);
      docker(['cp', services, `${container}:/tmp/q4x32-services.yaml`]);
      vaultCli([
        'vault',
        'service',
        'add',
        '-f',
        '/tmp/q4x32-services.yaml',
        '--vault',
        'lifemodel',
      ]);
    }, 240_000);

    it('shows the instance owner account on the loader page, and Agent Vault logs in with it', async () => {
      const page = await loaderPage();
      const account = accountFromPage(page.body);
      // Decision 18: the page carries the account and the way to use it, and
      // the page is never cached (a password is on it).
      expect(page.body).toContain('owner@lifemodel.local');
      expect(page.body).toContain(`<a href="http://vault.localhost:${String(port)}">`);
      const vaultPage = await fetchThroughFrontDoor(port, `boot.localhost:${String(port)}`, '/', {
        cookie: page.cookie,
      });
      expect(vaultPage.status).toBe(200);

      // Agent Vault's own login API, through the front door on its own host,
      // with the loader's session and the account the page showed: it answers
      // a session token, which is the owner signing in to add keys there.
      const login = await vaultApi('/v1/auth/login', page.cookie, {
        email: account.email,
        password: account.password,
      });
      expect(login.status).toBe(200);
      expect(String((JSON.parse(login.body) as { token?: string }).token)).toMatch(/^av_/);
    }, 120_000);

    it("carries lifemodel's request to the stub with its key injected, path placeholder and all", async () => {
      const env = lifemodelEnvironment();
      // The proxy environment lifemodel's own process has, built in ONE place:
      // the vault's proxy with the agent token, loopback out of the proxy, the
      // proxy understood by fetch, and the vault's CA.
      const token = (
        JSON.parse(docker(['exec', container, 'cat', '/var/lib/lifemodel/loader/vault-proxy.json'])) as {
          token: string;
        }
      ).token;
      expect(env['HTTPS_PROXY']).toBe(`http://${token}:lifemodel@127.0.0.1:14322`);
      expect(env['HTTP_PROXY']).toBe(env['HTTPS_PROXY']);
      expect(env['NO_PROXY']).toBe('localhost,127.0.0.1');
      expect(env['NODE_USE_ENV_PROXY']).toBe('1');
      expect(env['NODE_EXTRA_CA_CERTS']).toBe('/var/lib/lifemodel/vault-ca.pem');

      // The stub's host is NOT loopback: this only arrives if the request left
      // through the proxy, with the vault's own key attached on the way.
      const before = stubRecords().length;
      const model = probeAsLifemodel(
        `http://${STUB_HOST}:${String(STUB_PORT)}/v1/chat/completions`,
        env,
        [
          '-X',
          'POST',
          '-H',
          'content-type: application/json',
          '-d',
          '{"model":"q4x32-stub","messages":[]}',
        ]
      );
      expect(model.status).toBe(0);
      expect(model.out).toContain('a fixed completion from the stub');
      const modelRecord = await stubRequestFor('/v1/chat/completions', before);
      expect(modelRecord.method).toBe('POST');
      expect(modelRecord.headers['authorization']).toBe(`Bearer ${MODEL_KEY}`);
      // The proxy's own credential is the broker's business, not the
      // upstream's: it does not travel on.
      expect(modelRecord.headers['proxy-authorization']).toBeUndefined();
      expect(modelRecord.body).toContain('q4x32-stub');

      // The Telegram shape: the token lives in the PATH, and Agent Vault
      // substitutes it there (placeholders are declared in the service).
      const beforeBot = stubRecords().length;
      const bot = probeAsLifemodel(
        `http://${STUB_HOST}:${String(STUB_PORT)}/bot/__bot_token__/sendMessage`,
        env,
        ['-X', 'POST', '-d', 'chat_id=1&text=hello']
      );
      expect(bot.status).toBe(0);
      const botRecord = await stubRequestFor('/sendMessage', beforeBot);
      expect(botRecord.url).toBe(`/bot/${BOT_TOKEN}/sendMessage`);
      expect(botRecord.headers['x-q4x32-bot']).toBe(BOT_TOKEN);
      expect(JSON.stringify(botRecord)).not.toContain('__bot_token__');
    }, 180_000);

    it('refuses a direct connection from lifemodel to anywhere but loopback, at once', () => {
      // The kernel rule, not the environment: no proxy is set on this request.
      const outside = directAsLifemodel('http://1.1.1.1/');
      expect(outside.result.status).not.toBe(0);
      // A REJECT, not a DROP: it fails now and says so - a hang would be the
      // failure this rule exists to avoid.
      expect(outside.ms).toBeLessThan(3_000);
      expect(outside.result.out).not.toMatch(/timed out|Timeout/i);

      // And the stub, which root reaches, is out of lifemodel's reach too.
      const neighbour = directAsLifemodel(`http://${STUB_HOST}:${String(STUB_PORT)}/v1/chat/completions`);
      expect(neighbour.result.status).not.toBe(0);
      expect(neighbour.ms).toBeLessThan(3_000);

      // Loopback is still lifemodel's: the loader's own port answers it.
      const loopback = run('docker', [
        'exec',
        '-u',
        '1000',
        container,
        'curl',
        '-sS',
        '-m',
        '5',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        'http://127.0.0.1:7000/login',
      ]);
      expect(loopback.out.trim()).toBe('200');
    }, 120_000);

    it('leaves root untouched, and the key on the way out comes from the vault, not from the caller', async () => {
      // Root is not named by the rule: it reaches the stub directly, with no
      // proxy and no key - which is what makes the injected header above the
      // VAULT's doing and not the caller's.
      const before = stubRecords().length;
      const direct = runOk(
        'docker',
        [
          'exec',
          container,
          'curl',
          '-sS',
          '-m',
          '15',
          '-X',
          'POST',
          '-H',
          'content-type: application/json',
          '-d',
          '{}',
          `http://${STUB_HOST}:${String(STUB_PORT)}/v1/chat/completions`,
        ],
        { timeoutMs: 60_000 }
      );
      expect(direct).toContain('a fixed completion from the stub');
      const record = await stubRequestFor('/v1/chat/completions', before);
      expect(record.headers['authorization']).toBeUndefined();
    }, 120_000);

    it('leaves no IPv6 way out for the rule to miss', () => {
      // The rule is IPv4, the family Docker's default network gives the
      // container. Its ONLY IPv6 address is the loopback one, and there is no
      // IPv6 route out, so a bypass has no other address to use. An instance
      // on an IPv6-enabled Docker network is not covered by this stage.
      const addresses = docker(['exec', container, 'cat', '/proc/net/if_inet6'])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      expect(addresses).toHaveLength(1);
      expect(addresses[0]).toMatch(/ lo$/);
    }, 60_000);

    it("keeps the made-up key out of lifemodel's environment, config and logs", () => {
      const env = lifemodelEnvironment();
      // lifemodel holds its proxy credential (that is how it reaches the
      // vault) and NOT the key the vault attaches for it.
      expect(env['AGENT_VAULT_TOKEN']).toBeDefined();
      expect(JSON.stringify(env)).not.toContain(MODEL_KEY);
      expect(JSON.stringify(env)).not.toContain(BOT_TOKEN);
      // Its configuration: the data on the volume, where its own settings live.
      const inData = run('docker', ['exec', container, 'grep', '-rl', MODEL_KEY, '/var/lib/lifemodel/data']);
      expect(inData.status).toBe(1); // grep's own "found nothing"
      // And the container's log, the loader's lines included.
      const logs = docker(['logs', container]);
      expect(logs).not.toContain(MODEL_KEY);
      expect(logs).not.toContain(BOT_TOKEN);
      // The key IS in the vault: the stub saw it arrive, which is the point.
      expect(stubRecords().some((record) => record.headers['authorization'] === `Bearer ${MODEL_KEY}`)).toBe(
        true
      );
    }, 120_000);
  });

  it('holds panic and resumes, from the command line in the container', () => {
    const panicked = docker(['exec', container, 'lifemodel', 'panic'], { timeoutMs: 180_000 });
    expect(panicked).toContain('panic on');
    expect(panicked).toMatch(/^stopped\n/);

    const resumed = docker(['exec', container, 'lifemodel', 'resume'], { timeoutMs: 180_000 });
    expect(resumed).toContain('panic off');
    expect(resumed).toMatch(/^running\n/);
  }, 240_000);
});
