/**
 * The volume's day partitions, as the store lays them out (ADR-016 §5).
 *
 * The store keeps one directory per UTC day under `partitions/`, named
 * `YYYYMMDD`, and a restart re-attaches every directory still on disk. The
 * evictor therefore reads the directory as the truth about what is present: it
 * drops nothing that is not such a directory, drops the oldest one first, and
 * reports the bytes that directory held when it went.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_PATTERN = /^\d{8}$/;

/** The day partitions present, oldest first. A volume without them has none. */
export async function listLogPartitions(volumePath: string): Promise<string[]> {
  const directory = join(volumePath, 'partitions');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && DAY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** The bytes a directory holds: the sizes of the files inside it. */
async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

/** The bytes the partition holds, read before it is removed. */
export function logPartitionBytes(volumePath: string, day: string): Promise<number> {
  return directoryBytes(join(volumePath, 'partitions', day));
}

/**
 * Removes the partition directory from the volume. It is called only after the
 * store answered detach with 200 or its attached list confirmed the day's absence;
 * a failure here fails the run.
 */
export async function removeLogPartition(volumePath: string, day: string): Promise<void> {
  await rm(join(volumePath, 'partitions', day), { recursive: true, force: false });
}
