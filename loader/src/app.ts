/**
 * The loader, wired (lifemodel-q4x.2.1).
 *
 * One place decides what ends the process: the inputs the loader itself needs
 * to COME UP - a volume it can prepare, its own port, the front door it starts
 * and, while the volume holds no repository yet, the code the image carries -
 * are checked before it serves, said in one line with their cause, and then
 * the loader leaves with a non-zero code. It never falls back to something
 * else quietly.
 *
 * Everything that fails AFTER that - seeding the repository, building the
 * commit, starting lifemodel - leaves the loader UP with Caddy and its
 * interface, its state failed with the reason, and the owner's retry (the
 * page's resume button, or `lifemodel resume`) as the way on (rework 1:
 * decision 11, the interface runs always; it is the way out).
 */
import { createAgentVault, type AgentVault, type HealthProbe } from './agent-vault.js';
import { createBootstrap, type Bootstrap } from './bootstrap.js';
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandRunner, ProcessLauncher } from './exec.js';
import { createEgress, type Egress } from './egress.js';
import { createFrontDoor, type FrontDoor } from './front-door.js';
import type { FileSystem } from './fs.js';
import { createLoaderHttp, type LoaderHttp } from './http.js';
import type { LoaderLogger } from './logger.js';
import { createLoaderState, describe, type LoaderState } from './state.js';
import { requireSeedBundleForFirstStart } from './repo.js';
import { createSupervisor, type Supervisor } from './supervisor.js';
import {
  createKubernetesBaoCustody,
  createOpenBaoApi,
  createOpenBaoBootstrap,
  type BaoApi,
  type BaoCustody,
} from './openbao.js';
import {
  createKubernetesPhaseStore,
  createPlatformPhaseRunner,
  type PlatformPhaseStore,
  type PlatformPhase,
} from './platform-bootstrap.js';
import {
  createGiteaBootstrap,
  createGiteaHttpApi,
  createKubernetesGiteaAdminSecret,
  type GiteaApi,
} from './gitea.js';

export interface LoaderAppDeps {
  config: LoaderConfig;
  fs: FileSystem;
  runner: CommandRunner;
  launcher: ProcessLauncher;
  logger: LoaderLogger;
  clock: Clock;
  /** Leave the process with this code (injected: a test must not exit vitest). */
  exit(code: number): void;
  /**
   * A test says whether Agent Vault is up without a real server; the image
   * gets the server's own `/health` route.
   */
  agentVaultProbe?: HealthProbe;
  /** Test boundary for platform bootstrap; production uses in-cluster APIs. */
  openBao?: { api: BaoApi; custody: BaoCustody };
  platformPhaseStore?: PlatformPhaseStore;
  /** Test seam for later first-start phases; production uses the Gitea plan. */
  platformGiteaPhases?: PlatformPhase[];
  /** Test boundary for the Gitea HTTP and Kubernetes credential APIs. */
  platformGiteaApi?: GiteaApi;
  platformLoaderJwt?: () => Promise<string>;
  platformBootstrap?: { runInitial(): Promise<void>; unsealIfSealed(): Promise<void> };
}

export interface LoaderApp {
  /** Prepare the volume, open the loader's port, and start lifemodel if it may run. */
  start(): Promise<void>;
  /** The port the loader actually listens on (a test asks for 0 and reads this). */
  port(): number;
  /** The address the server actually bound, or null before it is listening. */
  host(): string | null;
  /** Stop intake, give lifemodel its drain; the code the process should leave with. */
  shutdown(reason: string): Promise<number>;
  /** The pieces, for a test that drives them directly. */
  state: LoaderState;
  supervisor: Supervisor;
  bootstrap: Bootstrap;
  frontDoor: FrontDoor;
  agentVault: AgentVault;
  egress: Egress;
}

