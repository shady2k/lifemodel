/**
 * The loader's own interface (lifemodel-q4x.2.1, stories S1, S2, S6).
 *
 * Everything here goes through the real HTTP server on a real port, the way
 * Caddy and a browser reach it: the password page on boot.<host>, one session
 * cookie that opens boot., the root host and vault., the forward_auth answer
 * Caddy asks for, and the command line's status|panic|resume.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../loader/src/cli.js';
import type { InstanceStatus } from '../../loader/src/bootstrap.js';
import {
  caddySpawn,
  createLoaderWorld,
  createRunningLoader,
  lifemodelSpawn,
  scriptRepository,
  settle,
  shutdownLoader,
  waitUntil,
} from '../helpers/loader-doubles.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RequestOptions {
  host?: string;
  cookie?: string;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /**
   * The page the request comes from. A browser sends one for a form post, and
   * the default here is what the loader's own page sends: the host the request
   * goes to. `null` sends none, which is what an attack page cannot avoid and a
   * test can (rework 2, finding 5).
   */
  origin?: string | null;
}

/** One request the way a browser or Caddy makes it: its own Host, its cookie. */
function ask(
  port: number,
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<Answer> {
  const form =
    options.form === undefined ? undefined : new URLSearchParams(options.form).toString();
  const host = options.host ?? 'localhost';
  const headers: Record<string, string> = {
    host,
    connection: 'close',
    ...options.headers,
  };
  const origin = options.origin === undefined ? `http://${host}` : options.origin;
  if (origin !== null) headers['origin'] = origin;
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (form !== undefined) req.write(form);
    req.end();
  });
}

/** The command line the way `docker exec <c> lifemodel ...` runs it. */
async function cli(
  app: Awaited<ReturnType<typeof createRunningLoader>>['app'],
  argv: string[]
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    baseUrl: `http://127.0.0.1:${app.port()}`,
    readCliToken: () => app.state.readCliToken(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetchImpl: fetch,
  });
  return { code, out, err };
}

/**
 * The anti-CSRF token of the loader's own page, taken from the form the way a
 * browser takes it (rework 2, finding 5).
 */
async function csrfOf(port: number, host: string, cookie: string): Promise<string> {
  const dashboard = await ask(port, 'GET', '/', { host, cookie });
  const match = /name="csrf" value="(?<csrf>[^"]+)"/.exec(dashboard.body);
  if (match?.groups?.csrf === undefined) {
    throw new Error(`the loader page carried no anti-CSRF token:\n${dashboard.body}`);
  }
  return match.groups.csrf;
}

/** The one cookie of a Set-Cookie header, as a browser would send it back. */
function cookieOf(headers: IncomingHttpHeaders): string {
  const setCookie = headers['set-cookie']?.[0];
  if (setCookie === undefined) throw new Error('the answer carried no Set-Cookie');
  return setCookie.split(';')[0] ?? '';
}

describe('first start through the browser', () => {
  it('asks for a password on boot.<host>, then seeds, builds and starts the instance', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world, { password: null });
    const port = app.port();

    const setup = await ask(port, 'GET', '/setup', { host: 'boot.localhost' });
    expect(setup.status).toBe(200);
    expect(setup.body).toContain("Set the loader's password");

    const set = await ask(port, 'POST', '/setup', {
      host: 'boot.localhost',
      form: { password: 'a password only the owner knows' },
    });
    expect(set.status).toBe(303);
    expect(set.headers['location']).toBe('/');
    const setCookie = set.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain('lm_session=');
    expect(setCookie).toContain('Domain=localhost');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');

    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    expect(world.runner.lines()).toEqual([
      `git clone ${world.config.seedBundle} ${world.config.repoDir}`,
      'git remote',
      'git remote rename origin upstream',
      `git remote set-url upstream ${world.config.upstreamUrl}`,
      'git rev-parse HEAD',
      'npm ci',
      'npm run build',
    ]);

    const dashboard = await ask(port, 'GET', '/', {
      host: 'boot.localhost',
      cookie: cookieOf(set.headers),
    });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toContain('running');
    expect(dashboard.body).toContain('c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff');
    expect(dashboard.body).toContain('panic</dt><dd>off');
    expect(lines.some((line) => line.message.includes('password is set'))).toBe(true);

    await shutdownLoader(world, app);
  });

  it('a second visit with the password set sends the owner to the login page', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    const port = app.port();

    const setup = await ask(port, 'GET', '/setup', { host: 'boot.localhost' });

    expect(setup.status).toBe(303);
    expect(setup.headers['location']).toBe('/login');
    await shutdownLoader(world, app);
  });
});

