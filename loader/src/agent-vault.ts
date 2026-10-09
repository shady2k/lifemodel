/**
 * Agent Vault, the layer that holds the keys (lifemodel-q4x.3.1, decisions 4
 * and 12).
 *
 * Agent Vault (github.com/Infisical/agent-vault, MIT) is a credential proxy:
 * lifemodel never holds the model key, it sends its requests through Agent
 * Vault's transparent proxy and Agent Vault attaches the key on the way out.
 * The loader owns it exactly as it owns Caddy - it is part of the trusted
 * layer - and with the same order of promises:
 *
 *   - it is started BEFORE lifemodel (lifemodel's proxy credential comes from
 *     it) and is kept up: a death is followed by a start after a backoff;
 *   - it is stopped AFTER lifemodel, inside the ONE deadline of the whole stop
 *     (loader/src/app.ts): lifemodel's drain may still be talking through the
 *     proxy, so the proxy has to outlive it;
 *   - a missing binary, or a store the loader cannot open, is a missing input
 *     of the loader's own: one line with the cause, then a non-zero exit.
 *
 * What it keeps on the volume, all of it root-only:
 *
 *   <volume>/vault/                 Agent Vault's store (0700). Decision 4:
 *                                   the store is PASSWORDLESS (`server
 *                                   --password-stdin` with an empty line), so
 *                                   its protection IS this directory's
 *                                   permissions. Agent Vault's own HOME, so
 *                                   its database, its CA and the CLI's session
 *                                   sit in <volume>/vault/.agent-vault/.
 *   <volume>/vault-ca.pem           the proxy's root CA (0644): lifemodel's
 *                                   user must READ it to trust the proxy, and
 *                                   must not be able to write it.
 *   <loader>/vault-owner.json       the instance owner account the loader
 *                                   registers in Agent Vault, with the
 *                                   password it generated. Nothing else holds
 *                                   it, and it never reaches a log.
 *   <loader>/vault-proxy.json       the vault and the agent token lifemodel's
 *                                   process is given as its proxy credential.
 *
 * Creating them is IDEMPOTENT: a start finds the vault, the agent and the
 * token already there and reuses them, so `docker restart` and a new
 * container on the same volume bring back the same keys. The store is
 * created only when the volume holds none.
 */
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { join } from 'node:path';

import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandRunner, ProcessLauncher, SpawnedProcess } from './exec.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';
import { describe } from './state.js';

/** The store and the files inside it are the loader's, and nobody else's. */
const STORE_MODE = 0o700;
const SECRET_MODE = 0o600;
const CA_MODE = 0o644;
/** The line the server reads for `--password-stdin`: empty means passwordless. */
const PASSWORDLESS_LINE = '\n';
/** The proxy listens on loopback, and lifemodel reaches it there. */
const PROXY_HOST = '127.0.0.1';
/** Loopback traffic skips the proxy: lifemodel's own calls to local services. */
const NO_PROXY = 'localhost,127.0.0.1';
/** How often the loader asks whether the server is up, until its bound. */
const HEALTH_INTERVAL_MS = 200;

/** The proxy credential lifemodel's process is given, and nothing more. */
export interface VaultCredential {
  vault: string;
  agent: string;
  /** The agent token: a secret. It is never logged, and never written outside the volume. */
  token: string;
}

/** The instance owner account the loader registered in Agent Vault. */
export interface VaultOwnerAccount {
  email: string;
  password: string;
}

export interface AgentVaultStatus {
  running: boolean;
  pid: number | null;
  restarts: number;
}