export function createLoaderApp(deps: LoaderAppDeps): LoaderApp {
  const { config, fs, runner, launcher, logger, clock } = deps;
  // Bound, not detached: `exit` is the process's way out, not a value to pass around.
  const exit = (code: number): void => {
    deps.exit(code);
  };

  const state = createLoaderState({ fs, config, logger });
  // Platform mode (ADR-010, platform step A0): the loader supervises nothing.
  // Its instance pieces are constructed for the app contract, but are not
  // passed to HTTP or asked to start. A deployment without a front-door binary,
  // Agent Vault or Docker socket still serves authentication. Instance mode
  // is unchanged: it starts them and exposes their controls.
  const platform = config.mode === 'platform';
  const platformPhaseStore = deps.platformPhaseStore ?? createKubernetesPhaseStore();
  const baoParts =
    deps.openBao ??
    ({
      api: createOpenBaoApi({ address: config.openBaoAddress }),
      custody: createKubernetesBaoCustody(),
    } satisfies { api: BaoApi; custody: BaoCustody });
  const giteaBootstrap = createGiteaBootstrap({
    api:
      deps.platformGiteaApi ?? {
        ...createGiteaHttpApi({
          address: 'http://gitea-http.lifemodel-git.svc:3000',
          seedBundle: '/opt/lifemodel/seed.bundle',
          runner,
        }),
        ensureAdminSecret: createKubernetesGiteaAdminSecret(),
      },
    runPhases: createPlatformPhaseRunner(platformPhaseStore),
  });
  const platformBootstrap =
    deps.platformBootstrap ??
    (() => {
      const bootstrap = createOpenBaoBootstrap({
        bao: baoParts.api,
        custody: baoParts.custody,
        runPhases: createPlatformPhaseRunner(platformPhaseStore),
        extraPhases: deps.platformGiteaPhases ?? giteaBootstrap.phases(),
        ...(deps.platformLoaderJwt === undefined ? {} : { loaderJwt: deps.platformLoaderJwt }),
      });
      return {
        runInitial: () => bootstrap.runInitial(),
        unsealIfSealed: () => bootstrap.unsealIfSealed(),
      };
    })();
  const agentVault = createAgentVault({
    launcher,
    runner,
    fs,
    logger,
    clock,
    config,
    ...(deps.agentVaultProbe === undefined ? {} : { probeHealth: deps.agentVaultProbe }),
  });
  const supervisor = createSupervisor({
    launcher,
    logger,
    clock,
    config,
    isPanicSet: () => state.isPanicSet(),
    // lifemodel's proxy credential comes from the vault, and only from it.
    proxyEnvironment: () => agentVault.lifemodelEnvironment(),
  });
  const bootstrap = createBootstrap({
    fs,
    runner,
    logger,
    config,
    state,
    supervisor,
    clock,
    // The instance's own code is built as lifemodel's user, and that user may
    // reach loopback only: the build leaves through the same proxy (an
    // unconfined npm ci would be the one hole in the rule).
    proxyEnvironment: () => agentVault.lifemodelEnvironment(),
  });
  const frontDoor = createFrontDoor({ launcher, fs, logger, clock, config });
  const egress = createEgress({ runner, logger, config });

  function fatal(error: unknown): void {
    const message =
      error instanceof LoaderFatalError ? error.message : `the loader stopped: ${describe(error)}`;
    logger.error({ error: describe(error) }, message);
    exit(1);
  }

  let http: LoaderHttp | null = null;

  /**
   * The stop's own latch: set when a stop begins and never unset. A stop must
   * reach everything a start created - including a start that was still on its
   * way when the stop arrived (held inside a step, or midway through it) - so
   * every startup continuation checks this latch at its fences: past it, the
   * start ends, and it neither spawns anything new nor opens the interface.
   */
  let stopping = false;
  /** The startup running now, for the stop to wait for and re-run against before it answers. */
  let startup: Promise<void> | null = null;
  let platformBootstrapStarted = false;
  let resolvePlatformStop!: () => void;
  const platformStop = new Promise<void>((resolve) => {
    resolvePlatformStop = resolve;
  });
  const waitForPlatform = (ms: number): Promise<void> =>
    Promise.race([clock.sleep(ms), platformStop]);

  /** Keep the interface live while durable first-start work retries and sealed restarts are repaired. */
  async function runPlatformBootstrap(): Promise<void> {
    if (platformBootstrapStarted) return;
    platformBootstrapStarted = true;
    let delayMs = 1_000;
    while (!stopping) {
      try {
        await platformBootstrap.runInitial();
        try {
          await platformBootstrap.unsealIfSealed();
        } catch (error) {
          await platformPhaseStore.write({ phase: 'openbao-unseal', status: 'failed' });
          throw error;
        }
        logger.info({}, 'OpenBao bootstrap is ready');
        delayMs = 30_000;
      } catch (error) {
        let failedPhase = 'unknown';
        try {
          const record = await platformPhaseStore.read();
          if (record?.status === 'failed') failedPhase = record.phase;
        } catch {
          // Keep the original bootstrap failure visible if reading its phase also fails.
        }
        logger.error(
          { error: describe(error), phase: failedPhase },
          `platform bootstrap failed during ${failedPhase}; retrying in ${String(delayMs)} ms`
        );
        await waitForPlatform(delayMs);
        delayMs = Math.min(delayMs * 2, 30_000);
        continue;
      }
      await waitForPlatform(delayMs);
    }
  }

  function listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http?.server;
      if (server === undefined) {
        reject(new LoaderFatalError('the loader has no server to open'));
        return;
      }
      server.once('error', reject);
      // Instance mode: loopback, inside the container that owns the front
      // door. Platform mode: every interface - the pod's Service reaches the
      // loader over the pod IP, and no front door sits beside it.
      const host = platform ? '0.0.0.0' : '127.0.0.1';
      server.listen(config.httpPort, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * The stop's second reach: whatever a fenced start made in the windows the
   * stop's own steps cannot see into. The startup in flight is awaited under
   * the same deadline first; what it created between the stop's steps is then
   * stopped again, and only what is still unreachable is reported.
   */
  async function stopStartupLeftovers(left: () => number, pending: string[]): Promise<void> {
    const inFlight = startup;
    if (inFlight === null) return;
    const settled = await Promise.race([
      inFlight.then(() => true).catch(() => true),
      clock.sleep(left()).then(() => false),
    ]);
    if (!settled) {
      pending.push("the loader's startup was still in flight when the stop deadline ran out");
      return;
    }
    // The start is over - fenced before any later step, so nothing it still
    // holds was created past its fence. What it DID make in the windows
    // between the stop's steps (a caddy that landed after the front door's
    // stop, a vault child past the vault's stop, the interface re-opened) is
    // stopped again here.
    if (http !== null) {
      const closedAgain = await Promise.race([
        http.close().then(() => true),
        clock.sleep(Math.min(left(), config.killWaitMs)).then(() => false),
      ]);
      if (!closedAgain) {
        pending.push(
          "the loader's own server (opened while the stop ran, still holding connections)"
        );
      }
    }
    const vaultAgain = await agentVault.stop(left());
    if (!vaultAgain)
      pending.push('Agent Vault (started while the stop ran, not reaped by the deadline)');
    const caddyAgain = await frontDoor.stop(left());
    if (!caddyAgain) pending.push('caddy (started while the stop ran, not reaped by the deadline)');
  }

  /**
   * The startup, one fence after every step: the stop's latch can go up while
   * any of these are running (a `docker stop` right after `docker run` runs
   * its shutdown beside the start), and a start that finds it up makes
   * NOTHING further - the stop re-reaches whatever an earlier window in this
   * start left behind, and the stop's answer stays the truth.
   */
  async function bringUp(): Promise<void> {
    try {
      await state.ensureLayout();
      if (!platform) {
        // The code the image carries, for a volume that holds no repository
        // yet: without it this instance can never be seeded, so it is one of
        // the loader's own inputs and is checked before it serves.
        await requireSeedBundleForFirstStart({ fs, config });
        if (stopping) return;
        // The front door first: it is what the owner reaches, and it must be
        // up while lifemodel is still being seeded, built or panicked.
        await frontDoor.start();
        if (stopping) return;
        // Agent Vault next, and before lifemodel: lifemodel's proxy credential
        // comes from the vault the loader creates here, and the vault must be
        // ready to answer before the process that uses it runs.
        await agentVault.start();
        if (stopping) return;
        // Then the kernel rule: uid 1000 may reach the named loopback services
        // and nothing else, so the proxy above is the only way out for
        // lifemodel AND for the build of its code. A container that cannot
        // carry the rule does not start lifemodel at all (a missing input of
        // the loader's own).
        await egress.install();
        if (stopping) return;
      }
      http = createLoaderHttp({
        state,
        ...(platform
          ? {}
          : { supervisor, bootstrap, vaultAccount: () => agentVault.ownerAccount() }),
        mode: platform ? 'platform' : 'instance',
        logger,
        clock,
      });
      await listen();
      if (stopping) {
        // The interface the stop had already closed once is closed again by
        // the stop itself (it re-reaches what a start made in its windows);
        // this start says only that it is not serving.
        logger.info({}, "the loader's interface is not opened for serving: the loader is stopping");
        return;
      }
      http.server.on('error', (error) => {
        fatal(
          new LoaderFatalError(
            `the loader's own server failed on port ${String(config.httpPort)}: ${describe(error)}`,
            { cause: error }
          )
        );
      });
      logger.info(
        { port: config.httpPort, volume: config.volumeRoot, repo: config.repoDir },
        'the loader is up'
      );
      if (platform) {
        void runPlatformBootstrap();
        return;
      }
      if ((await state.readAuth()) === null) {
        logger.info({}, 'no password is set: the owner is asked at /setup');
        return;
      }
      // A password is set, so this start continues where the last one left
      // off: seed if the volume is empty, build if needed, start lifemodel.
      // A failure here is the instance's state, not the loader's exit.
      void bootstrap.ensureReady('startup');
    } catch (error) {
      if (stopping) {
        // The stop is what ended this start (the fence above returns cleanly,
        // and a step that failed because the loader is leaving - its child
        // killed under it, its port taken away - is that stop's doing): the
        // loader is leaving with the stop's answer, not this start's reason.
        logger.info({}, "the loader's start did not finish: the loader is stopping");
        return;
      }
      fatal(
        error instanceof LoaderFatalError
          ? error
          : new LoaderFatalError(
              `the loader cannot listen on port ${String(config.httpPort)}: ${describe(error)}`,
              { cause: error }
            )
      );
    }
  }

  return {
    state,
    supervisor,
    bootstrap,
    frontDoor,
    agentVault,
    egress,

    port: () => {
      const address = http?.server.address();
      return address === null || address === undefined || typeof address === 'string'
        ? config.httpPort
        : address.port;
    },

    host: () => {
      const address = http?.server.address();
      return address === null || address === undefined || typeof address === 'string'
        ? null
        : address.address;
    },

    start: async () => {
      // A start asked for while a stop is in, or after a stop answered, does
      // nothing at all: the latch never unsets, so a stop cannot be answered
      // with work a later start quietly brought up.
      if (stopping) {
        logger.info({}, 'the loader is stopping or was stopped already: it is not started again');
        return;
      }
      const run = bringUp();
      startup = run;
      try {
        await run;
      } finally {
        if (startup === run) startup = null;
      }
    },

    shutdown: async (reason: string) => {
      // ONE deadline for the whole stop, from the moment the stop signal
      // arrived (rework 2, finding 10; rework 3): closing the loader's server,
      // lifemodel's drain, its SIGKILL and Caddy's exit all spend the same
      // budget, and no step waits past it. The documented `--stop-timeout 120`
      // is longer than this budget (110 s), so Docker's own kill comes after
      // the loader has either finished or given up and left with code 1.
      const deadline = clock.now() + config.stopBudgetMs;
      const left = (): number => Math.max(0, deadline - clock.now());
      logger.info({ reason, budgetMs: config.stopBudgetMs }, 'the loader is stopping');
      // The latch comes first: no startup continues past its fences, and
      // nothing starts from here on (not a start in flight, not a restart).
      stopping = true;
      resolvePlatformStop();
      // Nothing starts from here on: not a start in flight, not a restart.
      supervisor.close();
      const pending: string[] = [];
      const closing = http?.close() ?? Promise.resolve();
      // The server's close is bounded by a short share of the budget: a
      // client that holds its connection open must not eat lifemodel's drain.
      const closeWaitMs = Math.min(left(), config.killWaitMs);
      const closed = await Promise.race([
        closing.then(() => true),
        clock.sleep(closeWaitMs).then(() => false),
      ]);
      if (!closed) pending.push("the loader's own server (connections still open after its share)");
      // The supervisor already said it in one line when the drain ran out;
      // the code below is what the container leaves with.
      const outcome = await supervisor.stop('shutdown', left());
      if (outcome.pending !== null) pending.push(outcome.pending);
      // Then Agent Vault: lifemodel's drain may still be talking through its
      // proxy, so the proxy outlives it. Both share what is left of the one
      // deadline.
      const vaultLeft = await agentVault.stop(left());
      if (!vaultLeft) pending.push('Agent Vault (not reaped after SIGKILL by the stop deadline)');
      // Last: the front door stays open while lifemodel drains, so a person
      // watching the page sees the stop rather than a connection error.
      const caddyLeft = await frontDoor.stop(left());
      if (!caddyLeft) pending.push('caddy (not reaped after SIGKILL by the stop deadline)');
      // A start that was still working when the stop began: its continuation
      // is fenced, awaited, and re-stopped under the same deadline.
      await stopStartupLeftovers(left, pending);
      if (pending.length > 0) {
        // Each entry says which bound it hit: the shared deadline, or a step's
        // own shorter cap (rework 3, review round 4 finding 3).
        logger.error(
          { pending, budgetMs: config.stopBudgetMs },
          `the loader is leaving with work still pending: ${pending.join('; ')}`
        );
        return 1;
      }
      return outcome.drainTimedOut ? 1 : 0;
    },
  };
}
