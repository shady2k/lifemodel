/**
 * The front door (lifemodel-q4x.2.1, decision 13).
 *
 * Caddy is the only web entrance: `boot.<host>` to the loader, the root host
 * to lifemodel, `vault.<host>` to Agent Vault, every one of them checked
 * against the loader's session. The loader owns it as it owns lifemodel - it
 * is part of the trusted layer - with one difference that matters: it is
 * INDEPENDENT of lifemodel. A panicked, stopped or rebuilding lifemodel must
 * not take the login page with it, so Caddy is started before lifemodel, is
 * never stopped by panic, and is only stopped when the container itself stops.
 */
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { ProcessLauncher, SpawnedProcess } from './exec.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';
import { describe } from './state.js';

export interface FrontDoorDeps {
  launcher: ProcessLauncher;
  fs: FileSystem;
  logger: LoaderLogger;
  clock: Clock;
  config: LoaderConfig;
}

export interface FrontDoor {
  /** Bring Caddy up. A missing binary or configuration is a fatal input. */
  start(): Promise<void>;
  /**
   * Stop Caddy, and never wait longer than the budget the caller has left of
   * the stop's own deadline (rework 2, finding 10). At zero the front door is
   * killed rather than waited for: the container is leaving.
   */
  stop(budgetMs?: number): Promise<void>;
  status(): { running: boolean; pid: number | null; restarts: number };
}

export function createFrontDoor(deps: FrontDoorDeps): FrontDoor {
  const { launcher, fs, logger, clock, config } = deps;

  let child: SpawnedProcess | null = null;
  let pid: number | null = null;
  let startedAt: number | null = null;
  let restarts = 0;
  let consecutiveFailures = 0;
  let stopping = false;
  let epoch = 0;

  async function start(): Promise<void> {
    if (child !== null) return;
    if (!(await fs.exists(config.caddy.binary))) {
      throw new LoaderFatalError(
        `the front door is missing: there is no caddy at ${config.caddy.binary}, so no host of the instance can be reached`
      );
    }
    if (!(await fs.exists(config.caddy.config))) {
      throw new LoaderFatalError(
        `the front door has no configuration at ${config.caddy.config}: Caddy cannot route boot., the root host and vault.`
      );
    }
    const spawned = launcher.spawn(
      config.caddy.binary,
      ['run', '--config', config.caddy.config, '--adapter', 'caddyfile'],
      { cwd: config.volumeRoot, env: process.env }
    );
    child = spawned;
    pid = spawned.pid ?? null;
    startedAt = clock.now();
    const scheduledEpoch = epoch;
    spawned.onExit((code, signal) => {
      if (child !== spawned) return;
      const ranMs = startedAt === null ? 0 : clock.now() - startedAt;
      child = null;
      pid = null;
      startedAt = null;
      if (stopping || scheduledEpoch !== epoch) return;
      logger.warn({ code, signal, ranMs }, 'caddy exited');
      scheduleRestart(ranMs);
    });
    spawned.onError((error) => {
      logger.error({ error: describe(error) }, 'caddy could not be started');
    });
    logger.info({ pid, config: config.caddy.config }, 'caddy is up: the front door is open');
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
    logger.info({ delayMs: delay }, 'caddy is started again after a backoff');
    void (async () => {
      await clock.sleep(delay);
      if (stopping || scheduledEpoch !== epoch) return;
      await start();
    })();
  }

  async function stop(budgetMs: number = config.caddy.stopWaitMs): Promise<void> {
    epoch += 1;
    stopping = true;
    const current = child;
    if (current === null) {
      stopping = false;
      return;
    }
    const waitMs = Math.min(config.caddy.stopWaitMs, Math.max(0, budgetMs));
    logger.info({ pid }, 'stopping caddy');
    const exited = new Promise<boolean>((resolve) => {
      current.onExit(() => {
        resolve(true);
      });
    });
    current.kill('SIGTERM');
    const left = await Promise.race([exited, clock.sleep(waitMs).then(() => false)]);
    if (!left) {
      logger.warn({ pid }, `caddy did not leave within ${String(waitMs)} ms: it is killed`);
      current.kill('SIGKILL');
      await exited;
    }
    child = null;
    pid = null;
    stopping = false;
  }

  return {
    start,
    stop,
    status: () => ({ running: child !== null, pid, restarts }),
  };
}
