/**
 * ADR-016 §5: one automatic store restart per stranded day. The Deployment's
 * paired annotation maps are both the durable receipt and the rollout request:
 * no file-write/patch crash window can restart a day twice. Keep past days even
 * after a drop, since delayed or replayed failure lines must not restart them.
 */
import { createKubernetesObjectApi, type KubernetesObjectApi } from './logs-volume-claim.js';
import { LOGS_STORE_DEPLOYMENT_PATH } from './logs-settings-cluster.js';
import type { LogsEviction, LogsStore } from './logs-store-adapter.js';
import type { LoaderLogger } from './logger.js';

export const LOGS_STRANDED_DAYS_ANNOTATION = 'lifemodel.dev/logs-stranded-days';
export interface LogsStrandedRecoveryOptions {
  readonly api?: KubernetesObjectApi;
  readonly store: Pick<LogsStore, 'evictions'>;
  readonly logger: Pick<LoaderLogger, 'info' | 'warn'>;
}

/** The newest failure, unless its day has a later acknowledged drop. */
function strandedDay(lines: readonly LogsEviction[]): string | null {
  const failures = lines.filter((line) => line.freedBytes === null);
  const newest = [...failures].sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
  if (newest?.reason !== 'stranded_partition' || newest.day === null) return null;
  if (!/^\d{8}$/.test(newest.day) || !Number.isFinite(Date.parse(newest.time))) return null;
  const dropped = lines.some(
    (line) =>
      line.day === newest.day &&
      line.freedBytes !== null &&
      Date.parse(line.time) >= Date.parse(newest.time)
  );
  return dropped ? null : newest.day;
}

interface Deployment {
  metadata?: { resourceVersion?: string; annotations?: Record<string, string> };
  spec?: { template?: { metadata?: { annotations?: Record<string, string> } } };
}

export function createLogsStrandedRecovery(options: LogsStrandedRecoveryOptions): {
  reconcile(): Promise<void>;
} {
  const api = options.api ?? createKubernetesObjectApi();
  async function recover(): Promise<void> {
    const lines = await options.store.evictions();
    if (lines.state !== 'ok') return;
    const day = strandedDay(lines.evictions);
    if (day === null) return;
    const response = await api.get(LOGS_STORE_DEPLOYMENT_PATH);
    if (response.status !== 200) throw new Error('deployment_read_failed');
    const body = JSON.parse(response.body) as Deployment;
    const objectDays = body.metadata?.annotations?.[LOGS_STRANDED_DAYS_ANNOTATION] ?? '';
    const templateDays =
      body.spec?.template?.metadata?.annotations?.[LOGS_STRANDED_DAYS_ANNOTATION] ?? '';
    if (objectDays !== templateDays || (objectDays !== '' && !/^\d{8}(,\d{8})*$/.test(objectDays)))
      throw new Error('invalid_restart_receipt');
    const days = objectDays === '' ? [] : objectDays.split(',');
    if (days.includes(day)) return;
    const resourceVersion = body.metadata?.resourceVersion;
    if (resourceVersion === undefined) throw new Error('missing_resource_version');
    const annotations = { [LOGS_STRANDED_DAYS_ANNOTATION]: [...days, day].join(',') };
    const patched = await api.patch(
      LOGS_STORE_DEPLOYMENT_PATH,
      JSON.stringify({
        metadata: { resourceVersion, annotations },
        spec: { template: { metadata: { annotations } } },
      })
    );
    // A conflicting pass retries by reading the same receipt next time, never
    // by issuing a fresh revision. An unanswered accepted patch is safe too.
    if (patched.status !== 200) throw new Error('deployment_patch_failed');
    options.logger.info({ day }, 'the log store will restart for a stranded partition');
  }
  return {
    async reconcile() {
      try {
        await recover();
      } catch {
        options.logger.warn(
          { code: 'stranded_recovery_failed' },
          'the log store stranded partition recovery did not finish'
        );
      }
    },
  };
}
