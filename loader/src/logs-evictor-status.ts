/**
 * The log evictor's last successful run (ADR-016 §5; check L14).
 *
 * The page names `the log evictor is failing or has not run` only when the
 * CronJob's `status.lastSuccessfulTime` is older than about two minutes. This
 * reads exactly one named object through the client `logs-volume-claim.ts`
 * already uses; the loader's Role grants `get` on that one CronJob and nothing
 * wider (`deploy/platform/a0/logs-evictor-rbac.yaml`).
 */
import {
  createKubernetesObjectApi,
  type KubernetesObjectApi,
  type KubernetesObjectApiOptions,
} from './logs-volume-claim.js';
import type { LogsEvictorStatus } from './logs-status.js';

export const LOGS_EVICTOR_NAME = 'logs-evictor';
export const LOGS_EVICTOR_NAMESPACE = 'lifemodel-system';
/** The one object the loader may read, and the path it is read at. */
export const LOGS_EVICTOR_PATH = `/apis/batch/v1/namespaces/${LOGS_EVICTOR_NAMESPACE}/cronjobs/${LOGS_EVICTOR_NAME}`;

export interface LogsEvictorStatusOptions extends KubernetesObjectApiOptions {
  api?: KubernetesObjectApi;
}

interface CronJob {
  status?: { lastSuccessfulTime?: unknown };
}

/**
 * `status.lastSuccessfulTime` as the API wrote it, or null when the CronJob has
 * never completed a run. A refused or failed read throws: the page then says
 * nothing rather than blaming a working evictor.
 */
export function createLogsEvictorStatus(options: LogsEvictorStatusOptions = {}): LogsEvictorStatus {
  const api = options.api ?? createKubernetesObjectApi(options);
  return {
    async lastSuccessAt() {
      const response = await api.get(LOGS_EVICTOR_PATH);
      // The CronJob arrives with the logs step; before it exists no run has
      // succeeded.
      if (response.status === 404) return null;
      if (response.status !== 200)
        throw new Error(
          `Kubernetes CronJob ${LOGS_EVICTOR_NAME} read failed (${String(response.status)}): ${response.body}`
        );
      const time = (JSON.parse(response.body) as CronJob).status?.lastSuccessfulTime;
      return typeof time === 'string' ? time : null;
    },
  };
}
