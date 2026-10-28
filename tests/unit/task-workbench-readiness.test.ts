import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import {
  createTaskWorkbenchReadiness,
  createWorkbenchTaskService,
} from '../../src/core/task-workbench.js';
import { createStartTaskTool } from '../../src/layers/cognition/tools/core/start-task.js';
import { TASK_PROFILES } from '../../src/ports/task-profiles.js';
import { withTraceContext } from '../../src/core/trace-context.js';
import {
  TaskRegistryError,
  type TaskRecord,
  type TaskAcceptanceService,
} from '../../src/ports/tasks.js';

const digest = `sha256:${'a'.repeat(64)}`;
const context = { correlationId: 'turn-one', recipientId: 'owner', triggerType: 'user_message' };
const request = {
  launchKey: 'launch-one',
  briefing: 'private briefing',
  profile: TASK_PROFILES['small']!,
  imageRevision: digest,
};
const record = {
  id: 'task-one',
  traceId: 'trace-one',
  parentSpanId: null,
  state: 'queued',
} as TaskRecord;
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function registryProbe(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

describe('task workbench readiness', () => {
  it('captures the deciding trace and span without adding trace arguments to the tool', async () => {
    const applyStartTask = vi.fn(async () => record);
    const tool = createStartTaskTool({
      imageRevision: digest,
      readByLaunchKey: async () => null,
      applyStartTask,
    });
    await withTraceContext({ traceId: 'incoming-signal', spanId: 'deciding-span' }, () =>
      tool.execute({ briefing: request.briefing, profile: 'small' }, context)
    );
    expect(applyStartTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          traceId: 'incoming-signal',
          parentSpanId: 'deciding-span',
        }),
      })
    );
    await tool.execute({ briefing: request.briefing, profile: 'small' }, context);
    expect(applyStartTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          traceId: context.correlationId,
          parentSpanId: context.correlationId,
        }),
      })
    );
    expect(tool.parameters.map((parameter) => parameter.name)).toEqual(['briefing', 'profile']);
  });

  it('checks only the pinned local manifest using an anonymous HEAD', async () => {
    const seen: unknown[] = [];
    const local = await registryProbe((req, res) => {
      seen.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
      });
      res.writeHead(200, { 'docker-content-digest': digest }).end();
    });
    const wire = vi.fn<typeof fetch>((url, init) => {
      expect(String(url)).toBe(
        `http://zot.lifemodel-system.svc:5001/v2/lifemodel/workbench/manifests/${digest}`
      );
      return fetch(`${local}${new URL(String(url)).pathname}`, init);
    });
    expect(await createTaskWorkbenchReadiness({ fetch: wire })(digest)).toBe(true);
    expect(seen).toEqual([
      {
        method: 'HEAD',
        path: `/v2/lifemodel/workbench/manifests/${digest}`,
        authorization: undefined,
        cookie: undefined,
      },
    ]);
  });

  it.each([404, 401, 500, 302])(
    'refuses HTTP %s without reading a body or following a redirect',
    async (status) => {
      const target = vi.fn();
      const local = await registryProbe((req, res) => {
        if (req.url === '/attacker') target();
        res.writeHead(status, { location: '/attacker', 'docker-content-digest': digest }).end();
      });
      const ready = createTaskWorkbenchReadiness({
        fetch: (url, init) => fetch(`${local}${new URL(String(url)).pathname}`, init),
      });
      expect(await ready(digest)).toBe(false);
      expect(target).not.toHaveBeenCalled();
    }
  );

  it('refuses a wrong manifest digest and transport errors with no private error text', async () => {
    const ready = createTaskWorkbenchReadiness({
      fetch: async () =>
        new Response(null, { headers: { 'docker-content-digest': `sha256:${'b'.repeat(64)}` } }),
    });
    expect(await ready(digest)).toBe(false);
    expect(
      await createTaskWorkbenchReadiness({
        fetch: async () => {
          throw new Error('private-token-canary');
        },
      })(digest)
    ).toBe(false);
  });

  it('bounds an unresponsive local manifest request and refuses invalid revisions without a request', async () => {
    const local = await registryProbe(() => undefined);
    const wire = vi.fn<typeof fetch>((url, init) =>
      fetch(`${local}${new URL(String(url)).pathname}`, init)
    );
    const ready = createTaskWorkbenchReadiness({ fetch: wire, timeoutMs: 25 });
    expect(await ready(digest)).toBe(false);
    expect(await ready('latest')).toBe(false);
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('replays accepted effects without probing a new deployment image but retains registry conflict checks', async () => {
    const readByLaunchKey = vi.fn(async () => record);
    const ready = vi.fn(async () => false);
    const accept = vi.fn(async (input: typeof request) => {
      if (input.briefing !== request.briefing)
        throw new TaskRegistryError(record.id, 'launch_key_conflict');
      return record;
    });
    const service = createWorkbenchTaskService({
      service: {
        accept,
        read: async () => null,
        readByLaunchKey,
        list: async () => [record],
        listActiveContext: async () => ({ tasks: [], omitted: false }),
      },
      imageRevision: `sha256:${'b'.repeat(64)}`,
      ready,
      onAccepted: vi.fn(),
    });
    expect(await service.accept(request)).toBe(record);
    await expect(service.accept({ ...request, briefing: 'changed' })).rejects.toMatchObject({
      code: 'launch_key_conflict',
    });
    expect(readByLaunchKey).toHaveBeenCalledWith(request.launchKey);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(ready).not.toHaveBeenCalled();
  });

  it('fails closed on an uncertain replay lookup without accepting or probing', async () => {
    const accept = vi.fn(async () => record);
    const ready = vi.fn(async () => true);
    const service = createWorkbenchTaskService({
      service: {
        accept,
        read: async () => null,
        readByLaunchKey: async () => {
          throw new TaskRegistryError('', 'storage_error');
        },
        list: async () => [],
        listActiveContext: async () => ({ tasks: [], omitted: false }),
      },
      imageRevision: digest,
      ready,
      onAccepted: vi.fn(),
    });
    await expect(service.accept(request)).rejects.toMatchObject({ code: 'storage_error' });
    expect(accept).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it('refuses before any registry acceptance or Job, keeps the start tool honest, and accepts after import', async () => {
    let present = false;
    const accept = vi.fn(async () => record);
    const onAccepted = vi.fn();
    const underlying: TaskAcceptanceService = {
      accept,
      read: async () => null,
      readByLaunchKey: async () => null,
      list: async () => [],
      listActiveContext: async () => ({ tasks: [], omitted: false }),
    };
    const service = createWorkbenchTaskService({
      service: underlying,
      imageRevision: digest,
      ready: async (revision) => {
        expect(revision).toBe(digest);
        return present;
      },
      onAccepted,
    });
    const tool = createStartTaskTool({
      imageRevision: digest,
      readByLaunchKey: service.readByLaunchKey,
      applyStartTask: (intent) => service.accept(intent.payload),
    });
    const result = await tool.execute({ briefing: request.briefing, profile: 'small' }, context);
    expect(result).toEqual({ success: false, code: 'workbench_unavailable' });
    expect(accept).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(await service.list()).toEqual([]);
    present = true;
    expect(
      await tool.execute({ briefing: request.briefing, profile: 'small' }, context)
    ).toMatchObject({ success: true, taskId: record.id });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });
});
