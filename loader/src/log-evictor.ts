/**
 * The log evictor (ADR-016 §5, check L16): new logs displace the oldest ones
 * with nobody acting.
 *
 * A run reads the volume's free space and, while it is below the threshold,
 * detaches the oldest day partition in the store, removes that directory only
 * after a 200 detach, then looks again. An absent day fails as stranded,
 * because a directory the store still has open must not be removed. One line
 * per drop; nothing on a run that drops nothing. A detach no connection
 * answered is retried first (below); one that still fails removes nothing and
 * fails the run, and so does a run that finds no partition left while the
 * volume is still below the threshold: a failed Job the owner can see, never a
 * silent loop.
 *
 * `module` on the stored record is the pod's `app.kubernetes.io/name`, set by
 * the collector; this line carries the day, the bytes freed and the reason.
 * The partition key travels to the store and appears in no line.
 *
 * Runs as `node /opt/lifemodel/loader/dist/log-evictor.js` from the CronJob.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  createLogsPartitionStore,
  type LogsPartitionStore,
  type PartitionDetachResult,
  type PartitionListResult,
} from './logs-partition-store.js';
import { listLogPartitions, logPartitionBytes, removeLogPartition } from './logs-partitions.js';
import { evictorThresholdBytes, readVolumeSpace, type VolumeSpace } from './logs-volume-space.js';

/** Where the CronJob mounts the log volume, the store's own data path. */
export const EVICTOR_VOLUME_MOUNT = '/data';

/** The store's Service, the only peer the job is allowed besides DNS. */
const DEFAULT_STORE_URL = 'http://logs-store.lifemodel-system.svc:9428';

/**
 * A detach that got no answer at all - a connection refused, reset or timed
 * out, which is what a new pod's not-yet-synced network policy produces - is
 * retried, because the store answers a second later and a run that gave up
 * would drop nothing and fail the Job (ADR-016 §5). The window and the
 * backoff fit inside the Job's 60 s deadline; a store that answers, whatever
 * its status, is not retried: that answer is its verdict.
 */
export const CONNECT_RETRY_WINDOW_MS = 20_000;
export const CONNECT_RETRY_DELAYS_MS: readonly number[] = [
  250, 500, 1000, 2000, 4000, 4000, 4000, 4000,
];

export interface ConnectRetry {
  /** The longest a run spends retrying, the attempts themselves included. */
  readonly windowMs: number;
  /** The waits in order; the last one repeats. */
  readonly delaysMs: readonly number[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export const DEFAULT_CONNECT_RETRY: ConnectRetry = {
  windowMs: CONNECT_RETRY_WINDOW_MS,
  delaysMs: CONNECT_RETRY_DELAYS_MS,
  sleep: realSleep,
  now: () => Date.now(),
};

export interface LogEvictorDeps {
  readonly volumePath: string;
  readonly store: LogsPartitionStore;
  readonly space: (path: string) => Promise<VolumeSpace>;
  readonly write: (line: string) => void;
  readonly connectRetry?: ConnectRetry;
}

function failureLine(
  reason: string,
  space: VolumeSpace | null,
  detail: {
    readonly day?: string;
    readonly status?: number | null;
    readonly attempts?: number;
  } = {}
): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level: 'error',
    msg: 'the log evictor removed nothing',
    reason,
    ...(detail.day === undefined ? {} : { day: detail.day }),
    ...(detail.status === undefined || detail.status === null ? {} : { status: detail.status }),
    ...(detail.attempts === undefined || detail.attempts < 2 ? {} : { attempts: detail.attempts }),
    ...(space === null
      ? {}
      : {
          availableBytes: space.availableBytes,
          thresholdBytes: evictorThresholdBytes(space.totalBytes),
        }),
  });
}

function dropLine(day: string, freedBytes: number): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level: 'info',
    msg: 'the oldest log day was removed',
    day,
    freedBytes,
    reason: 'below_threshold',
  });
}

/**
 * Retry a partition call only when no answer came: a failure that carries
 * a status is the store's own verdict and is returned at once.
 */
