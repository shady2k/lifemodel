import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Socket } from 'node:net';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import {
  ScriptedTaskHarness,
  type TaskHarness,
  type TaskHarnessEvent,
} from '../../loader/src/task-harness.js';
import { OpenCodeTaskHarness, openCodeSemanticResult } from '../../loader/src/task-opencode.js';
import { createTaskModelRelay } from '../../loader/src/task-model-relay.js';

const exec = promisify(execFile);
const TOKEN = 'TASK-MODEL-TOKEN-PRIVATE-CANARY';
const BRIEFING = 'TASK-BRIEFING-PRIVATE-CANARY';
const RESULT = 'The task result is durable.';
const BINARY = '/usr/local/bin/opencode';
const briefing = { text: BRIEFING, model: 'lifemodel/task' };
type Scenario = 'success' | 'provider' | 'tool' | 'storage' | 'descendant' | 'abort';

/** Both adapters use exactly the same public port assertions. The real adapter
 * speaks to a TLS fake of the task gateway, never to a model on the Internet.
 * The isolated launcher provisions the checksum-verified binary before denying
 * external egress. A missing binary is a failing test, not a skipped contract.
 */
describe('TaskHarness contract: pinned OpenCode and scripted harness', () => {
  let certificate: TestStorageCertificate;
  let directory: string;
  let api: Server;
  let endpoint: string;
  let scenario: Scenario;
  let expectedToken: string;
  let toolSent: boolean;
  let requestSeen: (() => void) | undefined;
  let requests: { path: string; token: string | undefined; body: string }[];
  let events: TaskHarnessEvent[];
  let work: string;
  const sockets = new Set<Socket>();
  const cleanup: (() => Promise<void>)[] = [];
  let oldConfigHome: string | undefined;
  let oldPath: string | undefined;

  beforeAll(async () => {
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-harness-'));
    await writeFile(join(directory, 'ca'), certificate.ca);
    await writeFile(join(directory, 'token'), TOKEN);
    const immutable = join(directory, 'xdg/opencode');
    await mkdir(immutable, { recursive: true });
    await writeFile(join(immutable, '.gitignore'), 'node_modules\npackage.json\n');
    await chmod(immutable, 0o555);
    await writeFile(
      join(directory, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
      })
    );
    const traps = join(directory, 'traps');
    await mkdir(traps);
    for (const command of ['npm', 'bun', 'curl', 'wget']) {
      const path = join(traps, command);
      await writeFile(
        path,
        '#!/bin/sh\nprintf "bootstrap forbidden\n" >> "$HOME/bootstrap-attempt"\nexit 91\n'
      );
      await chmod(path, 0o755);
    }
    oldConfigHome = process.env.XDG_CONFIG_HOME;
    oldPath = process.env.PATH;
    process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
    process.env.PATH = `${traps}:${oldPath}`;
    api = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      void (async () => {
        let body = '';
        for await (const chunk of req) body += chunk.toString();
        requests.push({
          path: req.url ?? '',
          token: req.headers['x-lifemodel-task-token'] as string | undefined,
          body,
        });
        if (req.headers['x-lifemodel-task-token'] !== expectedToken) {
          res.writeHead(401).end('{"error":{"message":"missing_task_header"}}');
          return;
        }
        if (req.url === '/v1/models') {
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ data: [{ id: 'task' }] }));
          return;
        }
        if (req.url !== '/v1/chat/completions') {
          res.writeHead(404).end();
          return;
        }
        requestSeen?.();
        if (scenario === 'abort') return;
        if (scenario === 'provider') {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end('{"error":{"message":"provider_refused"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown, finish_reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-task',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'task',
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`
          );
        chunk({ role: 'assistant' });
        if (
          (scenario === 'tool' || scenario === 'storage' || scenario === 'descendant') &&
          !toolSent
        ) {
          toolSent = true;
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_required',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command:
                      scenario === 'storage'
                        ? 'test "$LIFEMODEL_STORAGE_ENDPOINT" = "https://storage.invalid" && test "$LIFEMODEL_STORAGE_SPACE" = "task-space" && test "$LIFEMODEL_STORAGE_TOKEN_FILE" = "/projected/storage/token" && test "$LIFEMODEL_STORAGE_CA_FILE" = "/projected/storage/ca" && test -z "$LIFEMODEL_TASK_MODEL_TOKEN_FILE" && test -z "$LIFEMODEL_TASK_CHANNEL_TOKEN_FILE" && printf storage-capability-ok'
                        : scenario === 'descendant'
                          ? `python3 -c 'import subprocess; p=subprocess.Popen(["python3","-c","import time; time.sleep(90)"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); open("detached.pid","w").write(str(p.pid))'`
                          : 'exit 42',
                    description: 'Required task operation',
                  }),
                },
              },
            ],
          });
          chunk({}, 'tool_calls');
        } else {
          chunk({ content: RESULT });
          chunk({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      })().catch(() => res.destroy());
    });
    api.on('error', () => undefined);
    api.on('connection', (socket) => {
      socket.on('error', () => undefined);
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const address = api.address();
    if (!address || typeof address === 'string') throw new Error('fake_gateway_bind_failed');
    endpoint = `https://localhost:${address.port}`;
    // Provisioning checks the official archive SHA256 before extraction. Verify
    // the executable pin again; no package resolution occurs during this test.
    expect(
      (
        await exec(BINARY, ['--version'], {
          env: {
            ...process.env,
            HOME: directory,
            TMPDIR: directory,
            XDG_DATA_HOME: join(directory, 'version-data'),
            XDG_STATE_HOME: join(directory, 'version-state'),
            XDG_CACHE_HOME: join(directory, 'version-cache'),
          },
        })
      ).stdout.trim()
    ).toBe('1.19.4');
    expect(
      createHash('sha256')
        .update(await readFile(BINARY))
        .digest('hex')
    ).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    if (work) {
      await expect(access(join(work, 'home/bootstrap-attempt'))).rejects.toThrow();
      await expect(access(join(directory, 'xdg/opencode/package.json'))).rejects.toThrow();
      await expect(access(join(work, '.opencode'))).rejects.toThrow();
    }
  });

  afterAll(async () => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    for (const socket of sockets) socket.destroy();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    if (directory) {
      await chmod(join(directory, 'xdg/opencode'), 0o755);
      await rm(directory, { recursive: true, force: true });
    }
    certificate?.cleanup();
  });

  async function harness(kind: 'OpenCode' | 'scripted', mode: Scenario): Promise<TaskHarness> {
    scenario = mode;
    expectedToken = TOKEN;
    requests = [];
    events = [];
    toolSent = false;
    requestSeen = undefined;
    await writeFile(join(directory, 'token'), TOKEN);
    work = await mkdtemp(join(directory, 'work-'));
    const onEvent = async (event: TaskHarnessEvent) => {
      events.push(event);
    };
    if (kind === 'scripted')
      return new ScriptedTaskHarness({
        onEvent,
        waitForAbort: mode === 'abort',
        terminal:
          mode === 'provider'
            ? { outcome: 'failed', result: '', reasonCode: 'provider_error' }
            : mode === 'tool'
              ? { outcome: 'failed', result: '', reasonCode: 'required_tool_failed' }
              : { outcome: 'succeeded', result: RESULT },
      });
    return new OpenCodeTaskHarness({
      modelEndpoint: endpoint,
      modelTokenFile: join(directory, 'token'),
      modelCaFile: join(directory, 'ca'),
      workDirectory: work,
      configFile: join(directory, 'opencode.json'),
      binary: BINARY,
      onEvent,
      timeoutMs: 45_000,
      storageEnv: {
        LIFEMODEL_STORAGE_ENDPOINT: 'https://storage.invalid',
        LIFEMODEL_STORAGE_SPACE: 'task-space',
        LIFEMODEL_STORAGE_TOKEN_FILE: '/projected/storage/token',
        LIFEMODEL_STORAGE_CA_FILE: '/projected/storage/ca',
      },
    });
  }

  for (const kind of ['OpenCode', 'scripted'] as const) {
    describe(kind, () => {
      it('returns one semantic success with a result and refuses a second start', async () => {
        const task = await harness(kind, 'success');
        const terminal = await task.start(briefing);
        expect(terminal).toEqual({ outcome: 'succeeded', result: RESULT });
        await expect(task.start(briefing)).rejects.toThrow('harness_already_started');
        expect(events.some((event) => event.type === 'step')).toBe(true);
        expect(JSON.stringify(events)).not.toContain(TOKEN);
        expect(JSON.stringify(events)).not.toContain(BRIEFING);
        expect(JSON.stringify(events)).not.toContain(RESULT);
        if (kind === 'OpenCode') {
          expect(requests.length).toBeGreaterThan(0);
          expect(
            requests.every(
              (request) => request.path === '/v1/chat/completions' && request.token === TOKEN
            )
          ).toBe(true);
        }
      }, 60_000);

      it('normalizes a provider error to failed', async () => {
        const task = await harness(kind, 'provider');
        expect(await task.start(briefing)).toEqual({
          outcome: 'failed',
          result: '',
          reasonCode: 'provider_error',
        });
      }, 60_000);

      it('does not count a final answer after an unresolved required tool failure as success', async () => {
        const task = await harness(kind, 'tool');
        expect(await task.start(briefing)).toEqual({
          outcome: 'failed',
          result: '',
          reasonCode: 'required_tool_failed',
        });
        if (kind === 'OpenCode') expect(toolSent).toBe(true);
      }, 60_000);

      it('aborts an in-flight turn and declares unsupported stage-4 operations', async () => {
        const task = await harness(kind, 'abort');
        let reached!: () => void;
        const active = new Promise<void>((resolve) => {
          reached = resolve;
        });
        if (kind === 'OpenCode') requestSeen = reached;
        const terminal = task.start(briefing);
        if (kind === 'scripted') reached();
        await Promise.race([
          active,
          terminal.then((result) => {
            throw new Error(`harness_finished_before_model:${result.reasonCode}`);
          }),
        ]);
        await task.abort();
        expect(await terminal).toEqual({ outcome: 'aborted', result: '', reasonCode: 'aborted' });
        expect(await task.steer('later')).toBe('not_supported');
        expect(await task.wrap()).toBe('not_supported');
      }, 60_000);
    });
  }

  it('passes only the storage capability to a real shell tool, not model or channel token paths', async () => {
    const task = await harness('OpenCode', 'storage');
    expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
    expect(toolSent).toBe(true);
    expect(requests.some((request) => request.body.includes('storage-capability-ok'))).toBe(true);
  }, 60_000);

  it('reaps a real shell tool detached grandchild before returning its result', async () => {
    const task = await harness('OpenCode', 'descendant');
    expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
    const pid = Number(await readFile(join(work, 'detached.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);

  it.each(['zero', 'crash'] as const)(
    'reaps detached children when the OpenCode leader exits early: %s',
    async (mode) => {
      await harness('scripted', 'success');
      const binary = join(work, 'early-leader');
      await writeFile(
        binary,
        `#!/usr/bin/python3
import os, signal, subprocess
p=subprocess.Popen(["python3","-c","import time; time.sleep(90)"], start_new_session=True)
open("detached.pid","w").write(str(p.pid))
${mode === 'crash' ? 'os.kill(os.getpid(), signal.SIGKILL)' : 'raise SystemExit(0)'}
`
      );
      await chmod(binary, 0o755);
      const task = new OpenCodeTaskHarness({
        modelEndpoint: endpoint,
        modelTokenFile: join(directory, 'token'),
        modelCaFile: join(directory, 'ca'),
        workDirectory: work,
        configFile: join(directory, 'opencode.json'),
        binary,
        timeoutMs: 5_000,
      });
      expect((await task.start(briefing)).outcome).toBe('failed');
      const pid = Number(await readFile(join(work, 'detached.pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  );

  it('does not mistake a harness process exit zero for a semantic result', async () => {
    await harness('scripted', 'success');
    const binary = join(work, 'zero-exit');
    await writeFile(binary, '#!/bin/sh\nexit 0\n');
    await chmod(binary, 0o755);
    const task = new OpenCodeTaskHarness({
      modelEndpoint: endpoint,
      modelTokenFile: join(directory, 'token'),
      modelCaFile: join(directory, 'ca'),
      workDirectory: work,
      configFile: join(directory, 'opencode.json'),
      binary,
      timeoutMs: 5_000,
    });
    expect(await task.start(briefing)).toEqual({
      outcome: 'failed',
      result: '',
      reasonCode: 'harness_process_failed',
    });
  });

  it('rereads the projected model token per call, strips caller auth and restricts routes', async () => {
    await harness('scripted', 'success');
    const relay = await createTaskModelRelay({
      modelEndpoint: endpoint,
      modelTokenFile: join(directory, 'token'),
      modelCaFile: join(directory, 'ca'),
      timeoutMs: 5_000,
    });
    cleanup.push(() => relay.close());
    const first = await fetch(relay.baseURL + '/models', {
      headers: { authorization: 'Bearer MUST-NOT-REACH-GATEWAY' },
    });
    expect(first.status).toBe(200);
    await first.text();
    expectedToken = 'ROTATED-TASK-TOKEN';
    await writeFile(join(directory, 'token'), expectedToken);
    const second = await fetch(relay.baseURL + '/models');
    expect(second.status).toBe(200);
    await second.text();
    expect(requests.map((entry) => entry.token)).toEqual([TOKEN, expectedToken]);
    expect((await fetch(relay.baseURL + '/forbidden')).status).toBe(404);
  });
});

describe('OpenCode semantic terminal boundary', () => {
  const assistant = (
    extra: Record<string, unknown> = {},
    parts: unknown[] = [{ type: 'text', text: RESULT }]
  ) => ({
    info: { role: 'assistant', finish: 'stop', time: { created: 1, completed: 2 }, ...extra },
    parts,
  });
  it('rejects CLI zero/step_finish/idle alone, truncated output and provider failures', () => {
    expect(openCodeSemanticResult([]).outcome).toBe('failed');
    expect(openCodeSemanticResult([assistant({}, [{ type: 'step-finish' }])]).outcome).toBe(
      'failed'
    );
    expect(openCodeSemanticResult([assistant({ finish: 'length' })]).outcome).toBe('failed');
    expect(openCodeSemanticResult([assistant()], true).outcome).toBe('failed');
    expect(openCodeSemanticResult([assistant({ error: { name: 'APIError' } })]).reasonCode).toBe(
      'provider_error'
    );
  });
  it('detects native tool errors, unfinished tools, and completed shell tools with a nonzero exit', () => {
    for (const state of [
      { status: 'error' },
      { status: 'running' },
      { status: 'completed', metadata: { exit: 42 } },
      { status: 'completed', metadata: { exit: null } },
    ]) {
      expect(
        openCodeSemanticResult([
          assistant({ finish: 'tool-calls' }, [{ type: 'tool', state }]),
          assistant(),
        ])
      ).toEqual({ outcome: 'failed', result: '', reasonCode: 'required_tool_failed' });
    }
  });
  it('accepts a completed required tool followed by a complete assistant answer', () => {
    expect(
      openCodeSemanticResult([
        assistant({ finish: 'tool-calls' }, [
          { type: 'tool', state: { status: 'completed', metadata: { exit: 0 } } },
        ]),
        assistant(),
      ])
    ).toEqual({ outcome: 'succeeded', result: RESULT });
  });
});
