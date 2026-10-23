import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PlatformSettingsReader } from '../config/platform-settings.js';
import type {
  AcceptTask,
  TaskAccessIntent,
  TaskAccessMode,
  TaskAllocationReceipt,
  TaskProfile,
  TaskRecord,
  TaskRegistry,
} from '../ports/tasks.js';
import { TaskRegistryError } from '../ports/tasks.js';
import { createFencedPostgres, StalePostgresEpochError } from './fenced-postgres.js';

interface TaskRow {
  id: string;
  launch_key: string;
  briefing: string;
  profile: TaskProfile;
  settings_revision: string;
  harness: TaskRecord['harness'];
  image_revision: string;
  wrap_grace_seconds: number;
  accepted_order: string;
  urgent: boolean;
  state: TaskRecord['state'];
  terminal_candidate: TaskRecord['terminalCandidate'];
  terminal_reason_code: string | null;
  finalization_pending: boolean;
  accepted_at: Date;
  updated_at: Date;
  started_at: Date | null;
  terminal_at: Date | null;
  attempt_id: string;
  launch_id: string;
  job_name: string;
  job_uid: string | null;
  template_hash: string | null;
  allocation_receipt: TaskAllocationReceipt | null;
  cleanup_pending: boolean;
  soft_stop_requested_at: Date | null;
  pod_uid: string | null;
  tombstoned_at: Date | null;
  slot_reserved: boolean;
}
interface IntentRow {
  task_id: string;
  attempt_id: string;
  launch_id: string;
  revision: string;
  mode: TaskAccessMode;
  soft_due_at: Date;
  hard_stop_at: Date;
}

const TASK_SELECT = `SELECT t.*, l.attempt_id,l.launch_id,l.job_name,l.job_uid,l.pod_uid,
  l.template_hash,l.allocation_receipt,l.cleanup_pending,l.soft_stop_requested_at,
  l.tombstoned_at,l.slot_reserved FROM core.tasks t JOIN core.task_launches l ON l.task_id=t.id`;

function taskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    launchKey: row.launch_key,
    briefing: row.briefing,
    profile: row.profile,
    settingsRevision: Number(row.settings_revision),
    harness: row.harness,
    imageRevision: row.image_revision,
    wrapGraceSeconds: row.wrap_grace_seconds,
    acceptedOrder: row.accepted_order,
    urgent: row.urgent,
    state: row.state,
    terminalCandidate: row.terminal_candidate,
    terminalReasonCode: row.terminal_reason_code,
    finalizationPending: row.finalization_pending,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    attemptId: row.attempt_id,
    launchId: row.launch_id,
    jobName: row.job_name,
    jobUid: row.job_uid,
    templateHash: row.template_hash,
    allocationReceipt: row.allocation_receipt,
    cleanupPending: row.cleanup_pending,
    softStopRequestedAt: row.soft_stop_requested_at,
    podUid: row.pod_uid,
    tombstonedAt: row.tombstoned_at,
    slotReserved: row.slot_reserved,
  };
}
function intentRecord(row: IntentRow): TaskAccessIntent {
  return {
    taskId: row.task_id,
    attemptId: row.attempt_id,
    launchId: row.launch_id,
    revision: row.revision,
    mode: row.mode,
    softDueAt: row.soft_due_at,
    hardStopAt: row.hard_stop_at,
  };
}
function taskIdentity(launchKey: string): {
  id: string;
  attemptId: string;
  launchId: string;
  jobName: string;
} {
  const digest = (domain: string) =>
    createHash('sha256').update(domain).update('\0').update(launchKey).digest('hex');
  const launchHash = digest('task-launch-v1');
  return {
    id: `task_${digest('task-v1')}`,
    attemptId: `attempt_${digest('task-attempt-v1')}`,
    launchId: `launch_${launchHash}`,
    jobName: `task-${launchHash.slice(0, 58)}`,
  };
}
function finiteDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function validateInput(request: AcceptTask, taskId: string): void {
  const profile = request.profile;
  if (
    typeof request.launchKey !== 'string' ||
    request.launchKey.length === 0 ||
    request.launchKey.length > 512 ||
    typeof request.briefing !== 'string' ||
    request.briefing.trim().length === 0 ||
    !profile ||
    typeof profile.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profile.id) ||
    typeof profile.revision !== 'string' ||
    profile.revision.length === 0 ||
    profile.revision.length > 128 ||
    ![profile.timeoutSeconds, profile.cpuMillis, profile.memoryBytes].every(
      (n) => Number.isSafeInteger(n) && n > 0
    ) ||
    profile.timeoutSeconds > Math.floor(8_640_000_000_000_000 / 1000 / 2) ||
    typeof request.imageRevision !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(request.imageRevision)
  ) {
    throw new TaskRegistryError(taskId, 'invalid_input');
  }
}

