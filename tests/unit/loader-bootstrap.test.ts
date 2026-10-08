/**
 * First start and the start after it (lifemodel-q4x.2.1, stories S1, S7).
 *
 * The criterion: "first start seeds and starts once, a second start reuses the
 * repository". The volume here is a real directory and the loader writes real
 * files; the two boundaries a test cannot cross unprivileged - git/npm and
 * starting lifemodel as uid 1000 - are doubled.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import { createLoaderState } from '../../loader/src/state.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import {
  caddySpawn,
  createLoaderWorld,
  lifemodelSpawn,
  scriptRepository,
  settle,
  shutdownLoader,
  testLoaderApp,
  waitUntil,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

interface AppUnderTest {
  app: ReturnType<typeof createLoaderApp>;
  world: LoaderWorld;
  lines: RecordedLine[];
  exits: number[];
  fs: ReturnType<typeof createNodeFileSystem>;
}

/** One loader over a volume of its own, with the process boundary doubled. */
function makeApp(
  world: LoaderWorld,
  lines: RecordedLine[] = [],
  exits: number[] = []
): AppUnderTest {
  roots.push(world.root);
  const fs = createNodeFileSystem();
  const app = testLoaderApp(world, { fs, lines, exits });
  return { app, world, lines, exits, fs };
}

/** The password the owner would have set through boot.<host>. */
async function setPassword(world: LoaderWorld, password = 'right'): Promise<void> {
  const state = createLoaderState({
    fs: createNodeFileSystem(),
    config: world.config,
    logger: createRecordingLogger([]),
  });
  await state.ensureLayout();
  await state.writeAuth(await hashPassword(password));
}