export interface AgentVault {
  /** Prepare the store, bring the server up, provision the vault, export the CA. */
  start(): Promise<void>;
  /**
   * Stop Agent Vault, and never wait longer than the budget the caller has
   * left of the stop's own deadline. False when it had not exited even after
   * SIGKILL when the budget ran out.
   */
  stop(budgetMs?: number): Promise<boolean>;
  status(): AgentVaultStatus;
  /**
   * What lifemodel's own process is given for the proxy: the address of the
   * broker, its agent token and the vault, the standard proxy environment
   * that sends its traffic there, and the CA that makes the proxy's own
   * certificates validate - and NOTHING else: no key, no admin credential, no
   * store. Empty until the vault is up.
   *
   * This is the ONE place lifemodel's proxy environment is built
   * (lifemodel-q4x.3.2): the kernel rule that confines its egress is installed
   * by the loader beside it, and the loader's own build of the instance's code
   * - which runs as the same uid - is handed the same environment.
   */
  lifemodelEnvironment(): NodeJS.ProcessEnv;
  /**
   * The instance owner account the loader registered, as the loader's own page
   * hands it to the owner (decision 18), or null when the loader has not made
   * one yet. The password is a secret: it belongs on that page, behind the
   * loader's login, and nowhere else - not in a log line, and not in
   * lifemodel's environment.
   */
  ownerAccount(): Promise<VaultOwnerAccount | null>;
}

/** Asking the server whether it is up; the one boundary a test doubles. */
export type HealthProbe = (url: string) => Promise<boolean>;

export interface AgentVaultDeps {
  launcher: ProcessLauncher;
  runner: CommandRunner;
  fs: FileSystem;
  logger: LoaderLogger;
  clock: Clock;
  config: LoaderConfig;
  /** A test says the server is up (or never answers) without a real server. */
  probeHealth?: HealthProbe;
}

interface OwnerRecord {
  version: 1;
  email: string;
  password: string;
}

interface ProxyRecord {
  version: 1;
  vault: string;
  agent: string;
  token: string;
}

/**
 * The command's own reason, in one line. Agent Vault's CLI is a cobra program:
 * a failure prints `Error: <reason>`, then its usage block, and finally the
 * reason on its own - so the LAST non-empty line is the reason, and a command
 * that failed without one falls back to the first line it did print.
 */
function firstLine(result: { stdout: string; stderr: string }, fallback: string): string {
  for (const stream of [result.stderr, result.stdout]) {
    const lines = stream
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const last = lines[lines.length - 1];
    if (last !== undefined) return last;
  }
  return fallback;
}

/** The server's own readiness route, the one its image healthcheck asks. */
function httpHealth(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = request(url, { method: 'GET', timeout: 3_000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.end();
  });
}

