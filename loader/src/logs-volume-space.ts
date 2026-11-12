/**
 * The log volume's free space and the evictor's threshold (ADR-016 §5).
 *
 * Logs have a filesystem of their own, so this reads that filesystem and
 * nothing else. The threshold is the margin the store keeps for its merges (a
 * quarter of the volume, the same share `-storage.minFreeDiskSpaceBytes` is set
 * to) plus 768 MiB: one minute of a realistic flood on disk, plus the slack a
 * CronJob may start a minute late. Below it a run drops the oldest day.
 */
import { statfs } from 'node:fs/promises';

/** The share of the volume the store keeps free for its merges. */
export const LOGS_VOLUME_MARGIN_SHARE = 0.25;

/** One minute of a realistic flood on disk, and the slack of a late start. */
export const EVICTOR_HEADROOM_BYTES = 768 * 1024 * 1024;

export interface VolumeSpace {
  readonly totalBytes: number;
  readonly availableBytes: number;
}

/** The free space below which a run drops the oldest partition. */
export function evictorThresholdBytes(totalBytes: number): number {
  return Math.ceil(totalBytes * LOGS_VOLUME_MARGIN_SHARE) + EVICTOR_HEADROOM_BYTES;
}

/**
 * The volume's size and the space left for its own writer. `f_bavail`, not
 * `f_bfree`: the store and the job both run as uid 1000, never as root, so the
 * filesystem's root reserve is not theirs to spend.
 */
export async function readVolumeSpace(path: string): Promise<VolumeSpace> {
  const stats = await statfs(path);
  return {
    totalBytes: stats.bsize * stats.blocks,
    availableBytes: stats.bsize * stats.bavail,
  };
}
