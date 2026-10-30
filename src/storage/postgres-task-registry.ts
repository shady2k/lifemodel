import { createHash } from 'node:crypto';
import { Client, type Pool, type PoolClient } from 'pg';
import type { PlatformSettingsReader } from '../config/platform-settings.js';
import type {
  AcceptTask,
  TaskContextEntry,
  TaskContextSnapshot,
  TaskAccessIntent,
  TaskAccessMode,
  TaskAllocationReceipt,
  TaskProfile,
  TaskRecord,
  TaskRegistry,
  TaskSealRequest,
  TaskSealReceipt,
  TaskOutcomeEvent,
} from '../ports/tasks.js';
import { TaskRegistryError, TASK_CONTEXT_LIMITS } from '../ports/tasks.js';
import type { TaskTerminalReport } from '../ports/task-channel.js';
import { taskCommandDeliverySql, taskAttemptEndedSql } from './task-command-delivery.js';
import { createFencedPostgres, StalePostgresEpochError } from './fenced-postgres.js';

interface TaskRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
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
  startup_phase: NonNullable<TaskRecord['startup']>['phase'] | null;
  startup_since: Date | null;
  terminal_candidate: TaskRecord['terminalCandidate'];
  terminal_reason_code: string | null;
  finalization_pending: boolean;
  terminal_summary: string | null;
  candidate_revision: string;
  finalization_failure_code: string | null;
  termination_confirmed_at: Date | null;
  seal_request: TaskSealRequest | null;
  seal_receipt: TaskSealReceipt | null;
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
  l.tombstoned_at,l.slot_reserved,l.termination_confirmed_at FROM core.tasks t JOIN core.task_launches l ON l.task_id=t.id`;

function taskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id,
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
    startup:
      row.state === 'starting'
        ? {
            phase: row.startup_phase ?? 'waiting-for-scheduling',
            elapsedSeconds: Math.max(
              0,
              Math.floor((Date.now() - (row.startup_since ?? row.updated_at).getTime()) / 1000)
            ),
          }
        : null,
    terminalCandidate: row.terminal_candidate,
    terminalReasonCode: row.terminal_reason_code,
    finalizationPending: row.finalization_pending,
    terminalSummary: row.terminal_summary,
    candidateRevision: row.candidate_revision,
    finalizationFailureCode: row.finalization_failure_code,
    terminationConfirmedAt: row.termination_confirmed_at,
    sealRequest: row.seal_request,
    sealReceipt: row.seal_receipt,
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

const TERMINAL = new Set(['done', 'failed', 'stopped']);
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
function validRevision(value: string): boolean {
  return typeof value === 'string' && REVISION.test(value) && BigInt(value) < 9223372036854775807n;
}
function validSealReceipt(receipt: TaskSealReceipt): boolean {
  if (
    !receipt ||
    ![receipt.id, receipt.space, receipt.effectKey].every(
      (value) => typeof value === 'string' && ID.test(value)
    ) ||
    !validRevision(receipt.revision) ||
    receipt.state !== 'sealed' ||
    !['completed', 'failed', 'stopped'].includes(receipt.outcome) ||
    !(receipt.reason === null || (typeof receipt.reason === 'string' && CODE.test(receipt.reason)))
  )
    return false;
  const manifest = receipt.manifest;
  if (
    !manifest ||
    typeof manifest.id !== 'string' ||
    !ID.test(manifest.id) ||
    manifest.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Array.isArray(manifest.objects)
  )
    return false;
  const validObject = (object: TaskSealReceipt['manifest']['objects'][number]) =>
    object &&
    typeof object.id === 'string' &&
    ID.test(object.id) &&
    typeof object.name === 'string' &&
    object.name.length > 0 &&
    object.name.length <= 1024 &&
    Number.isSafeInteger(object.size) &&
    object.size >= 0 &&
    typeof object.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(object.sha256) &&
    ['result', 'log', 'artifact'].includes(object.mark) &&
    (object.contentType === undefined ||
      (typeof object.contentType === 'string' && object.contentType.length <= 255));
  if (
    !manifest.objects.every(validObject) ||
    new Set(manifest.objects.map((o: TaskSealReceipt['manifest']['objects'][number]) => o.id))
      .size !== manifest.objects.length
  )
    return false;
  return (
    manifest.excluded === undefined ||
    (Array.isArray(manifest.excluded) &&
      manifest.excluded.every(
        (o: NonNullable<TaskSealReceipt['manifest']['excluded']>[number]) =>
          validObject(o) && o.reason === 'checksum_mismatch'
      ))
  );
}

/** Informational single-statement snapshot, not a mutation or authority check.
 * ADR-014 fences writes; command admission still checks the epoch and task authority.
 * Pool.query returns healthy clients for reuse. Production supplies an isolated,
 * short-timeout pool, never the owner-intake reserve. */
async function readTaskContext(pool: Pool): Promise<TaskContextSnapshot> {
  const rows = await pool.query<TaskContextEntry>({
    text: `SELECT t.id,t.harness,t.state,left(t.briefing,$2) AS briefing,
      CASE WHEN t.state='starting' THEN jsonb_build_object(
        'phase',COALESCE(t.startup_phase,'waiting-for-scheduling'),
        'elapsedSeconds',GREATEST(0,floor(extract(epoch FROM clock_timestamp()-COALESCE(t.startup_since,t.updated_at)))))
        ELSE NULL END AS startup,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('commandId',c.command_id,
        'kind',c.content->>'kind','delivery',${taskCommandDeliverySql(taskAttemptEndedSql, 'r.disposition')}) ORDER BY c.sequence)
        FROM (SELECT * FROM core.task_commands WHERE task_id=t.id ORDER BY sequence DESC LIMIT 32) c
        LEFT JOIN core.task_command_acks a USING(task_id,command_id)
        LEFT JOIN LATERAL (SELECT disposition FROM core.task_command_receipts
          WHERE task_id=c.task_id AND command_id=c.command_id
          ORDER BY received_at DESC,receipt_id DESC LIMIT 1) r ON true),'[]'::jsonb) AS commands,
      GREATEST(0,(SELECT count(*) FROM core.task_commands WHERE task_id=t.id)-32)::integer AS "commandsOmitted",
      CASE WHEN q.question_id IS NULL THEN NULL ELSE
        jsonb_build_object('questionId',q.question_id,'text',left(q.text,$3)) END AS question
      FROM core.tasks t
      LEFT JOIN LATERAL (
        SELECT q.question_id,m.payload->>'text' AS text FROM core.task_questions q
        INNER JOIN core.task_mailbox m ON m.task_id=q.task_id AND m.message_id=q.question_id
          AND m.kind='question'
        WHERE q.task_id=t.id AND q.answer_command_id IS NULL
          AND jsonb_typeof(m.payload->'text')='string'
          AND NOT EXISTS (SELECT 1 FROM core.task_mailbox terminal
            WHERE terminal.task_id=m.task_id AND terminal.attempt_id=m.attempt_id AND terminal.kind='terminal')
      ) q ON true
      WHERE t.state NOT IN ('done','failed','stopped')
      ORDER BY (q.question_id IS NOT NULL) DESC,t.accepted_order DESC,t.id LIMIT $1`,
    values: [
      TASK_CONTEXT_LIMITS.count + 1,
      TASK_CONTEXT_LIMITS.briefing,
      TASK_CONTEXT_LIMITS.question,
    ],
  });
  return {
    tasks: rows.rows.slice(0, TASK_CONTEXT_LIMITS.count),
    omitted: rows.rows.length > TASK_CONTEXT_LIMITS.count,
  };
}

/** Core-only writer. It owns no pool lifetime, filesystem state or platform metadata. */
export function createPostgresTaskRegistry(deps: {
  pool: Pool;
  /** Optional isolated read pool. No holder lock: this snapshot authorizes no effect. */
  contextPool?: Pool;
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
    let backendPid: number | undefined;
    let cancellation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const destroy = () => {
      if (raw && !released) {
        released = true;
        raw.release(true);
      }
    };
    const terminate = async (): Promise<void> => {
      if (backendPid === undefined) return;
      // A socket close cannot cancel a backend blocked on a SQL lock. Use an
      // independent connection, never another checkout from the shared pool.
      const control = new Client({
        ...deps.pool.options,
        connectionTimeoutMillis: 500,
        query_timeout: 750,
        statement_timeout: 750,
        application_name: 'lifemodel-task-cancel',
      });
      control.on('error', () => undefined);
      try {
        await control.connect();
        await control.query('SELECT pg_terminate_backend($1, 500)', [backendPid]);
      } catch {
        // Session lock/statement limits remain the fallback if the server is
        // unreachable. Never disclose credentials or a PostgreSQL error cause.
      } finally {
        await control.end().catch(() => undefined);
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
        backendPid = (await raw.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid;
        if (expired) {
          cancellation ??= terminate();
          await cancellation;
          throw new TaskRegistryError(taskId, 'storage_error');
        }
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
            cancellation ??= terminate();
            void cancellation.finally(() => {
              destroy();
              reject(new TaskRegistryError(taskId, 'storage_error'));
            });
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
  async function persistSealReceipt(
    client: PoolClient,
    task: TaskRecord,
    candidateRevision: string,
    receipt: TaskSealReceipt
  ): Promise<TaskRecord> {
    const taskId = task.id;
    if (!validSealReceipt(receipt)) throw new TaskRegistryError(taskId, 'invalid_input');
    const request = task.sealRequest;
    if (
      request?.candidateRevision !== candidateRevision ||
      receipt.effectKey !== request.effectKey ||
      receipt.space !== request.space ||
      receipt.outcome !== request.outcome ||
      BigInt(receipt.revision) < BigInt(request.expectedRevision) ||
      (request.outcome === 'completed' &&
        BigInt(receipt.revision) === BigInt(request.expectedRevision))
    )
      throw new TaskRegistryError(taskId, 'intent_conflict');
    if (task.sealReceipt) {
      const same = await client.query<{ matches: boolean }>(
        'SELECT seal_receipt=$2::jsonb AS matches FROM core.tasks WHERE id=$1',
        [taskId, JSON.stringify(receipt)]
      );
      if (!same.rows[0]?.matches) throw new TaskRegistryError(taskId, 'intent_conflict');
      return task;
    }
    if (TERMINAL.has(task.state)) throw new TaskRegistryError(taskId, 'invalid_transition');
    await client.query(
      'UPDATE core.tasks SET seal_receipt=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1',
      [taskId, JSON.stringify(receipt)]
    );
    return rereadTask(client, taskId);
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
          `INSERT INTO core.tasks(id,launch_key,briefing,profile,settings_revision,harness,image_revision,wrap_grace_seconds,request_image_revision,trace_id,parent_span_id)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
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
            request.traceId ?? identity.id,
            request.parentSpanId ?? null,
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
    readByLaunchKey: async (launchKey) =>
      transaction('registry', async (client) => {
        const rows = await client.query<TaskRow>(`${TASK_SELECT} WHERE t.launch_key=$1`, [
          launchKey,
        ]);
        return rows.rows[0] ? taskRecord(rows.rows[0]) : null;
      }),
    list: async () =>
      transaction('registry', async (client) => {
        const rows = await client.query<TaskRow>(`${TASK_SELECT} ORDER BY t.accepted_order,t.id`);
        return rows.rows.map(taskRecord);
      }),
    listActiveContext: () => readTaskContext(deps.contextPool ?? deps.pool),
    recordStartupObservation: async (taskId, launchId, observation) => {
      if (
        ![
          'waiting-for-scheduling',
          'pulling-image',
          'image-pulled',
          'container-started',
          'harness-starting',
        ].includes(observation.phase) ||
        !Number.isFinite(observation.since.getTime())
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      await transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (task.launchId !== launchId) throw new TaskRegistryError(taskId, 'invalid_transition');
        await client.query(
          `UPDATE core.tasks SET startup_phase=$2,
          startup_since=CASE WHEN startup_phase IS DISTINCT FROM $2 THEN $3 ELSE startup_since END
          WHERE id=$1 AND state='starting' AND terminal_candidate IS NULL
            AND COALESCE(array_position(ARRAY['waiting-for-scheduling','pulling-image',
              'image-pulled','container-started','harness-starting'],startup_phase),0)
              <= array_position(ARRAY['waiting-for-scheduling','pulling-image',
                'image-pulled','container-started','harness-starting'],$2)`,
          [taskId, observation.phase, observation.since]
        );
      });
    },
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
    listFinalizationWork: async (afterOrder = '0', limit = 100) => {
      if (!validRevision(afterOrder) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TaskRegistryError('registry', 'invalid_input');
      return transaction('registry', async (client) => {
        const rows = await client.query<TaskRow>(
          `${TASK_SELECT}
          WHERE t.accepted_order>$1::bigint AND (
            (t.state NOT IN ('done','failed','stopped') AND (t.terminal_candidate IS NOT NULL OR EXISTS (
              SELECT 1 FROM core.task_mailbox m WHERE m.task_id=t.id AND m.attempt_id=l.attempt_id AND m.kind='terminal'
            ))) OR l.cleanup_pending OR (l.slot_reserved AND l.termination_confirmed_at IS NOT NULL))
          ORDER BY t.accepted_order LIMIT $2`,
          [afterOrder, limit]
        );
        return rows.rows.map(taskRecord);
      });
    },
    beginFinalization: async (taskId, launchId, candidate) => {
      if (
        !candidate ||
        !TERMINAL.has(candidate.state) ||
        !CODE.test(candidate.reasonCode) ||
        typeof candidate.summary !== 'string' ||
        candidate.summary.length > 60000
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (TERMINAL.has(task.state)) return task;
        // Mailbox append takes this same task-row lock. Its terminal report may
        // have committed after the caller's unlocked read/compute observation.
        // Choose before saving/revoking authority, never from that stale view.
        // An explicit Stop still wins over a semantic report.
        if (!task.terminalCandidate && candidate.state !== 'stopped') {
          const terminal = await client.query<{ payload: TaskTerminalReport }>(
            `SELECT payload FROM core.task_mailbox WHERE task_id=$1 AND attempt_id=$2 AND direction='task_to_core' AND kind='terminal'`,
            [taskId, task.attemptId]
          );
          const report = terminal.rows[0]?.payload;
          if (report) {
            candidate = {
              state:
                report.outcome === 'succeeded'
                  ? 'done'
                  : report.outcome === 'aborted'
                    ? 'stopped'
                    : 'failed',
              reasonCode:
                report.outcome === 'failed'
                  ? report.reasonCode
                  : report.outcome === 'aborted'
                    ? 'aborted'
                    : 'completed',
              summary: report.summary,
            };
          }
        }
        // A report replay cannot undo a failure or hard stop. Only Stop may
        // supersede an already saved candidate; explicit seal refusals use abandonSeal.
        if (
          task.terminalCandidate &&
          (task.terminalCandidate === 'stopped' || candidate.state !== 'stopped')
        )
          return task;
        await client.query(
          `UPDATE core.tasks SET terminal_candidate=$2,terminal_reason_code=$3,
          terminal_summary=$4,candidate_revision=candidate_revision+1,finalization_pending=true,
          finalization_failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [taskId, candidate.state, candidate.reasonCode, candidate.summary]
        );
        await client.query(
          `UPDATE core.task_launches SET tombstoned_at=COALESCE(tombstoned_at,clock_timestamp()),
          cleanup_pending=true WHERE task_id=$1`,
          [taskId]
        );
        // UPDATE existing authority in place. Do not advance an already revoked
        // intent on replay: the exact seal request must survive response loss.
        await client.query(
          `INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at)
          VALUES($1,$2,$3,0,'revoked',clock_timestamp(),clock_timestamp())
          ON CONFLICT(task_id,attempt_id,launch_id) DO UPDATE SET mode='revoked',revision=task_access.intents.revision+1
          WHERE task_access.intents.mode<>'revoked'`,
          [taskId, task.attemptId, launchId]
        );
        return rereadTask(client, taskId);
      });
    },
    confirmComputeTerminated: async (taskId, launchId) =>
      transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (!task.tombstonedAt) throw new TaskRegistryError(taskId, 'invalid_transition');
        await client.query(
          `UPDATE core.task_launches SET termination_confirmed_at=COALESCE(termination_confirmed_at,clock_timestamp()) WHERE task_id=$1`,
          [taskId]
        );
        return rereadTask(client, taskId);
      }),
    prepareSeal: async (taskId, launchId) =>
      transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (task.sealRequest) return task;
        const intent = await readIntent(client, taskId);
        if (
          !task.terminalCandidate ||
          !task.terminationConfirmedAt ||
          !task.allocationReceipt ||
          intent?.mode !== 'revoked'
        )
          throw new TaskRegistryError(taskId, 'invalid_transition');
        const space = await client.query<{ access_revision: string }>(
          'SELECT access_revision::text FROM storage.spaces WHERE id=$1 FOR SHARE',
          [task.allocationReceipt.space]
        );
        const expectedRevision = space.rows[0]?.access_revision;
        if (expectedRevision === undefined || !validRevision(expectedRevision))
          throw new TaskRegistryError(taskId, 'storage_error');
        const request: TaskSealRequest = {
          space: task.allocationReceipt.space,
          effectKey: `seal_${createHash('sha256').update(launchId).update(':').update(task.candidateRevision).digest('hex')}`,
          expectedRevision,
          intentRevision: intent.revision,
          outcome: task.terminalCandidate === 'done' ? 'completed' : task.terminalCandidate,
          candidateRevision: task.candidateRevision,
        };
        await client.query(
          'UPDATE core.tasks SET seal_request=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1',
          [taskId, JSON.stringify(request)]
        );
        return rereadTask(client, taskId);
      }),
    abandonSeal: async (taskId, launchId, candidateRevision, reasonCode) => {
      if (
        !validRevision(candidateRevision) ||
        !['missing_result', 'checksum_mismatch', 'revision_conflict'].includes(reasonCode)
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (TERMINAL.has(task.state)) return task;
        if (task.sealRequest?.candidateRevision !== candidateRevision || task.sealReceipt)
          throw new TaskRegistryError(taskId, 'intent_conflict');
        if (reasonCode === 'revision_conflict') {
          // A definite rejection may precede any freeze. Only then can a new
          // keyed request replace the old one. Unknown responses never enter here.
          const space = await client.query<{
            mode: string;
            access_revision: string;
          }>('SELECT mode,access_revision::text FROM storage.spaces WHERE id=$1 FOR SHARE', [
            task.sealRequest.space,
          ]);
          const current = space.rows[0];
          const operation = await client.query(
            'SELECT 1 FROM storage.seal_operations WHERE space_id=$1',
            [task.sealRequest.space]
          );
          if (
            !current ||
            ['frozen', 'sealed'].includes(current.mode) ||
            operation.rowCount ||
            current.access_revision === task.sealRequest.expectedRevision
          )
            throw new TaskRegistryError(taskId, 'intent_conflict');
          await client.query(
            `UPDATE core.tasks SET candidate_revision=candidate_revision+1,
            seal_request=NULL,finalization_pending=true,finalization_failure_code=$2,
            updated_at=clock_timestamp() WHERE id=$1`,
            [taskId, reasonCode]
          );
          return rereadTask(client, taskId);
        }
        await client.query(
          `UPDATE core.tasks SET terminal_candidate=CASE WHEN terminal_candidate='stopped' THEN 'stopped' ELSE 'failed' END,
          terminal_reason_code=CASE WHEN terminal_candidate='stopped' THEN terminal_reason_code ELSE $2 END,
          candidate_revision=candidate_revision+1,seal_request=NULL,seal_receipt=NULL,finalization_pending=true,
          finalization_failure_code=$2,updated_at=clock_timestamp() WHERE id=$1`,
          [taskId, reasonCode]
        );
        return rereadTask(client, taskId);
      });
    },
    recordSealReceipt: async (taskId, launchId, candidateRevision, receipt) => {
      if (!validRevision(candidateRevision)) throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        return persistSealReceipt(client, task, candidateRevision, receipt);
      });
    },
    recoverSealReceipt: async (taskId, launchId, candidateRevision) => {
      if (!validRevision(candidateRevision)) throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (task.sealRequest?.candidateRevision !== candidateRevision)
          throw new TaskRegistryError(taskId, 'intent_conflict');
        if (task.sealReceipt) return task;
        // Exact immutable module receipt recovery. No rescan, remote response
        // buffering, authority mutation or alternative effect key is involved.
        const saved = await client.query<{ receipt: TaskSealReceipt }>(
          'SELECT receipt FROM storage.seal_receipts WHERE space_id=$1 AND effect_key=$2',
          [task.sealRequest.space, task.sealRequest.effectKey]
        );
        const receipt = saved.rows[0]?.receipt;
        return receipt === undefined
          ? task
          : persistSealReceipt(client, task, candidateRevision, receipt);
      });
    },
    commitFinalization: async (taskId, launchId, candidateRevision) => {
      if (!validRevision(candidateRevision)) throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        const existing = await client.query<{ event: TaskOutcomeEvent }>(
          'SELECT event FROM core.task_outcomes WHERE task_id=$1',
          [taskId]
        );
        if (TERMINAL.has(task.state)) {
          if (!existing.rows[0]) throw new TaskRegistryError(taskId, 'storage_error');
          return existing.rows[0].event;
        }
        const receipt = task.sealReceipt;
        const intent = await readIntent(client, taskId);
        if (
          task.candidateRevision !== candidateRevision ||
          !task.sealRequest ||
          (task.sealRequest.candidateRevision === task.candidateRevision
            ? task.sealRequest.intentRevision !== intent?.revision
            : task.terminalCandidate !== 'stopped')
        )
          throw new TaskRegistryError(taskId, 'intent_conflict');
        if (
          !task.terminalCandidate ||
          task.terminalReasonCode === null ||
          task.terminalSummary === null ||
          !task.terminationConfirmedAt ||
          !task.tombstonedAt ||
          receipt?.state !== 'sealed' ||
          intent?.mode !== 'revoked' ||
          (task.terminalCandidate === 'done' &&
            (receipt.outcome !== 'completed' ||
              !receipt.manifest.objects.some((object) => object.mark === 'result')))
        )
          throw new TaskRegistryError(taskId, 'invalid_transition');
        const commands = await client.query<NonNullable<TaskOutcomeEvent['commands']>[number]>(
          `SELECT c.command_id AS "commandId",c.content->>'kind' AS kind,
            ${taskCommandDeliverySql('true')} AS delivery FROM core.task_commands c
            LEFT JOIN core.task_command_acks a USING(task_id,command_id)
            WHERE c.task_id=$1 ORDER BY c.sequence LIMIT 1024`,
          [taskId]
        );
        const event: TaskOutcomeEvent = {
          ...(commands.rows.length ? { commands: commands.rows } : {}),
          taskId,
          outcomeKey: `outcome_${launchId}`,
          state: task.terminalCandidate,
          reasonCode: task.terminalReasonCode,
          summary: task.terminalSummary,
          objects: receipt.manifest.objects,
        };
        await client.query(
          `UPDATE core.tasks SET state=terminal_candidate,terminal_at=clock_timestamp(),
          finalization_pending=false,finalization_failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [taskId]
        );
        await client.query(
          `INSERT INTO core.task_outcomes(outcome_key,task_id,launch_id,event) VALUES($1,$2,$3,$4::jsonb)`,
          [event.outcomeKey, taskId, launchId, JSON.stringify(event)]
        );
        return event;
      });
    },
    setFinalizationPending: async (taskId, launchId, code) => {
      if (!CODE.test(code)) throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (TERMINAL.has(task.state)) return;
        if (!task.terminalCandidate) throw new TaskRegistryError(taskId, 'invalid_transition');
        await client.query(
          `UPDATE core.tasks SET finalization_pending=true,finalization_failure_code=$2,updated_at=clock_timestamp() WHERE id=$1`,
          [taskId, code]
        );
      });
    },
    listOutcomeWork: async (limit = 100) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TaskRegistryError('registry', 'invalid_input');
      return transaction('registry', async (client) => {
        const rows = await client.query<{ event: TaskOutcomeEvent }>(
          'SELECT event FROM core.task_outcomes WHERE signalled_at IS NULL ORDER BY created_at,outcome_key LIMIT $1',
          [limit]
        );
        return rows.rows.map((row) => row.event);
      });
    },
    markOutcomeSignalled: async (outcomeKey) =>
      transaction('registry', async (client) => {
        const changed = await client.query(
          `UPDATE core.task_outcomes SET signalled_at=COALESCE(signalled_at,clock_timestamp()) WHERE outcome_key=$1`,
          [outcomeKey]
        );
        if (!changed.rowCount) throw new TaskRegistryError('registry', 'not_found');
      }),
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
        if (!task.terminalCandidate) requireLaunchable(task);
        else if (TERMINAL.has(task.state))
          throw new TaskRegistryError(taskId, 'invalid_transition');
        await client.query(
          'UPDATE core.task_launches SET allocation_receipt=$2::jsonb WHERE task_id=$1',
          [
            taskId,
            JSON.stringify({
              id: receipt.id,
              space: receipt.space,
              effectKey: receipt.effectKey,
            }),
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
    bindCleanupJob: async (taskId, launchId, jobUid, templateHash) => {
      if (
        typeof jobUid !== 'string' ||
        !ID.test(jobUid) ||
        typeof templateHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(templateHash)
      )
        throw new TaskRegistryError(taskId, 'invalid_input');
      return transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (!task.tombstonedAt || !task.terminalCandidate || !task.allocationReceipt)
          throw new TaskRegistryError(taskId, 'invalid_transition');
        if (task.jobUid !== null || task.templateHash !== null) {
          if (task.jobUid !== jobUid || task.templateHash !== templateHash)
            throw new TaskRegistryError(taskId, 'intent_conflict');
          return task;
        }
        await client.query(
          `UPDATE core.task_launches SET job_uid=$2,template_hash=$3,
          cleanup_pending=true,termination_confirmed_at=NULL WHERE task_id=$1`,
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
          SET tombstoned_at=COALESCE(tombstoned_at,clock_timestamp()),cleanup_pending=true,
            termination_confirmed_at=CASE WHEN cleanup_pending THEN termination_confirmed_at ELSE NULL END
          WHERE task_id=$1`,
          [taskId]
        );
        return rereadTask(client, taskId);
      }),
    completeLaunchCleanup: async (taskId, launchId) =>
      transaction(taskId, async (client) => {
        const task = await lockLaunch(client, taskId, launchId);
        if (!task.tombstonedAt || !task.terminationConfirmedAt)
          throw new TaskRegistryError(taskId, 'invalid_transition');
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
        const task = await lockTask(client, taskId);
        if (!task.terminationConfirmedAt) throw new TaskRegistryError(taskId, 'invalid_transition');
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