describe('one login, three hosts', () => {
  it('answers forward_auth 2xx for the cookie and 401 for everything else', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    const port = app.port();

    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right' },
    });
    expect(login.status).toBe(303);
    const cookie = cookieOf(login.headers);

    for (const host of ['boot.localhost', 'localhost', 'vault.localhost']) {
      const verified = await ask(port, 'GET', '/_auth/verify', { host, cookie });
      expect({ host, status: verified.status, body: verified.body }).toEqual({
        host,
        status: 200,
        body: 'ok',
      });
    }

    const anonymous = await ask(port, 'GET', '/_auth/verify', { host: 'localhost' });
    expect(anonymous.status).toBe(401);
    const edited = await ask(port, 'GET', '/_auth/verify', {
      host: 'localhost',
      cookie: `${cookie}x`,
    });
    expect(edited.status).toBe(401);
    // The loader's own page is behind the same login.
    expect((await ask(port, 'GET', '/', { host: 'localhost' })).status).toBe(401);
    expect((await ask(port, 'GET', '/', { host: 'localhost', cookie })).status).toBe(200);

    await shutdownLoader(world, app);
  });

  it('sends a browser that opens a page without a session to the login, and back after it (rework 3)', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    const port = app.port();
    // What Caddy's forward_auth sends: the loader's own Host, and the browser's
    // method, host and path as X-Forwarded-*.
    const verify = (method: string, forwardedHost: string, uri = '/') =>
      ask(port, 'GET', '/_auth/verify', {
        host: forwardedHost,
        headers: {
          'x-forwarded-method': method,
          'x-forwarded-host': forwardedHost,
          'x-forwarded-uri': uri,
        },
      });

    const boot = await verify('GET', 'boot.localhost:8080');
    expect(boot.status).toBe(303);
    expect(boot.headers['location']).toBe(
      `http://boot.localhost:8080/login?next=${encodeURIComponent('http://boot.localhost:8080/')}`
    );
    const root = await verify('GET', 'localhost:8080', '/settings?x=1');
    expect(root.headers['location']).toBe(
      `http://boot.localhost:8080/login?next=${encodeURIComponent('http://localhost:8080/settings?x=1')}`
    );
    expect((await verify('HEAD', 'vault.localhost')).status).toBe(303);
    // A request that would change something is refused, never redirected.
    expect((await verify('POST', 'localhost:8080')).status).toBe(401);
    // A path that is not a path is not carried.
    expect((await verify('GET', 'localhost', '//evil.example/')).headers['location']).toBe(
      `http://boot.localhost/login?next=${encodeURIComponent('http://localhost/')}`
    );

    // The login page keeps an address of this instance as where to go next...
    const next = 'http://localhost:8080/settings';
    const page = await ask(port, 'GET', `/login?next=${encodeURIComponent(next)}`, {
      host: 'boot.localhost:8080',
    });
    expect(page.body).toContain(`name="next" value="${next}"`);
    // ...and nothing else: no open redirect.
    for (const foreign of [
      'http://evil.example/',
      'javascript:alert(1)',
      '//evil.example/',
      // Another local port: cookies are not scoped by port (review round 3, finding 3).
      'http://localhost:9999/',
      // Another scheme, so another default port (review round 4, finding 2).
      'https://localhost/',
    ]) {
      const refused = await ask(port, 'GET', `/login?next=${encodeURIComponent(foreign)}`, {
        host: 'boot.localhost',
      });
      expect(refused.body).not.toContain('name="next"');
    }
    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost:8080',
      form: { password: 'right', next },
    });
    expect(login.status).toBe(303);
    expect(login.headers['location']).toBe(next);
    const foreignLogin = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right', next: 'http://evil.example/' },
    });
    expect(foreignLogin.headers['location']).toBe('/');
    const otherPort = await ask(port, 'POST', '/login', {
      host: 'boot.localhost:8080',
      form: { password: 'right', next: 'http://localhost:9999/' },
    });
    expect(otherPort.headers['location']).toBe('/');
    const otherScheme = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right', next: 'https://localhost/' },
    });
    expect(otherScheme.headers['location']).toBe('/');

    await shutdownLoader(world, app);
  });

  it('refuses a wrong password, says so once at warn, and never writes the password', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world, { password: 'the right one' });
    const port = app.port();

    const wrong = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'the wrong one' },
    });

    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const warned = lines.filter((line) => line.level === 'warn');
    expect(warned.map((line) => line.message)).toEqual([
      'login refused: the password does not match',
    ]);
    expect(warned[0]?.fields['host']).toBe('boot.localhost');
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toContain('the wrong one');
      expect(JSON.stringify(line)).not.toContain('the right one');
    }

    const right = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'the right one' },
    });
    expect(right.status).toBe(303);
    expect(right.headers['set-cookie']?.[0]).toContain('lm_session=');

    await shutdownLoader(world, app);
  });

  it('logs out by clearing the cookie', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    const port = app.port();
    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right' },
    });
    const cookie = cookieOf(login.headers);

    const csrf = await csrfOf(port, 'boot.localhost', cookie);
    const out = await ask(port, 'POST', '/logout', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
    });

    expect(out.status).toBe(303);
    expect(out.headers['location']).toBe('/login');
    expect(out.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    await shutdownLoader(world, app);
  });
});

