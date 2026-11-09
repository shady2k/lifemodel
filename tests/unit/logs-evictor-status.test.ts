/**
 * The evictor's last successful run (ADR-016 §5, check L14).
 *
 * One named CronJob, read with one `get`. A CronJob that does not exist yet has
 * never succeeded; any other failure is thrown, so the page says nothing rather
 * than blaming a working evictor.
 */
import { describe, expect, it } from 'vitest';
import {
  LOGS_EVICTOR_NAME,
  LOGS_EVICTOR_PATH,
  createLogsEvictorStatus,
} from '../../loader/src/logs-evictor-status.js';
import type {
  KubernetesObjectApi,
  KubernetesObjectResponse,
} from '../../loader/src/logs-volume-claim.js';

function api(answer: KubernetesObjectResponse | (() => never)): {
  calls: string[];
  api: KubernetesObjectApi;
} {
  const calls: string[] = [];
  return {
    calls,
    api: {
      get: async (path) => {
        calls.push(path);
        if (typeof answer === 'function') return answer();
        return answer;
      },
      patch: async () => {
        throw new Error('the evictor read must never patch');
      },
    },
  };
}

function cronJob(status: Record<string, unknown> | undefined): KubernetesObjectResponse {
  return {
    status: 200,
    body: JSON.stringify({
      kind: 'CronJob',
      metadata: { name: LOGS_EVICTOR_NAME },
      ...(status === undefined ? {} : { status }),
    }),
  };
}

describe('the evictor CronJob read (ADR-016 §5)', () => {
  it('reads the last successful time of that one CronJob', async () => {
    const { api: client, calls } = api(
      cronJob({
        lastSuccessfulTime: '2026-11-07T10:59:00Z',
        lastScheduleTime: '2026-11-07T11:00:00Z',
      })
    );
    const status = createLogsEvictorStatus({ api: client });
    expect(await status.lastSuccessAt()).toBe('2026-11-07T10:59:00Z');
    expect(calls).toEqual([LOGS_EVICTOR_PATH]);
    expect(LOGS_EVICTOR_PATH).toBe(
      '/apis/batch/v1/namespaces/lifemodel-system/cronjobs/logs-evictor'
    );
  });

  it('says never succeeded when the CronJob has no status yet', async () => {
    const { api: client } = api(cronJob(undefined));
    expect(await createLogsEvictorStatus({ api: client }).lastSuccessAt()).toBeNull();
    const noField = api(cronJob({ lastScheduleTime: '2026-11-07T11:00:00Z' }));
    expect(await createLogsEvictorStatus({ api: noField.api }).lastSuccessAt()).toBeNull();
  });

  it('says never succeeded when the CronJob does not exist yet', async () => {
    const { api: client } = api({ status: 404, body: 'not found' });
    expect(await createLogsEvictorStatus({ api: client }).lastSuccessAt()).toBeNull();
  });

  it('throws when the read is refused, so the page blames nobody', async () => {
    const { api: client } = api({ status: 403, body: 'forbidden' });
    await expect(createLogsEvictorStatus({ api: client }).lastSuccessAt()).rejects.toThrow(
      /CronJob logs-evictor read failed \(403\)/
    );
  });
});