describe('the loader first start', () => {
  it('seeds the instance from the code the image carries, builds it and starts it once', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    const { app } = makeApp(world);

    await app.bootstrap.ensureReady('setup');

    expect(world.runner.lines()).toEqual([
      `git clone ${world.config.seedBundle} ${world.config.repoDir}`,
      'git remote',
      'git remote rename origin upstream',
      `git remote set-url upstream ${world.config.upstreamUrl}`,
      'git rev-parse HEAD',
      'npm ci',
      'npm run build',
    ]);
    // The upstream is what the clone's remote became: a rename keeps the
    // branch's tracking configuration, a set-url points it at the real one.
    const cloneCall = world.runner.calls[0];
    expect(cloneCall?.options.cwd).toBeUndefined();
    for (const call of world.runner.calls.slice(2)) {
      expect(call.options.cwd).toBe(world.config.repoDir);
    }

    expect(world.launcher.spawns).toHaveLength(1);
    const spawned = world.launcher.spawns[0];
    expect(spawned?.command).toBe('node');
    expect(spawned?.args).toEqual([world.config.lifemodelEntry]);
    expect(spawned?.options.cwd).toBe(world.config.volumeRoot);
    expect(spawned?.options.env['DATA_PATH']).toBe(world.config.dataDir);

    // The build runs as the instance's user (here: not root, so no uid).
    const build = world.runner.calls.find((call) => call.command === 'npm');
    expect(build?.options.uid).toBeUndefined();

    const status = await app.bootstrap.status();
    expect(status.lifemodel).toBe('running');
    expect(status.commit).toBe('c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff');
    expect(status.panic).toBe(false);
    expect(status.restarts).toBe(0);
  });

  it('a second start reuses the repository on the volume: no second seed, no second build', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);

    const first = makeApp(world);
    await first.app.bootstrap.ensureReady('setup');
    expect(world.runner.lines().filter((line) => line.startsWith('git clone'))).toHaveLength(1);

    // A second start of the same volume, as `docker restart` gives it: the
    // repository and the build are there, lifemodel is started again.
    world.runner.calls.length = 0;
    const second = makeApp(world);
    await second.app.bootstrap.ensureReady('startup');

    expect(world.runner.lines()).toEqual(['git rev-parse HEAD']);
    expect(world.launcher.spawns).toHaveLength(2);
  });

  it('builds a commit it has not built yet, and only that commit', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    const { app } = makeApp(world);
    await app.bootstrap.ensureReady('setup');

    // The instance's repository moved on (a commit of its own, or a merge
    // from upstream): the new commit is built, the old build is not reused.
    const moved = 'beefbeefbeefbeefbeefbeefbeefbeefbeefbeef';
    world.runner.on('git rev-parse HEAD', () => ({ code: 0, stdout: `${moved}\n`, stderr: '' }));
    world.runner.calls.length = 0;

    await app.bootstrap.ensureReady('startup');

    expect(world.runner.lines()).toEqual(['git rev-parse HEAD', 'npm ci', 'npm run build']);
    expect((await app.bootstrap.status()).commit).toBe(moved);
  });

  it('refuses to seed over a directory that is not a repository, and records it as the failure', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    mkdirSync(world.config.repoDir, { recursive: true });
    writeFileSync(join(world.config.repoDir, 'a-file-of-the-owner'), 'mine\n');
    const { app } = makeApp(world);

    // A failure to seed is the instance's state, not an error thrown at the
    // caller, and it is not fatal to the loader (rework 1).
    await app.bootstrap.ensureReady('setup');

    const status = await app.bootstrap.status();
    expect(status.phase).toBe('failed');
    expect(status.lastError).toMatch(/exists but is not a git repository/);
    expect(status.lifemodel).toBe('stopped');
    expect(world.runner.lines()).toEqual([]);
    expect(readFileSync(join(world.config.repoDir, 'a-file-of-the-owner'), 'utf8')).toBe('mine\n');
  });

  it('a build that fails is recorded with its reason, and the next try builds it', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
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
    const { app, lines } = makeApp(world);

    await app.bootstrap.ensureReady('setup');

    const failed = await app.bootstrap.status();
    expect(failed.phase).toBe('failed');
    expect(failed.lastError).toContain('npm ci failed');
    expect(failed.lastError).toContain('npm error the lockfile is not there');
    expect(failed.lifemodel).toBe('stopped');
    expect(lifemodelSpawn(world)).toBeUndefined();
    // One line, what and why.
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('the instance did not come up');
    expect(errors[0]?.message).toContain('npm ci failed');

    // The owner fixes what was wrong and asks again: resume retries the build.
    failing = false;
    await app.bootstrap.ensureReady('resume');

    const ready = await app.bootstrap.status();
    expect(ready.phase).toBe('idle');
    expect(ready.lastError).toBeNull();
    expect(ready.lifemodel).toBe('running');
    expect(lifemodelSpawn(world)).toBeDefined();
  });

  it('a spawn the launcher refuses is a failed start, and readiness is never announced', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    // The launcher cannot even ask the OS: `spawn` throws (rework 2, finding 6).
    world.launcher.refuseSpawns(new Error('spawn node EPERM: the identity is refused'));
    const { app, lines } = makeApp(world);

    await app.bootstrap.ensureReady('setup');

    const status = await app.bootstrap.status();
    expect(status.phase).toBe('failed');
    expect(status.failed).toBe(true);
    expect(status.lifemodel).toBe('failed');
    expect(status.lastError).toContain('spawn node EPERM');
    // Readiness is announced only for a start that really happened.
    expect(lines.some((line) => line.message.includes('the instance is ready'))).toBe(false);
    // One error line from the supervisor, one from the bootstrap, and the
    // reason in both.
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors.map((line) => line.message)).toEqual([
      'lifemodel could not be started',
      expect.stringContaining('the instance did not come up'),
    ]);
    // The same input fails the same way: nothing is retried.
    expect(world.clock.pending()).toBe(0);
  });

  it('a spawn error the OS emits after the call is a failed start too', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    // `spawn` returned, and the OS then said it never started the process.
    world.launcher.failSpawns(new Error('spawn node ENOENT'));
    const { app, lines } = makeApp(world);

    await app.bootstrap.ensureReady('startup');

    const status = await app.bootstrap.status();
    expect(status.phase).toBe('failed');
    expect(status.failed).toBe(true);
    expect(status.lastError).toContain('spawn node ENOENT');
    expect(lines.some((line) => line.message.includes('the instance is ready'))).toBe(false);
    expect(world.clock.pending()).toBe(0);
  });

  it('a start held down by panic is not readiness and not a failure', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    const { app, lines } = makeApp(world);
    await app.state.setPanic('a test');

    await app.bootstrap.ensureReady('startup');

    const status = await app.bootstrap.status();
    expect(status.phase).toBe('idle');
    expect(status.failed).toBe(false);
    expect(status.panic).toBe(true);
    expect(status.lifemodel).toBe('stopped');
    expect(lines.some((line) => line.message.includes('the instance is ready'))).toBe(false);
    expect(lines.some((line) => line.message.includes('the instance is not started'))).toBe(true);
    expect(lifemodelSpawn(world)).toBeUndefined();
  });

  it('a start that fails is recorded too, and lifemodel is not left running', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    const { app } = makeApp(world);

    await app.bootstrap.ensureReady('setup');
    expect((await app.bootstrap.status()).lifemodel).toBe('running');

    // The instance was built, and lifemodel dies at once on every start.
    lifemodelSpawn(world)?.child.exit(1, null);
    await settle();
    lifemodelSpawn(world)?.child.exit(1, null);
    await settle();

    const status = await app.bootstrap.status();
    expect(status.restarts).toBeGreaterThan(0);
    expect(status.lifemodel).toBe('stopped');
  });
});

