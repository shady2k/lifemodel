/**
 * Agent Vault under the loader (lifemodel-q4x.3.1, decisions 4 and 12).
 *
 * The criterion: Agent Vault runs in the image under the loader, reached at
 * `vault.<host>` behind the one login, with a passwordless store that is
 * root-only on the volume - created on an empty volume, reused on the next
 * start - and a vault and an agent token the loader creates for lifemodel and
 * hands to its process as the proxy credential, and to nothing else.
 *
 * Everything here goes through the loader's own interface: the module the
 * loader wires, and the app that starts it before lifemodel. The two process
 * boundaries are doubled (the launcher, the runner) and the readiness probe is
 * the test's own; the volume, its modes and the files are real.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentVault } from '../../loader/src/agent-vault.js';
import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createLoaderState } from '../../loader/src/state.js';
import {
  caddySpawn,
  createLoaderWorld,
  lifemodelSpawn,
  scriptRepository,
  settle,
  shutdownLoader,
  vaultSessionPath,
  vaultSpawn,
  waitUntil,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

const roots: string[] = [];
/** The environment a test sets must not leak into the next one. */
const savedEnv: [string, string | undefined][] = [];

afterEach(() => {
  roots.splice(0);
  for (const [name, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setEnv(name: string, value: string): void {
  savedEnv.push([name, process.env[name]]);
  process.env[name] = value;
}

/** A volume of this test's own, with the repository the loader's seed needs. */
function world(): LoaderWorld {
  const created = createLoaderWorld();
  roots.push(created.root);
  scriptRepository(created);
  return created;
}

const TOKEN = 'av_agt_the-token-the-loader-created';

/**
 * The answers of Agent Vault's CLI on an EMPTY volume: no account, no vault,
 * no agent - the first start, which is what creates all three.
 */
function scriptFirstStart(found: LoaderWorld): void {
  const { runner, config } = found;
  const binary = config.agentVault.binary;
  runner.on(`${binary} auth login`, () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: invalid email or password\n',
  }));
  runner.on(`${binary} auth register`, () => {
    // The real CLI writes the session into the store's own directory, which
    // its server made when it started.
    const dir = join(config.agentVault.storeDir, '.agent-vault');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), '{"token":"the-cli-session"}');
    return { code: 0, stdout: '✓ Owner account created.\n', stderr: '' };
  });
  runner.on(`${binary} vault credential-store show`, () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: Vault not found\n',
  }));
  runner.on(`${binary} vault create`, () => ({
    code: 0,
    stdout: `✓ Created vault "${config.agentVault.vaultName}"\n`,
    stderr: '',
  }));
  runner.on(`${binary} agent info`, () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: Agent not found\n',
  }));
  runner.on(`${binary} agent create`, () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: '' }));
  runner.on(`${binary} agent rotate`, () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: '' }));
  runner.on(`${binary} ca fetch`, () => ({
    code: 0,
    stdout: '-----BEGIN CERTIFICATE-----\nMIIBthe-proxy-ca\n-----END CERTIFICATE-----\n',
    stderr: '',
  }));
}

/**
 * The answers of a store that already holds the loader's account, the vault
 * and the agent: the second start, which creates nothing.
 */
function scriptExistingStore(found: LoaderWorld): void {
  const { runner, config } = found;
  const binary = config.agentVault.binary;
  runner.on(`${binary} auth login`, () => {
    const dir = join(config.agentVault.storeDir, '.agent-vault');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), '{"token":"the-cli-session"}');
    return { code: 0, stdout: '✓ Login successful.\n', stderr: '' };
  });
  runner.on(`${binary} vault credential-store show`, () => ({
    code: 0,
    stdout: 'Credential store: builtin\n',
    stderr: '',
  }));
  runner.on(`${binary} agent info`, () => ({
    code: 0,
    stdout: 'Agent: lifemodel\n',
    stderr: '',
  }));
}