describe('the command line inside the container', () => {
  it('reports the state, the commit and panic; panic stops lifemodel, resume starts it', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    const status = await cli(app, ['status']);
    expect(status.code).toBe(0);
    expect(status.out).toEqual([
      'running',
      'commit c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff',
      'panic off',
    ]);

    const panicking = cli(app, ['panic']);
    await waitUntil(
      () => lifemodelSpawn(world)?.child.signals.length === 1,
      'lifemodel is stopped'
    );
    lifemodelSpawn(world)?.child.exit(0, null);
    const panicked = await panicking;
    expect(panicked.code).toBe(0);
    expect(panicked.out).toEqual([
      'stopped',
      'commit c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff',
      'panic on',
    ]);

    const after = await cli(app, ['status']);
    expect(after.out[0]).toBe('stopped');
    expect(after.out[2]).toBe('panic on');

    const resumed = await cli(app, ['resume']);
    expect(resumed.code).toBe(0);
    expect(resumed.out[0]).toBe('running');
    expect(resumed.out[2]).toBe('panic off');
    expect(
      world.launcher.spawns.filter((s) => s.args[0] === world.config.lifemodelEntry)
    ).toHaveLength(2);
    expect(lines.some((line) => line.message.includes('panic cleared from the command line'))).toBe(
      true
    );

    await shutdownLoader(world, app);
  });

  it('refuses a caller without the loader token, and an unknown command', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world);
    const port = app.port();

    const forged = await ask(port, 'GET', '/_api/status', {
      host: 'localhost',
      headers: { 'x-loader-cli-token': 'not-the-token' },
    });
    expect(forged.status).toBe(403);
    expect(lines.some((line) => line.message.includes('command line request refused'))).toBe(true);

    const unknown = await cli(app, ['dance']);
    expect(unknown.code).toBe(1);
    expect(unknown.err[0]).toContain('unknown command');
    const missing = await cli(app, []);
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toContain('usage: lifemodel');

    await shutdownLoader(world, app);
  });

  it('reports a start the OS refused, and resume exits 1 with the reason', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    // The OS cannot start lifemodel (rework 2, finding 6); Caddy is fine.
    world.launcher.refuseSpawns(new Error('spawn node EPERM'), 'node');
    const { app, lines } = await createRunningLoader(world);
    await waitUntil(
      () => lines.some((line) => line.message.includes('the instance did not come up')),
      'the loader says the instance did not come up'
    );

    const status = await cli(app, ['status']);
    expect(status.code).toBe(0);
    expect(status.out).toEqual([
      'failed',
      'commit c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff',
      'panic off',
      'failed: spawn node EPERM',
    ]);

    // Resume is the retry, and it says the same: the instance did not come up.
    const resumed = await cli(app, ['resume']);
    expect(resumed.code).toBe(1);
    expect(resumed.out[0]).toBe('failed');
    expect(resumed.out[3]).toContain('spawn node EPERM');

    await shutdownLoader(world, app);
  });

  it('says why it cannot reach the loader', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    const port = app.port();
    await shutdownLoader(world, app);

    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['status'], {
      baseUrl: `http://127.0.0.1:${port}`,
      readCliToken: () => app.state.readCliToken(),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetchImpl: fetch,
    });

    expect(code).toBe(1);
    expect(err[0]).toContain('the loader is not reachable');
  });
});