/** Core-only writer. It owns no pool lifetime, filesystem state or platform metadata. */
export function createPostgresTaskRegistry(deps: {
  pool: Pool;
  epoch: number;
  settings: PlatformSettingsReader;
  /** Deployment image is a first-acceptance snapshot, not replay payload. */
  imageRevision?: string;
  /** Cancels only this registry instance's operations and checked-out clients. */
  signal?: AbortSignal;
  /** Bounds settings reads and SQL including acquisition/holder lock and admission's settings read. */
  operationTimeoutMs?: number;
}): TaskRegistry {
  const timeoutMs = deps.operationTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new TaskRegistryError('registry', 'invalid_input');

  async function boundedSettings() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      if (deps.signal?.aborted) throw new TaskRegistryError('registry', 'storage_error');
      return await Promise.race([
        deps.settings.read(),
        new Promise<never>((_resolve, reject) => {
          cancel = () => {
            reject(new TaskRegistryError('registry', 'storage_error'));
          };
          deps.signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(cancel, timeoutMs);
          if (deps.signal?.aborted) cancel();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (cancel) deps.signal?.removeEventListener('abort', cancel);
    }
  }

  async function transaction<T>(
    taskId: string,
    body: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    let raw: PoolClient | undefined;
    let released = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const destroy = () => {
      if (raw && !released) {
        released = true;
        raw.release(true);
      }
    };
    // Always discard this operation's connection. Session limits never leak to
    // another shared-pool borrower, and a timed-out in-flight query cannot retain
    // the holder/admission locks. This also handles COMMIT's unknown-response gap.
    const work = async (): Promise<T> => {
      try {
        raw = await deps.pool.connect();
        if (expired) {
          destroy();
          throw new TaskRegistryError(taskId, 'storage_error');
        }
        raw.on('error', () => undefined);
        // Session configuration only, BEFORE the seam's BEGIN/holder lock.
        // No domain read or write occurs outside the active-holder fence.
        await raw.query("SET lock_timeout='5s'; SET statement_timeout='10s'");
        const acquired = raw;
        const singleConnectionPool = new Proxy(deps.pool, {
          get(target, property) {
            if (property === 'connect') return () => Promise.resolve(acquired);
            return Reflect.get(target, property, target) as unknown;
          },
        });
        const client = await createFencedPostgres(singleConnectionPool, deps.epoch).connect();
        await client.query('BEGIN');
        // Require exact holder identity as well as the seam's stale check.
        const holder = await client.query<{ epoch: string }>(
          'SELECT epoch FROM core.active_holder WHERE id'
        );
        const epoch = Number(holder.rows[0]?.epoch);
        if (epoch !== deps.epoch)
          throw new StalePostgresEpochError(deps.epoch, Number.isFinite(epoch) ? epoch : null);
        const result = await body(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (error instanceof TaskRegistryError || error instanceof StalePostgresEpochError)
          throw error;
        // Never attach pg error/cause: it may contain private row/parameter data.
        throw new TaskRegistryError(taskId, 'storage_error');
      } finally {
        destroy();
      }
    };
    try {
      if (deps.signal?.aborted) throw new TaskRegistryError(taskId, 'storage_error');
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          cancel = () => {
            expired = true;
            destroy();
            reject(new TaskRegistryError(taskId, 'storage_error'));
          };
          deps.signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(cancel, timeoutMs);
          if (deps.signal?.aborted) cancel();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (cancel) deps.signal?.removeEventListener('abort', cancel);
    }
  }
  async function readTask(client: Pool | PoolClient, taskId: string): Promise<TaskRecord | null> {
    const result = await client.query<TaskRow>(`${TASK_SELECT} WHERE t.id=$1`, [taskId]);
    return result.rows[0] ? taskRecord(result.rows[0]) : null;
  }
  async function readIntent(
    client: Pool | PoolClient,
    taskId: string
  ): Promise<TaskAccessIntent | null> {
    const result = await client.query<IntentRow>(
      'SELECT * FROM task_access.intents WHERE task_id=$1',
      [taskId]
    );
    return result.rows[0] ? intentRecord(result.rows[0]) : null;
  }
  async function lockTask(client: PoolClient, taskId: string): Promise<TaskRecord> {
    await client.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [taskId]);
    const task = await readTask(client, taskId);
    if (!task) throw new TaskRegistryError(taskId, 'not_found');
    return task;
  }
  async function lockLaunch(
    client: PoolClient,
    taskId: string,
    launchId: string
  ): Promise<TaskRecord> {
    const task = await lockTask(client, taskId);
    if (task.launchId !== launchId) throw new TaskRegistryError(taskId, 'intent_conflict');
    return task;
  }
  function requireLaunchable(task: TaskRecord): void {
    if (
      task.state !== 'starting' ||
      !task.slotReserved ||
      task.tombstonedAt ||
      task.softStopRequestedAt ||
      task.terminalCandidate
    )
      throw new TaskRegistryError(task.id, 'invalid_transition');
  }
  async function rereadTask(client: PoolClient, taskId: string): Promise<TaskRecord> {
    const task = await readTask(client, taskId);
    if (!task) throw new TaskRegistryError(taskId, 'storage_error');
    return task;
  }
  return {
    accept: async (request) => {
      const identity = taskIdentity(typeof request.launchKey === 'string' ? request.launchKey : '');
      validateInput(request, identity.id);
      const imageRevision = deps.imageRevision ?? request.imageRevision;
      validateInput({ ...request, imageRevision }, identity.id);
      const settings = await boundedSettings();
      return transaction(identity.id, async (client) => {
        // Also serializes accepted-order assignment: commit order cannot invert
        // FIFO when two accepting transactions race the admission dispatcher.
        await client.query('SELECT id FROM core.task_admission WHERE id FOR UPDATE');
        const existing = await client.query<TaskRow>(`${TASK_SELECT} WHERE t.launch_key=$1`, [
          request.launchKey,
        ]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          // Compare JSON structurally in SQL, not JS key/insertion order. Settings
          // are NOT request payload: a replay keeps the original snapshot.
          const match = await client.query<{ matches: boolean }>(
            `SELECT briefing=$2 AND profile=$3::jsonb AND request_image_revision=$4 AS matches FROM core.tasks WHERE id=$1`,
            [row.id, request.briefing, JSON.stringify(request.profile), request.imageRevision]
          );
          if (!match.rows[0]?.matches) throw new TaskRegistryError(row.id, 'launch_key_conflict');
          return taskRecord(row);
        }
        await client.query(
          `INSERT INTO core.tasks(id,launch_key,briefing,profile,settings_revision,harness,image_revision,wrap_grace_seconds,request_image_revision)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
          [
            identity.id,
            request.launchKey,
            request.briefing,
            JSON.stringify(request.profile),
            settings.revision,
            settings.values['tasks.harness'],
            imageRevision,
            settings.values['tasks.wrapGraceSeconds'],
            request.imageRevision,
          ]
        );
        await client.query(
          'INSERT INTO core.task_launches(task_id,attempt_id,launch_id,job_name) VALUES($1,$2,$3,$4)',
          [identity.id, identity.attemptId, identity.launchId, identity.jobName]
        );
        const accepted = await readTask(client, identity.id);
        if (!accepted) throw new TaskRegistryError(identity.id, 'storage_error');
        return accepted;
      });
    },
    read: async (taskId) => transaction(taskId, (client) => readTask(client, taskId)),
    list: async () =>
      transaction('registry', async (client) => {
        const rows = await client.query<TaskRow>(`${TASK_SELECT} ORDER BY t.accepted_order,t.id`);
        return rows.rows.map(taskRecord);
      }),
    listLaunchWork: async (afterOrder = '0', limit = 100) => {
      if (
        typeof afterOrder !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(afterOrder) ||
        BigInt(afterOrder) > 9_223_372_036_854_775_807n ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new TaskRegistryError('registry', 'invalid_input');
      return transaction('registry', async (client) => {
        const rows = await client.query<TaskRow>(
          `${TASK_SELECT} WHERE t.accepted_order>$1::bigint
          AND (t.state NOT IN ('queued','done','failed','stopped') OR l.cleanup_pending)
          ORDER BY t.accepted_order LIMIT $2`,
          [afterOrder, limit]
        );
        return rows.rows.map(taskRecord);
      });
    },
    readByJobName: async (jobName) => {
      if (typeof jobName !== 'string' || !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(jobName))
        throw new TaskRegistryError('registry', 'invalid_input');
      return transaction('registry', async (client) => {
        const result = await client.query<TaskRow>(`${TASK_SELECT} WHERE l.job_name=$1`, [jobName]);
        return result.rows[0] ? taskRecord(result.rows[0]) : null;
      });
    },
    admitNext: async () => {
      return transaction('registry', async (client) => {
        await client.query('SELECT id FROM core.task_admission WHERE id FOR UPDATE');
        // Read policy at the serialized reservation decision, not before a wait
        // on the pool/holder/admission lock. Lowering the cap keeps existing
        // reservations but must prevent a stale waiter spending the old cap.
        const settings = await boundedSettings();
        // The platform declaration permits fractions; floor the upper bound.
        const cap = Math.floor(settings.values['tasks.concurrency']);
        const count = await client.query<{ count: string }>(
          'SELECT count(*) FROM core.task_launches WHERE slot_reserved'
        );
        if (!Number.isSafeInteger(cap) || cap < 1 || Number(count.rows[0]?.count) >= cap)
          return null;
        const next = await client.query<{
          id: string;
        }>(`SELECT t.id FROM core.tasks t JOIN core.task_launches l ON l.task_id=t.id
          WHERE t.state='queued' AND t.terminal_candidate IS NULL AND l.tombstoned_at IS NULL
            AND l.soft_stop_requested_at IS NULL
          ORDER BY t.accepted_order,t.id LIMIT 1 FOR UPDATE OF t,l`);
        const taskId = next.rows[0]?.id;
        if (!taskId) return null;
        await client.query(
          "UPDATE core.tasks SET state='starting',updated_at=clock_timestamp() WHERE id=$1",
          [taskId]
        );
        await client.query('UPDATE core.task_launches SET slot_reserved=true WHERE task_id=$1', [
          taskId,
        ]);
        return readTask(client, taskId);
      });
    },
    recordAllocation: async (taskId, launchId, receipt) => {
      if (
        !receipt ||
        ![receipt.id, receipt.space].every(
          (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
        ) ||
        typeof receipt.effectKey !== 'string' ||
        receipt.effectKey.length === 0 ||
        receipt.effectKey.length > 512
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        const existing = task.allocationReceipt;
        if (existing) {
          if (
            existing.id !== receipt.id ||
            existing.space !== receipt.space ||
            existing.effectKey !== receipt.effectKey
          )
            throw new TaskRegistryError(taskId, 'intent_conflict');
          return task;
        }
        requireLaunchable(task);
        await client.query(
          'UPDATE core.task_launches SET allocation_receipt=$2::jsonb WHERE task_id=$1',
          [
            taskId,
            JSON.stringify({ id: receipt.id, space: receipt.space, effectKey: receipt.effectKey }),
          ]
        );
        return rereadTask(client, taskId);
      });
    },
    bindJob: async (taskId, launchId, jobUid, templateHash) => {
      if (
        typeof jobUid !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobUid) ||
        typeof templateHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(templateHash)
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (task.tombstonedAt || task.softStopRequestedAt || task.terminalCandidate)
          throw new TaskRegistryError(taskId, 'invalid_transition');
        if (task.jobUid !== null || task.templateHash !== null) {
          if (task.jobUid !== jobUid || task.templateHash !== templateHash)
            throw new TaskRegistryError(taskId, 'intent_conflict');
          return task;
        }
        requireLaunchable(task);
        if (!task.allocationReceipt) throw new TaskRegistryError(taskId, 'invalid_transition');
        await client.query(
          'UPDATE core.task_launches SET job_uid=$2,template_hash=$3 WHERE task_id=$1',
          [taskId, jobUid, templateHash]
        );
        return rereadTask(client, taskId);
      });
    },
    tombstoneLaunch: async (taskId, launchId) =>
      transaction(taskId, async (client) => {
        await lockLaunch(client, taskId, launchId);
        await client.query(
          `UPDATE core.task_launches
          SET tombstoned_at=COALESCE(tombstoned_at,clock_timestamp()),cleanup_pending=true
          WHERE task_id=$1`,
          [taskId]
        );
        return rereadTask(client, taskId);
      }),
    completeLaunchCleanup: async (taskId, launchId) =>
      transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (!task.tombstonedAt) throw new TaskRegistryError(taskId, 'invalid_transition');
        await client.query('UPDATE core.task_launches SET cleanup_pending=false WHERE task_id=$1', [
          taskId,
        ]);
      }),
    recordSoftStop: async (taskId, launchId) =>
      transaction(taskId, async (client) => {
        await lockLaunch(client, taskId, launchId);
        await client.query(
          `UPDATE core.task_launches
          SET soft_stop_requested_at=COALESCE(soft_stop_requested_at,clock_timestamp()) WHERE task_id=$1`,
          [taskId]
        );
      }),
    releaseSlot: async (taskId) =>
      transaction(taskId, async (client) => {
        await client.query('SELECT id FROM core.task_admission WHERE id FOR UPDATE');
        await lockTask(client, taskId);
        await client.query('UPDATE core.task_launches SET slot_reserved=false WHERE task_id=$1', [
          taskId,
        ]);
      }),
    initializeAccessIntent: async (taskId, jobStartedAt) => {
      if (!finiteDate(jobStartedAt)) throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockTask(client, taskId);
        const existing = await readIntent(client, taskId);
        if (existing) {
          if (task.startedAt?.getTime() !== jobStartedAt.getTime())
            throw new TaskRegistryError(taskId, 'intent_conflict');
          return existing;
        }
        if (
          task.state !== 'starting' ||
          task.tombstonedAt ||
          task.softStopRequestedAt ||
          task.terminalCandidate ||
          !task.slotReserved
        )
          throw new TaskRegistryError(taskId, 'invalid_transition');
        const softDueAt = new Date(jobStartedAt.getTime() + task.profile.timeoutSeconds * 1000);
        const hardStopAt = new Date(softDueAt.getTime() + task.wrapGraceSeconds * 1000);
        if (!finiteDate(softDueAt) || !finiteDate(hardStopAt))
          throw new TaskRegistryError(taskId, 'invalid_input');
        await client.query(
          `INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at)
          VALUES($1,$2,$3,0,'active',$4,$5)`,
          [task.id, task.attemptId, task.launchId, softDueAt, hardStopAt]
        );
        await client.query(
          'UPDATE core.tasks SET started_at=$2,updated_at=clock_timestamp() WHERE id=$1',
          [taskId, jobStartedAt]
        );
        const initialized = await readIntent(client, taskId);
        if (!initialized) throw new TaskRegistryError(taskId, 'storage_error');
        return initialized;
      });
    },
    readAccessIntent: async (taskId) => transaction(taskId, (client) => readIntent(client, taskId)),
    advanceAccessIntent: async (taskId, change) => {
      if (
        !['active', 'wrapping', 'revoked'].includes(change.mode) ||
        !finiteDate(change.softDueAt) ||
        !finiteDate(change.hardStopAt) ||
        change.hardStopAt < change.softDueAt
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        await lockTask(client, taskId);
        // Lock the stable authority row itself, in addition to serializing core
        // writers on task. Readers' FOR SHARE guard conflicts with this UPDATE.
        const result = await client.query<IntentRow>(
          'SELECT * FROM task_access.intents WHERE task_id=$1 FOR UPDATE',
          [taskId]
        );
        const intent = result.rows[0];
        if (!intent) throw new TaskRegistryError(taskId, 'not_found');
        if (
          (intent.mode === 'revoked' && change.mode !== 'revoked') ||
          (intent.mode === 'wrapping' && change.mode === 'active') ||
          change.softDueAt > intent.soft_due_at ||
          change.hardStopAt > intent.hard_stop_at
        )
          throw new TaskRegistryError(taskId, 'intent_conflict');
        const updated = await client.query<IntentRow>(
          `UPDATE task_access.intents SET revision=revision+1,mode=$2,soft_due_at=$3,hard_stop_at=$4
          WHERE task_id=$1 RETURNING *`,
          [taskId, change.mode, change.softDueAt, change.hardStopAt]
        );
        const intentRow = updated.rows[0];
        if (!intentRow) throw new TaskRegistryError(taskId, 'storage_error');
        return intentRecord(intentRow);
      });
    },
  };
}