/** The commands the loader ran, Agent Vault's own CLI only. */
function vaultCalls(found: LoaderWorld): string[] {
  const binary = found.config.agentVault.binary;
  return found.runner
    .lines()
    .filter((line) => line.startsWith(binary))
    .map((line) => line.slice(binary.length + 1));
}

function storeMode(found: LoaderWorld): number {
  return statSync(found.config.agentVault.storeDir).mode & 0o777;
}

describe('Agent Vault, the layer that holds the keys', () => {
  it('comes up before lifemodel, passwordless, and creates the vault and the token', async () => {
    const found = world();
    // An operator's variable must not password-protect a store that decision 4
    // makes passwordless, nor decide the address the broker advertises.
    setEnv('AGENT_VAULT_MASTER_PASSWORD', 'an operators password');
    setEnv('AGENT_VAULT_ADDR', 'http://somewhere-else:14321');
    scriptFirstStart(found);
    const { app } = await start(found);

    const vault = vaultSpawn(found);
    expect(vault).toBeDefined();
    expect(vault?.args).toEqual([
      'server',
      '--host',
      '127.0.0.1',
      '--port',
      String(found.config.agentVault.apiPort),
      '--mitm-port',
      String(found.config.agentVault.proxyPort),
      '--password-stdin',
    ]);
    // An empty line IS the passwordless store; the store is the server's HOME.
    expect(vault?.options.stdin).toBe('\n');
    expect(vault?.options.env['HOME']).toBe(found.config.agentVault.storeDir);
    expect(vault?.options.env['AGENT_VAULT_MASTER_PASSWORD']).toBeUndefined();
    expect(vault?.options.env['AGENT_VAULT_ADDR']).toBeUndefined();
    expect(vault?.options.env['AGENT_VAULT_TELEMETRY']).toBe('false');
    expect(vault?.options.cwd).toBe(found.config.volumeRoot);
    expect(vault?.options.uid).toBeUndefined(); // root: the trusted layer

    // The loader created the vault, the agent and the token, in that order.
    expect(vaultCalls(found)).toEqual([
      'auth login --address http://127.0.0.1:14321 --email owner@lifemodel.local --password-stdin',
      'auth register --address http://127.0.0.1:14321 --email owner@lifemodel.local --password-stdin',
      'vault credential-store show lifemodel',
      'vault create lifemodel',
      'agent info lifemodel',
      'agent create lifemodel --vault lifemodel:proxy --token-only',
      'ca fetch',
    ]);
    // The token is what lifemodel's own process is given, and nothing of the
    // loader's account travels with it.
    await waitUntil(() => lifemodelSpawn(found) !== undefined, 'lifemodel is started');
    const env = lifemodelSpawn(found)?.options.env ?? {};
    expect(env['AGENT_VAULT_TOKEN']).toBe(TOKEN);
    expect(env['AGENT_VAULT_VAULT']).toBe('lifemodel');
    expect(JSON.stringify(env)).not.toContain(found.config.agentVault.ownerEmail);

    await shutdownLoader(found, app);
  });

  it('keeps the store, the CA and the credentials root-only, and the CA readable', async () => {
    const found = world();
    scriptFirstStart(found);
    const { app } = await start(found);

    expect(storeMode(found)).toBe(0o700); // decision 4: the directory IS the protection
    const proxy = JSON.parse(
      readFileSync(join(found.config.loaderDir, 'vault-proxy.json'), 'utf8')
    );
    expect(proxy).toMatchObject({ vault: 'lifemodel', agent: 'lifemodel', token: TOKEN });
    expect(statSync(join(found.config.loaderDir, 'vault-proxy.json')).mode & 0o777).toBe(0o600);
    const owner = JSON.parse(
      readFileSync(join(found.config.loaderDir, 'vault-owner.json'), 'utf8')
    );
    expect(owner.email).toBe('owner@lifemodel.local');
    expect(String(owner.password).length).toBeGreaterThan(20);
    expect(statSync(join(found.config.loaderDir, 'vault-owner.json')).mode & 0o777).toBe(0o600);
    // lifemodel's user reads the CA and cannot write it.
    expect(statSync(found.config.agentVault.caPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(found.config.agentVault.caPath, 'utf8')).toContain(
      '-----BEGIN CERTIFICATE-----'
    );

    await shutdownLoader(found, app);
  });

  it('hands lifemodel the proxy environment, and a value the container was given cannot win', async () => {
    const found = world();
    scriptFirstStart(found);
    // Docker passes the client's own proxy variables into the container by
    // default: the vault's values must be the ones lifemodel runs with, or
    // lifemodel would try to reach a proxy the kernel rule forbids.
    setEnv('HTTPS_PROXY', 'http://corp-proxy:3128');
    setEnv('HTTP_PROXY', 'http://corp-proxy:3128');
    // The lowercase spellings are the ones a client like Node's
    // EnvHttpProxyAgent prefers: a stale one would send lifemodel to a proxy
    // the kernel rule refuses (`no_proxy=*` would send it DIRECT).
    setEnv('https_proxy', 'http://corp-proxy:3128');
    setEnv('http_proxy', 'http://corp-proxy:3128');
    setEnv('no_proxy', '*');
    const { app } = await start(found);

    await waitUntil(() => lifemodelSpawn(found) !== undefined, 'lifemodel is started');
    const env = lifemodelSpawn(found)?.options.env ?? {};
    // One URL for both: the same listener takes CONNECT and absolute-form
    // requests. The agent token is the proxy credential, and it is the only
    // secret in there - no key, no vault admin credential, no store.
    const proxy = `http://${TOKEN}:lifemodel@127.0.0.1:${String(found.config.agentVault.proxyPort)}`;
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
      expect(env[name]).toBe(name === 'NO_PROXY' || name === 'no_proxy' ? 'localhost,127.0.0.1' : proxy);
    }
    expect(env['NODE_USE_ENV_PROXY']).toBe('1');
    expect(env['NODE_EXTRA_CA_CERTS']).toBe(found.config.agentVault.caPath);
    const owner = JSON.parse(
      readFileSync(join(found.config.loaderDir, 'vault-owner.json'), 'utf8')
    ) as { email: string; password: string };
    expect(JSON.stringify(env)).not.toContain(owner.email);
    expect(JSON.stringify(env)).not.toContain(owner.password);

    await shutdownLoader(found, app);
  });

  it('reuses the store and the token on the next start: nothing is created twice', async () => {
    const found = world();
    scriptFirstStart(found);
    const first = await start(found);
    await shutdownLoader(found, first.app);
    const firstToken = JSON.parse(
      readFileSync(join(found.config.loaderDir, 'vault-proxy.json'), 'utf8')
    ).token;
    const callsSoFar = vaultCalls(found).length;

    // `docker restart`: a fresh loader over the volume the first one left.
    const second = await start(found);
    expect(vaultCalls(found).slice(callsSoFar)).toEqual(['ca fetch']);
    await waitUntil(() => lifemodelSpawn(found) !== undefined, 'lifemodel is started again');
    const env = lifemodelSpawn(found)?.options.env ?? {};
    expect(env['AGENT_VAULT_TOKEN']).toBe(firstToken);
    expect(second.lines.filter((line) => line.level === 'error')).toEqual([]);

    await shutdownLoader(found, second.app);
  });

  it('mints a new token for an agent whose token was lost, and never a second agent', async () => {
    const found = world();
    scriptFirstStart(found);
    const first = await start(found);
    await shutdownLoader(found, first.app);
    // The record of the token is gone; the store is not.
    rmSync(join(found.config.loaderDir, 'vault-proxy.json'));
    scriptExistingStore(found);

    const second = await start(found);
    const calls = vaultCalls(found);
    expect(calls.filter((call) => call.startsWith('agent rotate'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('agent create'))).toHaveLength(1); // only the first start
    expect(
      JSON.parse(readFileSync(join(found.config.loaderDir, 'vault-proxy.json'), 'utf8')).token
    ).toBe(TOKEN);

    await shutdownLoader(found, second.app);
  });

  it('says why in one line when the vault could not be created', async () => {
    const found = world();
    scriptFirstStart(found);
    // The CLI's own failure shape: the reason, then its usage block, then the
    // reason again on the last line.
    found.runner.on(`${found.config.agentVault.binary} vault create`, () => ({
      code: 1,
      stdout: '',
      stderr:
        'Error: Vault "lifemodel" already exists\nUsage:\n  agent-vault vault create <name> [flags]\n\nVault "lifemodel" already exists\n',
    }));

    const { exits, lines } = await startExpectingFailure(found);
    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Vault "lifemodel" already exists');
    expect(errors[0]?.message).not.toContain('Usage:');
    expect(lifemodelSpawn(found)).toBeUndefined();
  });

  it('says why in one line when the account cannot act for the loader', async () => {
    const found = world();
    scriptFirstStart(found);
    // Registration answered politely and created nothing that can act (an
    // address already taken, or an account still waiting for a code).
    found.runner.on(`${found.config.agentVault.binary} auth register`, () => ({
      code: 0,
      stdout:
        "✓ If this email is not already registered, a verification code has been sent.\nUse 'agent-vault verify' to complete verification.\n",
      stderr: '',
    }));
    rmSync(vaultSessionPath(found), { force: true });

    const { exits, lines } = await startExpectingFailure(found);
    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('verification code');
    expect(lifemodelSpawn(found)).toBeUndefined();
  });

  it('a missing Agent Vault binary is a missing input: one line with the cause, non-zero exit', async () => {
    const found = world();
    // The image carries no agent-vault.
    found.config = {
      ...found.config,
      agentVault: { ...found.config.agentVault, binary: join(found.root, 'no-agent-vault-here') },
    };
    scriptFirstStart(found);

    const { exits, lines } = await startExpectingFailure(found);
    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Agent Vault is missing');
    expect(errors[0]?.message).toContain(join(found.root, 'no-agent-vault-here'));
    expect(lifemodelSpawn(found)).toBeUndefined();
  });

  it('a store it cannot open is a missing input: one line naming it, non-zero exit', async () => {
    const found = world();
    scriptFirstStart(found);
    const { app, lines, exits } = rig(found, () => Promise.resolve(false));
    const starting = app.start();
    await waitUntil(() => vaultSpawn(found) !== undefined, 'the server is spawned');
    // The server leaves at once: it cannot open its store.
    vaultSpawn(found)?.child.exit(1, null);
    found.clock.resolveAll();
    await starting;

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Agent Vault could not open its store');
    expect(errors[0]?.message).toContain(found.config.agentVault.storeDir);
    expect(lifemodelSpawn(found)).toBeUndefined();
  });

  it('starts again after a backoff when it dies', async () => {
    const found = world();
    scriptFirstStart(found);
    const { app } = await start(found);

    vaultSpawn(found)?.child.exit(1, null);
    await settle();
    expect(found.clock.sleeps).toContain(1_000);
    found.clock.resolveAll();
    await waitUntil(
      () =>
        found.launcher.spawns.filter(
          (spawn) => spawn.command === found.config.agentVault.binary && spawn.args[0] === 'server'
        ).length === 2,
      'Agent Vault is started again'
    );
    expect(app.agentVault.status().restarts).toBe(1);

    await shutdownLoader(found, app);
  });

  it('puts the store back to 0700 when a start finds a looser mode on it', async () => {
    const found = world();
    scriptFirstStart(found);
    const first = await start(found);
    await shutdownLoader(found, first.app);
    // An operator, or an older start, left the passwordless store readable.
    chmodSync(found.config.agentVault.storeDir, 0o755);
    expect(storeMode(found)).toBe(0o755);

    const second = await start(found);
    expect(storeMode(found)).toBe(0o700);

    await shutdownLoader(found, second.app);
  });

  it('removes a pid file a killed server left in the store before the next start', async () => {
    const found = world();
    scriptFirstStart(found);
    const first = await start(found);
    await shutdownLoader(found, first.app);
    // A server that was killed rather than waited out leaves this behind, and
    // a reused pid number would stop the next start.
    const pidPath = join(found.config.agentVault.storeDir, '.agent-vault', 'agent-vault.pid');
    writeFileSync(pidPath, `${String(process.pid)}\n`);

    const second = await start(found);
    expect(existsSync(pidPath)).toBe(false);

    await shutdownLoader(found, second.app);
  });

  it('stops after lifemodel, before the front door, inside the one deadline', async () => {
    const found = world();
    scriptFirstStart(found);
    const { app } = await start(found);
    await waitUntil(() => lifemodelSpawn(found) !== undefined, 'lifemodel is started');

    const leaving = app.shutdown('SIGTERM');
    await waitUntil(() => lifemodelSpawn(found)?.child.signals.length === 1, 'lifemodel is asked');
    expect(vaultSpawn(found)?.child.signals).toEqual([]); // it outlives the drain
    lifemodelSpawn(found)?.child.exit(0, null);
    await waitUntil(() => vaultSpawn(found)?.child.signals.length === 1, 'Agent Vault is asked');
    expect(caddySpawn(found)?.child.signals).toEqual([]);
    vaultSpawn(found)?.child.exit(0, null);
    await waitUntil(() => caddySpawn(found)?.child.signals.length === 1, 'caddy is asked');
    caddySpawn(found)?.child.exit(0, null);

    expect(await leaving).toBe(0);
  });

  it('makes nothing at all when a stop arrives before it starts anything', async () => {
    const found = world();
    scriptFirstStart(found);
    const lines: RecordedLine[] = [];
    const inner = createNodeFileSystem();
    // The start is held in the middle of preparing the store, which is where
    // the container's own stop can arrive (its signals are wired before the
    // loader starts).
    let release: (() => void) | null = null;
    const fs = {
      ...inner,
      chmod: async (path: string, mode: number): Promise<void> => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await inner.chmod(path, mode);
      },
    };
    const vault = createAgentVault({
      launcher: found.launcher,
      runner: found.runner,
      fs,
      logger: createRecordingLogger(lines),
      clock: found.clock,
      config: found.config,
      probeHealth: () => Promise.resolve(true),
    });
    const starting = vault.start();
    await waitUntil(() => release !== null, 'the start reached the store');

    expect(await vault.stop()).toBe(true); // nothing was running
    (release as unknown as () => void)();
    await starting;

    expect(vaultSpawn(found)).toBeUndefined();
    expect(vault.status().running).toBe(false);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
  });

  it('gives up what it started when a stop arrives while it is still starting', async () => {
    const found = world();
    scriptFirstStart(found);
    const lines: RecordedLine[] = [];
    // The server does not answer at first: that start is still in flight.
    let up = false;
    const vault = createAgentVault({
      launcher: found.launcher,
      runner: found.runner,
      fs: createNodeFileSystem(),
      logger: createRecordingLogger(lines),
      clock: found.clock,
      config: found.config,
      probeHealth: () => Promise.resolve(up),
    });
    const starting = vault.start();
    await waitUntil(() => vaultSpawn(found) !== undefined, 'the server is spawned');

    // The container's own stop arrives now. The child this start already made
    // is the stop's to reach, and the start itself does not fail: the loader
    // is leaving.
    const stopping = vault.stop();
    found.clock.resolveAll();
    vaultSpawn(found)?.child.exit(0, null);
    expect(await stopping).toBe(true);
    await expect(starting).resolves.toBeUndefined();
    expect(vault.status().running).toBe(false);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);

    // And the module is usable after that stop: the next start is a real one.
    up = true;
    await vault.start();
    expect(vault.status().running).toBe(true);
  });

  it('gives up a child it made when the stop lands in the middle of provisioning', async () => {
    const found = world();
    scriptFirstStart(found);
    const lines: RecordedLine[] = [];
    // The first CLI call of the provisioning is held: the start is between its
    // readiness wait and the vault it was about to create.
    const inner = found.runner;
    let release: (() => void) | null = null;
    let held = false;
    const runner = {
      run: async (
        command: string,
        args: string[],
        options: Parameters<typeof inner.run>[2]
      ): Promise<{ code: number; stdout: string; stderr: string }> => {
        if (args[0] === 'auth' && !held) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return inner.run(command, args, options);
      },
    };
    const vault = createAgentVault({
      launcher: found.launcher,
      runner,
      fs: createNodeFileSystem(),
      logger: createRecordingLogger(lines),
      clock: found.clock,
      config: found.config,
      probeHealth: () => Promise.resolve(true),
    });
    const starting = vault.start();
    await waitUntil(() => release !== null, 'the start reached the provisioning');

    const stopping = vault.stop();
    vaultSpawn(found)?.child.exit(0, null);
    expect(await stopping).toBe(true);
    (release as unknown as () => void)();
    await starting;

    expect(vault.status().running).toBe(false);
    expect(vaultSpawn(found)?.child.signals).toContain('SIGTERM');
    // The start gave its child up instead of finishing: it never announced a
    // vault that is up, and it said what it did.
    expect(lines.some((line) => line.message.includes('Agent Vault is up'))).toBe(false);
    expect(
      lines.some((line) => line.message.includes('was started while the loader was stopping'))
    ).toBe(true);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
  });

  it('never writes the token in a log line', async () => {
    const found = world();
    scriptFirstStart(found);
    const { app, lines } = await start(found);

    const written = JSON.stringify(lines);
    expect(written).not.toContain(TOKEN);
    expect(written).toContain('Agent Vault is up');

    await shutdownLoader(found, app);
  });
});

