/**
 * Volatile, metadata-only admission. Store state never depends on these leases.
 * Acquire before allocating a chunk, release in finally, and keep the signal
 * connected to the request until the operation has stopped using its buffer.
 */
import { StorageAccessError } from './storage-access-error.js';

const MiB = 1024 * 1024;
export const STORAGE_ADMISSION_DEFAULTS = Object.freeze({
  chunkBytes: 4 * MiB,
  transferWorkers: 8,
  perSpaceWorkers: 2,
  reservedReadWorkers: 2,
  controlWorkers: 2,
  bufferBytes: 32 * MiB,
  queueRequests: 32,
  queueBytes: 64 * 1024,
  queueWaitMs: 900,
  chunkDeadlineMs: 10_000,
});
export type StorageAdmissionSettings = {
  -readonly [K in keyof typeof STORAGE_ADMISSION_DEFAULTS]: number;
};

export const STORAGE_ADMISSION_ENV: Readonly<Record<keyof StorageAdmissionSettings, string>> =
  Object.freeze({
    chunkBytes: 'LIFEMODEL_STORAGE_CHUNK_BYTES',
    transferWorkers: 'LIFEMODEL_STORAGE_TRANSFER_WORKERS',
    perSpaceWorkers: 'LIFEMODEL_STORAGE_PER_SPACE_WORKERS',
    reservedReadWorkers: 'LIFEMODEL_STORAGE_RESERVED_READ_WORKERS',
    controlWorkers: 'LIFEMODEL_STORAGE_CONTROL_WORKERS',
    bufferBytes: 'LIFEMODEL_STORAGE_BUFFER_BYTES',
    queueRequests: 'LIFEMODEL_STORAGE_QUEUE_REQUESTS',
    queueBytes: 'LIFEMODEL_STORAGE_QUEUE_BYTES',
    queueWaitMs: 'LIFEMODEL_STORAGE_QUEUE_WAIT_MS',
    chunkDeadlineMs: 'LIFEMODEL_STORAGE_CHUNK_DEADLINE_MS',
  });

/** Hard upper bounds are the reviewed ADR-015 resource budget, not recommendations. */
export function validateStorageAdmissionSettings(
  input: unknown
): Readonly<StorageAdmissionSettings> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid_storage_admission_settings');
  const supplied = input as Record<string, unknown>;
  if (Object.keys(supplied).some((key) => !Object.hasOwn(STORAGE_ADMISSION_DEFAULTS, key)))
    throw new Error('invalid_storage_admission_settings');
  const settings: StorageAdmissionSettings = { ...STORAGE_ADMISSION_DEFAULTS };
  for (const key of Object.keys(settings) as (keyof StorageAdmissionSettings)[]) {
    const value = Object.hasOwn(supplied, key) ? supplied[key] : settings[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > STORAGE_ADMISSION_DEFAULTS[key]
    )
      throw new Error('invalid_storage_admission_settings');
    settings[key] = value;
  }
  if (
    settings.reservedReadWorkers >= settings.transferWorkers ||
    settings.perSpaceWorkers > settings.transferWorkers ||
    settings.bufferBytes < (settings.reservedReadWorkers + 1) * settings.chunkBytes
  )
    throw new Error('invalid_storage_admission_settings');
  return Object.freeze(settings);
}

export function readStorageAdmissionSettings(
  env: NodeJS.ProcessEnv = process.env
): Readonly<StorageAdmissionSettings> {
  const values: Partial<StorageAdmissionSettings> = {};
  for (const key of Object.keys(STORAGE_ADMISSION_ENV) as (keyof StorageAdmissionSettings)[]) {
    const value = env[STORAGE_ADMISSION_ENV[key]];
    if (value === undefined) continue;
    // No whitespace, fractions, exponential notation or infinity; never echo a value.
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error('invalid_storage_admission_settings');
    values[key] = Number(value);
  }
  return validateStorageAdmissionSettings(values);
}

