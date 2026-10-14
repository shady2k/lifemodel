/**
 * Platform mode (ADR-010, platform step A0 - lifemodel-lut.2.1).
 *
 * In platform mode the loader supervises nothing: Flux brings it into
 * `lifemodel-system` with no Docker socket, no seed bundle and no instance
 * on the volume - no lifemodel, no Agent Vault - so the loader brings up only
 * its own interface and login. What it would have started beside them it does
 * not even ASK for: a missing front-door binary is not an error there, because
 * nothing of it is read.
 *
 * Instance mode is the shape every other loader test walks; its walk is kept
 * here beside the platform one, so the two shapes stay one decision apart.
 */
import { describe, expect, it } from 'vitest';

import { createLoaderApp, type LoaderApp } from '../../loader/src/app.js';
import type { BaoApi, BaoKeys } from '../../loader/src/openbao.js';
import type {
  PlatformPhaseRecord,
  PlatformPhaseStore,
} from '../../loader/src/platform-bootstrap.js';
import { hashPassword } from '../../loader/src/auth.js';
import { createLoaderState } from '../../loader/src/state.js';
import { ownLoaderApp, registerLoaderLifecycle } from '../helpers/loader-lifecycle.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import {
  caddySpawn,
  createLoaderWorld,
  lifemodelSpawn,
  scriptAgentVault,
  scriptRepository,
  shutdownLoader,
  testLoaderApp,
  vaultSpawn,
  waitUntil,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

registerLoaderLifecycle();

/** A platform app over `world`, with its lines and exits captured. */
function platformApp(
  world: LoaderWorld,
  bootstrap = { runInitial: async () => {}, unsealIfSealed: async () => {} }
): {
  app: LoaderApp;
  lines: RecordedLine[];
  exits: number[];
} {
  const lines: RecordedLine[] = [];
  const exits: number[] = [];
  const app = createLoaderApp({
    config: { ...world.config, mode: 'platform' },
    fs: world.fs,
    runner: world.runner,
    launcher: world.launcher,
    logger: createRecordingLogger(lines),
    clock: world.clock,
    exit: (code) => exits.push(code),
    platformBootstrap: bootstrap,
  });
  ownLoaderApp(world, app);
  return { app, lines, exits };
}