describe('a failed first start (rework 1)', () => {
  it('leaves the loader serving, its state failed with the reason, and panic and resume working', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    // The build fails the way the owner's own repository can: a real npm ci
    // error. The loader is up and has a password, so it tries at startup.
    let failing = true;
    world.runner.on('npm ci', () =>
      failing
        ? {
            code: 1,
            stdout: '',
            stderr: 'npm error code EUSAGE\nnpm error the lockfile is not there\n',
          }
        : { code: 0, stdout: 'added 1 package\n', stderr: '' }
    );
    const { app, lines, exits } = await createRunningLoader(world);
    const port = app.port();

    // The event the test waits for is the loader's own line, not a timer.
    await waitUntil(
      () => lines.some((line) => line.message.includes('the instance did not come up')),
      'the loader says the instance did not come up'
    );
    expect(exits).toEqual([]); // the loader is still here
    expect(lifemodelSpawn(world)).toBeUndefined();

    // Its interface answers, and says failed with the reason.
    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right' },
    });
    const cookie = cookieOf(login.headers);
    const page = await ask(port, 'GET', '/', { host: 'boot.localhost', cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<dt>state</dt><dd>failed</dd>');
    expect(page.body).toContain('failed: npm ci failed');
    expect(page.body).toContain('npm error the lockfile is not there');
    // The two buttons are still there: panic and resume keep working.
    expect(page.body).toContain('action="/panic"');
    expect(page.body).toContain('action="/resume"');

    // `lifemodel status` says the same, and reports rather than fails.
    const status = await cli(app, ['status']);
    expect(status.code).toBe(0);
    expect(status.out).toEqual([
      'failed',
      'commit c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff',
      'panic off',
      'failed: npm ci failed in ' + world.config.repoDir + ': npm error the lockfile is not there',
    ]);

    const panicking = await cli(app, ['panic']);
    expect(panicking.code).toBe(0);
    expect(panicking.out[2]).toBe('panic on');

    // Resume is the retry: while the build still fails, it says so and exits 1.
    const stillFailing = await cli(app, ['resume']);
    expect(stillFailing.code).toBe(1);
    expect(stillFailing.out[0]).toBe('failed');
    expect(stillFailing.out[3]).toContain('failed: npm ci failed');

    // The owner fixes what was wrong; the same command now brings it up.
    failing = false;
    const resumed = await cli(app, ['resume']);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toEqual([
      'running',
      'commit c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff',
      'panic off',
    ]);
    expect(lifemodelSpawn(world)).toBeDefined();
    expect(exits).toEqual([]);

    await shutdownLoader(world, app);
  });
});

