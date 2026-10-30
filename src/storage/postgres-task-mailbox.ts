import type { Pool, PoolClient } from 'pg';
import { taskCommandDeliverySql, taskAttemptEndedSql } from './task-command-delivery.js';
import type { TaskProfile } from '../ports/tasks.js';
import type {
  TaskChannelCursor,
  TaskChannelDirection,
  TaskChannelFrame,
  TaskMailbox,
  StoredTaskChannelFrame,
  TaskChannelProof,
  TaskBriefing,
  TaskCommandMailbox,
  TaskCommand,
  TaskCommandInput,
  TaskCommandReader,
  TaskCommandStatus,
  TaskQuestion,
  TaskTranscriptReader,
  TaskTranscriptEntry,
} from '../ports/task-channel.js';
import {
  TaskChannelError,
  TASK_TRANSCRIPT_LIMITS,
  validateTaskChannelFrame,
  validateTaskCommandInput,
  validateTaskCommandAck,
  validateTaskCommandReceipt,
} from '../ports/task-channel.js';
import { createFencedPostgres, StalePostgresEpochError } from './fenced-postgres.js';
import { scrubTraceRecord } from './postgres-trace-store.js';
import { boundTaskTranscript } from '../ports/task-transcript-bounds.mjs';

interface MailboxRow {
  task_id: string;
  attempt_id: string;
  direction: TaskChannelDirection;
  sequence: string;
  message_id: string;
  kind: TaskChannelFrame['kind'];
  payload: TaskChannelFrame['payload'];
  received_at: Date;
}
interface Binding {
  task_id: string;
  attempt_id: string;
  launch_id: string;
  job_name: string;
  job_uid: string | null;
  pod_uid: string | null;
  template_hash: string | null;
  allocation_receipt: { space: string } | null;
  tombstoned_at: Date | null;
  slot_reserved: boolean;
  state: string;
  terminal_candidate: string | null;
  trace_id: string;
  parent_span_id: string | null;
  harness: string;
  started_at: Date | null;
  profile: TaskProfile;
  wrap_grace_seconds: number;
  soft_stop_requested_at: Date | null;
}
function record(row: MailboxRow): StoredTaskChannelFrame {
  const identity = {
    taskId: row.task_id,
    attemptId: row.attempt_id,
    direction: row.direction,
    messageId: row.message_id,
    sequence: Number(row.sequence),
  };
  return {
    frame: {
      ...identity,
      kind: row.kind,
      payload: row.payload,
    } as StoredTaskChannelFrame['frame'],
    ack: { ...identity, receivedAt: row.received_at.toISOString() },
  };
}
function inputId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
function requireKeys(taskId: string, direction: TaskChannelDirection, messageId?: string): void {
  if (
    !inputId(taskId) ||
    direction !== 'task_to_core' ||
    (messageId !== undefined && !inputId(messageId))
  )
    throw new TaskChannelError(400, 'invalid_input');
}
/** Dedicated caller-owned bounded Pool. Never borrows the owner-intake reservation. */
export function createPostgresTaskMailbox(deps: {
  pool: Pool;
  epoch: number;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  onAppendSettled?: () => void;
  /** Relay a committed core command to a separately pooled channel instance. */
  onCommandCommitted?: (taskId: string) => void;
  /** Same response-frame limit used by the task-only listener. */
  commandFrameLimit?: number;
  knownSecrets?: readonly string[];
}): TaskMailbox &
  TaskCommandMailbox &
  TaskCommandReader &
  TaskTranscriptReader & {
    readTraceAuthority(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskBriefing>;
    notifyCommands(taskId: string): void;
  } {
  const timeoutMs = deps.operationTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(deps.epoch) ||
    deps.epoch < 0
  )
    throw new TaskChannelError(500, 'invalid_input');
  const closing = new AbortController();
  const commandListeners = new Map<string, Set<() => void>>();
  const reconcile = new Map<string, symbol>();
  const clients = new WeakSet<PoolClient>();
  const transaction = async <T>(
    body: (client: PoolClient) => Promise<T>,
    parent?: AbortSignal,
    settled?: () => void
  ): Promise<T> => {
    if (closing.signal.aborted) throw new TaskChannelError(503, 'stopped');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([
      closing.signal,
      timeout,
      ...(deps.signal ? [deps.signal] : []),
      ...(parent ? [parent] : []),
    ]);
    let raw: PoolClient | undefined;
    let retired = false;
    let commitAttempted = false;
    let committed = false;
    const destroy = () => {
      if (raw && !retired) {
        retired = true;
        raw.release(true);
      }
    };
    const cancelled = () =>
      new TaskChannelError(
        503,
        closing.signal.aborted ? 'stopped' : timeout.aborted ? 'storage_error' : 'cancelled'
      );
    if (signal.aborted) throw cancelled();
    let cancel: (() => void) | undefined;
    const work = async (): Promise<T> => {
      try {
        raw = await deps.pool.connect();
        if (!clients.has(raw)) {
          raw.on('error', () => undefined);
          clients.add(raw);
        }
        if (signal.aborted) {
          destroy();
          throw cancelled();
        }
        // Session limits precede BEGIN but no domain access escapes the fence.
        // pg release(true) destroys an active-query socket. PostgreSQL otherwise
        // need not notice that disconnect while blocked on a lock until its SQL
        // timeout. Check the dead owned connection during execution as well.
        await raw.query(
          `SET lock_timeout='${String(timeoutMs)}ms'; SET statement_timeout='${String(timeoutMs)}ms'; SET client_connection_check_interval='50ms'`
        );
        const acquired = raw;
        const single = new Proxy(deps.pool, {
          get(target, key) {
            if (key === 'connect') return () => Promise.resolve(acquired);
            return Reflect.get(target, key, target) as unknown;
          },
        });
        const client = await createFencedPostgres(single, deps.epoch).connect();
        await client.query('BEGIN');
        const holder = await client.query<{ epoch: string }>(
          'SELECT epoch FROM core.active_holder WHERE id'
        );
        const current = Number(holder.rows[0]?.epoch);
        if (current !== deps.epoch)
          throw new StalePostgresEpochError(deps.epoch, Number.isFinite(current) ? current : null);
        const result = await body(client);
        if (signal.aborted) throw cancelled();
        commitAttempted = true;
        await client.query('COMMIT');
        if (signal.aborted) throw cancelled();
        committed = true;
        return result;
      } catch (error) {
        if (error instanceof TaskChannelError || error instanceof StalePostgresEpochError)
          throw error;
        // Schema/permission/input errors cannot recover through retries. Preserve
        // that classification, but never expose SQL detail, cause, input or bearer.
        const code =
          error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (
          (typeof code === 'string' && /^(22|28|3D|3F|42)/.test(code)) ||
          (code === '23514' &&
            error !== null &&
            typeof error === 'object' &&
            'table' in error &&
            error.table === 'task_transcript')
        )
          throw new TaskChannelError(400, 'invalid_input');
        throw new TaskChannelError(503, 'storage_error');
      } finally {
        if (committed && raw && !retired) {
          retired = true;
          raw.release();
        } else destroy();
        if (commitAttempted) settled?.();
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          cancel = () => {
            destroy();
            reject(cancelled());
          };
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        }),
      ]);
    } finally {
      if (cancel) signal.removeEventListener('abort', cancel);
    }
  };
  function denied(): never {
    throw new TaskChannelError(403, 'identity_mismatch');
  }
  async function authority(client: PoolClient, binding: Binding, start = false): Promise<void> {
    const values = [binding.task_id, binding.attempt_id, binding.launch_id];
    const locked = await client.query(
      `SELECT 1 FROM task_access.intents WHERE task_id=$1 AND attempt_id=$2 AND launch_id=$3 FOR SHARE`,
      values
    );
    if (locked.rowCount !== 1) denied();
    // A row lock can wait behind revoke. Use database wall time AFTER the wait.
    const found = await client.query<{ soft_due_at: Date; hard_stop_at: Date }>(
      `SELECT soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id=$1 AND attempt_id=$2 AND launch_id=$3 AND mode IN (${start ? "'active'" : "'active','wrapping'"}) AND clock_timestamp()<hard_stop_at`,
      values
    );
    const intent = found.rows[0];
    if (!intent || !binding.started_at) denied();
    const originalSoft = binding.started_at.getTime() + binding.profile.timeoutSeconds * 1000;
    if (
      intent.soft_due_at.getTime() > originalSoft ||
      intent.hard_stop_at.getTime() > originalSoft + binding.wrap_grace_seconds * 1000
    )
      denied();
  }
  async function resolveBinding(
    client: PoolClient,
    proof: TaskChannelProof,
    lock = true
  ): Promise<Binding> {
    // Resolve authority by freshly verified Job identity, not supplied task IDs.
    const found = await client.query<{ task_id: string }>(
      'SELECT task_id FROM core.task_launches WHERE job_name=$1 AND job_uid=$2',
      [proof?.jobName, proof?.jobUid]
    );
    const taskId = found.rows[0]?.task_id;
    if (found.rowCount !== 1 || !taskId) denied();
    if (lock) {
      const locked = await client.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [
        taskId,
      ]);
      if (locked.rowCount !== 1) denied();
    }
    const launch = await client.query<Binding>(
      `SELECT l.*,t.state,t.terminal_candidate,t.started_at,t.profile,t.wrap_grace_seconds,t.trace_id,t.parent_span_id,t.harness FROM core.task_launches l JOIN core.tasks t ON t.id=l.task_id WHERE l.task_id=$1${lock ? ' FOR UPDATE OF l' : ''}`,
      [taskId]
    );
    const binding = launch.rows[0];
    if (
      binding?.job_uid !== proof.jobUid ||
      binding.job_name !== proof.jobName ||
      !/^launch_[0-9a-f]{64}$/.test(binding.launch_id) ||
      binding.launch_id.slice(7, 65) !== proof.launchLabel ||
      binding.job_name !== `task-${proof.launchLabel}` ||
      binding.template_hash !== proof.templateHash ||
      binding.started_at?.getTime() !== new Date(proof.startedAt).getTime() ||
      (binding.pod_uid !== null && binding.pod_uid !== proof.podUid) ||
      !binding.allocation_receipt?.space
    )
      denied();
    return binding;
  }
  async function wonClaim(
    client: PoolClient,
    binding: Binding,
    proof: TaskChannelProof
  ): Promise<void> {
    const claim = await client.query(
      `SELECT 1 FROM task_access.start_claims c JOIN task_access.projections p USING(task_id,attempt_id,launch_id)
    WHERE c.task_id=$1 AND c.attempt_id=$2 AND c.launch_id=$3 AND c.pod_uid=$4 AND c.job_uid=$5 AND c.job_started_at=$6
    AND p.pod_uid=c.pod_uid AND p.job_uid=c.job_uid AND p.pod_name=$7 AND p.job_name=$8 AND p.space_id=$9 FOR SHARE OF c,p`,
      [
        binding.task_id,
        binding.attempt_id,
        binding.launch_id,
        proof.podUid,
        proof.jobUid,
        proof.startedAt,
        proof.podName,
        proof.jobName,
        binding.allocation_receipt?.space,
      ]
    );
    if (claim.rowCount !== 1) denied();
  }
  function liveAttempt(binding: Binding): void {
    if (
      !['starting', 'running', 'wrapping-up'].includes(binding.state) ||
      binding.terminal_candidate ||
      binding.tombstoned_at ||
      !binding.slot_reserved
    )
      throw new TaskChannelError(409, 'terminal_attempt');
  }
  async function allocation(client: PoolClient, binding: Binding): Promise<void> {
    const allocated = await client.query(
      `SELECT 1 FROM storage.allocations a JOIN storage.spaces s ON s.id=a.space_id
       WHERE a.task_id=$1 AND a.launch_id=$2 AND a.space_id=$3
       AND s.mode IN ('open','wrapping') FOR SHARE OF s`,
      [binding.task_id, binding.launch_id, binding.allocation_receipt?.space]
    );
    if (allocated.rowCount !== 1) denied();
  }
  const locators = (binding: Binding) => ({
    taskId: binding.task_id,
    attemptId: binding.attempt_id,
    launchId: binding.launch_id,
  });
  async function commandAuthority(client: PoolClient, binding: Binding): Promise<void> {
    liveAttempt(binding);
    await authority(client, binding, true);
    const terminal = await client.query(
      "SELECT 1 FROM core.task_mailbox WHERE task_id=$1 AND attempt_id=$2 AND kind='terminal'",
      [binding.task_id, binding.attempt_id]
    );
    if (terminal.rowCount) throw new TaskChannelError(409, 'terminal_attempt');
    if (binding.state === 'wrapping-up') throw new TaskChannelError(409, 'wrapping_attempt');
  }
  async function commandBinding(client: PoolClient, proof: TaskChannelProof, delivery = false) {
    // Empty poll rechecks never take task/launch UPDATE locks. ACK/receipt writes
    // still serialize with finalization, but may finish in authoritative wrapping.
    const binding = await resolveBinding(client, proof, !delivery);
    if (delivery) await commandAuthority(client, binding);
    else await authority(client, binding);
    await allocation(client, binding);
    await wonClaim(client, binding, proof);
    return binding;
  }
  function commandRecord(row: { content: TaskCommandInput; sequence: string }): TaskCommand {
    return {
      ...row.content,
      direction: 'core_to_task',
      sequence: Number(row.sequence),
    };
  }
  async function readCommands(taskId?: string, commandId?: string): Promise<TaskCommandStatus[]> {
    if (taskId !== undefined && !inputId(taskId)) throw new TaskChannelError(400, 'invalid_input');
    if (commandId !== undefined && !inputId(commandId))
      throw new TaskChannelError(400, 'invalid_input');
    return transaction(async (client) => {
      const rows = await client.query<{
        content: TaskCommandInput;
        sequence: string;
        disposition: TaskCommandStatus['disposition'];
        delivery: NonNullable<TaskCommandStatus['delivery']>;
        receipts: TaskCommandStatus['receipts'];
      }>(
        `SELECT c.content,c.sequence,COALESCE(a.disposition,'queued') AS disposition,
        ${taskCommandDeliverySql(taskAttemptEndedSql)} AS delivery,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('taskId',r.task_id,'attemptId',c.attempt_id,
          'commandId',r.command_id,'receiptId',r.receipt_id,'disposition',r.disposition,
          'receivedAt',r.received_at) ORDER BY r.received_at,r.receipt_id)
          FROM core.task_command_receipts r WHERE r.task_id=c.task_id AND r.command_id=c.command_id),'[]'::jsonb) AS receipts
        FROM core.task_commands c JOIN core.tasks t ON t.id=c.task_id
        LEFT JOIN core.task_command_acks a USING(task_id,command_id)
        WHERE ($1::text IS NULL OR c.task_id=$1) AND ($2::text IS NULL OR c.command_id=$2)
        ORDER BY c.sequence LIMIT 1024`,
        [taskId ?? null, commandId ?? null]
      );
      return rows.rows.map((row) => {
        const receipts = row.receipts.map((receipt) => ({
          ...receipt,
          receivedAt: new Date(receipt.receivedAt).toISOString(),
        }));
        return {
          ...commandRecord(row),
          disposition: row.disposition,
          delivery: row.delivery,
          receipts,
          currentReceipt: receipts.at(-1) ?? null,
          retryable: row.disposition === 'rejected',
        };
      });
    });
  }
  const notifyCommands = (taskId: string) => {
    for (const wake of commandListeners.get(taskId) ?? []) wake();
  };
  return {
    notifyCommands,
    readCommands: (taskId) => readCommands(taskId),
    readCommand: async (commandId) => (await readCommands(undefined, commandId))[0] ?? null,
    readQuestion: (taskId, questionId) => {
      if (!inputId(taskId)) throw new TaskChannelError(400, 'invalid_input');
      return transaction(async (client) => {
        const result = await client.query<TaskQuestion>(
          `SELECT q.task_id AS "taskId",m.attempt_id AS "attemptId",
          q.question_id AS "questionId",q.answer_command_id AS "answerCommandId",m.payload->>'text' AS text FROM core.task_questions q
          JOIN core.task_mailbox m ON m.task_id=q.task_id AND m.message_id=q.question_id AND m.kind='question'
          WHERE q.task_id=$1 AND (($2::text IS NULL AND q.answer_command_id IS NULL) OR q.question_id=$2)`,
          [taskId, questionId ?? null]
        );
        return result.rows[0] ?? null;
      });
    },
    subscribeCommands: (taskId, wake) => {
      const listeners = commandListeners.get(taskId) ?? new Set<() => void>();
      listeners.add(wake);
      commandListeners.set(taskId, listeners);
      return () => {
        listeners.delete(wake);
        if (!listeners.size) commandListeners.delete(taskId);
      };
    },
    enqueueCommand: async (input, parent) => {
      const command = validateTaskCommandInput(input);
      const result = await transaction(async (client) => {
        // Core callers have no Pod proof. Resolve the authoritative saved binding,
        // then apply the same fence, row order, canonical intent and allocation.
        await client.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [command.taskId]);
        const found = await client.query<Binding>(
          `SELECT l.*,t.state,t.terminal_candidate,t.started_at,t.profile,t.wrap_grace_seconds FROM core.task_launches l JOIN core.tasks t ON t.id=l.task_id WHERE l.task_id=$1 FOR UPDATE OF l`,
          [command.taskId]
        );
        const binding = found.rows[0];
        if (binding?.attempt_id !== command.attemptId) denied();
        const existing = await client.query<{
          content: TaskCommandInput;
          sequence: string;
          matches: boolean;
        }>(
          'SELECT *,content=$3::jsonb AS matches FROM core.task_commands WHERE task_id=$1 AND command_id=$2',
          [command.taskId, command.commandId, JSON.stringify(command)]
        );
        const old = existing.rows[0];
        if (old) {
          if (!old.matches) throw new TaskChannelError(409, 'message_conflict');
          return commandRecord(old);
        }
        await commandAuthority(client, binding);
        await allocation(client, binding);
        // Include the envelope, direction, and maximum sequence before commit.
        const wire = {
          command: {
            ...command,
            direction: 'core_to_task',
            sequence: Number.MAX_SAFE_INTEGER,
          },
        };
        if (Buffer.byteLength(JSON.stringify(wire)) > (deps.commandFrameLimit ?? 65_536))
          throw new TaskChannelError(413, 'invalid_frame');
        const count = await client.query<{ count: string }>(
          'SELECT count(*) FROM core.task_commands WHERE task_id=$1',
          [command.taskId]
        );
        if (Number(count.rows[0]?.count) >= 1024)
          throw new TaskChannelError(429, 'command_capacity');
        const inserted = await client.query<{
          content: TaskCommandInput;
          sequence: string;
        }>(
          `INSERT INTO core.task_commands(task_id,attempt_id,command_id,sequence,content) SELECT $1,$2,$3,COALESCE(max(sequence),0)+1,$4::jsonb FROM core.task_commands WHERE task_id=$1 RETURNING *`,
          [command.taskId, command.attemptId, command.commandId, JSON.stringify(command)]
        );
        if (command.kind === 'answer') {
          const answered = await client.query(
            'UPDATE core.task_questions SET answer_command_id=$3 WHERE task_id=$1 AND question_id=$2 AND answer_command_id IS NULL RETURNING question_id',
            [command.taskId, command.questionId, command.commandId]
          );
          if (!answered.rowCount) throw new TaskChannelError(409, 'question_absent');
        }
        await commandAuthority(client, binding);
        const row = inserted.rows[0];
        if (!row) throw new TaskChannelError(503, 'storage_error');
        return commandRecord(row);
      }, parent);
      // Only committed commands can wake a waiter. A lost COMMIT reply is covered
      // by the poll's bounded recheck, never by trusting this notification.
      notifyCommands(command.taskId);
      deps.onCommandCommitted?.(command.taskId);
      return result;
    },
    pollCommand: (proof, parent) =>
      transaction(async (client) => {
        const binding = await commandBinding(client, proof, true);
        const result = await client.query<{
          content: TaskCommandInput;
          sequence: string;
        }>(
          'SELECT * FROM core.task_commands WHERE task_id=$1 AND attempt_id=$2 AND retired_at IS NULL ORDER BY sequence LIMIT 1',
          [binding.task_id, binding.attempt_id]
        );
        return result.rows[0] ? commandRecord(result.rows[0]) : null;
      }, parent),
    acknowledgeCommand: async (input, proof, parent) => {
      const ack = validateTaskCommandAck(input);
      await transaction(async (client) => {
        const binding = await commandBinding(client, proof);
        if (binding.task_id !== ack.taskId || binding.attempt_id !== ack.attemptId) denied();
        const found = await client.query(
          'SELECT 1 FROM core.task_commands WHERE task_id=$1 AND attempt_id=$2 AND command_id=$3',
          [ack.taskId, ack.attemptId, ack.commandId]
        );
        if (!found.rowCount) throw new TaskChannelError(404, 'not_found');
        const previous = await client.query<{ disposition: string }>(
          'SELECT disposition FROM core.task_command_acks WHERE task_id=$1 AND command_id=$2',
          [ack.taskId, ack.commandId]
        );
        if (previous.rows[0] && previous.rows[0].disposition !== ack.disposition)
          throw new TaskChannelError(409, 'message_conflict');
        await client.query(
          'INSERT INTO core.task_command_acks(task_id,command_id,disposition) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [ack.taskId, ack.commandId, ack.disposition]
        );
        await client.query(
          'UPDATE core.task_commands SET retired_at=clock_timestamp() WHERE task_id=$1 AND command_id=$2 AND retired_at IS NULL',
          [ack.taskId, ack.commandId]
        );
        await authority(client, binding);
      }, parent);
    },
    recordCommandReceipt: async (input, proof, parent) => {
      const receipt = validateTaskCommandReceipt(input);
      await transaction(async (client) => {
        const binding = await commandBinding(client, proof);
        if (binding.task_id !== receipt.taskId || binding.attempt_id !== receipt.attemptId)
          denied();
        const found = await client.query(
          'SELECT 1 FROM core.task_commands WHERE task_id=$1 AND attempt_id=$2 AND command_id=$3',
          [receipt.taskId, receipt.attemptId, receipt.commandId]
        );
        if (!found.rowCount) throw new TaskChannelError(404, 'not_found');
        const old = await client.query<{
          command_id: string;
          disposition: string;
        }>('SELECT * FROM core.task_command_receipts WHERE task_id=$1 AND receipt_id=$2', [
          receipt.taskId,
          receipt.receiptId,
        ]);
        if (
          old.rows[0] &&
          (old.rows[0].command_id !== receipt.commandId ||
            old.rows[0].disposition !== receipt.disposition)
        )
          throw new TaskChannelError(409, 'message_conflict');
        const count = await client.query<{ count: string }>(
          'SELECT count(*) FROM core.task_command_receipts WHERE task_id=$1 AND command_id=$2',
          [receipt.taskId, receipt.commandId]
        );
        if (!old.rowCount && Number(count.rows[0]?.count) >= 16)
          throw new TaskChannelError(429, 'command_capacity');
        await client.query(
          'INSERT INTO core.task_command_receipts(task_id,command_id,receipt_id,disposition) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [receipt.taskId, receipt.commandId, receipt.receiptId, receipt.disposition]
        );
        await authority(client, binding);
      }, parent);
    },
    readIdentity: async (proof, parent) =>
      transaction(async (client) => {
        const binding = await resolveBinding(client, proof);
        liveAttempt(binding);
        if (binding.soft_stop_requested_at !== null) denied();
        await authority(client, binding, true);
        await allocation(client, binding);
        await authority(client, binding, true);
        return locators(binding);
      }, parent),
    readBriefing: async (proof, parent) =>
      transaction(async (client) => {
        const binding = await resolveBinding(client, proof);
        liveAttempt(binding);
        await authority(client, binding);
        await allocation(client, binding);
        await wonClaim(client, binding, proof);
        const result = await client.query<{
          briefing: string;
          harness: string;
          trace_id: string;
          parent_span_id: string | null;
        }>(
          'SELECT briefing,harness,trace_id,parent_span_id FROM core.tasks WHERE id=$1 AND octet_length(briefing)<=1048576',
          [binding.task_id]
        );
        await authority(client, binding);
        const briefing = result.rows[0]?.briefing;
        if (typeof briefing !== 'string') throw new TaskChannelError(503, 'channel_unavailable');
        const { id, revision, timeoutSeconds, cpuMillis, memoryBytes } = binding.profile;
        const response = {
          ...locators(binding),
          briefing,
          traceId: result.rows[0]?.trace_id ?? binding.task_id,
          parentSpanId: result.rows[0]?.parent_span_id ?? null,
          harness: result.rows[0]?.harness ?? '',
          profile: { id, revision, timeoutSeconds, cpuMillis, memoryBytes },
        };
        if (Buffer.byteLength(JSON.stringify(response)) > 1_048_576)
          throw new TaskChannelError(503, 'channel_unavailable');
        await client.query(
          `UPDATE core.tasks SET startup_phase='harness-starting',startup_since=clock_timestamp()
          WHERE id=$1 AND state='starting' AND startup_phase IS DISTINCT FROM 'harness-starting'`,
          [binding.task_id]
        );
        return response;
      }, parent),
    readTraceAuthority: async (proof, parent) =>
      transaction(async (client) => {
        // Evidence cannot hold the task/launch UPDATE locks used by terminal
        // append. Only the shared authority locks remain; terminal takes the
        // same compatible locks on intents, allocations and the won claim.
        const binding = await resolveBinding(client, proof, false);
        liveAttempt(binding);
        await authority(client, binding);
        await allocation(client, binding);
        await wonClaim(client, binding, proof);
        await authority(client, binding);
        const { id, revision, timeoutSeconds, cpuMillis, memoryBytes } = binding.profile;
        return {
          ...locators(binding),
          briefing: '',
          traceId: binding.trace_id,
          parentSpanId: binding.parent_span_id,
          harness: binding.harness,
          profile: { id, revision, timeoutSeconds, cpuMillis, memoryBytes },
        };
      }, parent),
    stop: () => {
      closing.abort();
      for (const listeners of commandListeners.values()) for (const wake of listeners) wake();
      commandListeners.clear();
    },
    append: async (input, proof, parent) => {
      let frame = validateTaskChannelFrame(input);
      if (frame.kind === 'transcript') {
        // Reuse the task.tool trace scrubber, before ANY durable write.
        const clean = scrubTraceRecord(
          {
            kind: 'event',
            event: {
              recordId: frame.messageId,
              traceId: frame.taskId,
              spanId: frame.attemptId,
              event: 'task.transcript',
              ts: frame.payload.time,
              fields: { ...frame.payload },
            },
          },
          deps.knownSecrets
        );
        if (clean.kind !== 'event') throw new TaskChannelError(400, 'invalid_frame');
        frame = validateTaskChannelFrame({
          ...frame,
          payload: boundTaskTranscript(clean.event.fields as unknown as TaskTranscriptEntry),
        });
      }
      return transaction(
        async (client) => {
          const binding = await resolveBinding(client, proof);
          if (binding.task_id !== frame.taskId || binding.attempt_id !== frame.attemptId) denied();
          await authority(client, binding);
          await wonClaim(client, binding, proof);
          await authority(client, binding);
          if (frame.kind === 'transcript') {
            const old = await client.query<{
              sequence: string;
              attempt_id: string;
              payload: TaskTranscriptEntry;
              received_at: Date;
              matches: boolean;
            }>(
              `SELECT *,attempt_id=$3 AND sequence=$4 AND payload=$5::jsonb AS matches
               FROM core.task_transcript WHERE task_id=$1 AND message_id=$2`,
              [
                frame.taskId,
                frame.messageId,
                frame.attemptId,
                frame.sequence,
                JSON.stringify(frame.payload),
              ]
            );
            const ack = (receivedAt: Date) => ({
              taskId: frame.taskId,
              attemptId: frame.attemptId,
              direction: frame.direction,
              messageId: frame.messageId,
              sequence: frame.sequence,
              receivedAt: receivedAt.toISOString(),
            });
            if (old.rows[0]) {
              if (!old.rows[0].matches) throw new TaskChannelError(409, 'message_conflict');
              return ack(old.rows[0].received_at);
            }
            const collision = await client.query<{ message_id: string; sequence: string }>(
              `SELECT message_id,sequence FROM core.task_mailbox WHERE task_id=$1 AND
                (message_id=$2 OR (attempt_id=$3 AND sequence=$4))`,
              [frame.taskId, frame.messageId, frame.attemptId, frame.sequence]
            );
            if (collision.rowCount)
              throw new TaskChannelError(
                409,
                collision.rows[0]?.message_id === frame.messageId
                  ? 'message_conflict'
                  : 'sequence_conflict'
              );
            liveAttempt(binding);
            const ended = await client.query(
              `SELECT 1 FROM core.task_mailbox WHERE task_id=$1 AND kind='terminal'`,
              [frame.taskId]
            );
            if (ended.rowCount) throw new TaskChannelError(409, 'terminal_attempt');
            const count = await client.query<{ count: string }>(
              'SELECT count(*) FROM core.task_transcript WHERE task_id=$1',
              [frame.taskId]
            );
            const horizon = await client.query(
              `SELECT 1 FROM core.task_transcript_horizons WHERE task_id=$1 AND attempt_id=$2 AND evicted_through >= $3::bigint`,
              [frame.taskId, frame.attemptId, frame.sequence]
            );
            if (horizon.rowCount) throw new TaskChannelError(409, 'transcript_evicted');
            if (Number(count.rows[0]?.count) >= TASK_TRANSCRIPT_LIMITS.entries) {
              await client.query(
                `WITH evicted AS (
                  DELETE FROM core.task_transcript WHERE task_id=$1 AND ordinal IN (
                    SELECT ordinal FROM core.task_transcript WHERE task_id=$1 ORDER BY ordinal
                    LIMIT $2
                  ) RETURNING attempt_id,sequence
                ) INSERT INTO core.task_transcript_horizons(task_id,attempt_id,evicted_through)
                  SELECT $1,attempt_id,max(sequence) FROM evicted GROUP BY attempt_id
                  ON CONFLICT(task_id,attempt_id) DO UPDATE SET evicted_through=greatest(
                    core.task_transcript_horizons.evicted_through,EXCLUDED.evicted_through)`,
                [frame.taskId, Number(count.rows[0]?.count) - TASK_TRANSCRIPT_LIMITS.entries + 1]
              );
            }
            const inserted = await client.query<{ received_at: Date }>(
              `INSERT INTO core.task_transcript(task_id,attempt_id,message_id,sequence,payload) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING received_at`,
              [
                frame.taskId,
                frame.attemptId,
                frame.messageId,
                frame.sequence,
                JSON.stringify(frame.payload),
              ]
            );
            // The briefing precedes harness startup and does not prove liveness.
            if (frame.payload.role !== 'user-briefing')
              await client.query(
                `UPDATE core.tasks SET state='running',updated_at=clock_timestamp() WHERE id=$1 AND state='starting'`,
                [frame.taskId]
              );
            await authority(client, binding);
            const insertedRow = inserted.rows[0];
            if (!insertedRow) throw new TaskChannelError(503, 'storage_error');
            return ack(insertedRow.received_at);
          }
          const existing = await client.query<MailboxRow>(
            'SELECT * FROM core.task_mailbox WHERE task_id=$1 AND direction=$2 AND message_id=$3',
            [frame.taskId, frame.direction, frame.messageId]
          );
          if (existing.rows[0]) {
            const row = existing.rows[0];
            const matches = await client.query<{ matches: boolean }>(
              `SELECT attempt_id=$4 AND sequence=$5 AND kind=$6 AND payload=$7::jsonb AS matches FROM core.task_mailbox WHERE task_id=$1 AND direction=$2 AND message_id=$3`,
              [
                frame.taskId,
                frame.direction,
                frame.messageId,
                frame.attemptId,
                frame.sequence,
                frame.kind,
                JSON.stringify(frame.payload),
              ]
            );
            if (!matches.rows[0]?.matches) throw new TaskChannelError(409, 'message_conflict');
            await authority(client, binding);
            return record(row).ack;
          }
          if (
            !['starting', 'running', 'wrapping-up'].includes(binding.state) ||
            binding.terminal_candidate ||
            binding.tombstoned_at ||
            !binding.slot_reserved
          )
            throw new TaskChannelError(409, 'terminal_attempt');
          const terminal = await client.query(
            `SELECT 1 FROM core.task_mailbox WHERE task_id=$1 AND attempt_id=$2 AND kind='terminal'`,
            [frame.taskId, frame.attemptId]
          );
          if (terminal.rowCount) throw new TaskChannelError(409, 'terminal_attempt');
          const sequence = await client.query(
            'SELECT 1 FROM core.task_mailbox WHERE task_id=$1 AND direction=$2 AND attempt_id=$3 AND sequence=$4',
            [frame.taskId, frame.direction, frame.attemptId, frame.sequence]
          );
          if (sequence.rowCount) throw new TaskChannelError(409, 'sequence_conflict');
          const transcriptCollision = await client.query<{ message_id: string }>(
            `SELECT message_id FROM core.task_transcript WHERE task_id=$1 AND
              (message_id=$2 OR (attempt_id=$3 AND sequence=$4))`,
            [frame.taskId, frame.messageId, frame.attemptId, frame.sequence]
          );
          if (transcriptCollision.rowCount)
            throw new TaskChannelError(
              409,
              transcriptCollision.rows[0]?.message_id === frame.messageId
                ? 'message_conflict'
                : 'sequence_conflict'
            );
          if (frame.kind === 'question') {
            const open = await client.query(
              'SELECT 1 FROM core.task_questions WHERE task_id=$1 AND answer_command_id IS NULL',
              [frame.taskId]
            );
            if (open.rowCount) throw new TaskChannelError(409, 'question_open');
            await client.query(
              'INSERT INTO core.task_questions(task_id,question_id) VALUES($1,$2)',
              [frame.taskId, frame.payload.questionId]
            );
          }
          if (frame.kind === 'step' || frame.kind === 'question') {
            await client.query(
              `UPDATE core.tasks SET state='running',updated_at=clock_timestamp() WHERE id=$1 AND state='starting'`,
              [frame.taskId]
            );
          }
          if (frame.kind === 'lifecycle') {
            await client.query(
              `UPDATE core.tasks SET state=$2,updated_at=clock_timestamp()
              WHERE id=$1 AND (state='starting' OR (state='running' AND $2='wrapping-up'))`,
              [frame.taskId, frame.payload.phase]
            );
          } else if (frame.kind === 'terminal') {
            await client.query(
              `UPDATE core.tasks SET state='wrapping-up',updated_at=clock_timestamp()
              WHERE id=$1 AND state IN ('starting','running')`,
              [frame.taskId]
            );
          }
          const inserted = await client.query<MailboxRow>(
            `INSERT INTO core.task_mailbox(task_id,attempt_id,direction,sequence,message_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
            [
              frame.taskId,
              frame.attemptId,
              frame.direction,
              frame.sequence,
              frame.messageId,
              frame.kind,
              JSON.stringify(frame.payload),
            ]
          );
          await client.query(
            `INSERT INTO core.task_mailbox_cursors(task_id,direction,received_count,last_received_message_id) VALUES($1,$2,1,$3)
          ON CONFLICT(task_id,direction) DO UPDATE SET received_count=core.task_mailbox_cursors.received_count+1,last_received_message_id=EXCLUDED.last_received_message_id`,
            [frame.taskId, frame.direction, frame.messageId]
          );
          await authority(client, binding);
          const row = inserted.rows[0];
          if (!row) throw new TaskChannelError(503, 'storage_error');
          return record(row).ack;
        },
        parent,
        () => {
          if (closing.signal.aborted || frame.kind === 'transcript') return;
          reconcile.set(frame.taskId, Symbol());
          deps.onAppendSettled?.();
        }
      );
    },
    listUnsignalled: async (limit = 100, parent) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new TaskChannelError(400, 'invalid_input');
      const pending = [...reconcile.entries()];
      const rows = await transaction(async (client) => {
        // A destroyed socket can reject COMMIT before PostgreSQL finishes it.
        // append holds this task's FOR UPDATE lock. Wait for its outcome before
        // the READ COMMITTED scan, not just for the pg promise to settle.
        if (pending.length)
          await client.query(
            'SELECT id FROM core.tasks WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',
            [pending.map(([taskId]) => taskId)]
          );
        const result = await client.query<MailboxRow>(
          `SELECT * FROM core.task_mailbox WHERE signalled_at IS NULL ORDER BY received_at,task_id,message_id LIMIT $1`,
          [limit]
        );
        return result.rows.map(record);
      }, parent);
      for (const [taskId, version] of pending)
        if (reconcile.get(taskId) === version) reconcile.delete(taskId);
      return rows;
    },
    markSignalled: async (taskId, direction, messageId, parent) => {
      requireKeys(taskId, direction, messageId);
      return transaction(async (client) => {
        // Same lock order as append; idempotent per-row ownership, not max(sequence).
        await client.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [taskId]);
        const result = await client.query(
          `UPDATE core.task_mailbox SET signalled_at=clock_timestamp() WHERE task_id=$1 AND direction=$2 AND message_id=$3 AND signalled_at IS NULL RETURNING message_id`,
          [taskId, direction, messageId]
        );
        if (result.rowCount)
          await client.query(
            `UPDATE core.task_mailbox_cursors SET signalled_count=signalled_count+1,last_signalled_message_id=$3 WHERE task_id=$1 AND direction=$2`,
            [taskId, direction, messageId]
          );
      }, parent);
    },
    readTerminal: async (taskId, attemptId, parent) => {
      requireKeys(taskId, 'task_to_core');
      if (!inputId(attemptId)) throw new TaskChannelError(400, 'invalid_input');
      return transaction(async (client) => {
        const result = await client.query<MailboxRow>(
          `SELECT * FROM core.task_mailbox WHERE task_id=$1 AND attempt_id=$2 AND kind='terminal'`,
          [taskId, attemptId]
        );
        return result.rows[0] ? record(result.rows[0]) : null;
      }, parent);
    },
    readTranscript: async (taskId, query = {}) => {
      requireKeys(taskId, 'task_to_core');
      const limit = query.limit ?? 20;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > TASK_TRANSCRIPT_LIMITS.page ||
        (query.before !== undefined &&
          (!/^[1-9][0-9]{0,18}$/.test(query.before) || BigInt(query.before) > 9223372036854775807n))
      )
        throw new TaskChannelError(400, 'invalid_input');
      return transaction(async (client) => {
        const rows = await client.query<{ ordinal: string; payload: TaskTranscriptEntry }>(
          `SELECT ordinal,payload FROM core.task_transcript WHERE task_id=$1 AND ($2::bigint IS NULL OR ordinal < $2::bigint) ORDER BY ordinal DESC LIMIT $3`,
          [taskId, query.before ?? null, limit + 1]
        );
        const dropped = await client.query(
          'SELECT 1 FROM core.task_transcript_horizons WHERE task_id=$1 LIMIT 1',
          [taskId]
        );
        return {
          entries: rows.rows
            .slice(0, limit)
            .sort(
              (a, b) =>
                Date.parse(b.payload.time) - Date.parse(a.payload.time) ||
                (BigInt(a.ordinal) < BigInt(b.ordinal) ? 1 : -1)
            )
            .map((row) => row.payload),
          nextCursor: rows.rows.length > limit ? (rows.rows[limit - 1]?.ordinal ?? null) : null,
          captureLimitReached: Boolean(dropped.rowCount),
        };
      });
    },
    readCursor: async (taskId, direction, parent) => {
      requireKeys(taskId, direction);
      return transaction(async (client) => {
        const result = await client.query<{
          received_count: string;
          last_received_message_id: string;
          signalled_count: string;
          last_signalled_message_id: string | null;
        }>('SELECT * FROM core.task_mailbox_cursors WHERE task_id=$1 AND direction=$2', [
          taskId,
          direction,
        ]);
        const row = result.rows[0];
        const cursor: TaskChannelCursor | null = row
          ? {
              taskId,
              direction,
              receivedCount: row.received_count,
              lastReceivedMessageId: row.last_received_message_id,
              signalledCount: row.signalled_count,
              lastSignalledMessageId: row.last_signalled_message_id,
            }
          : null;
        return cursor;
      }, parent);
    },
  };
}
