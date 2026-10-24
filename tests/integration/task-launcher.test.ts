/** Launcher orchestration over real TLS and the shipped storage CLI, not module mocks. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskLauncher, type LauncherOptions } from '../../loader/src/task-launcher.js';
import {
  ScriptedTaskHarness,
  type TaskBriefing,
  type TaskHarnessResult,
} from '../../loader/src/task-harness.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

const IDS = {
  taskId: `task_${'a'.repeat(64)}`,
  attemptId: `attempt_${'b'.repeat(64)}`,
  launchId: `launch_${'c'.repeat(64)}`,
};
const SPACE = 'space-launcher';
const BRIEFING = 'LAUNCHER-BRIEFING-PRIVATE-CANARY';
const RESULT = 'LAUNCHER-RESULT-PRIVATE-CANARY';
const EVENT = 'LAUNCHER-EVENT-PRIVATE-CANARY';
const TOKENS = {
  model: 'LAUNCHER-MODEL-TOKEN-PRIVATE-CANARY',
  channel: 'LAUNCHER-CHANNEL-TOKEN-PRIVATE-CANARY',
  storage: 'LAUNCHER-STORAGE-TOKEN-PRIVATE-CANARY',
};
type Service = keyof typeof TOKENS;
interface Frame {
  taskId: string;
  attemptId: string;
  direction: string;
  messageId: string;
  sequence: number;
  kind: 'step' | 'terminal';
  payload: {
    outcome?: string;
    reasonCode?: string;
    summary?: string;
    line?: string;
    resultObjectId?: string | null;
    logObjectId?: string | null;
    artifactObjectIds?: string[];
  };
}
interface StoredObject {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: 'result' | 'log' | 'artifact' | null;
  bytes: Buffer;
}
interface Call {
  service: Service;
  method: string;
  path: string;
  authorization: string | undefined;
  body: Buffer;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function metadata(object: StoredObject) {
  return {
    id: object.id,
    name: object.name,
    size: object.size,
    sha256: object.sha256,
    mark: object.mark,
  };
}

// These fakes implement the public task HTTP protocols. Storage records bytes
// and commits marks before responding; channel records before acknowledging.
describe('task launcher with scripted harness and real HTTPS services', () => {
  let certificate: TestStorageCertificate;
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let servers: Server[];
  let sockets: Set<Socket>;
  let calls: Call[];
  let wireErrors: string[];
  let expectedTokens: Record<Service, string>;
  let objects: Map<string, StoredObject>;
  let terminalFrames: Frame[];
  let reports: Map<string, Frame>;
  let durableAtReport: string[][];
  let diagnostics: string[];
  let harnessStarts: TaskBriefing[];
  let harnessCreations: number;
  let abortCalls: number;
  let startWon: boolean;
  let startMode: 'ok' | '409' | 'timeout' | 'lost_ack';
  let briefingStatus: number;
  let loseTerminalAcks: number;
  let markStatus: number;
  let markReceipt: 'committed' | 'unmarked' | 'wrong_id';
  let pendingMarks: Set<string>;
  let beforeMark: ((object: StoredObject) => Promise<void>) | undefined;
  let afterCall: ((call: Call) => Promise<void>) | undefined;
  let artifactPages: StoredObject[][];

  beforeAll(async () => {
    certificate = await createStorageCertificate(['localhost']);
  });
  afterAll(() => certificate.cleanup());
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'task-launcher-'));
    servers = [];
    sockets = new Set();
    calls = [];
    wireErrors = [];
    expectedTokens = { ...TOKENS };
    objects = new Map();
    terminalFrames = [];
    reports = new Map();
    durableAtReport = [];
    diagnostics = [];
    harnessStarts = [];
    harnessCreations = 0;
    abortCalls = 0;
    startWon = false;
    startMode = 'ok';
    briefingStatus = 200;
    loseTerminalAcks = 0;
    markStatus = 200;
    markReceipt = 'committed';
    pendingMarks = new Set();
    beforeMark = undefined;
    afterCall = undefined;
    artifactPages = [[]];
    const caFile = join(directory, 'ca.pem');
    await writeFile(caFile, certificate.ca);
    env = { LIFEMODEL_STORAGE_SPACE: SPACE };
    for (const service of ['model', 'channel', 'storage'] as const) {
      const prefix =
        service === 'storage' ? 'LIFEMODEL_STORAGE' : `LIFEMODEL_TASK_${service.toUpperCase()}`;
      const tokenFile = join(directory, `${service}.token`);
      await writeFile(tokenFile, expectedTokens[service]);
      env[`${prefix}_TOKEN_FILE`] = tokenFile;
      env[`${prefix}_CA_FILE`] = caFile;
      const server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
        req.on('error', () => undefined);
        res.on('error', () => undefined);
        void handle(service, req, res).catch(() => {
          wireErrors.push(`${service} handler failed`);
          res.destroy();
        });
      });
      server.on('error', () => undefined);
      server.on('tlsClientError', () => undefined);
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fake listener has no port');
      env[`${prefix}_ENDPOINT`] = `https://localhost:${address.port}`;
    }
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    await rm(directory, { recursive: true, force: true });
    expect(wireErrors).toEqual([]);
  });

  async function handle(service: Service, req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const call: Call = {
      service,
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization,
      body,
    };
    calls.push(call);
    if (call.authorization !== `Bearer ${expectedTokens[service]}`) {
      wireErrors.push(`${service} bearer did not match current token`);
      json(res, 401, {});
      return;
    }
    await afterCall?.(call);
    if (service === 'model' && call.method === 'POST' && call.path === '/task/start') {
      if (startMode === 'timeout') return; // Real request deadline closes this socket.
      if (startMode === 'lost_ack') {
        res.destroy();
        return;
      }
      if (startMode === '409') {
        json(res, 409, { error: 'start_consumed' });
        return;
      }
      startWon = true;
      json(res, 200, {
        ...IDS,
        start: true,
        space: SPACE,
        hardStopAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }
    if (service === 'channel' && call.method === 'GET' && call.path === '/task/identity') {
      json(res, 200, IDS);
      return;
    }
    if (service === 'channel' && call.method === 'GET' && call.path === '/task/briefing') {
      if (!startWon) {
        wireErrors.push('briefing fetched before won start');
        json(res, 403, {});
        return;
      }
      json(res, briefingStatus, { ...IDS, briefing: BRIEFING, harness: 'opencode' });
      return;
    }
    if (service === 'channel' && call.method === 'POST' && call.path === '/task/events') {
      const frame = JSON.parse(body.toString()) as Frame;
      if (frame.kind === 'terminal') {
        if (pendingMarks.size) wireErrors.push('terminal sent while storage mark was pending');
        terminalFrames.push(frame);
        if (!reports.has(frame.messageId)) {
          reports.set(frame.messageId, frame);
          durableAtReport.push(
            [...objects.values()]
              .filter((object) => object.mark !== null)
              .map((object) => object.id)
          );
        }
        if (loseTerminalAcks-- > 0) {
          res.destroy();
          return;
        }
      }
      json(res, 200, {
        taskId: frame.taskId,
        attemptId: frame.attemptId,
        direction: frame.direction,
        messageId: frame.messageId,
        sequence: frame.sequence,
        receivedAt: new Date().toISOString(),
      });
      return;
    }
    const base = `/spaces/${SPACE}/objects`;
    if (service === 'storage' && call.method === 'PUT' && call.path.startsWith(`${base}/upload_`)) {
      const id = `object_${objects.size + 1}`;
      const name = Buffer.from(String(req.headers['x-storage-name']), 'base64url').toString();
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (
        req.headers['x-storage-length'] !== String(body.length) ||
        req.headers['x-storage-sha256'] !== sha256
      ) {
        wireErrors.push('storage bytes did not match CLI metadata');
        json(res, 400, {});
        return;
      }
      const object: StoredObject = { id, name, size: body.length, sha256, mark: null, bytes: body };
      objects.set(id, object);
      json(res, 201, metadata(object));
      return;
    }
    if (service === 'storage' && call.method === 'POST' && call.path.endsWith('/mark')) {
      const id = call.path.slice(base.length + 1, -'/mark'.length);
      const object = objects.get(id);
      if (!object) throw new Error('mark without put');
      pendingMarks.add(id);
      await beforeMark?.(object);
      pendingMarks.delete(id);
      if (markStatus !== 200) {
        json(res, markStatus, {});
        return;
      }
      const { role } = JSON.parse(body.toString()) as { role: StoredObject['mark'] };
      // A 200 by itself is not a durable mark. The caller must inspect the
      // authoritative object identity and mark in the module receipt.
      if (markReceipt === 'unmarked') {
        json(res, 200, metadata(object));
        return;
      }
      if (markReceipt === 'wrong_id') {
        json(res, 200, { ...metadata(object), id: 'different_object', mark: role });
        return;
      }
      object.mark = role;
      json(res, 200, metadata(object));
      return;
    }
    if (service === 'storage' && call.method === 'GET' && call.path.startsWith(`${base}?`)) {
      if (pendingMarks.size) wireErrors.push('storage listed while mark was pending');
      const query = new URL(call.path, 'https://localhost').searchParams;
      if (query.get('limit') !== '100') wireErrors.push('list limit was not bounded');
      const page = query.has('cursor') ? Number(query.get('cursor')?.slice('page_'.length)) : 0;
      json(res, 200, {
        objects: [...(artifactPages[page] ?? []), ...(page === 0 ? [...objects.values()] : [])].map(
          metadata
        ),
        nextCursor: page + 1 < artifactPages.length ? `page_${page + 1}` : null,
      });
      return;
    }
    wireErrors.push(`unexpected ${service} route`);
    json(res, 404, {});
  }

  function run(
    scripted: ConstructorParameters<typeof ScriptedTaskHarness>[0] = {},
    extra: Partial<LauncherOptions> = {}
  ) {
    return runTaskLauncher({
      env,
      workDirectory: directory,
      requestTimeoutMs: 3000,
      diagnostic: (code) => {
        diagnostics.push(code);
      },
      harness: (onEvent) => {
        harnessCreations++;
        const script = new ScriptedTaskHarness({
          events: [{ type: 'step', text: EVENT }],
          ...scripted,
          onEvent,
        });
        return {
          start: async (briefing) => {
            harnessStarts.push(briefing);
            return script.start(briefing);
          },
          abort: async () => {
            abortCalls++;
            await script.abort();
          },
          steer: (text) => script.steer(text),
          wrap: () => script.wrap(),
        };
      },
      ...extra,
    });
  }
  function terminal() {
    expect(reports.size).toBe(1);
    return [...reports.values()][0]!;
  }
  function startCalls() {
    return calls.filter((call) => call.service === 'model');
  }
  function artifact(id: string, mark: StoredObject['mark'] = 'artifact'): StoredObject {
    return {
      id,
      name: `${id}.txt`,
      size: 0,
      sha256: createHash('sha256').update('').digest('hex'),
      mark,
      bytes: Buffer.alloc(0),
    };
  }
  async function rotate(service: Service, value: string) {
    const file = join(directory, `${service}.token`);
    await writeFile(`${file}.new`, value);
    await rename(`${file}.new`, file);
    expectedTokens[service] = value;
  }

  it('takes one start, fetches the briefing after it, and stores exact result/log bytes and artifact IDs', async () => {
    artifactPages = [
      [artifact('artifact_a'), artifact('unmarked', null)],
      [artifact('artifact_b')],
    ];
    expect(await run({ terminal: { outcome: 'succeeded', result: RESULT } })).toBe(0);
    expect(harnessCreations).toBe(1);
    expect(harnessStarts).toEqual([{ text: BRIEFING, model: 'lifemodel/task' }]);
    expect(startCalls()).toHaveLength(1);
    const claim = JSON.parse(startCalls()[0]!.body.toString());
    expect(claim).toEqual({ ...IDS, bootNonce: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(calls.slice(0, 3).map((call) => call.path)).toEqual([
      '/task/identity',
      '/task/start',
      '/task/briefing',
    ]);
    const report = terminal();
    expect(report).toEqual({
      taskId: IDS.taskId,
      attemptId: IDS.attemptId,
      direction: 'task_to_core',
      messageId: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      sequence: 2,
      kind: 'terminal',
      payload: {
        outcome: 'succeeded',
        summary: 'Task result is ready',
        resultObjectId: 'object_1',
        logObjectId: 'object_2',
        artifactObjectIds: ['artifact_a', 'artifact_b'],
      },
    });
    expect(objects.get('object_1')).toMatchObject({ bytes: Buffer.from(RESULT), mark: 'result' });
    expect(objects.get('object_2')).toMatchObject({
      bytes: Buffer.from(`${JSON.stringify({ type: 'step', line: 'Task is working' })}\n`),
      mark: 'log',
    });
    expect(durableAtReport).toEqual([['object_1', 'object_2']]);
    const storageCalls = calls.filter((call) => call.service === 'storage');
    expect(storageCalls.map((call) => call.method)).toEqual([
      'PUT',
      'POST',
      'PUT',
      'POST',
      'GET',
      'GET',
    ]);
    expect(
      new Set(storageCalls.filter((call) => call.method === 'PUT').map((call) => call.path)).size
    ).toBe(2);
    expect(diagnostics).toEqual([]);
  });

  it.each(['409', 'timeout', 'lost_ack'] as const)(
    'never retries an uncertain %s start or enters the harness',
    async (mode) => {
      startMode = mode;
      expect(await run({}, { requestTimeoutMs: mode === 'timeout' ? 1000 : 3000 })).toBe(1);
      expect(startCalls()).toHaveLength(1);
      expect(harnessCreations).toBe(0);
      expect(harnessStarts).toEqual([]);
      expect(
        calls.some((call) => call.path === '/task/briefing' || call.service === 'storage')
      ).toBe(false);
      expect(terminal().payload).toEqual({
        outcome: 'failed',
        summary: 'Task could not complete',
        reasonCode: 'start_lost',
        resultObjectId: null,
        logObjectId: null,
        artifactObjectIds: [],
      });
      expect(diagnostics).toEqual(['start_lost']);
    }
  );

  it('does not start a harness when the post-start briefing is denied', async () => {
    briefingStatus = 403;
    expect(await run()).toBe(1);
    expect(startCalls()).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/task/briefing')).toHaveLength(1);
    expect(harnessCreations).toBe(0);
    expect(objects.size).toBe(0);
    expect(terminal().payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'briefing_unavailable',
    });
  });

  it('does not send the terminal report until the log mark response is durable', async () => {
    const markingLog = deferred();
    const commitMark = deferred();
    beforeMark = async (object) => {
      if (object.name.endsWith('/log.jsonl')) {
        markingLog.resolve();
        await commitMark.promise;
      }
    };
    const execution = run();
    try {
      await markingLog.promise;
      expect(terminalFrames).toEqual([]);
      expect(objects.get('object_1')?.mark).toBe('result');
      expect(objects.get('object_2')?.mark).toBeNull();
    } finally {
      commitMark.resolve();
    }
    expect(await execution).toBe(0);
    expect(durableAtReport).toEqual([['object_1', 'object_2']]);
  });

  it.each([
    ['provider error', 'provider_error'],
    ['unresolved required tool error', 'unresolved_tool_failure'],
  ])(
    'preserves a semantic failed result for %s rather than treating harness completion as success',
    async (_label, reasonCode) => {
      const result: TaskHarnessResult = { outcome: 'failed', result: RESULT, reasonCode };
      expect(await run({ events: [{ type: 'error', code: reasonCode }], terminal: result })).toBe(
        1
      );
      expect(terminal().payload).toEqual({
        outcome: 'failed',
        summary: 'Task could not complete',
        reasonCode,
        resultObjectId: 'object_1',
        logObjectId: 'object_2',
        artifactObjectIds: [],
      });
      expect(objects.get('object_1')?.bytes.toString()).toBe(RESULT);
      expect(durableAtReport).toEqual([['object_1', 'object_2']]);
    }
  );

  it('aborts an active harness and reports one durable aborted outcome with a nonzero exit', async () => {
    const controller = new AbortController();
    const running = deferred();
    afterCall = async (call) => {
      if (call.path === '/task/events' && JSON.parse(call.body.toString()).kind === 'step')
        running.resolve();
    };
    const execution = run({ waitForAbort: true }, { signal: controller.signal });
    await running.promise;
    controller.abort();
    expect(await execution).toBe(1);
    expect(abortCalls).toBe(1);
    expect(terminal().payload).toEqual({
      outcome: 'aborted',
      summary: 'Task was aborted',
      resultObjectId: 'object_1',
      logObjectId: 'object_2',
      artifactObjectIds: [],
    });
    expect(durableAtReport).toEqual([['object_1', 'object_2']]);
  });

  it('replays the identical terminal frame after a stored report loses its ACK, not a second outcome', async () => {
    loseTerminalAcks = 1;
    expect(await run()).toBe(0);
    expect(terminalFrames).toHaveLength(2);
    expect(terminalFrames[1]).toEqual(terminalFrames[0]);
    expect(reports.size).toBe(1);
    expect(startCalls()).toHaveLength(1);
    expect(harnessStarts).toHaveLength(1);
    expect(objects.size).toBe(2);
  });

  it('does not exit successfully if every terminal ACK is lost, even if the channel stored the outcome', async () => {
    loseTerminalAcks = 3;
    expect(await run()).toBe(1);
    expect(terminalFrames).toHaveLength(3);
    expect(
      terminalFrames.every((frame) => JSON.stringify(frame) === JSON.stringify(terminalFrames[0]))
    ).toBe(true);
    expect(reports.size).toBe(1);
    expect(diagnostics).toEqual(['channel_unavailable']);
  });

  it('rereads rotated model, channel and storage token files, including on terminal replay', async () => {
    loseTerminalAcks = 1;
    let terminalCalls = 0;
    afterCall = async (call) => {
      if (call.path === '/task/identity') {
        await rotate('model', 'ROTATED-MODEL-CANARY');
        await rotate('channel', 'ROTATED-CHANNEL-CANARY');
      }
      if (call.service === 'storage' && call.method === 'PUT')
        await rotate('storage', `${expectedTokens.storage}-next`);
      if (
        call.path === '/task/events' &&
        JSON.parse(call.body.toString()).kind === 'terminal' &&
        terminalCalls++ === 0
      )
        await rotate('channel', 'REPLAY-CHANNEL-CANARY');
    };
    expect(await run()).toBe(0);
    expect(startCalls()[0]?.authorization).toBe('Bearer ROTATED-MODEL-CANARY');
    expect(calls.find((call) => call.path === '/task/briefing')?.authorization).toBe(
      'Bearer ROTATED-CHANNEL-CANARY'
    );
    expect(
      calls.filter((call) => call.path.endsWith('/mark')).map((call) => call.authorization)
    ).toEqual([`Bearer ${TOKENS.storage}-next`, `Bearer ${TOKENS.storage}-next-next`]);
    expect(
      calls
        .filter((call) => call.path === '/task/events')
        .slice(-2)
        .map((call) => call.authorization)
    ).toEqual(['Bearer ROTATED-CHANNEL-CANARY', 'Bearer REPLAY-CHANNEL-CANARY']);
  });

  it('reports storage failure without claiming an unmarked object as a durable result', async () => {
    markStatus = 503;
    expect(await run()).toBe(1);
    expect(terminal().payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'storage_unavailable',
      resultObjectId: null,
      logObjectId: null,
    });
    expect(durableAtReport).toEqual([[]]);
    expect(abortCalls).toBe(1);
  });

  it.each(['unmarked', 'wrong_id'] as const)(
    'refuses an invalid %s mark receipt before reporting a durable result',
    async (receipt) => {
      markReceipt = receipt;
      expect(await run()).toBe(1);
      expect(terminal().payload).toEqual({
        outcome: 'failed',
        summary: 'Task could not complete',
        reasonCode: 'storage_mark_invalid',
        resultObjectId: null,
        logObjectId: null,
        artifactObjectIds: [],
      });
      expect(durableAtReport).toEqual([[]]);
      expect(calls.some((call) => call.service === 'storage' && call.method === 'GET')).toBe(false);
      expect(abortCalls).toBe(1);
    }
  );

  it('keeps tokens, briefing, event text and model output out of diagnostics and channel progress', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await run({ terminal: { outcome: 'failed', result: RESULT, reasonCode: RESULT } })
      ).toBe(1);
      expect(terminal().payload.reasonCode).toBe('harness_failed');
      const publicOutput = JSON.stringify({
        diagnostics,
        console: [consoleLog.mock.calls, consoleError.mock.calls],
        frames: calls
          .filter((call) => call.path === '/task/events')
          .map((call) => JSON.parse(call.body.toString())),
      });
      for (const secret of [...Object.values(TOKENS), BRIEFING, EVENT, RESULT])
        expect(publicOutput).not.toContain(secret);
      expect(objects.get('object_1')?.bytes.toString()).toBe(RESULT);
      const logObject = objects.get('object_2')!;
      const storedLog = await readFile(join(directory, logObject.name), 'utf8');
      expect(logObject.bytes.toString()).toBe(storedLog);
      expect(storedLog).toBe(`${JSON.stringify({ type: 'step', line: 'Task is working' })}\n`);
      for (const secret of [...Object.values(TOKENS), BRIEFING, EVENT, RESULT])
        expect(storedLog).not.toContain(secret);
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });
});
