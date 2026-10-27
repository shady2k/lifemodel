import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Socket } from 'node:net';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { type TaskHarness, type TaskHarnessEvent } from '../../loader/src/task-harness.js';
import { AcpTaskHarness, AcpTurn } from '../../loader/src/task-acp.js';
import { configureAgent, toolOutputFailed } from '../../loader/src/task-opencode.js';
import { createRegisteredHarness } from '../../loader/src/task-harness-factory.js';
import { taskHarnessRegistry } from '../../loader/src/task-harness-registry.js';
import { createTaskModelRelay } from '../../loader/src/task-model-relay.js';

const exec = promisify(execFile);
const TOKEN = 'TASK-MODEL-TOKEN-PRIVATE-CANARY';
const BRIEFING = 'TASK-BRIEFING-PRIVATE-CANARY';
const RESULT = 'The task result is durable.';
const briefing = { text: BRIEFING, model: 'lifemodel/task' };
type Scenario =
  | 'success'
  | 'provider'
  | 'tool'
  | 'tool-success'
  | 'storage'
  | 'descendant'
  | 'abort'
  | 'permission'
  | 'background'
  | 'steer-long'
  | 'steer-parallel'
  | 'steer-failure';
const fixtureRegistry = JSON.parse(
  await readFile('tests/fixtures/task-agent-registry.json', 'utf8')
);
Object.assign(taskHarnessRegistry, fixtureRegistry);
type ContractFixture = {
  usesModelEndpoint: boolean;
  nativeReplay?: (input: {
    workDirectory: string;
    sessionId: string;
    commandId: string;
    text: string;
  }) => Promise<string>;
  shellTool?: (command: string) => { name: string; arguments: string };
  failedToolExemption?: string;
  prepare?: (work: string, mode: string) => Promise<void>;
  checkProvisioned: () => Promise<void>;
  checkOffline: (work: string) => Promise<void>;
};
const contractFixtures: Record<string, ContractFixture> = {};
for (const [name, agent] of Object.entries(taskHarnessRegistry)) {
  contractFixtures[name] = (await import(
    new URL(
      agent.contractModule!,
      new URL('../../loader/src/task-harness-registry.ts', import.meta.url)
    ).href
  )) as ContractFixture;
}

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
  let activeFixture: ContractFixture | undefined;
  let insertionSeen: (() => void) | undefined;
  let finalRequest: (() => void) | undefined;
  let inserted = false;
  let nativeSessionId = '';
  const STEER = 'STEERING-CONTRACT-65395: finish after the tools';
  const sockets = new Set<Socket>();
  const cleanup: (() => Promise<void>)[] = [];
  let oldConfigHome: string | undefined;
  let oldPath: string | undefined;

  beforeAll(async () => {
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-harness-'));
    await writeFile(join(directory, 'ca'), certificate.ca);
    await writeFile(join(directory, 'token'), TOKEN);
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
        if (scenario.startsWith('steer-') && !toolSent) {
          toolSent = true;
          const count = scenario === 'steer-parallel' ? 2 : 1;
          chunk({
            tool_calls: Array.from({ length: count }, (_, i) => ({
              index: i,
              id: `call_sleep_${i}`,
              type: 'function',
              function: activeFixture?.shellTool?.(
                `touch start-${i}; sleep ${3 + i}; touch done-${i}; echo done-${i}`
              ) ?? {
                name: 'shell',
                arguments: JSON.stringify({
                  command: `touch start-${i}; sleep ${3 + i}; touch done-${i}; echo done-${i}`,
                  description: 'Uninterrupted sleeping tool',
                }),
              },
            })),
          });
          chunk({}, 'tool_calls');
        } else if (scenario.startsWith('steer-')) {
          finalRequest?.();
          // Keep ACP alive while the independent native insertion observer catches up.
          if (!inserted)
            await new Promise<void>((resolve) => {
              insertionSeen = resolve;
            });
          chunk({ content: RESULT });
          chunk({}, 'stop');
        } else if (
          ['tool', 'tool-success', 'storage', 'descendant', 'background'].includes(scenario) &&
          !toolSent
        ) {
          toolSent = true;
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_required',
                type: 'function',
                function: activeFixture?.shellTool?.(
                  'printf prime-shell-contract-ok > prime-shell-result'
                ) ?? {
                  name: 'shell',
                  arguments: JSON.stringify({
                    command:
                      scenario === 'storage'
                        ? 'test "$LIFEMODEL_STORAGE_ENDPOINT" = "https://storage.invalid" && test "$LIFEMODEL_STORAGE_SPACE" = "task-space" && test "$LIFEMODEL_STORAGE_TOKEN_FILE" = "/projected/storage/token" && test "$LIFEMODEL_STORAGE_CA_FILE" = "/projected/storage/ca" && test -z "$LIFEMODEL_TASK_MODEL_TOKEN_FILE" && test -z "$LIFEMODEL_TASK_CHANNEL_TOKEN_FILE" && printf storage-capability-ok'
                        : scenario === 'descendant'
                          ? `python3 -c 'import subprocess; p=subprocess.Popen(["python3","-c","import time; time.sleep(90)"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); open("detached.pid","w").write(str(p.pid))'`
                          : scenario === 'background'
                            ? 'sleep 90'
                            : 'exit 42',
                    ...(scenario === 'background' ? { background: true } : {}),
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
    // Every registry configuration owns its fixture. No shared agent override.
    for (const agent of Object.values(taskHarnessRegistry)) {
      await access(agent.configFile);
      expect(
        (
          await exec(agent.command, agent.versionArgs, {
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
      ).toBe(agent.versionOutput);
    }
    for (const fixture of Object.values(contractFixtures)) await fixture.checkProvisioned();
  }, 30_000);

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    if (work) await activeFixture?.checkOffline(work);
  });

  afterAll(async () => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    for (const socket of sockets) socket.destroy();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
    certificate?.cleanup();
  });

  async function harness(kind: string, mode: Scenario): Promise<TaskHarness> {
    activeFixture = contractFixtures[kind];
    scenario = mode;
    expectedToken = TOKEN;
    requests = [];
    events = [];
    toolSent = false;
    requestSeen = undefined;
    insertionSeen = undefined;
    finalRequest = undefined;
    inserted = false;
    await writeFile(join(directory, 'token'), TOKEN);
    work = await mkdtemp(join(directory, 'work-'));
    const onEvent = async (event: TaskHarnessEvent) => {
      events.push(event);
      if (event.type === 'receipt' && event.disposition === 'inserted') {
        inserted = true;
        insertionSeen?.();
      }
      if (!activeFixture?.usesModelEndpoint && event.type === 'tool') requestSeen?.();
    };
    await contractFixtures[kind]?.prepare?.(work, mode);
    return createRegisteredHarness(kind, {
      modelEndpoint: endpoint,
      modelTokenFile: join(directory, 'token'),
      modelCaFile: join(directory, 'ca'),
      workDirectory: work,
      onEvent,
      // Only fixtures exposing a native stable-ID replay need the ACP/native ID.
      ...(activeFixture?.nativeReplay
        ? {
            bind: async ({ sessionId }: { sessionId: string }) => {
              nativeSessionId = sessionId;
            },
          }
        : {}),
      timeoutMs: 45000,
      storageEnv: {
        LIFEMODEL_STORAGE_ENDPOINT: 'https://storage.invalid',
        LIFEMODEL_STORAGE_SPACE: 'task-space',
        LIFEMODEL_STORAGE_TOKEN_FILE: '/projected/storage/token',
        LIFEMODEL_STORAGE_CA_FILE: '/projected/storage/ca',
      },
    });
  }

  for (const kind of Object.keys(taskHarnessRegistry)) {
    describe(kind, () => {
      it('returns one semantic success with a result and refuses a second start', async () => {
        const task = await harness(kind, 'success');
        const terminal = await task.start(briefing);
        expect(terminal).toEqual({ outcome: 'succeeded', result: RESULT });
        await expect(task.start(briefing)).rejects.toThrow('harness_already_started');
        expect(events.some((event) => event.type === 'step')).toBe(true);
        expect(JSON.stringify(events)).not.toContain(TOKEN);
        expect(JSON.stringify(events)).not.toContain(BRIEFING);
        expect(JSON.stringify(events.filter((event) => event.type !== 'trace'))).not.toContain(
          RESULT
        );
        if (contractFixtures[kind]!.usesModelEndpoint) {
          expect(requests.length).toBeGreaterThan(0);
          expect(
            requests.every(
              (request) => request.path === '/v1/chat/completions' && request.token === TOKEN
            )
          ).toBe(true);
        }
      }, 60_000);

      it.each(['steer-long', 'steer-parallel'] as const)(
        'admits once during uninterrupted tools, joins redelivery and receipts insertion: %s',
        async (mode) => {
          const task = await harness(kind, mode);
          let finished = false;
          const terminal = task.start(briefing).then((result) => {
            finished = true;
            return result;
          });
          cleanup.push(async () => {
            await task.abort();
            await terminal;
          });
          const count = mode === 'steer-parallel' ? 2 : 1;
          await vi.waitFor(
            async () => {
              for (let i = 0; i < count; i++) await access(join(work, `start-${i}`));
            },
            { timeout: 20000, interval: 20 }
          );
          const command = { commandId: 'contract-steer-1', text: STEER };
          const before = performance.now();
          // Both calls enter while the first native socket operation is in flight.
          expect(await Promise.all([task.steer(command), task.steer(command)])).toEqual([
            'accepted',
            'accepted',
          ]);
          expect(performance.now() - before).toBeLessThan(2000);
          expect(finished).toBe(false);
          await expect(access(join(work, `done-${count - 1}`))).rejects.toThrow();
          expect(await task.steer(command)).toBe('accepted');
          if (activeFixture?.nativeReplay) {
            // Bypass the launcher's journal to exercise OpenCode's own same-ID
            // pending replay. Both the native queue and journal must dedupe.
            const native = { ...command, workDirectory: work, sessionId: nativeSessionId };
            expect(await activeFixture.nativeReplay(native)).toBe('accepted');
            expect(await activeFixture.nativeReplay(native)).toBe('accepted');
          }
          expect(await task.steer({ ...command, text: 'changed' })).toBe('rejected');
          expect(await terminal).toEqual({ outcome: 'succeeded', result: RESULT });
          for (let i = 0; i < count; i++) await access(join(work, `done-${i}`));
          expect(events.filter((event) => event.type === 'receipt')).toEqual([
            { type: 'receipt', commandId: command.commandId, disposition: 'inserted' },
          ]);
          expect(
            events.filter((event) => event.type === 'tool' && event.status === 'completed')
          ).toHaveLength(count);
          if (activeFixture!.usesModelEndpoint) {
            const next = JSON.parse(
              requests.filter((request) => request.path === '/v1/chat/completions')[1]!.body
            );
            const messages = next.messages as {
              role: string;
              content: unknown;
              tool_call_id?: string;
            }[];
            const steering = messages.filter(
              (message) =>
                message.role === 'user' && JSON.stringify(message.content).includes(STEER)
            );
            expect(steering).toHaveLength(1);
            const index = messages.indexOf(steering[0]!);
            const tools = messages.slice(0, index).filter((message) => message.role === 'tool');
            expect(tools).toHaveLength(count);
            for (let i = 0; i < count; i++) {
              expect(tools[i]!.tool_call_id).toBe(`call_sleep_${i}`);
              expect(JSON.stringify(tools[i]!.content)).toContain(`done-${i}`);
            }
          }
        },
        60000
      );

      it.runIf(kind === 'prime-agent')(
        'fails uncertain socket admission without retrying or waiting for the tool',
        async () => {
          const task = await harness(kind, 'steer-failure');
          const terminal = task.start(briefing);
          cleanup.push(async () => {
            await task.abort();
            await terminal;
          });
          await vi.waitFor(() => access(join(work, 'start-0')), { timeout: 20000, interval: 20 });
          await rm(join(work, 'tmp/daemon.sock'));
          const command = { commandId: 'lost-socket', text: STEER };
          expect(await task.steer(command)).toBe('uncertain');
          expect(await terminal).toMatchObject({
            outcome: 'failed',
            reasonCode: 'steer_uncertain',
          });
          expect(events).toContainEqual({
            type: 'receipt',
            commandId: command.commandId,
            disposition: 'uncertain',
          });
        },
        60000
      );

      it('normalizes a provider error to failed', async () => {
        const task = await harness(kind, 'provider');
        expect(await task.start(briefing)).toEqual({
          outcome: 'failed',
          result: '',
          reasonCode: 'provider_error',
          failureSpanId: expect.any(String),
        });
      }, 60_000);

      it.skipIf(Boolean(contractFixtures[kind]!.failedToolExemption))(
        'recovers a failed command when the agent continues with its final answer',
        async () => {
          const task = await harness(kind, 'tool');
          expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
          expect(
            events.some(
              (event) =>
                event.type === 'trace' &&
                event.span.component === 'task.tool' &&
                event.span.status === 'failed'
            )
          ).toBe(true);
          if (contractFixtures[kind]!.usesModelEndpoint) expect(toolSent).toBe(true);
        },
        60_000
      );

      it('aborts an in-flight turn and declares unsupported stage-4 operations', async () => {
        const task = await harness(kind, 'abort');
        let reached!: () => void;
        const active = new Promise<void>((resolve) => {
          reached = resolve;
        });
        requestSeen = reached;
        const terminal = task.start(briefing);
        await Promise.race([
          active,
          terminal.then((result) => {
            throw new Error(`harness_finished_before_model:${result.reasonCode}`);
          }),
        ]);
        await task.abort();
        expect(await terminal).toEqual({ outcome: 'aborted', result: '', reasonCode: 'aborted' });
        expect(await task.steer({ commandId: 'later', text: 'later' })).toBe('rejected');
        expect(await task.wrap()).toBe('not_supported');
      }, 60_000);
    });
  }

  it('answers an ACP permission callback fail-closed rather than hanging or granting owner authority', async () => {
    const task = await harness('scripted', 'permission');
    expect(await task.start(briefing)).toEqual({
      outcome: 'aborted',
      result: '',
      reasonCode: 'aborted',
    });
  }, 60000);

  it.each(['malformed', 'late-tool'])(
    'fails closed on coalesced post-terminal frames: %s',
    async (mode) => {
      await harness('scripted', 'success');
      const task = new AcpTaskHarness({
        modelEndpoint: endpoint,
        modelTokenFile: join(directory, 'token'),
        modelCaFile: join(directory, 'ca'),
        workDirectory: work,
        timeoutMs: 5000,
        agent: {
          label: 'Scripted ACP',
          protocol: 'acp',
          command: 'python3',
          args: [resolve('tests/fixtures/task-scripted-acp.py'), mode],
          configFile: '',
          version: '',
          versionOutput: '',
          versionArgs: [],
          adapterModule: '',
        },
        configure: () => ({}),
      });
      expect((await task.start(briefing)).outcome).toBe('failed');
    }
  );

  it('aborts a never-settling event sink and discards queued notifications within the cleanup bound', async () => {
    await harness('scripted', 'success');
    let reached!: () => void;
    const active = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let count = 0;
    const task = new AcpTaskHarness({
      modelEndpoint: endpoint,
      modelTokenFile: join(directory, 'token'),
      modelCaFile: join(directory, 'ca'),
      workDirectory: work,
      timeoutMs: 10000,
      agent: {
        label: 'Scripted ACP',
        protocol: 'acp',
        command: 'python3',
        args: [resolve('tests/fixtures/task-scripted-acp.py'), 'backlog'],
        configFile: '',
        version: '',
        versionOutput: '',
        versionArgs: [],
        adapterModule: '',
      },
      configure: () => ({}),
      onEvent: (event) => {
        if (event.type === 'trace') return;
        if (++count === 1) return;
        reached();
        return new Promise<void>(() => {});
      },
    });
    const result = task.start(briefing);
    await Promise.race([
      active,
      result.then(() => {
        throw new Error('premature_terminal');
      }),
    ]);
    await task.abort();
    expect(await result).toEqual({ outcome: 'aborted', result: '', reasonCode: 'aborted' });
    expect(count).toBe(2);
  }, 10000);

  it('replaces an ACP agent through one registry entry and its own output rule', async () => {
    await harness('scripted', 'success');
    const modulePath = join(work, 'different-agent.mjs');
    await writeFile(
      modulePath,
      'export const configureAgent = () => ({}); export const toolOutputFailed = output => output?.customFailure === true;\n'
    );
    taskHarnessRegistry['different'] = {
      label: 'Different ACP',
      protocol: 'acp',
      command: 'python3',
      args: [resolve('tests/fixtures/task-scripted-acp.py'), 'custom-failure'],
      configFile: '',
      version: '',
      versionOutput: '',
      versionArgs: [],
      adapterModule: modulePath,
    };
    try {
      const task = await createRegisteredHarness('different', {
        modelEndpoint: endpoint,
        modelTokenFile: join(directory, 'token'),
        modelCaFile: join(directory, 'ca'),
        workDirectory: work,
        timeoutMs: 5000,
      });
      expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
    } finally {
      delete taskHarnessRegistry['different'];
    }
  });

  it.each(['background'] as const)(
    'accepts later agent work after an unobserved shell %s result',
    async (mode) => {
      const task = await harness('opencode', mode);
      expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
      expect(
        events.some(
          (event) =>
            event.type === 'trace' &&
            event.span.component === 'task.tool' &&
            event.span.status === 'failed'
        )
      ).toBe(true);
      expect(toolSent).toBe(true);
    },
    60000
  );

  it('runs Prime Python kernel and its real shell tool', async () => {
    const task = await harness('prime-agent', 'tool-success');
    expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
    expect(toolSent).toBe(true);
    expect(await readFile(join(work, 'prime-shell-result'), 'utf8')).toBe(
      'prime-shell-contract-ok'
    );
  }, 60_000);

  it('passes only the storage capability to a real shell tool, not model or channel token paths', async () => {
    const task = await harness('opencode', 'storage');
    expect(await task.start(briefing)).toEqual({ outcome: 'succeeded', result: RESULT });
    expect(toolSent).toBe(true);
    expect(requests.some((request) => request.body.includes('storage-capability-ok'))).toBe(true);
  }, 60_000);

  it('reaps a real shell tool detached grandchild before returning its result', async () => {
    const task = await harness('opencode', 'descendant');
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
      const task = new AcpTaskHarness({
        modelEndpoint: endpoint,
        modelTokenFile: join(directory, 'token'),
        modelCaFile: join(directory, 'ca'),
        workDirectory: work,
        agent: {
          ...taskHarnessRegistry['opencode']!,
          configFile: taskHarnessRegistry['opencode']!.configFile,
          command: binary,
        },
        configure: configureAgent,
        toolOutputFailed,
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
    const task = new AcpTaskHarness({
      modelEndpoint: endpoint,
      modelTokenFile: join(directory, 'token'),
      modelCaFile: join(directory, 'ca'),
      workDirectory: work,
      agent: {
        ...taskHarnessRegistry['opencode']!,
        configFile: taskHarnessRegistry['opencode']!.configFile,
        command: binary,
      },
      configure: configureAgent,
      toolOutputFailed,
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

describe('ACP semantic terminal boundary', () => {
  const text = (turn: AcpTurn) =>
    turn.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: RESULT } });
  it('rejects exit zero alone, truncation, refusal and provider errors after partial output', () => {
    expect(new AcpTurn(toolOutputFailed).result('end_turn').outcome).toBe('failed');
    for (const reason of ['max_tokens', 'refusal', undefined]) {
      const turn = new AcpTurn(toolOutputFailed);
      text(turn);
      expect(turn.result(reason).outcome).toBe('failed');
    }
    const turn = new AcpTurn(toolOutputFailed);
    text(turn);
    turn.error();
    expect(turn.result('end_turn').reasonCode).toBe('provider_error');
  });
  it('rejects failed, unfinished, nonzero-exit and killed calls without later agent work', () => {
    for (const update of [
      { status: 'failed' },
      { status: 'in_progress' },
      { status: 'completed', rawOutput: { metadata: { exit: 42 } } },
      { status: 'completed', rawOutput: { metadata: { exit: null } } },
      { status: 'completed', rawOutput: { metadata: { signal: 'SIGKILL' } } },
      { status: 'completed', rawOutput: { metadata: { timeout: true } } },
      { status: 'completed', rawInput: { background: true } },
      { status: 'completed', rawOutput: { metadata: { status: 'running' } } },
    ]) {
      const turn = new AcpTurn(toolOutputFailed);
      text(turn);
      turn.update({ sessionUpdate: 'tool_call', toolCallId: 'required', ...update });
      expect(turn.result('end_turn')).toEqual({
        outcome: 'failed',
        result: '',
        reasonCode: 'required_tool_failed',
        failureSpanId: expect.any(String),
      });
    }
  });
  it('accepts a settled tool then final assistant text; cancelled overrides partial text', () => {
    const turn = new AcpTurn(toolOutputFailed);
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'required',
      status: 'completed',
      rawOutput: { metadata: { exit: 0 } },
    });
    text(turn);
    expect(turn.result('end_turn')).toEqual({ outcome: 'succeeded', result: RESULT });
    expect(turn.result('cancelled')).toEqual({
      outcome: 'aborted',
      result: '',
      reasonCode: 'aborted',
    });
  });
});