export function createAgentVault(deps: AgentVaultDeps): AgentVault {
  const { launcher, runner, fs, logger, clock, config } = deps;
  const vaultConfig = config.agentVault;
  const probe = deps.probeHealth ?? httpHealth;
  const ownerPath = join(config.loaderDir, 'vault-owner.json');
  const proxyPath = join(config.loaderDir, 'vault-proxy.json');
  const sessionPath = join(vaultConfig.storeDir, '.agent-vault', 'session.json');

  let child: SpawnedProcess | null = null;
  let pid: number | null = null;
  let startedAt: number | null = null;
  let restarts = 0;
  let consecutiveFailures = 0;
  let stopping = false;
  let epoch = 0;
  let credential: VaultCredential | null = null;

  const apiAddress = (): string => `http://127.0.0.1:${String(vaultConfig.apiPort)}`;

  /**
   * The environment Agent Vault itself and its CLI run in. Two inherited
   * variables are dropped on purpose: the master password (the store is
   * passwordless by decision 4, and an operator's variable must not silently
   * password-protect it and then disagree with itself on the next start), and
   * the advertised address (the broker's links must name the address the
   * loader gave it, not one inherited from the container's environment).
   */
  function storeEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: vaultConfig.storeDir,
      AGENT_VAULT_TELEMETRY: 'false',
    };
    delete env['AGENT_VAULT_MASTER_PASSWORD'];
    delete env['AGENT_VAULT_ADDR'];
    return env;
  }

  function serverArgs(): string[] {
    return [
      'server',
      '--host',
      '127.0.0.1',
      '--port',
      String(vaultConfig.apiPort),
      '--mitm-port',
      String(vaultConfig.proxyPort),
      '--password-stdin',
    ];
  }

  /**
   * The commands the current startup is still running. Each has its own bound
   * (`commandWaitMs`) and the current startup's cancellation: the stop aborts
   * the live ones (they are ROOT-owned work, and a stop must reach everything
   * a start made), and reports whatever does not settle even killed.
   */
  interface TrackedCommand {
    promise: Promise<CommandResultLike>;
    abort(): void;
  }
  interface CommandResultLike {
    code: number;
    stdout: string;
    stderr: string;
  }
  const liveCommands = new Set<TrackedCommand>();
  /** The startup's cancellation for the commands it runs; null between starts. */
  let startupCommands: AbortController | null = null;

  /** One CLI call of the same binary, with the vault's own HOME. */
  async function vaultCli(args: string[], stdin?: string): Promise<CommandResultLike> {
    const controller = startupCommands ?? new AbortController();
    const tracked: TrackedCommand = {
      promise: runner.run(vaultConfig.binary, args, {
        cwd: config.volumeRoot,
        env: storeEnvironment(),
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs: vaultConfig.commandWaitMs,
        signal: controller.signal,
      }),
      abort: () => {
        controller.abort();
      },
    };
    liveCommands.add(tracked);
    try {
      return await tracked.promise;
    } finally {
      liveCommands.delete(tracked);
    }
  }

  /**
   * One record of the loader's own on the volume, read wholesale: JSON, the
   * version this loader writes, and EVERY field it needs as a non-empty
   * string. A record that holds less than that is not "partly there" - it is
   * a record the loader cannot use, and using it would hand clients an
   * unusable credential while announcing success - so the file's path and
   * the missing field's name (NEVER a value; these records hold secrets) are
   * what the loader leaves with.
   */
  async function readRecord<T extends { version: 1 }>(
    path: string,
    fields: readonly string[]
  ): Promise<T | null> {
    if (!(await fs.exists(path))) return null;
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (error) {
      throw new LoaderFatalError(`cannot read ${path}: ${describe(error)}`, { cause: error });
    }
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch (error) {
      throw new LoaderFatalError(`${path} is not valid JSON: ${describe(error)}`, { cause: error });
    }
    if (value.version !== 1) {
      throw new LoaderFatalError(`${path} does not hold what this loader wrote`);
    }
    const asRecord = value as Record<string, unknown>;
    for (const field of fields) {
      const value = asRecord[field];
      if (typeof value !== 'string' || value === '') {
        throw new LoaderFatalError(
          `${path} is not a complete record: the field "${field}" is missing or empty - restore the record or remove the file, and the loader will provision it again (the missing value is never printed)`
        );
      }
    }
    return value;
  }

  /**
   * The store directory: made when the volume holds none, and its mode forced
   * back to 0700 (Agent Vault's own files are 0600, but the directory is what
   * protects a passwordless store).
   */
  async function prepareStore(): Promise<void> {
    try {
      await fs.ensureDir(vaultConfig.storeDir, STORE_MODE);
      await fs.chmod(vaultConfig.storeDir, STORE_MODE);
    } catch (error) {
      throw new LoaderFatalError(
        `Agent Vault cannot open its store: ${vaultConfig.storeDir} could not be prepared (${describe(error)})`,
        { cause: error }
      );
    }
    if (!(await fs.isDirectory(vaultConfig.storeDir))) {
      throw new LoaderFatalError(
        `Agent Vault cannot open its store: ${vaultConfig.storeDir} is not a directory`
      );
    }
  }

  /**
   * A pid file left in the store is stale by construction: the loader is the
   * only thing that starts a server on this volume, and it has none running
   * here. Agent Vault refuses to start when that pid belongs to a live process
   * ("server is already running (PID n)") - and a process it killed rather
   * than waited out leaves the file behind - so the file is removed before the
   * start instead of letting a reused pid number stop the instance.
   */
  async function removeStalePidFile(): Promise<void> {
    const pidPath = join(vaultConfig.storeDir, '.agent-vault', 'agent-vault.pid');
    if (!(await fs.exists(pidPath))) return;
    await fs.remove(pidPath);
    logger.info({ pidPath }, 'a pid file was left in the store: it is stale, and removed');
  }

  /**
   * Wait for the server to answer its own readiness route, and never past the
   * bound this start has. A server that left, or that the OS refused to start,
   * fails at once and with its own reason: a store it cannot open must be one
   * line and a non-zero exit, not a backoff loop that hides the cause.
   */
  async function waitUntilUp(spawned: SpawnedProcess): Promise<void> {
    const deadline = clock.now() + vaultConfig.startWaitMs;
    const left: { seen: boolean; how: string } = { seen: false, how: '' };
    const refused: { reason: string | null } = { reason: null };
    spawned.onExit((code, signal) => {
      left.seen = true;
      left.how = String(code ?? signal);
    });
    spawned.onError((error) => {
      refused.reason = describe(error);
    });
    const health = `${apiAddress()}/health`;
    for (;;) {
      if (refused.reason !== null) {
        throw new LoaderFatalError(
          `Agent Vault could not be started at ${vaultConfig.binary}: ${refused.reason}`
        );
      }
      if (left.seen) {
        throw new LoaderFatalError(
          `Agent Vault could not open its store at ${vaultConfig.storeDir}: it exited (${left.how}) before it answered on ${apiAddress()}; its own line is in the container log`
        );
      }
      if (await probe(health)) return;
      if (clock.now() >= deadline) {
        throw new LoaderFatalError(
          `Agent Vault did not answer on ${apiAddress()} within ${String(vaultConfig.startWaitMs)} ms; its store is ${vaultConfig.storeDir}`
        );
      }
      await clock.sleep(HEALTH_INTERVAL_MS);
    }
  }

  /** The owner account's credentials, generated once and kept root-only. */
  async function ensureOwnerCredentials(): Promise<OwnerRecord> {
    const existing = await readRecord<OwnerRecord>(ownerPath, ['email', 'password']);
    if (existing !== null) return existing;
    const record: OwnerRecord = {
      version: 1,
      email: vaultConfig.ownerEmail,
      password: randomBytes(24).toString('base64url'),
    };
    await fs.writeFileAtomic(ownerPath, `${JSON.stringify(record, null, 2)}\n`, SECRET_MODE);
    return record;
  }

  /**
   * A CLI session for that account. A fresh store has no account yet, so the
   * first attempt is a login and the second a registration; on a store that
   * already has the account the login is the whole of it. The session file is
   * what proves the account is live: a registration of an address that is
   * already taken answers politely and creates nothing, and an account that
   * still wants a verification code cannot act for the loader at all.
   */
  async function cliAuthenticate(owner: OwnerRecord): Promise<void> {
    await fs.remove(sessionPath);
    const args = (command: string): string[] => [
      'auth',
      command,
      '--address',
      apiAddress(),
      '--email',
      owner.email,
      '--password-stdin',
    ];
    const login = await vaultCli(args('login'), `${owner.password}\n`);
    if (login.code === 0) return;
    const register = await vaultCli(args('register'), `${owner.password}\n`);
    if (register.code !== 0) {
      throw new LoaderFatalError(
        `Agent Vault refused the loader's own account ${owner.email}: ${firstLine(register, `the command left with ${String(register.code)}`)}`
      );
    }
    if (!(await fs.exists(sessionPath))) {
      throw new LoaderFatalError(
        `Agent Vault did not give the loader a session for ${owner.email}: the account needs a verification code the loader cannot complete`
      );
    }
  }

  async function ensureVault(): Promise<string> {
    const name = vaultConfig.vaultName;
    const existing = await vaultCli(['vault', 'credential-store', 'show', name]);
    if (existing.code === 0) return name;
    const created = await vaultCli(['vault', 'create', name]);
    if (created.code !== 0) {
      throw new LoaderFatalError(
        `Agent Vault has no vault ${name} and could not create one: ${firstLine(created, `the command left with ${String(created.code)}`)}`
      );
    }
    logger.info({ vault: name }, 'Agent Vault: the vault lifemodel uses is created');
    return name;
  }

  function tokenOf(
    vault: string,
    agent: string,
    result: { code: number; stdout: string; stderr: string }
  ): string {
    const token = result.stdout.trim();
    if (token === '' || /\s/.test(token)) {
      throw new LoaderFatalError(
        `Agent Vault answered no token for the agent ${agent} in vault ${vault}: ${firstLine(result, 'the command printed nothing usable')}`
      );
    }
    return token;
  }

  /**
   * The agent whose token lifemodel's process is given. An agent that is there
   * but whose token is not on this volume any more is ROTATED: the store keeps
   * the agent, the token is minted for it, and nothing but lifemodel's next
   * start uses it. That is what makes a lost record recoverable instead of a
   * fatal.
   */
  async function ensureAgent(vault: string): Promise<string> {
    const name = vaultConfig.agentName;
    const info = await vaultCli(['agent', 'info', name]);
    if (info.code === 0) {
      const rotated = await vaultCli(['agent', 'rotate', name, '--token-only']);
      if (rotated.code !== 0) {
        throw new LoaderFatalError(
          `Agent Vault could not mint a token for its agent ${name}: ${firstLine(rotated, `the command left with ${String(rotated.code)}`)}`
        );
      }
      return tokenOf(vault, name, rotated);
    }
    const created = await vaultCli([
      'agent',
      'create',
      name,
      '--vault',
      `${vault}:proxy`,
      '--token-only',
    ]);
    if (created.code !== 0) {
      throw new LoaderFatalError(
        `Agent Vault could not create its agent ${name}: ${firstLine(created, `the command left with ${String(created.code)}`)}`
      );
    }
    logger.info({ vault, agent: name }, "Agent Vault: lifemodel's agent is created");
    return tokenOf(vault, name, created);
  }

  /**
   * The vault, the agent and its token, created once and reused after that -
   * and reused ONLY when the record still matches what the vault's store
   * holds: the store can be replaced while `vault-proxy.json` survives (that
   * is what recovery from a bad store looks like), and a record read back
   * without the store check would hand clients a token the replacement store
   * does not know while the loader announces success. So a kept record is
   * reconciled first: the CLI's own read of the vault the record names, and
   * the CLI session that proves the account can still act for the loader.
   * Either missing: the record does not match the store, and provisioning
   * runs whole, ending with a fresh record.
   */
  async function provision(): Promise<VaultCredential> {
    const known = await readRecord<ProxyRecord>(proxyPath, ['vault', 'agent', 'token']);
    if (known !== null) {
      const session = await fs.exists(sessionPath);
      const inStore = await vaultCli(['vault', 'credential-store', 'show', known.vault]);
      if (session && inStore.code === 0) {
        return { vault: known.vault, agent: known.agent, token: known.token };
      }
      logger.warn(
        { vault: known.vault, agent: known.agent, record: proxyPath },
        'the saved proxy record does not match what the store holds: it is provisioned again, and the record beside it is written fresh'
      );
    }
    const owner = await ensureOwnerCredentials();
    await cliAuthenticate(owner);
    const vault = await ensureVault();
    const token = await ensureAgent(vault);
    const record: ProxyRecord = { version: 1, vault, agent: vaultConfig.agentName, token };
    await fs.writeFileAtomic(proxyPath, `${JSON.stringify(record, null, 2)}\n`, SECRET_MODE);
    return { vault: record.vault, agent: record.agent, token: record.token };
  }

  /**
   * The CA lifemodel's user must trust, written where it can be read and not
   * written. It is re-read on every start, so a store that was replaced brings
   * its own CA with it.
   */
  async function exportCa(): Promise<void> {
    const fetched = await vaultCli(['ca', 'fetch']);
    if (fetched.code !== 0) {
      throw new LoaderFatalError(
        `Agent Vault's proxy certificate could not be read: ${firstLine(fetched, `the command left with ${String(fetched.code)}`)}`
      );
    }
    const pem = fetched.stdout;
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new LoaderFatalError(
        `Agent Vault printed no proxy certificate for ${vaultConfig.caPath}`
      );
    }
    await fs.writeFileAtomic(vaultConfig.caPath, pem.endsWith('\n') ? pem : `${pem}\n`, CA_MODE);
  }

  function scheduleRestart(ranMs: number): void {
    if (ranMs >= config.restart.healthyRunMs) consecutiveFailures = 0;
    else consecutiveFailures += 1;
    const delay = Math.min(
      config.restart.initialDelayMs * 2 ** Math.max(0, consecutiveFailures - 1),
      config.restart.maxDelayMs
    );
    restarts += 1;
    const scheduledEpoch = epoch;
    logger.info({ delayMs: delay }, 'Agent Vault is started again after a backoff');
    void (async () => {
      await clock.sleep(delay);
      if (stopping || scheduledEpoch !== epoch) return;
      await start();
    })();
  }

  async function start(): Promise<void> {
    if (child !== null) return;
    // The stop-free interval this start belongs to: a stop bumps the epoch,
    // and then nothing this start makes may outlive that stop's answer.
    const startEpoch = epoch;
    // This start's own cancellation for its CLI commands; the stop aborts it.
    const commands = new AbortController();
    startupCommands = commands;
    if (!(await fs.exists(vaultConfig.binary))) {
      throw new LoaderFatalError(
        `Agent Vault is missing: there is no agent-vault at ${vaultConfig.binary}, so no key could be held for lifemodel`
      );
    }
    await prepareStore();
    await removeStalePidFile();
    // A stop can begin during the awaits above (the loader's own signals are
    // wired before it starts, so a `docker stop` right after `docker run` runs
    // its shutdown beside this start): then this start makes nothing at all,
    // and the stop's answer - nothing was running - stays true.
    if (stoppedSince(startEpoch)) return;
    const spawned = launcher.spawn(vaultConfig.binary, serverArgs(), {
      cwd: config.volumeRoot,
      env: storeEnvironment(),
      stdin: PASSWORDLESS_LINE,
    });
    child = spawned;
    pid = spawned.pid ?? null;
    startedAt = clock.now();
    const scheduledEpoch = epoch;
    spawned.onExit((code, signal) => {
      if (child !== spawned) return;
      const ranMs = startedAt === null ? 0 : clock.now() - startedAt;
      stopped();
      // A stop, or a start that already gave this child up: not a death anyone
      // has to bring back.
      if (stopping || scheduledEpoch !== epoch) return;
      logger.warn({ code, signal, ranMs }, 'Agent Vault exited');
      scheduleRestart(ranMs);
    });
    spawned.onError((error) => {
      logger.error({ error: describe(error) }, 'Agent Vault could not be started');
    });
    try {
      await waitUntilUp(spawned);
      credential ??= await provision();
      await exportCa();
      if (stoppedSince(startEpoch)) {
        giveUpAfterStop(spawned);
        return;
      }
    } catch (error) {
      stopped();
      spawned.kill('SIGKILL');
      if (stoppedSince(startEpoch)) {
        // The stop is what ended this start (it stopped the child this start
        // had already made): the loader is leaving, and this is not a missing
        // input to leave with.
        logger.info({}, 'Agent Vault did not finish starting: the loader is stopping');
        return;
      }
      // The start failed as a missing input of the loader's own: the child is
      // given up on here - the loader is about to leave with the reason, and a
      // restart loop of a server that cannot open its store would only hide it.
      epoch += 1;
      throw error;
    }
    logger.info(
      {
        pid,
        apiPort: vaultConfig.apiPort,
        proxyPort: vaultConfig.proxyPort,
        store: vaultConfig.storeDir,
        vault: credential?.vault ?? null,
        agent: credential?.agent ?? null,
      },
      'Agent Vault is up: it holds the keys, and lifemodel holds none'
    );
  }

  /** The child is gone (or given up on): this module owns nothing of it any more. */
  function stopped(): void {
    child = null;
    pid = null;
    startedAt = null;
  }

  /**
   * Whether a stop began after this start did. Every stop bumps the epoch, so
   * this is true for a stop that is still running AND for one that has already
   * answered - which is the case that matters: a stop that found no child
   * answered "nothing is running", and a start that then spawned one would
   * make that answer false.
   */
  function stoppedSince(startEpoch: number): boolean {
    return stopping || epoch !== startEpoch;
  }

  /**
   * A stop began while this start was still making the vault: what this start
   * made is given up rather than left running behind a stop that already
   * answered. The loader is leaving in that case - the stop is the container's
   * own - so the start says one line and returns instead of failing.
   */
  function giveUpAfterStop(spawned: SpawnedProcess): void {
    stopped();
    spawned.kill('SIGTERM');
    logger.info(
      { pid: spawned.pid ?? null },
      'Agent Vault was started while the loader was stopping: it is stopped again'
    );
  }

  async function stop(
    budgetMs: number = vaultConfig.stopWaitMs + config.killWaitMs
  ): Promise<boolean> {
    const deadline = clock.now() + Math.max(0, budgetMs);
    const remaining = (): number => Math.max(0, deadline - clock.now());
    epoch += 1;
    stopping = true;
    // The commands the startup is still running are the stop's to reach too:
    // they are killed here, and what does not settle even killed is reported.
    const running = [...liveCommands];
    for (const tracked of running) tracked.abort();
    if (running.length > 0) {
      logger.info(
        { commands: running.length },
        'aborting the vault commands the startup is running'
      );
      const settled = await Promise.race([
        Promise.allSettled(running.map((tracked) => tracked.promise)).then(() => true),
        clock.sleep(remaining()).then(() => false),
      ]);
      if (!settled) {
        logger.error(
          { commands: running.length },
          "Agent Vault's provisioning commands had not left when the stop deadline ran out"
        );
        stopping = false;
        return false;
      }
    }
    const current = child;
    if (current === null) {
      stopping = false;
      return true;
    }
    const waitMs = Math.min(vaultConfig.stopWaitMs, Math.max(0, remaining() - config.killWaitMs));
    logger.info({ pid }, 'stopping Agent Vault');
    const exited = new Promise<boolean>((resolve) => {
      current.onExit(() => {
        resolve(true);
      });
    });
    current.kill('SIGTERM');
    const left = await Promise.race([exited, clock.sleep(waitMs).then(() => false)]);
    if (!left) {
      logger.warn({ pid }, `Agent Vault did not leave within ${String(waitMs)} ms: it is killed`);
      current.kill('SIGKILL');
      const reaped = await Promise.race([exited, clock.sleep(remaining()).then(() => false)]);
      if (!reaped) {
        logger.error(
          { pid },
          'Agent Vault had not exited after SIGKILL when the stop deadline ran out'
        );
        stopping = false;
        return false;
      }
    }
    stopped();
    stopping = false;
    return true;
  }

  /**
   * The proxy URL a standard client is pointed at: the agent token as the
   * user and the vault as the password, exactly as Agent Vault's own `vault
   * run` builds it. Both halves are URL-encoded (RFC 3986 userinfo), so a
   * token with a reserved character still arrives intact.
   */
  function proxyUrl(current: VaultCredential): string {
    const user = encodeURIComponent(current.token);
    const password = encodeURIComponent(current.vault);
    return `http://${user}:${password}@${PROXY_HOST}:${String(vaultConfig.proxyPort)}`;
  }

  return {
    start,
    stop,
    status: () => ({ running: child !== null, pid, restarts }),
    lifemodelEnvironment: () => {
      const current = credential;
      if (current === null) return {};
      const proxy = proxyUrl(current);
      return {
        AGENT_VAULT_ADDR: apiAddress(),
        AGENT_VAULT_TOKEN: current.token,
        AGENT_VAULT_VAULT: current.vault,
        // Every one of these is a standard name a client already honours:
        // HTTPS_PROXY for https upstreams, HTTP_PROXY for plain http ones (the
        // same listener answers both), NO_PROXY so loopback calls and the
        // broker's own control plane skip the proxy, NODE_USE_ENV_PROXY so
        // Node 24's fetch uses the environment's proxy at all, and the CA so
        // the certificates the proxy re-signs with validate.
        //
        // Each of the three is set in BOTH spellings: clients are not agreed
        // on the case (Node's EnvHttpProxyAgent prefers the lowercase one),
        // and `docker run` hands a caller's lowercase `http_proxy` into the
        // container as its own - a stale lowercase value must not silently
        // win over what the loader set. The environment that reaches
        // lifemodel's process is built by spreading `process.env` FIRST and
        // this object LAST, so these keys also REPLACE whatever the container
        // inherited.
        HTTPS_PROXY: proxy,
        https_proxy: proxy,
        HTTP_PROXY: proxy,
        http_proxy: proxy,
        NO_PROXY,
        no_proxy: NO_PROXY,
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: vaultConfig.caPath,
      };
    },
    ownerAccount: async () => {
      const known = await readRecord<OwnerRecord>(ownerPath, ['email', 'password']);
      if (known === null) return null;
      return { email: known.email, password: known.password };
    },
  };
}