describe('the loader says what it is missing', () => {
  it('a missing seed bundle: one line with the cause, then a non-zero exit', async () => {
    // The bundle is one of the loader's OWN inputs, checked before it opens
    // its interface: while the volume holds no repository, an instance can
    // never be seeded from an image that carries no code, so the loader leaves
    // rather than serving a page it cannot act on (rework 1).
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    // The image forgot to carry the code: no bundle on disk.
    const config = { ...world.config, seedBundle: join(world.root, 'not-there.bundle') };
    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = testLoaderApp(world, { config, lines, exits });
    roots.push(world.root);

    await app.start();
    await waitUntil(() => exits.length > 0, 'the loader left');

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(config.seedBundle);
    expect(errors[0]?.message).toContain('seed bundle is missing');
    expect(world.runner.lines()).toEqual([]);
    expect(lifemodelSpawn(world)).toBeUndefined();
    expect(caddySpawn(world)).toBeUndefined(); // checked before the front door opens
  });

  it('a volume it cannot write: one line with the cause, then a non-zero exit', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    // The volume's path is a file, so the layout cannot be created there.
    const blocker = join(world.root, 'not-a-directory');
    writeFileSync(blocker, 'a file where the volume should be\n');
    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = testLoaderApp(world, {
      config: { ...world.config, volumeRoot: blocker, loaderDir: join(blocker, 'loader') },
      lines,
      exits,
    });
    roots.push(world.root);

    await app.start();

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('cannot prepare the volume');
    expect(errors[0]?.message).toContain(blocker);
    expect(world.launcher.spawns).toEqual([]); // nothing was started, not even the front door
  });

  it('a port already taken: one line naming the port, then a non-zero exit', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    // Something else already listens where the loader's interface belongs.
    const blocker = createServer(() => undefined);
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const taken = (blocker.address() as AddressInfo).port;

    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = testLoaderApp(world, {
      config: { ...world.config, httpPort: taken },
      lines,
      exits,
    });
    roots.push(world.root);

    await app.start();

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(String(taken));
    expect(errors[0]?.message).toContain('cannot listen');
    await shutdownLoader(world, app);
    blocker.close();
  });
});

describe('the loader waits before it has a password', () => {
  it('seeds nothing and starts nothing while the owner has not set a password', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    const { app, lines } = makeApp(world);

    await app.start();
    await settle();

    // Agent Vault's own CLI is the only command run, and it seeds nothing:
    // this start makes the store and the vault, and no repository or build.
    expect(
      world.runner.lines().filter((line) => !line.startsWith(world.config.agentVault.binary))
    ).toEqual([]);
    expect(lifemodelSpawn(world)).toBeUndefined();
    expect(lines.some((line) => line.message.includes('no password is set'))).toBe(true);
    await shutdownLoader(world, app);
  });
});

describe('what the loader keeps on the volume', () => {
  it('keeps the password, the panic flag and the token where lifemodel cannot read them', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    await setPassword(world);
    const { app } = makeApp(world);
    await app.bootstrap.ensureReady('setup');

    const loaderDir = world.config.loaderDir;
    expect(statSync(loaderDir).mode & 0o777).toBe(0o700);
    const state = createLoaderState({
      fs: createNodeFileSystem(),
      config: world.config,
      logger: createRecordingLogger([]),
    });
    const paths = state.paths();
    for (const path of [paths.auth, paths.cliToken, paths.state]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(paths.auth, 'utf8')).not.toContain('right');
    // The panic flag is a file whose presence is the flag.
    await state.setPanic('a test');
    expect(await state.isPanicSet()).toBe(true);
    await state.clearPanic();
    expect(await state.isPanicSet()).toBe(false);
    // The instance's own data directory is there for lifemodel to write.
    expect(statSync(world.config.dataDir).isDirectory()).toBe(true);
  });
});