describe('the loader in platform mode', () => {
  it('sets up authentication without starting an instance and keeps it across restart', async () => {
    const world = createLoaderWorld();
    const first = platformApp(world);

    await first.app.start();
    const setup = await fetch(`http://127.0.0.1:${String(first.app.port())}/setup`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${String(first.app.port())}`,
        host: `127.0.0.1:${String(first.app.port())}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=secret',
      redirect: 'manual',
    });
    expect(setup.status, await setup.text()).toBe(303);
    const cookie = setup.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeDefined();

    const dashboard = await fetch(`http://127.0.0.1:${String(first.app.port())}/`, {
      headers: { host: 'boot.localhost', cookie: cookie ?? '' },
    });
    const dashboardHtml = await dashboard.text();
    expect(dashboard.status).toBe(200);
    expect(dashboardHtml).toContain('Platform mode');
    expect(dashboardHtml).not.toMatch(/Panic:|Resume:|Agent Vault|failed:/);
    expect(world.launcher.spawns).toEqual([]);
    expect(world.runner.lines()).toEqual([]);
    expect(await first.app.bootstrap.status()).toMatchObject({ failed: false });

    const outcome = await first.app.shutdown('test');
    expect(outcome).toBe(0);

    const restarted = platformApp(world);
    await restarted.app.start();
    const afterRestart = await fetch(`http://127.0.0.1:${String(restarted.app.port())}/`, {
      headers: { host: 'boot.localhost', cookie: cookie ?? '' },
    });
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.text()).toContain('Platform mode');
    expect(await restarted.app.state.readAuth()).not.toBeNull();
    expect(world.launcher.spawns).toEqual([]);
    expect(world.runner.lines()).toEqual([]);
    expect(await restarted.app.shutdown('test')).toBe(0);
  });

  it('runs the real OpenBao bootstrap composition with only API and stores faked', async () => {
    const world = createLoaderWorld();
    const events: string[] = [];
    let secret: BaoKeys | null = null;
    let phase: PlatformPhaseRecord | null = null;
    let initialized = false;
    const bao: BaoApi = {
      status: async () => {
        events.push('status');
        return { initialized, sealed: false };
      },
      init: async () => {
        events.push('init');
        initialized = true;
        return { keys: ['share'], rootToken: 'root' };
      },
      unseal: async () => {
        events.push('unseal');
      },
      rootTokenActive: async () => false,
      ensureLoaderPolicy: async () => {
        events.push('policy');
      },
      loginLoader: async () => {
        events.push('login');
      },
      revokeRootToken: async () => {
        events.push('revoke');
      },
    };
    const custody = {
      read: async () => secret,
      write: async (value: BaoKeys) => {
        events.push('custody');
        secret = structuredClone(value);
      },
    };
    const phases: PlatformPhaseStore = {
      read: async () => phase,
      write: async (next) => {
        phase = next;
      },
    };
    const lines: RecordedLine[] = [];
    const app = createLoaderApp({
      config: { ...world.config, mode: 'platform' },
      fs: world.fs,
      runner: world.runner,
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      exit: () => {},
      openBao: { api: bao, custody },
      platformPhaseStore: phases,
      platformLoaderJwt: async () => 'loader-jwt',
      platformGiteaPhases: [],
    });
    ownLoaderApp(world, app);
    await app.start();
    await waitUntil(
      () =>
        (phase?.phase === 'openbao-policy' && phase.status === 'complete') ||
        lines.some((line) => line.level === 'error'),
      'OpenBao composition'
    );
    expect(events).toContain('init');
    expect(phase?.phase).toBe('openbao-policy');
    await app.shutdown('test');
  });

  it('starts OpenBao phases only after its HTTP interface is listening', async () => {
    const world = createLoaderWorld();
    const observed: string[] = [];
    const { app } = platformApp(world, {
      runInitial: async () => {
        observed.push(`initial:${app.host() ?? 'down'}`);
      },
      unsealIfSealed: async () => {
        observed.push(`unseal:${app.host() ?? 'down'}`);
      },
    });
    await app.start();
    await waitUntil(() => observed.length === 2, 'platform bootstrap ran');
    expect(observed).toEqual(['initial:0.0.0.0', 'unseal:0.0.0.0']);
    expect(await app.shutdown('test')).toBe(0);
  });

  it('refuses browser and CLI resume in platform mode', async () => {
    const world = createLoaderWorld();
    const { app } = platformApp(world);
    const state = createLoaderState({
      config: { ...world.config, mode: 'platform' },
      fs: world.fs,
      logger: createRecordingLogger([]),
    });
    await state.ensureLayout();
    await state.writeAuth(await hashPassword('secret'));
    await app.start();
    const cliToken = await state.ensureCliToken();

    const login = await fetch(`http://127.0.0.1:${String(app.port())}/login`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${String(app.port())}`,
        origin: `http://127.0.0.1:${String(app.port())}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=secret',
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(login.status, await login.clone().text()).toBe(303);
    const dashboard = await fetch(`http://127.0.0.1:${String(app.port())}/`, {
      headers: { host: 'boot.localhost', cookie },
    });
    const html = await dashboard.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
    const browser = await fetch(`http://127.0.0.1:${String(app.port())}/resume`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${String(app.port())}`,
        origin: `http://127.0.0.1:${String(app.port())}`,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${encodeURIComponent(csrf)}`,
      redirect: 'manual',
    });
    expect(browser.status).toBe(409);

    const cli = await fetch(`http://127.0.0.1:${String(app.port())}/_api/resume`, {
      method: 'POST',
      headers: { host: 'boot.localhost', 'x-loader-cli-token': cliToken },
    });
    expect(cli.status).toBe(409);
    const cliStatus = await fetch(`http://127.0.0.1:${String(app.port())}/_api/status`, {
      headers: { host: 'boot.localhost', 'x-loader-cli-token': cliToken },
    });
    expect(cliStatus.status).toBe(409);
    expect(world.launcher.spawns).toEqual([]);
    expect(world.runner.lines()).toEqual([]);
    expect(await app.shutdown('test')).toBe(0);
  });

  it('serves the login page with no Docker socket, and starts nothing beside it', async () => {
    // The world simulates the cluster: nothing but the volume exists - no
    // caddy, no agent-vault binary, no seed bundle, no repository.
    const world = createLoaderWorld();
    const { app, exits } = platformApp(world);

    await app.start();
    const port = app.port();
    expect(port).toBeGreaterThan(0);
    expect(app.host()).toBe('0.0.0.0');

    const response = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      headers: { host: 'boot.localhost' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('lifemodel loader');

    expect(caddySpawn(world)).toBeUndefined();
    expect(vaultSpawn(world)).toBeUndefined();
    expect(lifemodelSpawn(world)).toBeUndefined();
    expect(world.launcher.spawns).toEqual([]); // not even a process was asked for
    expect(world.runner.lines()).toEqual([]); // no git, no npm, no vault CLI
    expect(exits).toEqual([]); // a missing front door is not an error here

    const outcome = await app.shutdown('test');
    expect(outcome).toBe(0);
  });

  it('serves the login page through /setup when no password is set', async () => {
    // The volume is fresh: the owner has not chosen a password yet, and the
    // login answers with the setup walk, as it always has. The browser's
    // fetch follows that answer on its own.
    const world = createLoaderWorld();
    const { app } = platformApp(world);

    await app.start();
    const port = app.port();
    const response = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      headers: { host: 'boot.localhost' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('lifemodel loader');

    const outcome = await app.shutdown('test');
    expect(outcome).toBe(0);
  });

  it('never asks for the front door, the vault or the seed bundle', async () => {
    // The inputs an instance loader ends over: missing on this volume.
    const world = createLoaderWorld();
    const config = {
      ...world.config,
      mode: 'platform' as const,
      caddy: { ...world.config.caddy, binary: `${world.root}/no-caddy` },
      agentVault: { ...world.config.agentVault, binary: `${world.root}/no-agent-vault` },
      seedBundle: `${world.root}/no-seed.bundle`,
    };
    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = createLoaderApp({
      config,
      fs: world.fs,
      runner: world.runner,
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      exit: (code) => exits.push(code),
    });
    ownLoaderApp(world, app);

    await app.start();
    expect(exits).toEqual([]);
    const response = await fetch(`http://127.0.0.1:${String(app.port())}/login`, {
      headers: { host: 'boot.localhost' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('lifemodel loader');
    expect(world.launcher.spawns).toEqual([]);
    expect(exits).toEqual([]);

    const outcome = await app.shutdown('test');
    expect(outcome).toBe(0);
  });
});

describe('the loader in instance mode (unchanged)', () => {
  it('still demands the front door and the seed bundle before it serves', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    const state = createLoaderState({
      config: world.config,
      fs: world.fs,
      logger: createRecordingLogger([]),
    });
    await state.writeAuth(await hashPassword('right'));
    // The image forgot the front door: an instance loader cannot open it.
    const config = {
      ...world.config,
      caddy: { ...world.config.caddy, binary: `${world.root}/no-caddy` },
    };
    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = createLoaderApp({
      config,
      fs: world.fs,
      runner: world.runner,
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      exit: (code) => exits.push(code),
    });
    ownLoaderApp(world, app);

    await app.start();
    expect(app.host()).toBeNull();
    await waitUntil(() => exits.length > 0, 'the loader left');

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('there is no caddy at');
    expect(errors[0]?.message).toContain(`${world.root}/no-caddy`);
    expect(lifemodelSpawn(world)).toBeUndefined();
    expect(vaultSpawn(world)).toBeUndefined();
    expect(caddySpawn(world)).toBeUndefined();
    expect(world.launcher.spawns).toEqual([]); // checked before the front door opens
  });

  it('still walks the first start it has always walked', async () => {
    const world = createLoaderWorld();
    scriptRepository(world);
    scriptAgentVault(world);
    const state = createLoaderState({
      config: world.config,
      fs: world.fs,
      logger: createRecordingLogger([]),
    });
    await state.ensureLayout();
    await state.writeAuth(await hashPassword('right'));
    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = testLoaderApp(world, { lines, exits });
    ownLoaderApp(world, app);

    await app.start();
    expect(app.host()).toBe('127.0.0.1');
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    expect(caddySpawn(world)).toBeDefined();
    expect(vaultSpawn(world)).toBeDefined();
    expect(lifemodelSpawn(world)).toBeDefined();
    expect(exits).toEqual([]); // the shape's own start, not a fatal

    // The children answer their stops, the way the image's would.
    const outcome = await shutdownLoader(world, app);
    expect(outcome).toBe(0);
  });
});