describe('panic holds across a restart of the container', () => {
  it('a fresh loader over the same volume starts nothing until it is resumed', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const first = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    await first.app.state.setPanic('the command line');

    const panicking = first.app.supervisor.stop('panic');
    await settle();
    lifemodelSpawn(world)?.child.exit(0, null);
    await panicking;
    await shutdownLoader(world, first.app);
    const spawnsSoFar = world.launcher.spawns.length;

    // `docker restart`: the loader comes up again on the same volume.
    const second = await createRunningLoader(world);
    await settle(8);

    expect(world.launcher.spawns.length).toBe(spawnsSoFar + 1); // only caddy
    expect(caddySpawn(world)?.command).toBe(world.config.caddy.binary);
    const status = await second.app.bootstrap.status();
    expect(status.panic).toBe(true);
    expect(status.lifemodel).toBe('stopped');

    // `lifemodel resume` (or the button) clears it and starts lifemodel.
    await second.app.state.clearPanic();
    await second.app.bootstrap.ensureReady('resume');
    expect(lifemodelSpawn(world)).toBeDefined();
    expect((await second.app.bootstrap.status()).lifemodel).toBe('running');

    await shutdownLoader(world, second.app);
  });
});

describe('the loader page drives panic and resume', () => {
  it('stops lifemodel from the button and starts it again', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    const port = app.port();
    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right' },
    });
    const cookie = cookieOf(login.headers);
    const csrf = await csrfOf(port, 'boot.localhost', cookie);

    const panicking = ask(port, 'POST', '/panic', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
    });
    await waitUntil(
      () => lifemodelSpawn(world)?.child.signals.length === 1,
      'lifemodel is stopped'
    );
    lifemodelSpawn(world)?.child.exit(0, null);
    const panicked = await panicking;
    expect(panicked.status).toBe(303);
    const status: InstanceStatus = await second_status(port, cookie);
    expect(status.panic).toBe(true);
    expect(status.lifemodel).toBe('stopped');

    const resuming = ask(port, 'POST', '/resume', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
    });
    const resumed = await resuming;
    expect(resumed.status).toBe(303);
    await waitUntil(
      () =>
        world.launcher.spawns.filter((s) => s.args[0] === world.config.lifemodelEntry).length === 2,
      'lifemodel is started again'
    );

    await shutdownLoader(world, app);
  });
});

