import type { Pool, PoolClient } from 'pg';
import type { TaskProfile } from '../ports/tasks.js';
import type {
  TaskChannelCursor,
  TaskChannelDirection,
  TaskChannelFrame,
  TaskMailbox,
  StoredTaskChannelFrame,
  TaskChannelProof,
} from '../ports/task-channel.js';
import { TaskChannelError, validateTaskChannelFrame } from '../ports/task-channel.js';
import { createFencedPostgres, StalePostgresEpochError } from './fenced-postgres.js';

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
    frame: { ...identity, kind: row.kind, payload: row.payload } as TaskChannelFrame,
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
}): TaskMailbox {
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
  const reconcile = new Map<string, symbol>();
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
        raw.on('error', () => undefined);
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
        return result;
      } catch (error) {
        if (error instanceof TaskChannelError || error instanceof StalePostgresEpochError)
          throw error;
        // No raw SQL error, detail, cause, input or bearer can leave this layer.
        throw new TaskChannelError(503, 'storage_error');
      } finally {
        destroy();
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
  async function resolveBinding(client: PoolClient, proof: TaskChannelProof): Promise<Binding> {
    // Resolve authority by freshly verified Job identity, not supplied task IDs.
    const found = await client.query<{ task_id: string }>(
      'SELECT task_id FROM core.task_launches WHERE job_name=$1 AND job_uid=$2',
      [proof?.jobName, proof?.jobUid]
    );
    const taskId = found.rows[0]?.task_id;
    if (found.rowCount !== 1 || !taskId) denied();
    const locked = await client.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [taskId]);
    if (locked.rowCount !== 1) denied();
    const launch = await client.query<Binding>(
      `SELECT l.*,t.state,t.terminal_candidate,t.started_at,t.profile,t.wrap_grace_seconds FROM core.task_launches l JOIN core.tasks t ON t.id=l.task_id WHERE l.task_id=$1 FOR UPDATE OF l`,
      [taskId]
    );
    const binding = launch.rows[0];
    if (
      !binding ||
      binding.job_uid !== proof.jobUid ||
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
  return {
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
        const result = await client.query<{ briefing: string }>(
          'SELECT briefing FROM core.tasks WHERE id=$1 AND octet_length(briefing)<=1048576',
          [binding.task_id]
        );
        await authority(client, binding);
        const briefing = result.rows[0]?.briefing;
        if (typeof briefing !== 'string') throw new TaskChannelError(503, 'channel_unavailable');
        const { id, revision, timeoutSeconds, cpuMillis, memoryBytes } = binding.profile;
        const response = {
          ...locators(binding),
          briefing,
          profile: { id, revision, timeoutSeconds, cpuMillis, memoryBytes },
        };
        if (Buffer.byteLength(JSON.stringify(response)) > 1_048_576)
          throw new TaskChannelError(503, 'channel_unavailable');
        return response;
      }, parent),
    stop: () => {
      closing.abort();
    },
    append: async (input, proof, parent) => {
      const frame = validateTaskChannelFrame(input);
      return transaction(
        async (client) => {
          const binding = await resolveBinding(client, proof);
          if (binding.task_id !== frame.taskId || binding.attempt_id !== frame.attemptId) denied();
          await authority(client, binding);
          await wonClaim(client, binding, proof);
          await authority(client, binding);
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
          if (closing.signal.aborted) return;
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