/** The loader, wired for a test: the vault's CLI doubled and its probe the test's. */
function rig(
  found: LoaderWorld,
  probe: () => Promise<boolean>
): {
  app: ReturnType<typeof createLoaderApp>;
  lines: RecordedLine[];
  exits: number[];
} {
  const lines: RecordedLine[] = [];
  const exits: number[] = [];
  const app = createLoaderApp({
    config: found.config,
    fs: createNodeFileSystem(),
    runner: found.runner,
    launcher: found.launcher,
    logger: createRecordingLogger(lines),
    clock: found.clock,
    exit: (code) => exits.push(code),
    agentVaultProbe: probe,
  });
  return { app, lines, exits };
}

/** A loader brought up over `found`, with a password already set. */
async function start(found: LoaderWorld): Promise<{
  app: ReturnType<typeof createLoaderApp>;
  lines: RecordedLine[];
}> {
  const state = createLoaderState({
    fs: createNodeFileSystem(),
    config: found.config,
    logger: createRecordingLogger([]),
  });
  await state.ensureLayout();
  await state.writeAuth(await hashPassword('right'));
  const { app, lines, exits } = rig(found, () => Promise.resolve(true));
  await app.start();
  expect(exits).toEqual([]);
  return { app, lines };
}

/** A loader whose Agent Vault start fails: what it left with, and what it said. */
async function startExpectingFailure(found: LoaderWorld): Promise<{
  lines: RecordedLine[];
  exits: number[];
}> {
  const state = createLoaderState({
    fs: createNodeFileSystem(),
    config: found.config,
    logger: createRecordingLogger([]),
  });
  await state.ensureLayout();
  await state.writeAuth(await hashPassword('right'));
  const { app, lines, exits } = rig(found, () => Promise.resolve(true));
  await app.start();
  return { lines, exits };
}
