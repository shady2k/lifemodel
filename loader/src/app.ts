/**
 * The loader, wired (lifemodel-q4x.2.1).
 *
 * One place decides what a fatal failure is: an input the loader needs and
 * does not have (the seed bundle, a writable volume, its port) is said in one
 * line, with its cause, and then the loader leaves with a non-zero code. It
 * never falls back to something else quietly.
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
        // The front door first: it is what the owner reaches, and it must be
        // up while lifemodel is still being seeded, built or panicked.
        await frontDoor.start();
        http = createLoaderHttp({ state, supervisor, bootstrap, logger, clock, fatal });
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
        void bootstrap.ensureReady('startup').catch(fatal);
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
      logger.info({ reason }, 'the loader is stopping');
      await http?.close();
      // The supervisor already said it in one line when the drain ran out;
      // the code below is what the container leaves with, not a second line.
      const outcome = await supervisor.stop('shutdown');
      // Last: the front door stays open while lifemodel drains, so a person
      // watching the page sees the stop rather than a connection error.
      await frontDoor.stop();
      return outcome.drainTimedOut ? 1 : 0;
    },
  };
}
