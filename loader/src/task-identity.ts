/** The gateway's durable once-only door. No caller ID is identity evidence. */
import { Pool, type PoolClient } from 'pg';
import { StorageAccessError } from './storage-access-error.js';
import type { TaskKubernetesProof } from './task-kubernetes-identity.js';
import { storageMaintenanceFence } from './storage-maintenance.js';

export interface TaskStart {
  taskId: string;
  attemptId: string;
  launchId: string;
  bootNonce: string;
}
export interface TaskIdentityOptions {
  /** Lazy credentials let step A start before Postgres is installed in C. */
  connectionString: string | ((signal: AbortSignal) => Promise<string>);
  identity: { verify(token: string, signal?: AbortSignal): Promise<TaskKubernetesProof> };
  timeoutMs?: number;
}
interface Binding {
  task_id: string;
  attempt_id: string;
  launch_id: string;
  job_name: string;
  job_uid: string;
  template_hash: string;
  allocation_receipt: { space: string } | null;
  started_at: Date;
  profile: { timeoutSeconds: number };
  wrap_grace_seconds: number;
  soft_stop_requested_at: Date | null;
}
function denied(): never {
  throw new StorageAccessError(403, 'task_denied');
}
export function createTaskIdentity(options: TaskIdentityOptions) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let pool: Pool | undefined;
  let poolUrl: string | undefined;
  let closed = false;
  const failed = new WeakSet<PoolClient>();
  const operations = new Set<AbortController>();
  async function getPool(signal: AbortSignal): Promise<Pool> {
    const url =
      typeof options.connectionString === 'string'
        ? options.connectionString
        : await options.connectionString(signal);
    if (closed) throw new StorageAccessError(503, 'task_unavailable');
    if (pool && poolUrl !== url) {
      // Rotation never falls back to stale credentials. Existing requests retain
      // their own pool; end() waits for their checked-out clients.
      void pool.end().catch(() => undefined);
      pool = undefined;
    }
    if (!pool) {
      poolUrl = url;
      pool = new Pool({
        connectionString: url,
        max: 8,
        application_name: 'lifemodel-task-identity',
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        statement_timeout: timeoutMs,
        lock_timeout: timeoutMs,
        idleTimeoutMillis: 1000,
        allowExitOnIdle: true,
      });
      pool.on('error', () => undefined);
      pool.on('connect', (client) =>
        client.on('error', () => {
          failed.add(client);
        })
      );
    }
    return pool;
  }
  async function transaction<T>(
    run: (client: PoolClient) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    let client: PoolClient | undefined;
    let retired = false;
    const abort = () => {
      if (client && !retired) {
        retired = true;
        client.release(true);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const source = await getPool(signal);
      signal.throwIfAborted();
      client = await new Promise<PoolClient>((resolve, reject) => {
        const cancel = () => {
          reject(new StorageAccessError(503, 'task_unavailable'));
        };
        signal.addEventListener('abort', cancel, { once: true });
        void source.connect().then(
          (acquired) => {
            signal.removeEventListener('abort', cancel);
            if (signal.aborted || closed) {
              acquired.release(true);
              cancel();
            } else resolve(acquired);
          },
          () => {
            signal.removeEventListener('abort', cancel);
            cancel();
          }
        );
      });
      if (signal.aborted) abort();
      signal.throwIfAborted();
      await client.query('BEGIN');
      await storageMaintenanceFence(client);
      const result = await run(client);
      signal.throwIfAborted();
      if (failed.has(client)) throw new StorageAccessError(503, 'task_unavailable');
      try {
        await client.query('COMMIT');
      } catch (error) {
        failed.add(client);
        throw error;
      }
      signal.throwIfAborted();
      return result;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (
        client &&
        !(error instanceof StorageAccessError) &&
        (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code))
      )
        failed.add(client);
      if (client && !retired && !failed.has(client))
        await client.query('ROLLBACK').catch(() => {
          if (client) failed.add(client);
        });
      if (error instanceof StorageAccessError) throw error;
      throw new StorageAccessError(503, 'task_unavailable');
    } finally {
      signal.removeEventListener('abort', abort);
      if (client && !retired) client.release(failed.has(client));
    }
  }
  async function verified<T>(
    token: string,
    parent: AbortSignal | undefined,
    run: (client: PoolClient, proof: TaskKubernetesProof, binding: Binding) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    operations.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
      ...(parent ? [parent] : []),
    ]);
    try {
      if (closed) throw new StorageAccessError(503, 'task_unavailable');
      const proof = await options.identity.verify(token, signal);
      return await transaction(async (client) => {
        // Discover by verified Job identity, NEVER the caller's requested task.
        const found = await client.query<{ task_id: string }>(
          'SELECT task_id FROM core.task_launches WHERE job_name=$1 AND job_uid=$2',
          [proof.jobName, proof.jobUid]
        );
        if (found.rows.length !== 1) denied();
        const taskId = found.rows[0]?.task_id;
        if (!taskId) denied();
        // Same order as the canonical writer: task -> launch -> intent -> space.
        const task = await client.query(
          `SELECT id FROM core.tasks WHERE id=$1
          AND state IN ('starting','running','wrapping-up') AND terminal_candidate IS NULL FOR SHARE`,
          [taskId]
        );
        if (task.rowCount !== 1) denied();
        const result = await client.query<Binding>(
          `SELECT l.*,t.started_at,t.profile,t.wrap_grace_seconds
          FROM core.task_launches l JOIN core.tasks t ON t.id=l.task_id
          WHERE l.task_id=$1 AND l.slot_reserved AND l.tombstoned_at IS NULL
          FOR SHARE OF l`,
          [taskId]
        );
        const binding = result.rows[0];
        if (
          binding?.job_uid !== proof.jobUid ||
          binding.job_name !== proof.jobName ||
          !/^launch_[0-9a-f]{64}$/.test(binding.launch_id) ||
          binding.launch_id.slice(7, 65) !== proof.launchLabel ||
          binding.job_name !== `task-${proof.launchLabel}` ||
          binding.template_hash !== proof.templateHash ||
          binding.started_at?.getTime() !== new Date(proof.startedAt).getTime()
        )
          denied();
        return run(client, proof, binding);
      }, signal);
    } catch (error) {
      if (error instanceof StorageAccessError) throw error;
      throw new StorageAccessError(503, 'task_unavailable');
    } finally {
      operations.delete(controller);
    }
  }
  async function intent(client: PoolClient, binding: Binding, start: boolean) {
    const values = [binding.task_id, binding.attempt_id, binding.launch_id];
    const locked = await client.query(
      `SELECT 1 FROM task_access.intents
      WHERE task_id=$1 AND attempt_id=$2 AND launch_id=$3 FOR SHARE`,
      values
    );
    if (locked.rowCount !== 1) denied();
    // This statement's clock is AFTER the lock wait, not transaction start.
    const current = await client.query<{
      revision: string;
      mode: string;
      soft_due_at: Date;
      hard_stop_at: Date;
    }>(
      `SELECT revision::text,mode,soft_due_at,hard_stop_at FROM task_access.intents
       WHERE task_id=$1 AND attempt_id=$2 AND launch_id=$3 AND mode IN (${start ? "'active'" : "'active','wrapping'"})
       AND clock_timestamp()<hard_stop_at`,
      values
    );
    const row = current.rows[0];
    if (!row) denied();
    const originalSoft = binding.started_at.getTime() + binding.profile.timeoutSeconds * 1000;
    if (
      row.soft_due_at.getTime() > originalSoft ||
      row.hard_stop_at.getTime() > originalSoft + binding.wrap_grace_seconds * 1000
    )
      denied();
    return row;
  }
  return {
    close: async () => {
      closed = true;
      for (const op of operations) op.abort();
      await pool?.end();
    },
    start: async (input: TaskStart, token: string, signal?: AbortSignal) => {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        typeof input.taskId !== 'string' ||
        typeof input.attemptId !== 'string' ||
        typeof input.launchId !== 'string' ||
        typeof input.bootNonce !== 'string' ||
        Object.keys(input).sort().join(',') !== 'attemptId,bootNonce,launchId,taskId' ||
        !/^task_[0-9a-f]{64}$/.test(input.taskId) ||
        !/^attempt_[0-9a-f]{64}$/.test(input.attemptId) ||
        !/^launch_[0-9a-f]{64}$/.test(input.launchId) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(input.bootNonce)
      )
        throw new StorageAccessError(400, 'invalid_request');
      return verified(token, signal, async (client, proof, binding) => {
        if (
          input.taskId !== binding.task_id ||
          input.attemptId !== binding.attempt_id ||
          input.launchId !== binding.launch_id
        )
          denied();
        if (binding.soft_stop_requested_at != null) denied();
        await intent(client, binding, true);
        const spaceId = binding.allocation_receipt?.space;
        if (!spaceId) denied();
        const allocation = await client.query<{ access_revision: string }>(
          `SELECT s.access_revision::text FROM storage.allocations a
          JOIN storage.spaces s ON s.id=a.space_id WHERE a.task_id=$1 AND a.launch_id=$2 AND a.space_id=$3
          AND s.mode IN ('open','wrapping') FOR SHARE OF s`,
          [binding.task_id, binding.launch_id, spaceId]
        );
        const allocated = allocation.rows[0];
        if (allocation.rowCount !== 1 || !allocated) denied();
        // A space lock can wait. Recheck canonical DB time after that wait.
        const authority = await intent(client, binding, true);
        const claim = await client.query(
          `INSERT INTO task_access.start_claims
          (launch_id,task_id,attempt_id,pod_uid,job_uid,boot_nonce,job_started_at,soft_due_at,hard_stop_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING launch_id`,
          [
            binding.launch_id,
            binding.task_id,
            binding.attempt_id,
            proof.podUid,
            proof.jobUid,
            input.bootNonce,
            proof.startedAt,
            authority.soft_due_at,
            authority.hard_stop_at,
          ]
        );
        if (claim.rowCount !== 1) throw new StorageAccessError(409, 'start_consumed');
        await client.query(
          `INSERT INTO task_access.projections
          (task_id,attempt_id,launch_id,job_uid,pod_uid,pod_name,job_name,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            binding.task_id,
            binding.attempt_id,
            binding.launch_id,
            proof.jobUid,
            proof.podUid,
            proof.podName,
            proof.jobName,
            spaceId,
            allocated.access_revision,
            authority.revision,
            authority.mode,
            authority.soft_due_at,
            authority.hard_stop_at,
          ]
        );
        // A late query/DDL wait cannot turn an expired launch into a start.
        await intent(client, binding, true);
        return {
          start: true as const,
          taskId: binding.task_id,
          attemptId: binding.attempt_id,
          launchId: binding.launch_id,
          space: spaceId,
          softDueAt: authority.soft_due_at.toISOString(),
          hardStopAt: authority.hard_stop_at.toISOString(),
        };
      });
    },
    authorize: async (token: string, signal?: AbortSignal) =>
      verified(token, signal, async (client, proof, binding) => {
        await intent(client, binding, false);
        const claim = await client.query(
          `SELECT 1 FROM task_access.start_claims c
        JOIN task_access.projections p USING(task_id,attempt_id,launch_id)
        WHERE c.launch_id=$1 AND c.pod_uid=$2 AND c.job_uid=$3 AND p.pod_uid=c.pod_uid AND p.job_uid=c.job_uid`,
          [binding.launch_id, proof.podUid, proof.jobUid]
        );
        if (claim.rowCount !== 1) denied();
        await intent(client, binding, false);
        return { taskId: binding.task_id };
      }),
  };
}
