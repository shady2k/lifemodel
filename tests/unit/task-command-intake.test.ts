import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskCommandIntake } from '../../loader/src/task-command-intake.js';
import { LauncherError, TaskJsonClient } from '../../loader/src/task-launcher-http.js';

const command = {
  taskId: 'task-one',
  attemptId: 'attempt-one',
  commandId: 'command-one',
  direction: 'core_to_task',
  sequence: 1,
  kind: 'steer',
  text: 'Check this',
};
const receipt = {
  type: 'receipt' as const,
  commandId: command.commandId,
  disposition: 'inserted' as const,
};
function pending(signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new LauncherError('request_unavailable'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function setup() {
  const diagnostic = vi.fn();
  const onFatal = vi.fn();
  const steer = vi.fn(async () => 'accepted' as const);
  const intake = createTaskCommandIntake({
    endpoint: { endpoint: 'https://localhost:1', tokenFile: '/unused', caFile: '/unused' },
    identity: { taskId: command.taskId, attemptId: command.attemptId, launchId: 'launch-one' },
    harness: { intakeReady: Promise.resolve(), steer },
    hardStopAt: Date.now() + 60_000,
    diagnostic,
    onFatal,
  });
  return { intake, diagnostic, onFatal, steer };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('command intake failure classification', () => {
  it.each([400, 403, 404, 409, 413])(
    'fails intake visibly, without retry, on deterministic HTTP %s',
    async (status) => {
      vi.useFakeTimers();
      const calls = vi
        .spyOn(TaskJsonClient.prototype, 'call')
        .mockRejectedValue(new LauncherError('request_refused', status));
      const f = setup();
      f.intake.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onFatal).toHaveBeenCalledOnce();
      expect(f.diagnostic).toHaveBeenCalledWith('error', 'command_intake_failed', status);
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls).toHaveBeenCalledOnce();
      await f.intake.stop();
    }
  );
  it('fails malformed head commands closed instead of retrying them forever', async () => {
    const calls = vi
      .spyOn(TaskJsonClient.prototype, 'call')
      .mockResolvedValue({ command: { ...command, text: '' } });
    const f = setup();
    f.intake.start();
    await vi.waitFor(() => expect(f.onFatal).toHaveBeenCalledOnce());
    expect(calls).toHaveBeenCalledOnce();
    expect(f.steer).not.toHaveBeenCalled();
    await f.intake.stop();
  });
  it.each([429, 503, undefined])(
    'retries transient poll failure %s with exponential backoff',
    async (status) => {
      vi.useFakeTimers();
      const calls = vi
        .spyOn(TaskJsonClient.prototype, 'call')
        .mockRejectedValue(new LauncherError('request_unavailable', status));
      const f = setup();
      f.intake.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(calls).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveBeenCalledTimes(3);
      expect(f.onFatal).not.toHaveBeenCalled();
      const stop = f.intake.stop();
      await vi.advanceTimersByTimeAsync(15000);
      await stop;
    }
  );
  it.each([400, 403, 404, 409, 413])(
    'drops a deterministic receipt %s with a warning and continues later receipts',
    async (status) => {
      vi.useFakeTimers();
      const calls = vi
        .spyOn(TaskJsonClient.prototype, 'call')
        .mockRejectedValueOnce(new LauncherError('request_refused', status))
        .mockResolvedValue({ stored: true });
      const f = setup();
      f.intake.receipt(receipt);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.diagnostic).toHaveBeenCalledWith('warn', 'command_receipt_dropped', status);
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls).toHaveBeenCalledTimes(1);
      f.intake.receipt({ ...receipt, commandId: 'second' });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveBeenCalledTimes(2);
      await f.intake.stop();
    }
  );
  it.each([429, 503, undefined])(
    'backs off transient receipts %s exponentially',
    async (status) => {
      vi.useFakeTimers();
      const calls = vi
        .spyOn(TaskJsonClient.prototype, 'call')
        .mockRejectedValue(new LauncherError('request_unavailable', status));
      const f = setup();
      f.intake.receipt(receipt);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(calls).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveBeenCalledTimes(3);
      await f.intake.stop();
    }
  );
  it('warns when the bounded receipt backlog drops an entry', async () => {
    const hold = Promise.withResolvers<Record<string, unknown>>();
    vi.spyOn(TaskJsonClient.prototype, 'call').mockReturnValue(hold.promise);
    const f = setup();
    for (let i = 0; i <= 128; i++) f.intake.receipt({ ...receipt, commandId: `c-${i}` });
    expect(f.diagnostic).toHaveBeenCalledWith('warn', 'command_receipt_capacity', undefined);
    hold.resolve({ stored: true });
    await f.intake.stop();
  });
  it('flushes a receipt that arrives at the end of the previous receipt flight', async () => {
    const written: unknown[] = [];
    const f = setup();
    vi.spyOn(TaskJsonClient.prototype, 'call').mockImplementation(async (_path, body) => {
      written.push(body);
      if (written.length === 1) {
        // Run after the first response continuation finished its Map iteration,
        // but before its finally releases flight ownership.
        queueMicrotask(() => queueMicrotask(() => f.intake.receipt({ ...receipt, commandId: 'next' })));
      }
      return { stored: true };
    });
    f.intake.receipt(receipt);
    await vi.waitFor(() => expect(written).toHaveLength(2));
    await f.intake.stop();
  });

  it('drains insertion receipts emitted by an in-flight native dispatch after intake stops', async () => {
    const admitted = Promise.withResolvers<'accepted'>();
    const paths: string[] = [];
    vi.spyOn(TaskJsonClient.prototype, 'call').mockImplementation(async (path, _body, signal) => {
      paths.push(path);
      if (path === '/task/commands') return { command };
      if (path === '/task/commands/ack' || path === '/task/commands/receipt') return { stored: true };
      return pending(signal);
    });
    const f = setup();
    f.steer.mockImplementationOnce(() => admitted.promise);
    f.intake.start();
    await vi.waitFor(() => expect(f.steer).toHaveBeenCalledOnce());
    const stopped = f.intake.stop();
    f.intake.receipt(receipt);
    admitted.resolve('accepted');
    await stopped;
    expect(paths).toContain('/task/commands/ack');
    expect(paths).toContain('/task/commands/receipt');
  });

  it('a deterministic ACK failure fails closed after one native admission', async () => {
    vi.spyOn(TaskJsonClient.prototype, 'call').mockImplementation(async (path, _body, signal) => {
      if (path === '/task/commands') return { command };
      if (path === '/task/commands/ack') throw new LauncherError('request_refused', 409);
      return pending(signal);
    });
    const f = setup();
    f.intake.start();
    await vi.waitFor(() => expect(f.onFatal).toHaveBeenCalledOnce());
    expect(f.steer).toHaveBeenCalledOnce();
    await f.intake.stop();
  });
});
