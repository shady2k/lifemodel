/**
 * The store's partition API, in one file (ADR-016 §5).
 *
 * The evictor detaches through: `POST /internal/partition/detach`
 * with the day and the partition key as form fields. It answers 200 only
 * after the queries reading that partition have stopped, which is what makes
 * removing the directory safe. The path is the store's own protocol, so it is
 * named here and nowhere else.
 *
 * Failure is an answer, never a silent success: a refused connection, a
 * timeout or any status but 200 returns a reason and the key is not in it. The
 * detach error body is never read; list answers are validated before use.
 *
 * A failed result with `status: null` got no HTTP answer at all - the
 * connection was refused, reset or timed out - and is the one failure the
 * evictor retries for a bounded time (ADR-016 §5). A non-200 status is the
 * store's verdict and is never retried.
 */
export const LOGS_PARTITION_DETACH_PATH = 'internal/partition/detach';

export type PartitionDetachFailure = 'timeout' | 'connection_refused' | 'unreachable' | 'rejected';

export type PartitionDetachResult =
  | { readonly state: 'detached' }
  | {
      readonly state: 'failed';
      readonly reason: PartitionDetachFailure;
      /** The answer's status, or null when no answer came. */
      readonly status: number | null;
    };

export type PartitionListResult =
  | { readonly state: 'listed'; readonly days: string[] }
  | Extract<PartitionDetachResult, { state: 'failed' }>;

export interface LogsPartitionStore {
  list(): Promise<PartitionListResult>;
  detach(day: string): Promise<PartitionDetachResult>;
}

export interface LogsPartitionStoreOptions {
  /** The store's HTTP base, the same one the page's adapter reads. */
  readonly url: string;
  /** The partition key the store reads from its own file. */
  readonly key: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function failureReason(error: unknown): PartitionDetachFailure {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return 'timeout';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause?.code === 'ECONNREFUSED') return 'connection_refused';
  return 'unreachable';
}

export function createLogsPartitionStore(options: LogsPartitionStoreOptions): LogsPartitionStore {
  const endpoint = new URL(
    LOGS_PARTITION_DETACH_PATH,
    options.url.endsWith('/') ? options.url : `${options.url}/`
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async list(): Promise<PartitionListResult> {
      const target = new URL('list', endpoint);
      try {
        const response = await fetch(target, {
          method: 'POST',
          body: new URLSearchParams({ authKey: options.key }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return { state: 'failed', reason: 'rejected', status: response.status };
        }
        const days: unknown = await response.json();
        if (
          !Array.isArray(days) ||
          !days.every((day) => typeof day === 'string' && /^\d{8}$/.test(day))
        )
          return { state: 'failed', reason: 'rejected', status: response.status };
        return { state: 'listed', days };
      } catch (error) {
        return { state: 'failed', reason: failureReason(error), status: null };
      }
    },
    async detach(day: string): Promise<PartitionDetachResult> {
      const target = new URL(endpoint);
      const body = new URLSearchParams({ name: day, authKey: options.key });
      try {
        const response = await fetch(target, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        if (response.status === 200) return { state: 'detached' };
        return { state: 'failed', reason: 'rejected', status: response.status };
      } catch (error) {
        return { state: 'failed', reason: failureReason(error), status: null };
      }
    },
  };
}