async function partitionCallWithRetry<T extends PartitionDetachResult | PartitionListResult>(
  call: () => Promise<T>,
  retry: ConnectRetry
): Promise<{ readonly result: T; readonly attempts: number }> {
  const startedAt = retry.now();
  let result = await call();
  let attempts = 1;
  while (result.state === 'failed' && result.status === null) {
    const delayMs = retry.delaysMs[Math.min(attempts - 1, retry.delaysMs.length - 1)];
    // The window counts its own attempts: a store that hangs until the request
    // timeout must not stretch the wait past the Job's deadline.
    if (delayMs === undefined || retry.now() - startedAt + delayMs > retry.windowMs) break;
    await retry.sleep(delayMs);
    attempts += 1;
    result = await call();
  }
  return { result, attempts };
}

export async function runLogEvictor(deps: LogEvictorDeps): Promise<number> {
  const retry = deps.connectRetry ?? DEFAULT_CONNECT_RETRY;
  const read = async (): Promise<VolumeSpace | null> => {
    try {
      return await deps.space(deps.volumePath);
    } catch {
      deps.write(failureLine('volume_unreadable', null));
      return null;
    }
  };

  let space = await read();
  if (space === null) return 1;
  while (space.availableBytes < evictorThresholdBytes(space.totalBytes)) {
    let present: string[];
    try {
      present = await listLogPartitions(deps.volumePath);
    } catch {
      deps.write(failureLine('volume_unreadable', space));
      return 1;
    }
    const day = present[0];
    if (day === undefined) {
      deps.write(failureLine('no_partition', space));
      return 1;
    }
    const { result: attached, attempts: listAttempts } = await partitionCallWithRetry(
      () => deps.store.list(),
      retry
    );
    if (attached.state === 'failed') {
      deps.write(
        failureLine(attached.reason, space, {
          day,
          status: attached.status,
          attempts: listAttempts,
        })
      );
      return 1;
    }
    if (!attached.days.includes(day)) {
      // List absence precedes drain completion in the store. Only a 200
      // detach acknowledges that readers and final flushes have finished.
      deps.write(failureLine('stranded_partition', space, { day }));
      return 1;
    }
    const { result: detach, attempts } = await partitionCallWithRetry(
      () => deps.store.detach(day),
      retry
    );
    if (detach.state !== 'detached') {
      deps.write(failureLine(detach.reason, space, { day, status: detach.status, attempts }));
      return 1;
    }
    let freedBytes: number;
    try {
      freedBytes = await logPartitionBytes(deps.volumePath, day);
      await removeLogPartition(deps.volumePath, day);
    } catch {
      deps.write(failureLine('remove_failed', space, { day }));
      return 1;
    }
    deps.write(dropLine(day, freedBytes));
    const next = await read();
    if (next === null) return 1;
    space = next;
  }
  return 0;
}

/** Missing configuration is a startup failure, never a silent default. */
function main(): void {
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const volumePath = process.env['LIFEMODEL_LOGS_VOLUME_PATH'] ?? EVICTOR_VOLUME_MOUNT;
  const storeUrl = process.env['LIFEMODEL_LOGS_STORE_URL'] ?? DEFAULT_STORE_URL;
  // An empty value is a real state - the Secret is declared empty and the
  // store has no key yet - so only an absent variable stops the job.
  const key = process.env['LIFEMODEL_LOGS_PARTITION_KEY'];
  if (key === undefined) {
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        msg: 'the log evictor cannot start',
        reason: 'missing_partition_key',
        name: 'LIFEMODEL_LOGS_PARTITION_KEY',
      })
    );
    process.exitCode = 1;
    return;
  }
  // The exit code is left to the drained stdout: the job's standard output is
  // a pipe to the kubelet, and an exit before it drains loses the one line the
  // owner reads.
  void runLogEvictor({
    volumePath,
    store: createLogsPartitionStore({ url: storeUrl, key }),
    space: readVolumeSpace,
    write,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      write(failureLine('unexpected_failure', null));
      process.exitCode = 1;
    }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
