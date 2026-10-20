/** Platform bootstrap loader wiring (ADR-010, platform step A0). */
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import type { CommandRunner } from './exec.js';
import type { FileSystem } from './fs.js';
import { createLoaderHttp, type LoaderHttp } from './http.js';
import type { ModelSlots } from './model.js';
import { createPkiManager, type PkiManager } from './pki.js';
import { createKubernetesTlsStores } from './pki-kubernetes.js';
import type { LoaderLogger } from './logger.js';
import { createLoaderState, describe, type LoaderState } from './state.js';
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
import { platformSettings } from './settings/platform.js';
import { createKubernetesSettingsProjection } from './settings/projection.js';
import {
  createSettingsStore,
  type SettingsProjection,
  type SettingsStore,
} from './settings/store.js';
import { createKubernetesPostgresSecretPhase } from './postgres.js';
import { createKubernetesValkeySecretPhase } from './valkey.js';
import { createKubernetesS3IdentitySecret, createStorageCustodyPhase } from './storage-custody.js';
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
  logger: LoaderLogger;
  clock: Clock;
  exit(code: number): void;
  openBao?: { api: BaoApi; custody: BaoCustody };
  platformPhaseStore?: PlatformPhaseStore;
  platformGiteaPhases?: PlatformPhase[];
  platformGiteaApi?: GiteaApi;
  platformBootstrap?: { runInitial(): Promise<void>; unsealIfSealed(): Promise<void> };
  /** The SeaweedFS S3 custody phase (ADR-015 S-D1); tests replace it. */
  platformStorageCustody?: PlatformPhase;
  pki?: PkiManager;
  settingsProjection?: SettingsProjection;
  settingsStore?: SettingsStore;
}

export interface LoaderApp {
  start(): Promise<void>;
  port(): number;
  host(): string | null;
  shutdown(reason: string): Promise<number>;
  state: LoaderState;
}

export function createLoaderApp(deps: LoaderAppDeps): LoaderApp {
  const { config, fs, runner, logger, clock } = deps;
  const state = createLoaderState({ fs, config, logger });
  const tlsStores = createKubernetesTlsStores();
  const pki = deps.pki ?? createPkiManager({ config, fs, clock, ...tlsStores });
  const phaseStore = deps.platformPhaseStore ?? createKubernetesPhaseStore();
  const bao = deps.openBao ?? {
    api: createOpenBaoApi({
      address: config.openBaoAddress,
      role: 'loader',
      logger,
      now: () => clock.now(),
    }),
    custody: createKubernetesBaoCustody(),
  };
  const giteaApi = deps.platformGiteaApi ?? {
    ...createGiteaHttpApi({
      address: 'http://gitea-http.lifemodel-git.svc:3000',
      seedBundle: '/opt/lifemodel/seed.bundle',
      runner,
    }),
    ensureAdminSecret: createKubernetesGiteaAdminSecret(),
  };
  const giteaBootstrap = createGiteaBootstrap({
    api: giteaApi,
    runPhases: createPlatformPhaseRunner(phaseStore),
  });
  const platformStorageCustody =
    deps.platformStorageCustody ??
    createStorageCustodyPhase({
      bao: {
        read: () => bao.api.readStorageCustody(),
        write: (value) => bao.api.writeStorageCustody(value),
      },
      identity: createKubernetesS3IdentitySecret(),
    });
  const platformBootstrap =
    deps.platformBootstrap ??
    (() => {
      const bootstrap = createOpenBaoBootstrap({
        bao: bao.api,
        custody: bao.custody,
        runPhases: createPlatformPhaseRunner(phaseStore),
        extraPhases: deps.platformGiteaPhases ?? [
          ...giteaBootstrap.phases(),
          createKubernetesPostgresSecretPhase(),
          createKubernetesValkeySecretPhase(),
          // The SeaweedFS service identity, after the loader holds its own
          // custody-record access (ADR-015 S-D1).
          platformStorageCustody,
        ],
      });
      return {
        runInitial: () => bootstrap.runInitial(),
        unsealIfSealed: () => bootstrap.unsealIfSealed(),
      };
    })();

  const settings: SettingsStore =
    deps.settingsStore ??
    createSettingsStore({
      fs,
      config,
      registry: platformSettings,
      clock,
      logger,
      projection: deps.settingsProjection ?? createKubernetesSettingsProjection(),
    });
  const modelSlots: ModelSlots = {
    read: (slot) => bao.api.readModelSlot(slot),
    write: (slot, value) => bao.api.writeModelSlot(slot, value),
    clearReserve: () => bao.api.deleteModelReserve(),
  };
  let http: LoaderHttp | null = null;
  let stopping = false;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  /** A failed settings projection is retried for the loader's whole life; never fatal. */
  async function projectSettingsUntilStopped(): Promise<void> {
    await settings.projectNow();
    while (!stopping) {
      await Promise.race([clock.sleep(30_000), stopped]);
      if (stopping) return;
      if (settings.section().projection.state === 'failed') await settings.projectNow();
    }
  }

  async function renewPkiUntilStopped(): Promise<void> {
    while (!stopping) {
      await Promise.race([clock.sleep(24 * 60 * 60 * 1000), stopped]);
      if (stopping) return;
      try {
        await pki.bootstrap();
        await pki.report();
        logger.info({}, 'loader TLS certificate renewal check completed');
      } catch (error) {
        logger.error({ error: describe(error) }, 'loader TLS certificate renewal failed');
      }
    }
  }

  async function bootstrapUntilStopped(): Promise<void> {
    let delayMs = 1_000;
    while (!stopping) {
      try {
        await platformBootstrap.runInitial();
        await platformBootstrap.unsealIfSealed();
        logger.info({}, 'platform bootstrap is ready');
        delayMs = 30_000;
      } catch (error) {
        let phase = 'unknown';
        try {
          const record = await phaseStore.read();
          if (record?.status === 'failed') phase = record.phase;
        } catch {
          /* Keep the original bootstrap failure visible. */
        }
        logger.error(
          { error: describe(error), phase },
          `platform bootstrap failed during ${phase}; retrying in ${String(delayMs)} ms`
        );
        await Promise.race([clock.sleep(delayMs), stopped]);
        delayMs = Math.min(delayMs * 2, 30_000);
        continue;
      }
      await Promise.race([clock.sleep(delayMs), stopped]);
    }
  }

  return {
    state,
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
      if (http !== null) return;
      try {
        await state.ensureLayout();
        try {
          await pki.bootstrap();
          await pki.report();
        } catch (error) {
          try {
            await pki.report();
          } catch {
            /* preserve original fail-closed cause */
          }
          throw error;
        }
        await settings.load();
        http = createLoaderHttp({ state, logger, clock, pki, config, modelSlots, settings });
        await new Promise<void>((resolve, reject) => {
          const server = http?.server;
          if (server === undefined) {
            reject(new Error('loader HTTP server is unavailable'));
            return;
          }
          server.once('error', reject);
          server.listen(config.httpPort, '0.0.0.0', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        logger.info({ port: config.httpPort, volume: config.volumeRoot }, 'platform loader is up');
        void bootstrapUntilStopped();
        void renewPkiUntilStopped();
        void projectSettingsUntilStopped();
      } catch (error) {
        logger.error({ error: describe(error) }, 'the platform loader could not start');
        deps.exit(1);
        throw error;
      }
    },
    shutdown: async (reason: string) => {
      stopping = true;
      resolveStop();
      logger.info({ reason }, 'platform loader is stopping');
      if (http !== null) await http.close();
      return 0;
    },
  };
}
