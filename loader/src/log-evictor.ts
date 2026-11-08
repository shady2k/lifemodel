/**
 * The log evictor (ADR-016 §5, check L16): new logs displace the oldest ones
 * with nobody acting.
 *
 * A run reads the volume's free space and, while it is below the threshold,
 * detaches the oldest day partition in the store, removes that directory only
 * after the detach answered 200, and looks again - never the other way round,
 * because a directory the store still has open must not be removed. One line
 * per drop; nothing on a run that drops nothing. A detach that fails removes
 * nothing and fails the run, and so does a run that finds no partition left
 * while the volume is still below the threshold: a failed Job the owner can
 * see, never a silent loop.
 *
 * `module` on the stored record is the pod's `app.kubernetes.io/name`, set by
 * the collector; this line carries the day, the bytes freed and the reason.
 * The partition key travels to the store and appears in no line.
 *
 * Runs as `node /opt/lifemodel/loader/dist/log-evictor.js` from the CronJob.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createLogsPartitionStore, type LogsPartitionStore } from './logs-partition-store.js';
import { listLogPartitions, logPartitionBytes, removeLogPartition } from './logs-partitions.js';
import { evictorThresholdBytes, readVolumeSpace, type VolumeSpace } from './logs-volume-space.js';

/** Where the CronJob mounts the log volume, the store's own data path. */
export const EVICTOR_VOLUME_MOUNT = '/data';

/** The store's Service, the only peer the job is allowed besides DNS. */
const DEFAULT_STORE_URL = 'http://logs-store.lifemodel-system.svc:9428';

export interface LogEvictorDeps {
  readonly volumePath: string;
  readonly store: LogsPartitionStore;
  readonly space: (path: string) => Promise<VolumeSpace>;
  readonly write: (line: string) => void;
}

function failureLine(
  reason: string,
  space: VolumeSpace | null,
  detail: { readonly day?: string; readonly status?: number | null } = {}
): string {
  return JSON.stringify({
    time: new Date().toISOString(),
    level: 'error',
    msg: 'the log evictor removed nothing',
    reason,
    ...(detail.day === undefined ? {} : { day: detail.day }),
    ...(detail.status === undefined || detail.status === null ? {} : { status: detail.status }),
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

export async function runLogEvictor(deps: LogEvictorDeps): Promise<number> {
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
    const detach = await deps.store.detach(day);
    if (detach.state !== 'detached') {
      deps.write(failureLine(detach.reason, space, { day, status: detach.status }));
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
