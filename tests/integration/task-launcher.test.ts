/** Launcher orchestration over real TLS and the shipped storage CLI, not module mocks. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TaskJsonClient } from '../../loader/src/task-launcher-http.js';
import { createTaskModelRelay } from '../../loader/src/task-model-relay.js';
import { mkdir, symlink, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as harnessFactory from '../../loader/src/task-harness-factory.js';
import { AcpTaskHarness } from '../../loader/src/task-acp.js';
import { runTaskLauncher, type LauncherOptions } from '../../loader/src/task-launcher.js';
import { validateTaskTraceFrame } from '../../src/ports/task-channel.js';
import {
  ScriptedTaskHarness,
  type TaskBriefing,
  type TaskHarnessResult,
  type TaskHarnessTraceSpan,
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
  kind: 'step' | 'question' | 'terminal' | 'lifecycle' | 'transcript';
  payload: {
    role?: string;
    outcome?: string;
    reasonCode?: string;
    summary?: string;
    line?: string;
    phase?: string;
    questionId?: string;
    text?: string;
    resultObjectId?: string | null;
    artifactObjectIds?: string[];
  };
}
interface TraceFrame {
  taskId: string;
  attemptId: string;
  launchId: string;
  span: TaskHarnessTraceSpan & { traceId: string };
}
interface StoredObject {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: 'result' | 'artifact' | null;
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
  let traceFrames: TraceFrame[];
  let traceMode: 'ok' | 'timeout' | 'lost_ack';
  let reports: Map<string, Frame>;
  let durableAtReport: string[][];
  let diagnostics: string[];
  let harnessStarts: TaskBriefing[];
  let harnessCreations: number;
  let abortCalls: number;
  let startWon: boolean;
  let startMode: 'ok' | '409' | 'timeout' | 'lost_ack';
  let softDeadline: unknown;
  let briefingStatus: number;
  let commandStatus: number;
  let briefingHarness: string;
  let loseTerminalAcks: number;
  let loseReportAcks: boolean;
  let reportMode: 'ok' | '409' | 'lost_then_409';
  let lifecycleFailure:
    | { phase: 'running' | 'wrapping-up' | 'both'; mode: 409 | 503 | 'transport' }
    | undefined;
  let progressReports: Map<string, Frame>;
  let markStatus: number;
  let artifactPutStatus: number;
  let markReceipt: 'committed' | 'unmarked' | 'wrong_id';
  let pendingMarks: Set<string>;
  let beforeMark: ((object: StoredObject) => Promise<void>) | undefined;
  let afterCall: ((call: Call) => Promise<void>) | undefined;
  let artifactPages: StoredObject[][];
  let beforeHarness: (() => Promise<void>) | undefined;
  let restartTimers: ReturnType<typeof setTimeout>[];

  beforeAll(async () => {
    certificate = await createStorageCertificate(['localhost']);
  });
  afterAll(() => certificate.cleanup());
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'task-launcher-'));
    servers = [];
    restartTimers = [];
    sockets = new Set();
    calls = [];
    wireErrors = [];
    expectedTokens = { ...TOKENS };
    objects = new Map();
    terminalFrames = [];
    traceFrames = [];
    traceMode = 'ok';
    reports = new Map();
    durableAtReport = [];
    diagnostics = [];
    harnessStarts = [];
    harnessCreations = 0;
    abortCalls = 0;
    startWon = false;
    startMode = 'ok';
    softDeadline = new Date(Date.now() + 50_000).toISOString();
    briefingStatus = 200;
    commandStatus = 200;
    briefingHarness = 'opencode';
    loseTerminalAcks = 0;
    loseReportAcks = false;
    reportMode = 'ok';
    lifecycleFailure = undefined;
    progressReports = new Map();
    markStatus = 200;
    artifactPutStatus = 201;
    markReceipt = 'committed';
    pendingMarks = new Set();
    beforeMark = undefined;
    afterCall = undefined;
    artifactPages = [[]];
    beforeHarness = undefined;
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
    for (const timer of restartTimers) clearTimeout(timer);
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
    if (
      service === 'model' &&
      call.path === '/v1/models' &&
      req.headers['x-lifemodel-task-token'] === expectedTokens.model
    ) {
      json(res, 200, { data: [] });
      return;
    }
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
        ...(softDeadline === undefined ? {} : { softDueAt: softDeadline }),
        hardStopAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }
    if (service === 'channel' && call.method === 'GET' && call.path === '/task/commands') {
      if (commandStatus !== 200) json(res, commandStatus, {});
      // A real held response, closed when the harness/launcher settles.
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
      json(res, briefingStatus, {
        ...IDS,
        briefing: BRIEFING,
        harness: briefingHarness,
        traceId: IDS.taskId,
        parentSpanId: null,
      });
      return;
    }
    if (service === 'channel' && call.method === 'POST' && call.path === '/task/trace') {
      traceFrames.push(JSON.parse(body.toString()) as TraceFrame);
      if (traceMode === 'timeout') return;
      if (traceMode === 'lost_ack') {
        res.destroy();
        return;
      }
      json(res, 200, { accepted: true });
      return;
    }
    if (service === 'channel' && call.method === 'POST' && call.path === '/task/events') {
      const frame = JSON.parse(body.toString()) as Frame;
      if (frame.kind === 'step' || frame.kind === 'question') {
        if (
          reportMode === '409' ||
          (reportMode === 'lost_then_409' &&
            [...progressReports.values()].some((f) => f.kind !== 'lifecycle'))
        ) {
          json(res, 409, {});
          return;
        }
        const previous = progressReports.get(frame.messageId);
        if (previous) expect(frame).toEqual(previous);
        else {
          progressReports.set(frame.messageId, frame);
          if (loseReportAcks || reportMode === 'lost_then_409') {
            res.destroy();
            return;
          }
        }
      }
      if (frame.kind === 'lifecycle') {
        if (
          lifecycleFailure &&
          (lifecycleFailure.phase === 'both' || lifecycleFailure.phase === frame.payload.phase)
        ) {
          if (lifecycleFailure.mode === 'transport') res.destroy();
          else json(res, lifecycleFailure.mode, { error: EVENT });
          return;
        }
        progressReports.set(frame.messageId, frame);
      }
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
      if (name === 'good.txt' && artifactPutStatus !== 201) {
        json(res, artifactPutStatus, {});
        return;
      }
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
            await beforeHarness?.();
            return script.start(briefing);
          },
          abort: async () => {
            abortCalls++;
            await script.abort();
          },
          intakeReady: script.intakeReady,
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

  async function pause(service: Service, restartMs?: number) {
    const server = servers[['model', 'channel', 'storage'].indexOf(service)]!;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener missing');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (restartMs !== undefined)
      restartTimers.push(setTimeout(() => server.listen(address.port, '127.0.0.1'), restartMs));
  }
  function client(service: Service, windowMs = 2000) {
    const prefix = `LIFEMODEL_TASK_${service.toUpperCase()}`;
    return new TaskJsonClient(
      {
        endpoint: env[`${prefix}_ENDPOINT`]!,
        tokenFile: env[`${prefix}_TOKEN_FILE`]!,
        caFile: env[`${prefix}_CA_FILE`]!,
      },
      1000,
      windowMs
    );
  }

  it.each([undefined, null, 123, 'not-a-date'])(
    'refuses an invalid start softDueAt: %s',
    async (value) => {
      softDeadline = value;
      expect(await run({})).not.toBe(0);
      expect(harnessStarts).toEqual([]);
      expect(harnessCreations).toBe(0);
      expect(diagnostics).toContain('start_lost');
    }
  );

  it('fails and reports visibly when deterministic command intake is refused', async () => {
    commandStatus = 403;
    expect(await run({ waitForAbort: true })).toBe(1);
    expect(abortCalls).toBe(1);
    expect(diagnostics).toContain('command_intake_failed');
    expect(terminal().payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'command_intake_failed',
    });
  });

  it('transcript: forwards bounded scrubbed session entries and inserted steer/answer claims over the existing channel', async () => {
    const entry = (id: string, role: 'assistant' | 'tool' | 'steer' | 'answer') => ({
      type: 'transcript' as const,
      entry: {
        id,
        role,
        time: '2026-10-30T00:00:00.000Z',
        text: role === 'tool' ? '' : `session text api_key=planted-key ${TOKENS.model}`,
        tool:
          role === 'tool'
            ? {
                name: 'shell',
                status: 'completed' as const,
                outputTail: `last output token=planted-token ${TOKENS.channel}`,
              }
            : null,
      },
    });
    const a = entry('transcript-assistant', 'assistant');
    expect(
      await run({
        events: [
          a,
          a,
          entry('transcript-tool', 'tool'),
          entry('transcript-steer', 'steer'),
          entry('transcript-answer', 'answer'),
        ],
        terminal: { outcome: 'succeeded', result: RESULT },
      })
    ).toBe(0);
    const entries = calls
      .filter((call) => call.path === '/task/events')
      .map((call) => JSON.parse(call.body.toString()) as Frame)
      .filter((frame) => frame.kind === 'transcript');
    expect(entries).toHaveLength(5); // briefing plus four unique observations
    expect(entries.map((frame) => frame.payload.role)).toEqual(
      expect.arrayContaining(['user-briefing', 'assistant', 'tool', 'steer', 'answer'])
    );
    expect(entries.filter((frame) => frame.messageId === a.entry.id)).toHaveLength(1);
    const serialized = JSON.stringify(entries);
    for (const canary of [...Object.values(TOKENS), 'planted-key', 'planted-token'])
      expect(serialized).not.toContain(canary);
    expect(serialized).toContain('[REDACTED]');
  });

  it.each([false, true])(
    'passes the credential-free shim through the production factory; lost report ACK=%s',
    async (lost) => {
      loseReportAcks = lost;
      const factory = vi.spyOn(harnessFactory, 'createRegisteredHarness');
      const start = vi.spyOn(AcpTaskHarness.prototype, 'start').mockImplementation(async () => {
        const options = factory.mock.calls[0]![1];
        const config = options.mcpServers![0]!;
        expect(config.env).toEqual([]);
        expect(config.args.slice(0, 2)).toEqual(['-i', '/usr/bin/python3']);
        expect(options.question!.isOpen()).toBe(false);
        const child = spawn(config.command, config.args, { stdio: 'pipe' });
        const lines = createInterface({ input: child.stdout });
        const responses = new Map<number, (value: any) => void>();
        lines.on('line', (line) => {
          const response = JSON.parse(line);
          responses.get(response.id)?.(response.result);
        });
        let id = 0;
        const call = (method: string, params: unknown) =>
          new Promise<any>((resolve) => {
            responses.set(++id, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          });
        try {
          await call('initialize', { protocolVersion: '2024-11-05' });
          expect(
            (await call('tools/call', { name: 'step', arguments: { text: 'Actual private step' } }))
              .isError
          ).toBe(false);
          expect(
            (
              await call('tools/call', {
                name: 'question',
                arguments: { text: 'Which private result?' },
              })
            ).isError
          ).toBe(false);
          expect(options.question!.isOpen()).toBe(true);
          const frames = calls
            .filter((call) => call.path === '/task/events')
            .map((call) => JSON.parse(call.body.toString()))
            .filter((frame) => frame.kind !== 'transcript');
          expect(frames).toHaveLength(lost ? 4 : 2);
          if (lost) {
            expect(frames[0]).toEqual(frames[1]);
            expect(frames[2]).toEqual(frames[3]);
          }
          const unique = [...progressReports.values()].filter(
            (frame) => frame.kind !== 'transcript'
          );
          expect(unique).toEqual([
            expect.objectContaining({ kind: 'step', payload: { line: 'Actual private step' } }),
            expect.objectContaining({
              kind: 'question',
              payload: { questionId: expect.any(String), text: 'Which private result?' },
            }),
          ]);
          expect(unique[1]!.payload.questionId).toBe(unique[1]!.messageId);
        } finally {
          const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill();
          await closed;
          lines.close();
        }
        return { outcome: 'succeeded', result: RESULT };
      });
      try {
        expect(await run({}, { harness: undefined })).toBe(0);
      } finally {
        start.mockRestore();
        factory.mockRestore();
      }
      expect(diagnostics).toEqual([]);
    }
  );

  it.each(['409', 'lost_then_409'] as const)(
    'classifies report refusal after production send attempts: %s',
    async (mode) => {
      reportMode = mode;
      const factory = vi.spyOn(harnessFactory, 'createRegisteredHarness');
      const start = vi.spyOn(AcpTaskHarness.prototype, 'start').mockImplementation(async () => {
        const options = factory.mock.calls[0]![1];
        const config = options.mcpServers![0]!;
        const child = spawn(config.command, config.args, { stdio: 'pipe' });
        const lines = createInterface({ input: child.stdout });
        try {
          const response = new Promise<any>((resolve) =>
            lines.once('line', (line) => resolve(JSON.parse(line).result))
          );
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'question', arguments: { text: 'PRIVATE REFUSAL QUESTION' } },
            }) + '\n'
          );
          expect(await response).toMatchObject({
            isError: true,
            content: [
              { text: JSON.stringify(mode === '409' ? 'report_unavailable' : 'report_uncertain') },
            ],
          });
          expect(options.question!.isOpen()).toBe(mode === 'lost_then_409');
        } finally {
          const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
          child.kill();
          await closed;
          lines.close();
        }
        return { outcome: 'succeeded', result: RESULT };
      });
      try {
        expect(await run({}, { harness: undefined })).toBe(0);
      } finally {
        start.mockRestore();
        factory.mockRestore();
      }
      expect(diagnostics).toEqual(
        mode === '409'
          ? ['task_tool_report_unavailable']
          : ['task_tool_question_retained', 'task_tool_report_uncertain']
      );
      expect(
        calls.filter(
          (call) =>
            call.path === '/task/events' && JSON.parse(call.body.toString()).kind !== 'transcript'
        ).length
      ).toBe(mode === '409' ? 3 : 4);
    }
  );

  it('resolves the accepted Prime Agent harness through the launcher factory', async () => {
    briefingHarness = 'prime-agent';
    const factory = vi.spyOn(harnessFactory, 'createRegisteredHarness');
    const start = vi.spyOn(AcpTaskHarness.prototype, 'start').mockResolvedValue({
      outcome: 'succeeded',
      result: RESULT,
    });
    try {
      expect(await run({}, { harness: undefined })).toBe(0);
      expect(factory).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledWith('prime-agent', expect.any(Object));
      expect(start).toHaveBeenCalledOnce();
      expect(terminal().payload.outcome).toBe('succeeded');
    } finally {
      factory.mockRestore();
      start.mockRestore();
    }
  });

  it('survives refused connections before identity, briefing, progress and terminal', async () => {
    await pause('channel', 250);
    let stoppedProgress = false;
    beforeHarness = () => pause('channel', 250);
    afterCall = async (call) => {
      if (call.path === '/task/start') await pause('channel', 250);
      if (call.path === '/task/events' && JSON.parse(call.body.toString()).kind === 'step')
        stoppedProgress = true;
      if (call.service === 'storage' && call.method === 'GET') await pause('channel', 250);
    };
    expect(await run({ terminal: { outcome: 'succeeded', result: RESULT } })).toBe(0);
    expect(harnessStarts).toEqual([
      {
        text: `Files for the owner go in ${join(directory, 'outputs')}/, flat, with their final file names.\nOnly regular files are allowed; no subfolders or symlinks. Maximum: 64 files.\ntask-report.txt is reserved for my semantic report; do not use it as a work output name.\nFiles elsewhere are not retained. Failed-task outputs are retained as partial objects, not delivered as successful work.\nUse the task MCP step tool for short progress reports and question to ask the coordinating agent.\nQuestion returns after storage, not an answer. Wait for the correlated answer via steering.\n\n${BRIEFING}`,
        model: 'lifemodel/task',
        softDueAt: expect.any(String),
      },
    ]);
    expect(stoppedProgress).toBe(true);
    expect(terminal().payload.outcome).toBe('succeeded');
    expect(startCalls()).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it.each([false, true])(
    'closes the tools socket before outputs and terminal; execution throws=%s',
    async (throws) => {
      const observations: { path: string; open: boolean }[] = [];
      afterCall = async (call) => {
        if (
          call.service !== 'storage' &&
          !(call.path === '/task/events' && JSON.parse(call.body.toString()).kind === 'terminal')
        )
          return;
        const open = await new Promise<boolean>((resolve) => {
          const socket = createConnection(join(directory, '.launcher/tools.sock'));
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => {
            socket.destroy();
            resolve(false);
          });
        });
        observations.push({ path: call.path, open });
      };
      const harness = throws
        ? () => ({
            intakeReady: new Promise<void>(() => undefined),
            start: async (): Promise<TaskHarnessResult> => {
              throw new Error('private execution error');
            },
            abort: async () => undefined,
            steer: async () => 'rejected' as const,
            wrap: async () => 'not_supported' as const,
          })
        : undefined;
      expect(
        await run({ terminal: { outcome: 'succeeded', result: RESULT } }, throws ? { harness } : {})
      ).toBe(throws ? 1 : 0);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((entry) => !entry.open)).toBe(true);
      expect(observations.some((entry) => entry.path === '/task/events')).toBe(true);
      if (!throws) expect(observations.some((entry) => entry.path.includes('/objects'))).toBe(true);
    }
  );

  it('never retries a JSON request after bytes reached the server and the peer resets', async () => {
    const transport = client('channel');
    afterCall = async (call) => {
      if (call.path === '/task/identity') for (const socket of sockets) socket.destroy();
    };
    try {
      await expect(transport.call('/task/identity')).rejects.toMatchObject({
        code: 'request_unavailable',
        connectionAttempts: 1,
      });
      expect(calls.filter((call) => call.path === '/task/identity')).toHaveLength(1);
    } finally {
      transport.close();
    }
  });

  it('does not retry even a never-connected start', async () => {
    await pause('model');
    const transport = client('model');
    try {
      await expect(
        transport.call('/task/start', { ...IDS, bootNonce: 'nonce' })
      ).rejects.toMatchObject({
        code: 'request_unavailable',
        connectionAttempts: 1,
      });
      expect(startCalls()).toHaveLength(0);
    } finally {
      transport.close();
    }
  });

  it.each(['startup', 'hardStopAt'] as const)(
    'bounds refused connects by %s and reports safe attempt counts',
    async (bound) => {
      await pause('channel');
      const transport = client('channel', bound === 'startup' ? 250 : 2000);
      if (bound === 'hardStopAt') transport.hardStopAt = Date.now() + 250;
      const begin = performance.now();
      try {
        await expect(transport.call('/task/identity')).rejects.toMatchObject({
          code: 'request_unavailable',
          connectionAttempts: expect.any(Number),
        });
        expect(performance.now() - begin).toBeLessThan(750);
        expect(calls).toHaveLength(0);
      } finally {
        transport.close();
      }
    }
  );

  it('preserves failure codes and adds only connection counts on exhausted startup', async () => {
    await pause('channel');
    expect(await run({}, { startupWindowMs: 180 })).toBe(1);
    expect(diagnostics[0]).toBe('request_unavailable');
    expect(diagnostics[1]).toMatch(/^connection_attempts=[2-9]$/);
    expect(diagnostics[2]).toBe('terminal_unavailable');
  });

  it.each(['GET', 'POST'] as const)(
    'retries only idempotent model-list connections, not %s completion streams',
    async (method) => {
      // The fake model-list handler is below. Completions must not reach it after refusal.
      await pause('model', 250);
      const relay = await createTaskModelRelay({
        modelEndpoint: env['LIFEMODEL_TASK_MODEL_ENDPOINT']!,
        modelTokenFile: env['LIFEMODEL_TASK_MODEL_TOKEN_FILE']!,
        modelCaFile: env['LIFEMODEL_TASK_MODEL_CA_FILE']!,
        timeoutMs: 1500,
      });
      try {
        const response = await fetch(
          `${relay.baseURL}/${method === 'GET' ? 'models' : 'chat/completions'}`,
          {
            method,
            ...(method === 'POST' ? { body: '{"messages":[]}' } : {}),
          }
        );
        expect(response.status).toBe(method === 'GET' ? 200 : 502);
        await response.text();
        expect(calls.filter((call) => call.path === '/v1/models')).toHaveLength(
          method === 'GET' ? 1 : 0
        );
      } finally {
        await relay.close();
      }
    }
  );

  it.each([
    { phase: 'running', mode: 409 },
    { phase: 'wrapping-up', mode: 409 },
    { phase: 'running', mode: 503 },
    { phase: 'wrapping-up', mode: 503 },
    { phase: 'running', mode: 'transport' },
    { phase: 'wrapping-up', mode: 'transport' },
    { phase: 'both', mode: 409 },
  ] as const)(
    'retains succeeded outputs when lifecycle frames fail: $phase / $mode',
    async (failure) => {
      lifecycleFailure = failure;
      beforeHarness = () => writeFile(join(directory, 'outputs', 'good.txt'), 'Owner artifact');
      expect(
        await run({
          events: [
            { type: 'step', text: EVENT },
            { type: 'tool', name: EVENT, status: 'completed' },
          ],
          terminal: { outcome: 'succeeded', result: RESULT },
        })
      ).toBe(0);
      expect(terminal().payload).toEqual({
        outcome: 'succeeded',
        summary: 'Task result is ready',
        resultObjectId: 'object_1',
        artifactObjectIds: ['object_2'],
      });
      expect(objects.get('object_1')).toMatchObject({ bytes: Buffer.from(RESULT), mark: 'result' });
      expect(objects.get('object_2')).toMatchObject({
        bytes: Buffer.from('Owner artifact'),
        mark: 'artifact',
      });
      expect(durableAtReport).toEqual([['object_1', 'object_2']]);
      expect(abortCalls).toBe(0);
      expect(diagnostics).toEqual(
        failure.phase === 'both'
          ? ['lifecycle_unavailable', 'lifecycle_unavailable']
          : ['lifecycle_unavailable']
      );
      const lifecycleFrames = calls
        .filter((call) => call.path === '/task/events')
        .map((call) => JSON.parse(call.body.toString()) as Frame)
        .filter((frame) => frame.kind === 'lifecycle');
      for (const phase of ['running', 'wrapping-up']) {
        const frames = lifecycleFrames.filter((frame) => frame.payload.phase === phase);
        const failed = failure.phase === 'both' || failure.phase === phase;
        expect(frames).toHaveLength(failed && failure.mode !== 409 ? 3 : 1);
        // Ambiguous transport or server failures replay the same immutable frame.
        for (const frame of frames) expect(frame).toEqual(frames[0]);
      }
    }
  );

  it('takes one start, fetches the briefing after it, and stores only result bytes and artifact IDs', async () => {
    artifactPages = [
      [artifact('artifact_a'), artifact('unmarked', null)],
      [artifact('artifact_b')],
    ];
    expect(await run({ terminal: { outcome: 'succeeded', result: RESULT } })).toBe(0);
    expect(harnessCreations).toBe(1);
    expect(harnessStarts).toEqual([
      {
        text: `Files for the owner go in ${join(directory, 'outputs')}/, flat, with their final file names.\nOnly regular files are allowed; no subfolders or symlinks. Maximum: 64 files.\ntask-report.txt is reserved for my semantic report; do not use it as a work output name.\nFiles elsewhere are not retained. Failed-task outputs are retained as partial objects, not delivered as successful work.\nUse the task MCP step tool for short progress reports and question to ask the coordinating agent.\nQuestion returns after storage, not an answer. Wait for the correlated answer via steering.\n\n${BRIEFING}`,
        model: 'lifemodel/task',
        softDueAt: expect.any(String),
      },
    ]);
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
      sequence: 5,
      kind: 'terminal',
      payload: {
        outcome: 'succeeded',
        summary: 'Task result is ready',
        resultObjectId: 'object_1',
        artifactObjectIds: ['artifact_a', 'artifact_b'],
      },
    });
    expect(
      [...progressReports.values()]
        .filter((f) => f.kind === 'lifecycle')
        .map((f) => f.payload.phase)
    ).toEqual(['running', 'wrapping-up']);
    expect(objects.get('object_1')).toMatchObject({ bytes: Buffer.from(RESULT), mark: 'result' });
    expect(objects.size).toBe(1);
    expect(report.payload).not.toHaveProperty('logObjectId');
    expect(durableAtReport).toEqual([['object_1']]);
    const storageCalls = calls.filter((call) => call.service === 'storage');
    expect(storageCalls.map((call) => call.method)).toEqual(['PUT', 'POST', 'GET', 'GET']);
    expect(
      new Set(storageCalls.filter((call) => call.method === 'PUT').map((call) => call.path)).size
    ).toBe(1);
    expect(diagnostics).toEqual([]);
  });

  it.each([false, true])(
    'preserves failed tool evidence with recovered=%s and classifies the root',
    async (recovered) => {
      const startedAt = new Date().toISOString();
      const spans: TaskHarnessTraceSpan[] = [
        {
          spanId: 'model',
          parentSpanId: null,
          component: 'task.model',
          startedAt,
          endedAt: startedAt,
          status: 'ok',
          attrs: { model: 'lifemodel/task', stopReason: 'end_turn', inputTokens: 12 },
        },
        {
          spanId: 'failed_tool',
          parentSpanId: 'model',
          component: 'task.tool',
          startedAt,
          endedAt: startedAt,
          status: 'failed',
          attrs: {
            command: `private-command ${TOKENS.model} ${TOKENS.channel} ${TOKENS.storage}`,
            outputTail: `private-output ${TOKENS.storage}`,
            exitCode: 7,
          },
        },
        {
          spanId: 'successful_tool',
          parentSpanId: 'model',
          component: 'task.tool',
          startedAt,
          endedAt: startedAt,
          status: 'ok',
          attrs: { command: 'later-command', outputTail: 'later-output', exitCode: 0 },
        },
      ];
      expect(
        await run({
          events: spans.map((span) => ({ type: 'trace' as const, span })),
          terminal: recovered
            ? { outcome: 'succeeded', result: RESULT }
            : {
                outcome: 'failed',
                result: '',
                reasonCode: 'required_tool_failed',
                failureSpanId: 'failed_tool',
              },
        })
      ).toBe(recovered ? 0 : 1);
      await expect
        .poll(() =>
          traceFrames.some(
            (frame) => frame.span.spanId === IDS.launchId && frame.span.endedAt !== null
          )
        )
        .toBe(true);
      expect(traceFrames).toHaveLength(5); // Task start/end, model and two tools.
      for (const frame of traceFrames) {
        expect(Object.keys(frame).sort()).toEqual(['attemptId', 'launchId', 'span', 'taskId']);
        expect(frame).toMatchObject({ ...IDS, span: { traceId: IDS.taskId } });
        expect(Buffer.byteLength(JSON.stringify(frame.span))).toBeLessThanOrEqual(30_000);
      }
      expect(
        traceFrames.find((frame) => frame.span.spanId === `${IDS.launchId}_failed_tool`)?.span
      ).toMatchObject({
        parentSpanId: `${IDS.launchId}_model`,
        component: 'task.tool',
        status: 'failed',
        attrs: { exitCode: 7, command: expect.stringContaining('private-command') },
      });
      expect(
        traceFrames.find((frame) => frame.span.spanId === `${IDS.launchId}_successful_tool`)?.span
      ).toMatchObject({
        parentSpanId: `${IDS.launchId}_model`,
        status: 'ok',
        attrs: { exitCode: 0 },
      });
      expect(
        traceFrames.find((frame) => frame.span.spanId === `${IDS.launchId}_model`)?.span
      ).toMatchObject({ parentSpanId: IDS.launchId, status: 'ok' });
      const root = traceFrames.find(
        (frame) => frame.span.spanId === IDS.launchId && frame.span.endedAt !== null
      )?.span;
      expect(root).toMatchObject({
        parentSpanId: null,
        component: 'task',
        status: recovered ? 'ok' : 'failed',
        attrs: recovered
          ? { outcome: 'succeeded' }
          : {
              outcome: 'failed',
              reasonCode: 'required_tool_failed',
              failureSpanId: `${IDS.launchId}_failed_tool`,
            },
      });
      if (recovered) expect(root?.attrs['failureSpanId']).toBeNull();
      for (const token of Object.values(TOKENS))
        expect(JSON.stringify(traceFrames)).not.toContain(token);
      expect(terminal().payload).toMatchObject(
        recovered
          ? { outcome: 'succeeded' }
          : { outcome: 'failed', reasonCode: 'required_tool_failed' }
      );
      expect(terminal().sequence).toBe(3); // Briefing transcript and wrapping occupy sequence numbers; traces do not.
      expect(
        calls.filter(
          (call) =>
            call.path === '/task/events' && JSON.parse(call.body.toString()).kind === 'terminal'
        )
      ).toHaveLength(1);
      expect(objects.size).toBe(1);
      expect(diagnostics).toEqual([]);
    }
  );

  it('scrubs projected credential fragments at text boundaries and nested trace fields', async () => {
    const startedAt = new Date().toISOString();
    const spans: TaskHarnessTraceSpan[] = Object.entries(TOKENS).map(([service, token]) => ({
      spanId: `credential_${service}`,
      parentSpanId: null,
      component: 'task.tool',
      startedAt,
      endedAt: startedAt,
      status: 'ok',
      attrs: {
        command: `safe-command ${token.slice(0, 20)}`,
        outputTail: `${token.slice(-20)} safe-output`,
        nested: [{ quoted: `"${token}"`, [token]: token }],
      },
    }));
    expect(
      await run({
        events: spans.map((span) => ({ type: 'trace' as const, span })),
        terminal: { outcome: 'succeeded', result: RESULT },
      })
    ).toBe(0);
    await expect
      .poll(() =>
        traceFrames.some(
          (frame) => frame.span.spanId === IDS.launchId && frame.span.endedAt !== null
        )
      )
      .toBe(true);
    expect(traceFrames).toHaveLength(5);
    for (const [service, token] of Object.entries(TOKENS)) {
      const frame = traceFrames.find(
        (candidate) => candidate.span.spanId === `${IDS.launchId}_credential_${service}`
      );
      expect(frame?.span.attrs).toEqual({
        command: 'safe-command [REDACTED]',
        outputTail: '[REDACTED] safe-output',
        nested: [{ quoted: '"[REDACTED]"', '[REDACTED]': '[REDACTED]' }],
      });
      const encoded = JSON.stringify(traceFrames);
      expect(encoded).not.toContain(token);
      expect(encoded).not.toContain(token.slice(0, 20));
      expect(encoded).not.toContain(token.slice(-20));
    }
    expect(diagnostics).toEqual([]);
    expect(terminal().payload.outcome).toBe('succeeded');
  });

  it.each(['timeout', 'lost_ack'] as const)(
    'does not let a trace %s block or retry a semantic terminal report',
    async (mode) => {
      traceMode = mode;
      const traceStarted = deferred();
      let activeTraceRequests = 0;
      let terminalWhileTraceOpen = false;
      afterCall = async (call) => {
        if (call.path === '/task/trace') traceStarted.resolve();
        if (call.service === 'storage' && call.method === 'POST') await traceStarted.promise;
        if (call.path === '/task/events' && JSON.parse(call.body.toString()).kind === 'terminal')
          terminalWhileTraceOpen = activeTraceRequests > 0;
      };
      const channelServer = servers[1]!;
      channelServer.on('request', (req, res) => {
        if (req.url !== '/task/trace') return;
        activeTraceRequests++;
        res.on('close', () => activeTraceRequests--);
      });
      expect(await run({ events: [], terminal: { outcome: 'succeeded', result: RESULT } })).toBe(0);
      expect(terminal().payload.outcome).toBe('succeeded');
      expect(terminalFrames).toHaveLength(1);
      if (mode === 'timeout') expect(terminalWhileTraceOpen).toBe(true);
      expect(diagnostics).toEqual([]);
      // The trace client has its own 1500 ms deadline and at most a one-second
      // post-terminal drain. A hung first frame is cut off by close before its
      // timeout; queued evidence is dropped, not replayed or made authoritative.
      if (mode === 'lost_ack')
        await expect.poll(() => traceFrames.length, { timeout: 2000 }).toBe(2);
      await expect.poll(() => activeTraceRequests, { timeout: 2000 }).toBe(0);
      expect(traceFrames.map((frame) => frame.span.endedAt === null)).toEqual(
        mode === 'timeout' ? [true] : [true, false]
      );
      expect(
        calls.filter(
          (call) =>
            call.path === '/task/events' && JSON.parse(call.body.toString()).kind === 'terminal'
        )
      ).toHaveLength(1);
    }
  );

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
        artifactObjectIds: [],
      });
      expect(diagnostics).toEqual(
        mode === '409' ? ['start_lost'] : ['start_lost', 'connection_attempts=1']
      );
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

  it('does not send the terminal report until the result mark response is durable', async () => {
    const markingResult = deferred();
    const commitMark = deferred();
    beforeMark = async (object) => {
      if (object.name === 'task-report.txt') {
        markingResult.resolve();
        await commitMark.promise;
      }
    };
    const execution = run();
    try {
      await markingResult.promise;
      await expect
        .poll(() => traceFrames.some((frame) => frame.span.spanId === IDS.launchId))
        .toBe(true);
      expect(terminalFrames).toEqual([]);
      expect(objects.get('object_1')?.mark).toBeNull();
      const roots = traceFrames.filter((frame) => frame.span.spanId === IDS.launchId);
      expect(roots).toHaveLength(1);
      expect(roots[0]?.span).toMatchObject({ endedAt: null, status: null });
    } finally {
      commitMark.resolve();
    }
    expect(await execution).toBe(0);
    expect(durableAtReport).toEqual([['object_1']]);
    await expect
      .poll(() =>
        traceFrames.some(
          (frame) => frame.span.spanId === IDS.launchId && frame.span.endedAt !== null
        )
      )
      .toBe(true);
    expect(
      traceFrames.find((frame) => frame.span.spanId === IDS.launchId && frame.span.endedAt !== null)
        ?.span.status
    ).toBe('ok');
  });

  it.each([
    ['provider error', 'provider_error'],
    ['unresolved required tool error', 'required_tool_failed'],
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
        artifactObjectIds: [],
      });
      expect(objects.get('object_1')?.bytes.toString()).toBe(RESULT);
      expect(durableAtReport).toEqual([['object_1']]);
    }
  );

  it.each(['subdirectory', 'symlink', 'upload'] as const)(
    'preserves the original unsuccessful outcome with a partial-output %s warning',
    async (mode) => {
      beforeHarness = async () => {
        if (mode === 'subdirectory') await mkdir(join(directory, 'outputs', 'tmp'));
        if (mode === 'symlink') await symlink('/etc/passwd', join(directory, 'outputs', 'bad'));
        await writeFile(join(directory, 'outputs', 'good.txt'), 'partial bytes');
      };
      if (mode === 'upload') artifactPutStatus = 503;
      const outcome = mode === 'symlink' ? 'aborted' : 'failed';
      const reasonCode = outcome === 'aborted' ? 'aborted' : 'provider_error';
      const culprit = 'model-culprit';
      expect(
        await run({ terminal: { outcome, reasonCode, result: '', failureSpanId: culprit } })
      ).toBe(1);
      expect(terminal().payload).toMatchObject({ outcome, reasonCode });
      await expect
        .poll(() => traceFrames.some((frame) => frame.span.component === 'task.outputs'))
        .toBe(true);
      const warningFrame = traceFrames.find((frame) => frame.span.component === 'task.outputs')!;
      expect(() => validateTaskTraceFrame(warningFrame)).not.toThrow();
      const warning = warningFrame.span;
      expect(warning).toMatchObject({
        status: 'failed',
        attrs: {
          severity: 'warn',
          skippedEntries: mode === 'upload' ? 0 : 1,
          uploadFailures: mode === 'upload' ? 1 : 0,
        },
      });
      await expect
        .poll(() =>
          traceFrames.some((frame) => frame.span.component === 'task' && !!frame.span.endedAt)
        )
        .toBe(true);
      expect(
        traceFrames.filter((frame) => frame.span.component === 'task').at(-1)!.span.attrs
      ).toMatchObject({ outcome, reasonCode, failureSpanId: `${IDS.launchId}_${culprit}` });
      if (mode !== 'upload')
        expect([...objects.values()].find((object) => object.name === 'good.txt')).toMatchObject({
          mark: 'artifact',
          bytes: Buffer.from('partial bytes'),
        });
    }
  );

  it('keeps a work output result.txt separate from its reserved task-report.txt report', async () => {
    beforeHarness = () => writeFile(join(directory, 'outputs', 'result.txt'), '2 3 5');
    expect(await run()).toBe(0);
    expect(
      [...objects.values()].map((object) => [object.name, object.mark, object.bytes.toString()])
    ).toEqual([
      ['task-report.txt', 'result', 'Task completed.'],
      ['result.txt', 'artifact', '2 3 5'],
    ]);
    expect(new Set([...objects.values()].map((object) => object.name)).size).toBe(objects.size);
  });

  it('refuses a work output with the reserved report name', async () => {
    beforeHarness = () =>
      writeFile(join(directory, 'outputs', 'task-report.txt'), 'not the report');
    expect(await run()).toBe(1);
    expect(terminal().payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'output_name_reserved',
    });
    expect([...objects.values()].map((object) => object.name)).toEqual(['task-report.txt']);
  });

  it.each(['artifact', 'result'] as const)(
    'refuses an explicit %s upload with the reserved name',
    async (mark) => {
      artifactPages = [[{ ...artifact('explicit', mark), name: 'task-report.txt' }]];
      expect(await run()).toBe(1);
      expect(terminal().payload).toMatchObject({
        outcome: 'failed',
        reasonCode: 'output_name_reserved',
      });
    }
  );

  it('refuses ambiguous explicit owner-facing names across listing pages', async () => {
    artifactPages = [
      [{ ...artifact('first'), name: 'same.txt' }],
      [{ ...artifact('second'), name: 'same.txt' }],
    ];
    expect(await run()).toBe(1);
    expect(terminal().payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'output_name_ambiguous',
    });
  });

  it('retains primes-like outputs as partial objects after a late provider failure', async () => {
    beforeHarness = async () => {
      await writeFile(join(directory, 'outputs', 'primes.py'), 'print(2, 3, 5)');
      await writeFile(join(directory, 'outputs', 'primes.txt'), '2 3 5');
    };
    expect(
      await run({ terminal: { outcome: 'failed', result: '', reasonCode: 'provider_error' } })
    ).toBe(1);
    expect(terminal().payload).toMatchObject({
      outcome: 'failed',
      reasonCode: 'provider_error',
      artifactObjectIds: ['object_2', 'object_3'],
    });
    expect(
      [...objects.values()].map((object) => [object.name, object.mark, object.bytes.toString()])
    ).toEqual([
      ['task-report.txt', 'result', ''],
      ['primes.py', 'artifact', 'print(2, 3, 5)'],
      ['primes.txt', 'artifact', '2 3 5'],
    ]);
    expect(durableAtReport).toEqual([['object_1', 'object_2', 'object_3']]);
  });

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
      reasonCode: 'aborted',
      resultObjectId: 'object_1',
      artifactObjectIds: [],
    });
    expect(durableAtReport).toEqual([['object_1']]);
  });

  it('replays the identical terminal frame after a stored report loses its ACK, not a second outcome', async () => {
    loseTerminalAcks = 1;
    expect(await run()).toBe(0);
    expect(terminalFrames).toHaveLength(2);
    expect(terminalFrames[1]).toEqual(terminalFrames[0]);
    expect(reports.size).toBe(1);
    expect(startCalls()).toHaveLength(1);
    expect(harnessStarts).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  it('does not exit successfully if every terminal ACK is lost, even if the channel stored the outcome', async () => {
    loseTerminalAcks = 3;
    expect(await run()).toBe(1);
    expect(terminalFrames).toHaveLength(3);
    expect(
      terminalFrames.every((frame) => JSON.stringify(frame) === JSON.stringify(terminalFrames[0]))
    ).toBe(true);
    expect(reports.size).toBe(1);
    expect(diagnostics).toEqual(['channel_unavailable', 'connection_attempts=3']);
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
      ) {
        // Finish the independent trace request before changing the fake's sole
        // accepted token. Real token rotation overlaps validity windows.
        await expect
          .poll(() =>
            traceFrames.some(
              (frame) => frame.span.spanId === IDS.launchId && frame.span.endedAt !== null
            )
          )
          .toBe(true);
        await rotate('channel', 'REPLAY-CHANNEL-CANARY');
      }
    };
    expect(await run()).toBe(0);
    expect(startCalls()[0]?.authorization).toBe('Bearer ROTATED-MODEL-CANARY');
    expect(calls.find((call) => call.path === '/task/briefing')?.authorization).toBe(
      'Bearer ROTATED-CHANNEL-CANARY'
    );
    expect(
      calls.filter((call) => call.path.endsWith('/mark')).map((call) => call.authorization)
    ).toEqual([`Bearer ${TOKENS.storage}-next`]);
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
          .map((call) => JSON.parse(call.body.toString()))
          .filter((frame) => frame.kind !== 'transcript'),
      });
      for (const secret of [...Object.values(TOKENS), BRIEFING, EVENT, RESULT])
        expect(publicOutput).not.toContain(secret);
      expect(objects.get('object_1')?.bytes.toString()).toBe(RESULT);
      expect(objects.size).toBe(1);
      const privateDirectory = (await readdir(directory)).find((name) =>
        name.startsWith('launcher_')
      )!;
      expect(await readdir(join(directory, privateDirectory))).toEqual(['task-report.txt']);
      expect(calls.some((call) => call.path.includes('log.jsonl'))).toBe(false);
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });
});