export class StorageAdmissionError extends StorageAccessError {
  readonly retryAfter = 1;
  constructor() {
    super(429, 'storage_overloaded');
    this.name = 'StorageAdmissionError';
  }
}
export type StorageAdmissionRole = 'task' | 'read' | 'control';
export interface StorageAdmissionRequest {
  space: string;
  role: StorageAdmissionRole;
  bytes: number;
  signal: AbortSignal;
  metadataBytes?: number;
}
export interface StorageAdmissionLease {
  release(): void;
}
export interface StorageAdmissionCounters {
  /** Transfer workers only; controls have their own independent pool. */
  active: number;
  task: number;
  read: number;
  control: number;
  bufferedBytes: number;
  queued: number;
  queueBytes: number;
}
export interface StorageAdmissionSnapshot extends StorageAdmissionCounters {
  /** Combined transfer telemetry; task and read admission caps are independent. */
  bySpace: Record<string, number>;
  /** maxPerSpace is the maximum within either role, not their combined count. */
  observed: StorageAdmissionCounters & { maxPerSpace: number };
}
export interface StorageAdmission {
  readonly settings: Readonly<StorageAdmissionSettings>;
  acquire(request: StorageAdmissionRequest): Promise<StorageAdmissionLease>;
  snapshot(): StorageAdmissionSnapshot;
}
interface Pending {
  space: string;
  role: StorageAdmissionRole;
  bytes: number;
  signal: AbortSignal;
  metadataBytes: number;
  resolve(lease: StorageAdmissionLease): void;
  reject(error: Error): void;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
function aborted(): Error {
  const error = new Error('storage_request_aborted');
  error.name = 'AbortError';
  return error;
}

export function createStorageAdmission(
  input: Partial<StorageAdmissionSettings> = {}
): StorageAdmission {
  const settings = validateStorageAdmissionSettings(input);
  const queue: Pending[] = [];
  const bySpace = new Map<string, number>();
  const byRoleSpace = { task: new Map<string, number>(), read: new Map<string, number>() };
  const current: StorageAdmissionCounters = {
    active: 0,
    task: 0,
    read: 0,
    control: 0,
    bufferedBytes: 0,
    queued: 0,
    queueBytes: 0,
  };
  const observed = { ...current, maxPerSpace: 0 };
  let taskBytes = 0;
  let lastTransferSpace: string | undefined;
  let lastControlSpace: string | undefined;

  function observe(): void {
    for (const key of Object.keys(current) as (keyof StorageAdmissionCounters)[])
      observed[key] = Math.max(observed[key], current[key]);
    for (const counts of Object.values(byRoleSpace))
      for (const count of counts.values())
        observed.maxPerSpace = Math.max(observed.maxPerSpace, count);
  }
  function eligible(request: Pick<Pending, 'role' | 'space' | 'bytes'>): boolean {
    if (request.role === 'control') return current.control < settings.controlWorkers;
    if (
      current.active >= settings.transferWorkers ||
      (byRoleSpace[request.role].get(request.space) ?? 0) >= settings.perSpaceWorkers ||
      current.bufferedBytes + request.bytes > settings.bufferBytes
    )
      return false;
    if (
      request.role === 'task' &&
      (current.task >= settings.transferWorkers - settings.reservedReadWorkers ||
        taskBytes + request.bytes >
          settings.bufferBytes - settings.reservedReadWorkers * settings.chunkBytes)
    )
      return false;
    return true;
  }
  function remove(pending: Pending): void {
    const index = queue.indexOf(pending);
    if (index < 0) return;
    queue.splice(index, 1);
    current.queued -= 1;
    current.queueBytes -= pending.metadataBytes;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.abort);
  }
  function grant(pending: Pending): void {
    remove(pending);
    if (pending.role === 'control') {
      current.control += 1;
      lastControlSpace = pending.space;
    } else {
      current.active += 1;
      current[pending.role] += 1;
      current.bufferedBytes += pending.bytes;
      if (pending.role === 'task') taskBytes += pending.bytes;
      bySpace.set(pending.space, (bySpace.get(pending.space) ?? 0) + 1);
      const counts = byRoleSpace[pending.role];
      counts.set(pending.space, (counts.get(pending.space) ?? 0) + 1);
      lastTransferSpace = pending.space;
    }
    observe();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      pending.signal.removeEventListener('abort', release);
      if (pending.role === 'control') current.control -= 1;
      else {
        current.active -= 1;
        current[pending.role] -= 1;
        current.bufferedBytes -= pending.bytes;
        if (pending.role === 'task') taskBytes -= pending.bytes;
        const counts = byRoleSpace[pending.role];
        const roleCount = (counts.get(pending.space) ?? 1) - 1;
        if (roleCount === 0) counts.delete(pending.space);
        else counts.set(pending.space, roleCount);
        const count = (bySpace.get(pending.space) ?? 1) - 1;
        if (count === 0) bySpace.delete(pending.space);
        else bySpace.set(pending.space, count);
      }
      drain();
    };
    // Cancellation requests that a control handler stop. Only its finally may
    // retire execution capacity after SQL/S3 and cleanup have actually settled.
    if (pending.role !== 'control')
      pending.signal.addEventListener('abort', release, { once: true });
    pending.resolve({ release });
  }
  function next(control: boolean): Pending | undefined {
    const candidates = queue.filter((request) => (request.role === 'control') === control);
    const spaces = [...new Set(candidates.map((request) => request.space))];
    const last = control ? lastControlSpace : lastTransferSpace;
    const start = last === undefined ? -1 : spaces.indexOf(last);
    for (let offset = 1; offset <= spaces.length; offset += 1) {
      const space = spaces[(start + offset) % spaces.length];
      const pending = candidates.find((request) => request.space === space && eligible(request));
      if (pending) return pending;
    }
    return undefined;
  }
  function drain(): void {
    for (const control of [true, false]) {
      let pending: Pending | undefined;
      while ((pending = next(control)) !== undefined) grant(pending);
    }
  }

  return {
    settings,
    acquire: async (request) => {
      if (
        typeof request.space !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(request.space) ||
        !['task', 'read', 'control'].includes(request.role) ||
        !Number.isSafeInteger(request.bytes) ||
        request.bytes < 0 ||
        request.bytes > settings.chunkBytes ||
        (request.role === 'control' && request.bytes !== 0) ||
        (request.metadataBytes !== undefined &&
          (!Number.isSafeInteger(request.metadataBytes) || request.metadataBytes < 0))
      )
        throw new StorageAccessError(400, 'invalid_admission');
      if (request.signal.aborted) throw aborted();
      // Charge a finite minimum for the scheduler's own metadata. Caller-supplied
      // overhead may increase this charge but can never reduce it.
      const metadataBytes = Math.max(
        128 + Buffer.byteLength(request.space),
        request.metadataBytes ?? 0
      );
      return new Promise<StorageAdmissionLease>((resolve, reject) => {
        const pending: Pending = {
          space: request.space,
          role: request.role,
          bytes: request.bytes,
          signal: request.signal,
          metadataBytes,
          resolve,
          reject,
          abort: () => {
            remove(pending);
            reject(aborted());
            drain();
          },
        };
        // Eligible work may use an independent pool even when another pool's
        // queue is full. Existing queued work still gets first selection.
        drain();
        if (
          eligible(pending) &&
          !queue.some((entry) => entry.role === pending.role && eligible(entry))
        ) {
          grant(pending);
          return;
        }
        if (
          current.queued >= settings.queueRequests ||
          current.queueBytes + metadataBytes > settings.queueBytes
        ) {
          reject(new StorageAdmissionError());
          return;
        }
        queue.push(pending);
        current.queued += 1;
        current.queueBytes += metadataBytes;
        observe();
        pending.signal.addEventListener('abort', pending.abort, { once: true });
        pending.timer = setTimeout(() => {
          remove(pending);
          reject(new StorageAdmissionError());
          drain();
        }, settings.queueWaitMs);
        pending.timer.unref();
      });
    },
    snapshot: () => ({
      ...current,
      bySpace: Object.fromEntries(bySpace),
      observed: { ...observed },
    }),
  };
}
