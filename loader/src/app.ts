/** Platform bootstrap loader wiring (ADR-010, platform step A0). */
import type { Clock } from './clock.js';
import { join } from 'node:path';
import {
  createZotCustodyPhase,
  createKubernetesZotIdentitySecret,
  parseZotCredential,
} from './zot-custody.js';
import { createWorkbenchImportPhase } from './workbench-import.js';
import { DEFAULT_WORKBENCH_SOURCE } from './workbench-source.js';
import { createWorkbenchImportTask, type WorkbenchImportTask } from './workbench-task.js';
import type { LoaderConfig } from './config.js';
import type { CommandRunner } from './exec.js';
import type { FileSystem } from './fs.js';
import { createLoaderHttp, type LoaderHttp } from './http.js';
import type { ModelSlots } from './model.js';
import {
  createPkiManager,
  STORAGE_MODULE_TLS_HOSTS,
  TASK_MODEL_TLS_HOSTS,
  TASK_CHANNEL_TLS_HOSTS,
  type PkiManager,
} from './pki.js';
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
  PlatformPhaseError,
  type PlatformPhaseStore,
  type PlatformPhase,
} from './platform-bootstrap.js';
import { platformSettings } from './settings/platform.js';
import { createPlatformSettingsProjection } from './settings/projection.js';
import {
  createSettingsStore,
  type SettingsProjection,
  type SettingsStore,
} from './settings/store.js';
import {
  createKubernetesPostgresSecretPhase,
  createKubernetesCaptureSecretPhase,
} from './postgres.js';
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
  workbenchTask?: WorkbenchImportTask;
}

export interface FirstStartPhaseDeps {
  gitea: PlatformPhase[];
  storageCustody: PlatformPhase;
  zotCustody: PlatformPhase;
  postgres?: PlatformPhase;
  valkey?: PlatformPhase;
  capture?: PlatformPhase;
}

/**
 * The loader's first-start phase order after OpenBao's policy phase
 * (ADR-010 R7-02, ADR-015 S-D1).
 *
 * Seaweed and zot custody need only OpenBao and their platform Secrets.
 * Workbench import is independent background work: a source outage must not
 * hold application source creation. Core checks zot before task admission.
 * None of these custody phases waits for C. The Postgres and Valkey
 * credential phases copy
 * Secrets that only exist once `lifemodel-state` (platform C) has run.
 *
 * The storage module lives in its own step after C (platform D, ADR-015 S-D1)
 * and its readiness reads this custody record, so the record must land before
 * that step can finish. Keeping the phase first means a fresh installation gets
 * it from the step that needs only A, not from behind a wait in C that the
 * module itself is one step further away from.
 */
export function platformFirstStartPhases(deps: FirstStartPhaseDeps): PlatformPhase[] {
  return [
    deps.storageCustody,
    deps.zotCustody,
    ...deps.gitea,
    deps.postgres ?? createKubernetesPostgresSecretPhase(),
    deps.valkey ?? createKubernetesValkeySecretPhase(),
    deps.capture ?? createKubernetesCaptureSecretPhase(),
  ];
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
  const pki =
    deps.pki ??
    createPkiManager({
      config,
      fs,
      clock,
      secret: tlsStores.secret,
      configMap: tlsStores.configMap,
      status: tlsStores.status,
      // The storage module's task listener is reached in-cluster only, so its
      // leaf lives in its own Secret with its own DNS names (ADR-015 S-D1).
      service: { hosts: STORAGE_MODULE_TLS_HOSTS, secret: tlsStores.serviceSecret },
      taskModelService: { hosts: TASK_MODEL_TLS_HOSTS, secret: tlsStores.taskModelSecret },
      taskChannelService: { hosts: TASK_CHANNEL_TLS_HOSTS, secret: tlsStores.taskChannelSecret },
    });
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
        extraPhases:
          deps.platformGiteaPhases ??
          platformFirstStartPhases({
            gitea: giteaBootstrap.phases(),
            storageCustody: platformStorageCustody,
            zotCustody: createZotCustodyPhase({
              bao: {
                read: () => bao.api.readRegistryCustody(),
                write: (value) => bao.api.writeRegistryCustody(value),
              },
              identity: createKubernetesZotIdentitySecret(),
            }),
          }),
      });
      return bootstrap;
    })();

  const settings: SettingsStore =
    deps.settingsStore ??
    createSettingsStore({
      fs,
      config,
      registry: platformSettings,
      clock,
      logger,
      projection: deps.settingsProjection ?? createPlatformSettingsProjection(),
    });
  const readWorkbenchSource = async () =>
    (await bao.api.readWorkbenchSource()) ?? { ...DEFAULT_WORKBENCH_SOURCE };
  const workbenchTask =
    deps.workbenchTask ??
    createWorkbenchImportTask({
      fs,
      config,
      clock,
      logger,
      pinnedDigest: process.env['LIFEMODEL_WORKBENCH_DIGEST'] ?? '',
      run: (signal) =>
        createWorkbenchImportPhase({
          pinnedDigest: process.env['LIFEMODEL_WORKBENCH_DIGEST'] ?? '',
          readSource: readWorkbenchSource,
          readCredential: async () => parseZotCredential(await bao.api.readRegistryCustody()),
          tempDirectory: join(config.volumeRoot, 'workbench-import'),
          signal,
        }).run(),
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
        // A named failure states its own phase: a precondition checked before
        // the plan runs has no failed phase record to read (ADR-015 S-D1).
        const named = error instanceof PlatformPhaseError ? error.phase : undefined;
        let phase = named ?? 'unknown';
        try {
          const record = await phaseStore.read();
          if (named === undefined && record?.status === 'failed') phase = record.phase;
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
        http = createLoaderHttp({
          state,
          logger,
          clock,
          pki,
          config,
          modelSlots,
          modelCapture: {
            read: () => bao.api.readCapture(),
            write: (value) => bao.api.writeCapture(value),
          },
          settings,
          workbench: {
            read: readWorkbenchSource,
            write: (value) => bao.api.writeWorkbenchSource(value),
            status: () => Promise.resolve(workbenchTask.status()),
            retrigger: () => workbenchTask.trigger(),
          },
        });
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
        // Start an independent worker. Its failures retry and never hold first start.
        await workbenchTask.start();
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
      await workbenchTask.stop();
      if (http !== null) await http.close();
      return 0;
    },
  };
}
