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
import { createBootstrap, type Bootstrap } from './bootstrap.js';
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandRunner, ProcessLauncher } from './exec.js';
import { createFrontDoor, type FrontDoor } from './front-door.js';
import type { FileSystem } from './fs.js';
import { createLoaderHttp, type LoaderHttp } from './http.js';
import type { LoaderLogger } from './logger.js';
import { createLoaderState, describe, type LoaderState } from './state.js';
import { requireSeedBundleForFirstStart } from './repo.js';
import { createSupervisor, type Supervisor } from './supervisor.js';

export interface LoaderAppDeps {
  config: LoaderConfig;
  fs: FileSystem;
  runner: CommandRunner;
  launcher: ProcessLauncher;
  logger: LoaderLogger;
  clock: Clock;
  /** Leave the process with this code (injected: a test must not exit vitest). */
  exit(code: number): void;
}

export interface LoaderApp {
  /** Prepare the volume, open the loader's port, and start lifemodel if it may run. */
  start(): Promise<void>;
  /** The port the loader actually listens on (a test asks for 0 and reads this). */
  port(): number;
  /** Stop intake, give lifemodel its drain; the code the process should leave with. */
  shutdown(reason: string): Promise<number>;
  /** The pieces, for a test that drives them directly. */
  state: LoaderState;
  supervisor: Supervisor;
  bootstrap: Bootstrap;
  frontDoor: FrontDoor;
}

export function createLoaderApp(deps: LoaderAppDeps): LoaderApp {
  const { config, fs, runner, launcher, logger, clock } = deps;
  // Bound, not detached: `exit` is the process's way out, not a value to pass around.
  const exit = (code: number): void => {
    deps.exit(code);
  };

  const state = createLoaderState({ fs, config, logger });
  const supervisor = createSupervisor({
    launcher,
    logger,
    clock,
    config,
    isPanicSet: () => state.isPanicSet(),
  });
  const bootstrap = createBootstrap({ fs, runner, logger, config, state, supervisor, clock });
  const frontDoor = createFrontDoor({ launcher, fs, logger, clock, config });

  function fatal(error: unknown): void {
    const message =
      error instanceof LoaderFatalError ? error.message : `the loader stopped: ${describe(error)}`;
    logger.error({ error: describe(error) }, message);
    exit(1);
  }

  let http: LoaderHttp | null = null;

  function listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http?.server;
      if (server === undefined) {
        reject(new LoaderFatalError('the loader has no server to open'));
        return;
      }
      server.once('error', reject);
      server.listen(config.httpPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  return {
    state,
    supervisor,
    bootstrap,
    frontDoor,

    port: () => {
      const address = http?.server.address();
      return address === null || address === undefined || typeof address === 'string'
        ? config.httpPort
        : address.port;
    },

    start: async () => {
      try {
        await state.ensureLayout();
        // The code the image carries, for a volume that holds no repository
        // yet: without it this instance can never be seeded, so it is one of
        // the loader's own inputs and is checked before it serves.
        await requireSeedBundleForFirstStart({ fs, config });
        // The front door first: it is what the owner reaches, and it must be
        // up while lifemodel is still being seeded, built or panicked.
        await frontDoor.start();
        http = createLoaderHttp({ state, supervisor, bootstrap, logger, clock });
        await listen();
        http.server.on('error', (error) => {
          fatal(
            new LoaderFatalError(
              `the loader's own server failed on 127.0.0.1:${String(config.httpPort)}: ${describe(error)}`,
              { cause: error }
            )
          );
        });
        logger.info(
          { port: config.httpPort, volume: config.volumeRoot, repo: config.repoDir },
          'the loader is up'
        );
        if ((await state.readAuth()) === null) {
          logger.info({}, 'no password is set: the owner is asked at /setup');
          return;
        }
        // A password is set, so this start continues where the last one left
        // off: seed if the volume is empty, build if needed, start lifemodel.
        // A failure here is the instance's state, not the loader's exit.
        void bootstrap.ensureReady('startup');
      } catch (error) {
        fatal(
          error instanceof LoaderFatalError
            ? error
            : new LoaderFatalError(
                `the loader cannot listen on 127.0.0.1:${String(config.httpPort)}: ${describe(error)}`,
                { cause: error }
              )
        );
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
      // Last: the front door stays open while lifemodel drains, so a person
      // watching the page sees the stop rather than a connection error.
      const caddyLeft = await frontDoor.stop(left());
      if (!caddyLeft) pending.push('caddy (not reaped after SIGKILL by the stop deadline)');
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
