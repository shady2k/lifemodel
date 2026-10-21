import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  createOpenBaoApi,
  createOpenBaoBootstrap,
  type BaoKeys,
} from '../../loader/src/openbao.js';
import {
  createPlatformPhaseRunner,
  type PlatformPhaseRecord,
} from '../../loader/src/platform-bootstrap.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

/** The real init phase and HTTP transport; custody is the external Secret store boundary. */
function initPhase(api: ReturnType<typeof createOpenBaoApi>) {
  let saved: BaoKeys | null = null;
  let record: PlatformPhaseRecord | null = null;
  const events: string[] = [];
  const run = createPlatformPhaseRunner({
    read: async () => record,
    write: async (next) => {
      record = next;
    },
  });
  const bootstrap = createOpenBaoBootstrap({
    bao: api,
    custody: {
      read: async () => {
        events.push('custody-read');
        return saved;
      },
      write: async (value) => {
        events.push('custody-write');
        saved = structuredClone(value);
      },
    },
    // Only this phase is under test. No fake policies or root-token use.
    runPhases: (phases) => run(phases.filter(({ name }) => name === 'openbao-init')),
  });
  return { bootstrap, events, saved: () => saved, record: () => record };
}

describe('OpenBao non-idempotent init over real HTTP', () => {
  it.each([403, 500, 503])(
    'reports init HTTP %s by ID and status without its body',
    async (status) => {
      const logs: unknown[] = [];
      const address = await listen((_req, res) => {
        res.writeHead(status).end('test-share test-root PRIVATE BODY');
      });
      const api = createOpenBaoApi({
        address,
        role: 'loader',
        logger: {
          error: (fields) => {
            logs.push(fields);
          },
        },
      });
      const failure = await api.init().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: status === 403 ? 'denied' : status === 503 ? 'sealed' : 'unreachable',
        status,
      });
      expect(logs).toEqual([
        { code: status === 403 ? 'denied' : status === 503 ? 'sealed' : 'unreachable', status },
      ]);
      expect(JSON.stringify({ failure, logs })).not.toMatch(/test-share|test-root|PRIVATE BODY/);
    }
  );

  it('preserves HTTP 200 for malformed JSON without exposing its private body', async () => {
    const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const address = await listen((_req, res) => {
      res.writeHead(200).end('PRIVATE-MALFORMED-INIT-BODY');
    });
    const api = createOpenBaoApi({
      address,
      role: 'loader',
      logger: {
        error: (fields, message) => {
          logs.push({ fields, message });
        },
      },
    });
    const failure = await api.init().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unreachable', status: 200, message: 'unreachable' });
    expect(logs).toEqual([
      { fields: { code: 'unreachable', status: 200 }, message: 'OpenBao request failed' },
    ]);
    expect(JSON.stringify({ failure, message: (failure as Error).message, logs })).not.toContain(
      'PRIVATE-MALFORMED-INIT-BODY'
    );
  });

  it('keeps slow init material until custody while ordinary requests still expire', async () => {
    const initEntered = deferred<ServerResponse>();
    const ordinaryEntered = deferred<ServerResponse>();
    let initialized = false;
    let holdStatus = false;
    let inits = 0;
    const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const address = await listen((req, res) => {
      if (req.url === '/v1/sys/init' && req.method === 'POST') {
        inits++;
        initialized = true; // Bao can commit before its response reaches the loader.
        initEntered.resolve(res);
      } else if (req.url === '/v1/sys/seal-status') {
        if (holdStatus) ordinaryEntered.resolve(res);
        else res.end(JSON.stringify({ initialized, sealed: true }));
      } else {
        res.writeHead(404).end();
      }
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = createOpenBaoApi({
      address,
      role: 'loader',
      logger: {
        error: (fields, message) => {
          logs.push({ fields, message });
        },
      },
    });
    const phase = initPhase(api);
    // Attach the rejection handler before advancing time, including on unfixed main.
    const outcome = phase.bootstrap.runInitial().then(
      () => 'complete',
      () => 'failed'
    );
    const initResponse = await initEntered.promise;
    holdStatus = true;
    const ordinary = api.status().catch((error: unknown) => error);
    const lateResponse = await ordinaryEntered.promise;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await ordinary).toMatchObject({ code: 'unreachable' });
    // Even several first-election lengths must not cause us to discard init's one response.
    await vi.advanceTimersByTimeAsync(120_000);
    // The diagnostic is fixed-text metadata only, emitted before custody exists.
    expect(phase.saved()).toBeNull();
    expect(logs).toEqual([
      { fields: { code: 'unreachable', status: 0 }, message: 'OpenBao request failed' },
      {
        fields: { operation: 'POST /v1/sys/init', elapsedMs: 30_000 },
        message: 'OpenBao initialization is still pending',
      },
    ]);
    lateResponse.end('late status response');
    initResponse.end(JSON.stringify({ keys: ['test-share'], root_token: 'test-root' }));
    expect(await outcome).toBe('complete');
    expect(phase.saved()).toEqual({ keys: ['test-share'], rootToken: 'test-root' });
    expect(phase.record()).toEqual({ phase: 'openbao-init', status: 'complete' });
    expect(phase.events).toEqual(['custody-write', 'custody-read']);
    expect(inits).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(logs)).not.toMatch(/test-share|test-root|late status response/);
  });

  it('clears the pending diagnostic when init succeeds before 30 seconds', async () => {
    const logs: unknown[] = [];
    const address = await listen((_req, res) => {
      res.end(JSON.stringify({ keys: ['test-share'], root_token: 'test-root' }));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = createOpenBaoApi({
      address,
      role: 'loader',
      logger: {
        error: (fields) => {
          logs.push(fields);
        },
      },
    });
    await api.init();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(logs).toEqual([]);
  });

  it.each(['disconnect', 'truncated'])(
    'fails closed after committed init loses its %s response',
    async (mode) => {
      let initialized = false;
      let inits = 0;
      const cut = deferred<ServerResponse>();
      const address = await listen((req, res) => {
        if (req.url === '/v1/sys/init') {
          inits++;
          initialized = true;
          if (mode === 'truncated') {
            res.writeHead(200, { 'content-length': 1000, connection: 'close' });
            res.write('{"keys":["test-share"],"root_token":"test-root"');
          }
          cut.resolve(res);
        } else res.end(JSON.stringify({ initialized, sealed: true }));
      });
      const logs: Array<Record<string, unknown>> = [];
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const api = createOpenBaoApi({
        address,
        role: 'loader',
        logger: {
          error: (fields) => {
            logs.push(fields);
          },
        },
      });
      const phase = initPhase(api);
      const outcome = phase.bootstrap.runInitial().catch((error: unknown) => error);
      const response = await cut.promise;
      // An orderly EOF below Content-Length forces an IncomingMessage stream
      // failure after headers, not just a ClientRequest connection failure.
      if (mode === 'truncated') response.end();
      else response.destroy();
      expect(await outcome).toMatchObject({ code: 'unreachable' });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(logs).toEqual([{ code: 'unreachable', status: 0 }]);
      expect(phase.saved()).toBeNull();
      expect(phase.record()).toEqual({ phase: 'openbao-init', status: 'failed' });
      await expect(phase.bootstrap.runInitial()).rejects.toThrow(
        /Secret openbao-unseal-custody is missing or invalid/
      );
      expect(inits).toBe(1);
      expect(phase.events).not.toContain('custody-write');
    }
  );
});