describe("a state change must come from the loader's own page (rework 2, finding 5)", () => {
  /** A logged-in browser: its cookie, and the token of the page it is on. */
  async function loggedIn(port: number): Promise<{ cookie: string; csrf: string }> {
    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: 'right' },
    });
    const cookie = cookieOf(login.headers);
    return { cookie, csrf: await csrfOf(port, 'boot.localhost', cookie) };
  }

  it('refuses panic and resume with a valid cookie but no token or a foreign Origin', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    const port = app.port();
    const { cookie, csrf } = await loggedIn(port);

    // The attack: a form served by the root host (or any other page of the
    // parent site) posting to boot.localhost with the owner's cookie.
    const foreign = await ask(port, 'POST', '/resume', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
      origin: 'http://localhost:8080',
    });
    expect(foreign.status).toBe(403);
    // A request that names no page at all is refused too.
    const nameless = await ask(port, 'POST', '/panic', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
      origin: null,
    });
    expect(nameless.status).toBe(403);
    // And the token is the session's: no token, a foreign one, or one of
    // another session all fail, whatever the Origin says.
    for (const form of [{}, { csrf: 'not-a-token' }]) {
      const forged = await ask(port, 'POST', '/panic', { host: 'boot.localhost', cookie, form });
      expect({ form, status: forged.status }).toEqual({ form, status: 403 });
    }
    expect(await app.state.isPanicSet()).toBe(false);
    expect(lifemodelSpawn(world)?.child.signals).toEqual([]);
    expect(
      lines.filter((line) => line.message.includes('a state-changing request was refused'))
    ).not.toHaveLength(0);

    // The form the loader itself serves does pass: the same cookie, the same
    // Origin, and the token out of its own page. The answer comes after the
    // stop, so the child is let go first (as the test above does).
    const own = ask(port, 'POST', '/panic', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
    });
    await waitUntil(
      () => lifemodelSpawn(world)?.child.signals.length === 1,
      'lifemodel is stopped'
    );
    lifemodelSpawn(world)?.child.exit(0, null);
    expect((await own).status).toBe(303);
    expect(await app.state.isPanicSet()).toBe(true);

    await shutdownLoader(world, app);
  });

  it('refuses a POST to / : the two actions have their own addresses', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    const port = app.port();
    const { cookie, csrf } = await loggedIn(port);

    // Everything a resume alias would need, sent to / instead: refused.
    const atRoot = await ask(port, 'POST', '/', {
      host: 'boot.localhost',
      cookie,
      form: { csrf },
    });

    expect(atRoot.status).toBe(405);
    expect(atRoot.body).toContain('there is no action at /');
    expect(await app.state.isPanicSet()).toBe(false);
    expect(
      world.launcher.spawns.filter((s) => s.args[0] === world.config.lifemodelEntry)
    ).toHaveLength(1); // nothing was started again

    await shutdownLoader(world, app);
  });

  it('refuses a password set and a login driven from another page of the site', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world, { password: null });
    const port = app.port();

    // The root host's page cannot claim the instance by setting its password.
    const claim = await ask(port, 'POST', '/setup', {
      host: 'boot.localhost',
      form: { password: 'the attacker picks this' },
      origin: 'http://localhost:8080',
    });
    expect(claim.status).toBe(403);
    expect(await app.state.readAuth()).toBeNull();

    // Nor can it log itself in with the owner's password.
    const set = await ask(port, 'POST', '/setup', {
      host: 'boot.localhost',
      form: { password: "the owner's password" },
    });
    expect(set.status).toBe(303);
    const login = await ask(port, 'POST', '/login', {
      host: 'boot.localhost',
      form: { password: "the owner's password" },
      origin: 'http://vault.localhost:8080',
    });
    expect(login.status).toBe(403);
    expect(login.headers['set-cookie']).toBeUndefined();

    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    await shutdownLoader(world, app);
  });
});

describe('the loader answers on its own hosts only (rework 2, finding 7)', () => {
  it('refuses any other Host, on every route, and derives no cookie from one', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world, { password: null });
    const port = app.port();

    for (const path of ['/', '/setup', '/login', '/_auth/verify', '/_api/status']) {
      const refused = await ask(port, 'GET', path, { host: 'boot.example.com' });
      expect({ path, status: refused.status }).toEqual({ path, status: 400 });
      expect(refused.body).toContain('the loader answers only');
    }
    // A login through a crafted boot.<attacker domain> cannot mint a cookie
    // scoped to that domain.
    const crafted = await ask(port, 'POST', '/login', {
      host: 'boot.attacker.test',
      form: { password: 'right' },
    });
    expect(crafted.status).toBe(400);
    expect(crafted.headers['set-cookie']).toBeUndefined();
    expect(
      lines.filter((line) => line.message.includes('does not answer on that host')).length
    ).toBeGreaterThan(0);

    // The instance's own hosts still answer, port or no port.
    expect((await ask(port, 'GET', '/setup', { host: 'boot.localhost:8080' })).status).toBe(200);
    expect((await ask(port, 'GET', '/_auth/verify', { host: 'vault.localhost' })).status).toBe(401);

    await shutdownLoader(world, app);
  });
});

/** The status the loader reports, read the way the command line reads it. */
async function second_status(port: number, cookie: string): Promise<InstanceStatus> {
  const answer = await ask(port, 'GET', '/', { host: 'boot.localhost', cookie });
  expect(answer.status).toBe(200);
  return {
    lifemodel: answer.body.includes('panic</dt><dd>on') ? 'stopped' : 'running',
    commit: null,
    panic: answer.body.includes('panic</dt><dd>on'),
    pid: null,
    restarts: 0,
    phase: 'idle',
    failed: false,
    lastError: null,
  };
}
