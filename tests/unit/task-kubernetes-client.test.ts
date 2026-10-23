import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskKubernetesClient } from '../../src/core/task-kubernetes-client.js';
import { TaskExecutorError } from '../../src/core/task-executor.js';

// Projection stalls are part of the request deadline and close boundary. A late
// secret read must never become an HTTP request after shutdown.
describe('task Kubernetes transport projection boundary', () => {
  afterEach(() => vi.useRealTimers());
  it.each(['timeout', 'abort', 'close'] as const)(
    'cancels stuck token reads on %s without leaking their cause',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const held = Promise.withResolvers<Buffer>();
      const signals: AbortSignal[] = [];
      const client = createTaskKubernetesClient({
        apiServer: 'https://localhost:1',
        tokenFile: 'private-token-path',
        caFile: 'ca',
        timeoutMs: 100,
        readProjection: (path, signal) => {
          signals.push(signal);
          return path === 'ca' ? Promise.resolve(Buffer.from('ca')) : held.promise;
        },
      });
      const controller = new AbortController();
      const outcome = client
        .request(
          'GET',
          '/apis/batch/v1/namespaces/lifemodel-motor/jobs',
          undefined,
          controller.signal
        )
        .catch((error: unknown) => error);
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(100);
      if (kind === 'abort') controller.abort();
      if (kind === 'close') client.close();
      const error = await outcome;
      expect(error).toBeInstanceOf(TaskExecutorError);
      expect(String(error)).not.toMatch(/private-token|secret/);
      expect(signals.every((s) => s.aborted)).toBe(true);
      held.reject(new Error('secret projection cause'));
      await vi.advanceTimersByTimeAsync(0);
      client.close();
      await expect(
        client.request('GET', '/apis/batch/v1/namespaces/lifemodel-motor/jobs')
      ).rejects.toBeInstanceOf(TaskExecutorError);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
