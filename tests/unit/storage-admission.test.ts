import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStorageAdmission,
  readStorageAdmissionSettings,
  validateStorageAdmissionSettings,
  STORAGE_ADMISSION_DEFAULTS,
  type StorageAdmission,
} from '../../loader/src/storage-admission.js';

const MiB = 1024 * 1024;
const signal = (): AbortSignal => new AbortController().signal;
function request(
  admission: StorageAdmission,
  space: string,
  role: 'task' | 'read' | 'control' = 'task',
  bytes = MiB
) {
  return admission.acquire({ space, role, bytes, signal: signal() });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('storage admission settings', () => {
  it('declares bounded defaults and accepts validated environment settings', () => {
    expect(readStorageAdmissionSettings({})).toEqual({
      chunkBytes: 4 * MiB,
      transferWorkers: 8,
      perSpaceWorkers: 2,
      reservedReadWorkers: 2,
      controlWorkers: 2,
      bufferBytes: 32 * MiB,
      queueRequests: 32,
      queueBytes: 64 * 1024,
      queueWaitMs: 800,
      chunkDeadlineMs: 10_000,
    });
    expect(
      readStorageAdmissionSettings({
        LIFEMODEL_STORAGE_TRANSFER_WORKERS: '4',
        LIFEMODEL_STORAGE_QUEUE_WAIT_MS: '500',
      })
    ).toMatchObject({ transferWorkers: 4, queueWaitMs: 500 });
    expect(validateStorageAdmissionSettings({})).toEqual(STORAGE_ADMISSION_DEFAULTS);
  });

  it('rejects non-finite, fractional, out-of-bound and contradictory settings instead of clamping', () => {
    for (const key of Object.keys(STORAGE_ADMISSION_DEFAULTS)) {
      for (const value of [NaN, Infinity, -1, 0, 1.5, '2', null])
        expect(() => validateStorageAdmissionSettings({ [key]: value })).toThrow();
      expect(() =>
        validateStorageAdmissionSettings({
          [key]: STORAGE_ADMISSION_DEFAULTS[key as keyof typeof STORAGE_ADMISSION_DEFAULTS] + 1,
        })
      ).toThrow();
    }
    for (const value of ['', 'NaN', 'Infinity', '1e1', ' 2 ', '2.0', 'private-canary'])
      expect(() =>
        readStorageAdmissionSettings({ LIFEMODEL_STORAGE_TRANSFER_WORKERS: value })
      ).toThrow();
    expect(() => validateStorageAdmissionSettings({ transferWorkers: 2 })).toThrow();
    expect(() => validateStorageAdmissionSettings({ bufferBytes: MiB })).toThrow();
    expect(() => validateStorageAdmissionSettings({ unknown: 1 })).toThrow();
  });
});

describe('storage admission scheduler', () => {
  it('keeps canceled control execution slots until handlers settle', async () => {
    const admission = createStorageAdmission();
    const controllers = [new AbortController(), new AbortController()];
    const leases = await Promise.all(
      controllers.map((controller) =>
        admission.acquire({
          space: 'control',
          role: 'control',
          bytes: 0,
          signal: controller.signal,
        })
      )
    );
    const next = request(admission, 'next', 'control', 0);
    controllers.forEach((controller) => controller.abort());
    expect(admission.snapshot()).toMatchObject({ control: 2, queued: 1 });
    leases[0]!.release();
    const replacement = await next;
    expect(admission.snapshot().control).toBe(2);
    leases[1]!.release();
    replacement.release();
  });

  it('caps reads separately from task transfers in the same space', async () => {
    const admission = createStorageAdmission();
    const tasks = await Promise.all([request(admission, 'a'), request(admission, 'a')]);
    const reads = await Promise.all([
      request(admission, 'a', 'read'),
      request(admission, 'a', 'read'),
    ]);
    const third = request(admission, 'a', 'read');
    expect(admission.snapshot()).toMatchObject({ task: 2, read: 2, queued: 1 });
    reads[0]!.release();
    const replacement = await third;
    for (const lease of [...tasks, ...reads, replacement]) lease.release();
  });

  it('caps each space at two chunks and accounts held buffers exactly once', async () => {
    const admission = createStorageAdmission();
    const first = await request(admission, 'space-a');
    const second = await request(admission, 'space-a');
    const pending = request(admission, 'space-a');
    expect(admission.snapshot()).toMatchObject({
      active: 2,
      bufferedBytes: 2 * MiB,
      queued: 1,
      bySpace: { 'space-a': 2 },
    });
    first.release();
    const third = await pending;
    first.release();
    expect(admission.snapshot()).toMatchObject({
      active: 2,
      queued: 0,
      observed: { maxPerSpace: 2 },
    });
    second.release();
    third.release();
    expect(admission.snapshot()).toMatchObject({ active: 0, bufferedBytes: 0, bySpace: {} });
  });

  it('reserves two transfer slots for reads while control uses an independent pool', async () => {
    const admission = createStorageAdmission({ transferWorkers: 4 });
    const tasks = await Promise.all([request(admission, 'a'), request(admission, 'a')]);
    const pendingTask = request(admission, 'b');
    const reads = await Promise.all([
      request(admission, 'reader', 'read'),
      request(admission, 'reader', 'read'),
    ]);
    const controls = await Promise.all([
      request(admission, 'control', 'control', 0),
      request(admission, 'control', 'control', 0),
    ]);
    const pendingControl = request(admission, 'control', 'control', 0);
    expect(admission.snapshot()).toMatchObject({
      active: 4,
      task: 2,
      read: 2,
      control: 2,
      queued: 2,
      observed: { active: 4, control: 2 },
    });
    controls[0]!.release();
    const nextControl = await pendingControl;
    expect(admission.snapshot()).toMatchObject({ active: 4, queued: 1 });
    tasks[0]!.release();
    const nextTask = await pendingTask;
    for (const lease of [...tasks, ...reads, ...controls, nextControl, nextTask]) lease.release();
  });

  it('preserves full-chunk read buffer capacity when the configured byte budget is tight', async () => {
    const admission = createStorageAdmission({ bufferBytes: 12 * MiB });
    const task = await request(admission, 'a', 'task', 4 * MiB);
    const pending = request(admission, 'b', 'task', 4 * MiB);
    const reads = await Promise.all([
      request(admission, 'r', 'read', 4 * MiB),
      request(admission, 'r', 'read', 4 * MiB),
    ]);
    expect(admission.snapshot()).toMatchObject({ active: 3, bufferedBytes: 12 * MiB, queued: 1 });
    reads[0]!.release();
    expect(admission.snapshot().queued).toBe(1);
    task.release();
    const next = await pending;
    for (const lease of [...reads, next]) lease.release();
    expect(admission.snapshot().observed.bufferedBytes).toBe(12 * MiB);
  });

  it('selects the next space round-robin rather than allowing a hot space to reacquire first', async () => {
    const admission = createStorageAdmission({ transferWorkers: 3, perSpaceWorkers: 1 });
    const first = await request(admission, 'a');
    const order: string[] = [];
    const again = request(admission, 'a').then((lease) => {
      order.push('a');
      return lease;
    });
    const other = request(admission, 'b').then((lease) => {
      order.push('b');
      return lease;
    });
    first.release();
    const next = await other;
    expect(order).toEqual(['b']);
    next.release();
    (await again).release();
    expect(order).toEqual(['b', 'a']);
  });

  it('removes queued aborts immediately and abort-releases an active lease idempotently', async () => {
    const admission = createStorageAdmission({ perSpaceWorkers: 1 });
    const active = new AbortController();
    const first = await admission.acquire({
      space: 'a',
      role: 'task',
      bytes: MiB,
      signal: active.signal,
    });
    const queued = new AbortController();
    const pending = admission.acquire({
      space: 'a',
      role: 'task',
      bytes: MiB,
      signal: queued.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    queued.abort();
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0, queueBytes: 0 });
    await rejected;
    const successor = request(admission, 'a');
    active.abort();
    const lease = await successor;
    first.release();
    expect(admission.snapshot()).toMatchObject({ active: 1, bufferedBytes: MiB });
    lease.release();
    const already = new AbortController();
    already.abort();
    await expect(
      admission.acquire({ space: 'a', role: 'task', bytes: MiB, signal: already.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('refuses excess request count immediately with 429 and Retry-After, then recovers', async () => {
    const admission = createStorageAdmission({ queueRequests: 2, perSpaceWorkers: 1 });
    const first = await request(admission, 'a');
    const queued = [request(admission, 'a'), request(admission, 'a')];
    await expect(request(admission, 'a')).rejects.toMatchObject({
      status: 429,
      code: 'storage_overloaded',
      retryAfter: 1,
    });
    expect(admission.snapshot()).toMatchObject({ queued: 2, observed: { queued: 2 } });
    first.release();
    for (const pending of queued) (await pending).release();
    (await request(admission, 'b')).release();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, queueBytes: 0 });
  });

  it('counts bounded queue metadata, not chunk bodies, and enforces the aggregate byte limit', async () => {
    const admission = createStorageAdmission({ queueBytes: 1024, perSpaceWorkers: 1 });
    const first = await request(admission, 'a');
    const queued = admission.acquire({
      space: 'a',
      role: 'task',
      bytes: 4 * MiB,
      metadataBytes: 1024,
      signal: signal(),
    });
    await expect(request(admission, 'a')).rejects.toMatchObject({ status: 429 });
    expect(admission.snapshot()).toMatchObject({
      bufferedBytes: MiB,
      queueBytes: 1024,
      observed: { queueBytes: 1024 },
    });
    first.release();
    (await queued).release();
    expect(admission.snapshot().queueBytes).toBe(0);
  });

  it('expires queued work within one second and removes its metadata before a later valid request', async () => {
    vi.useFakeTimers();
    const admission = createStorageAdmission();
    const active = await Promise.all([request(admission, 'a'), request(admission, 'a')]);
    const pending = request(admission, 'a');
    const refusal = expect(pending).rejects.toMatchObject({ status: 429, retryAfter: 1 });
    await vi.advanceTimersByTimeAsync(900);
    await refusal;
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 0, queueBytes: 0 });
    for (const lease of active) lease.release();
    (await request(admission, 'a')).release();
  });

  it('charges time already spent against an absolute monotonic admission deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const admission = createStorageAdmission({ perSpaceWorkers: 1 });
    const held = await request(admission, 'a');
    const arrived = performance.now();
    await vi.advanceTimersByTimeAsync(350);
    const pending = admission.acquire({
      space: 'a',
      role: 'task',
      bytes: MiB,
      signal: signal(),
      deadline: arrived + 800,
    });
    const refused = expect(pending).rejects.toMatchObject({ status: 429, retryAfter: 1 });
    await vi.advanceTimersByTimeAsync(449);
    expect(admission.snapshot().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(admission.snapshot().queued).toBe(0);
    await refused;
    expect(performance.now() - arrived).toBe(800);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0, queueBytes: 0 });
    held.release();
    // Later chunks omit the initial deadline and earn their own bounded attempt.
    const next = await request(admission, 'a');
    next.release();
  });

  it('never extends a short queue budget or grants an already expired deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const admission = createStorageAdmission({ perSpaceWorkers: 1, queueWaitMs: 100 });
    const held = await request(admission, 'a');
    const pending = admission.acquire({
      space: 'a',
      role: 'task',
      bytes: MiB,
      signal: signal(),
      deadline: performance.now() + 800,
    });
    const refused = expect(pending).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(100);
    await refused;
    held.release();
    await expect(
      admission.acquire({
        space: 'a',
        role: 'task',
        bytes: MiB,
        signal: signal(),
        deadline: performance.now(),
      })
    ).rejects.toMatchObject({ status: 429 });
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('does not grant expired queued work when its timer callback has not run', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const admission = createStorageAdmission({ perSpaceWorkers: 1 });
    const held = await request(admission, 'a');
    const pending = admission.acquire({
      space: 'a',
      role: 'task',
      bytes: MiB,
      signal: signal(),
      deadline: 200,
    });
    const refused = expect(pending).rejects.toMatchObject({ status: 429 });
    clock.mockReturnValue(201);
    held.release();
    await refused;
    clock.mockRestore();
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, queueBytes: 0 });
  });

  it('rejects impossible chunks and unbounded request metadata without recording private content', async () => {
    const admission = createStorageAdmission();
    for (const bytes of [-1, 4 * MiB + 1, Infinity, NaN, 1.5])
      await expect(request(admission, 'a', 'task', bytes)).rejects.toMatchObject({ status: 400 });
    await expect(request(admission, 'private-path-canary/'.repeat(20))).rejects.toMatchObject({
      status: 400,
    });
    await expect(request(admission, 'control', 'control', 1)).rejects.toMatchObject({
      status: 400,
    });
    for (const deadline of [NaN, Infinity, -Infinity])
      await expect(
        admission.acquire({ space: 'a', role: 'task', bytes: MiB, signal: signal(), deadline })
      ).rejects.toMatchObject({ status: 400 });
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, bySpace: {} });
    const held = await request(admission, 'a');
    const snapshot = admission.snapshot();
    snapshot.bySpace['a'] = 999;
    expect(admission.snapshot().bySpace['a']).toBe(1);
    held.release();
  });
});
