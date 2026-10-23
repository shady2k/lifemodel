import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskKubernetesClient } from '../../src/core/task-kubernetes-client.js';
import { TaskExecutorError } from '../../src/core/task-executor.js';
import { createKubernetesTaskExecutor } from '../../src/core/kubernetes-task-executor.js';

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

describe('task Kubernetes LIST bounds', () => {
  afterEach(() => vi.useRealTimers());

  it('refuses many empty pages with unique continuation tokens at the page limit', async () => {
    let pages = 0;
    const request = vi.fn(async () => ({
      status: 200,
      body: {
        items: [],
        metadata: { continue: ++pages < 150 ? `page-${pages}` : '' },
      },
    }));
    const api = createKubernetesTaskExecutor({ client: { request, close: vi.fn() } });
    await expect(api.listJobs()).rejects.toMatchObject({ code: 'api_error' });
    expect(request).toHaveBeenCalledTimes(100);
  });

  it('refuses an oversized continuation before sending it back to the API', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: { items: [], metadata: { continue: 'é'.repeat(2049) } },
    }));
    const api = createKubernetesTaskExecutor({ client: { request, close: vi.fn() } });
    await expect(api.listJobs()).rejects.toMatchObject({ code: 'api_error' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shares one deadline across slow pages and aborts the outstanding request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const signals: AbortSignal[] = [];
    const request = vi.fn(
      async (_method: string, _path: string, _body?: unknown, signal?: AbortSignal) => {
        signals.push(signal!);
        return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new TaskExecutorError('aborted'));
          };
          const timer = setTimeout(() => {
            signal!.removeEventListener('abort', abort);
            resolve({
              status: 200,
              body: { items: [], metadata: { continue: `page-${signals.length}` } },
            });
          }, 10_000);
          signal!.addEventListener('abort', abort, { once: true });
        });
      }
    );
    const api = createKubernetesTaskExecutor({ client: { request, close: vi.fn() } });
    const outcome = api.listJobs().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ code: 'aborted' });
    expect(request).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
