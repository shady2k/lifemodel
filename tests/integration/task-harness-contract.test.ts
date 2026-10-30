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
import { AcpTaskHarness, AcpTurn, type AcpTaskHarnessOptions } from '../../loader/src/task-acp.js';
import { configureAgent, toolOutputFailed } from '../../loader/src/task-opencode.js';
import { createRegisteredHarness } from '../../loader/src/task-harness-factory.js';
import { taskHarnessRegistry } from '../../loader/src/task-harness-registry.js';
import { createTaskModelRelay } from '../../loader/src/task-model-relay.js';
import { createTaskTools } from '../../loader/src/task-tools.js';
import { taskToolsContract } from '../helpers/task-tools-contract.js';
import { createSteerTaskTool } from '../../src/layers/cognition/tools/core/steer-task.js';
import { createTaskCommandIntake } from '../../loader/src/task-command-intake.js';

const exec = promisify(execFile);
const TOKEN = 'TASK-MODEL-TOKEN-PRIVATE-CANARY';
const BRIEFING = 'TASK-BRIEFING-PRIVATE-CANARY';
const RESULT = 'The task result is durable.';
const briefing = { text: BRIEFING, model: 'lifemodel/task' };
type Scenario =
  | 'mcp'
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
  | 'steer-failure'
  | 'barrier'
  | 'barrier-tool';
const fixtureRegistry = JSON.parse(
  await readFile('tests/fixtures/task-agent-registry.json', 'utf8')
);
Object.assign(taskHarnessRegistry, fixtureRegistry);
type ContractFixture = {
  usesModelEndpoint: boolean;
  reportTool?: (
    kind: string,
    text: string,
    tools: { function: { name: string } }[]
  ) => { name: string; arguments: string };
  loseSuccessorEvidence?: (work: string) => Promise<() => Promise<void>>;
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
describe('TaskHarness contract: both pinned adapters and scripted harness', () => {
  let certificate: TestStorageCertificate;
  let directory: string;
  let api: Server;
  let endpoint: string;
  let scenario: Scenario;
  let expectedToken: string;
  let toolSent: boolean;
  let mcpReports = 0;
  let requestSeen: (() => void) | undefined;
  let requests: { path: string; token: string | undefined; body: string }[];
  let events: TaskHarnessEvent[];
  let work: string;
  let activeFixture: ContractFixture | undefined;
  let insertionSeen: (() => void) | undefined;
  let finalRequest: (() => void) | undefined;
  let inserted = false;
  let prematureInsertion = false;
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
        // MCP discovery can lag session/new. Retry only a bounded number of
        // model tool attempts so missing tools fail instead of flooding history.
        if (scenario === 'mcp' && mcpReports < 2 && requests.length <= 8) {
          const kind = mcpReports === 0 ? 'step' : 'question';
          const text = kind === 'step' ? 'MCP step contract' : 'Which result should I use?';
          const tools = JSON.parse(body).tools;
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `mcp-${kind}`,
                type: 'function',
                function: activeFixture!.reportTool!(kind, text, tools),
              },
            ],
          });
          chunk({}, 'tool_calls');
        } else if (scenario === 'barrier-tool' && body.includes(STEER) && !toolSent) {
          toolSent = true;
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'successor-required',
                type: 'function',
                function: activeFixture?.shellTool?.('printf successor-tool-ok') ?? {
                  name: 'shell',
                  arguments: JSON.stringify({
                    command: 'printf successor-tool-ok',
                    description: 'Successor tool',
                  }),
                },
              },
            ],
          });
          chunk({}, 'tool_calls');
        } else if (scenario.startsWith('steer-') && !toolSent) {
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
          chunk({
            content:
              (scenario.startsWith('barrier') || scenario === 'mcp') && body.includes(STEER)
                ? 'Steered terminal result.'
                : RESULT,
          });
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

  async function harness(
    kind: string,
    mode: Scenario,
    options: Partial<AcpTaskHarnessOptions> = {}
  ): Promise<TaskHarness> {
    activeFixture = contractFixtures[kind];
    scenario = mode;
    expectedToken = TOKEN;
    requests = [];
    events = [];
    toolSent = false;
    mcpReports = 0;
    requestSeen = undefined;
    insertionSeen = undefined;
    finalRequest = undefined;
    inserted = false;
    prematureInsertion = false;
    await writeFile(join(directory, 'token'), TOKEN);
    work = await mkdtemp(join(directory, 'work-'));
    const onEvent = async (event: TaskHarnessEvent) => {
      events.push(event);
      await options.onEvent?.(event);
      if (event.type === 'receipt' && event.disposition === 'inserted') {
        if (scenario.startsWith('steer-')) {
          const count = scenario === 'steer-parallel' ? 2 : 1;
          for (let i = 0; i < count; i++) {
            try {
              await access(join(work, `done-${i}`));
            } catch {
              prematureInsertion = true;
            }
          }
        }
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
      ...options,
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
      it('T02/T07: offline MCP step and question round trip leave 20 owner and 20 second-task control ACKs under 2 s', async () => {
        const durable = await taskToolsContract(certificate, directory);
        cleanup.push(() => durable.close());
        const servers: NonNullable<AcpTaskHarnessOptions['mcpServers']> = [];
        let tools: Awaited<ReturnType<typeof createTaskTools>>;
        const waiting = Promise.withResolvers<void>();
        const task = await harness(kind, 'mcp', {
          mcpServers: servers,
          question: {
            isOpen: () => tools.question.isOpen(),
            waitForChange: (signal) => tools.question.waitForChange(signal),
          },
          onEvent: (event) => {
            if (event.type === 'step' && event.text === 'Waiting for task answer')
              waiting.resolve();
          },
        });
        tools = await createTaskTools({
          workDirectory: work,
          report: async (...args) => {
            await durable.report(...args);
            mcpReports++;
          },
        });
        servers.push(...tools.mcpServers);
        cleanup.push(() => tools.close());
        const intake = createTaskCommandIntake({
          endpoint: durable.endpoint,
          identity: durable.first,
          harness: task,
          hardStopAt: Date.now() + 60000,
          onAnswerAdmitted: tools.answerAdmitted,
        });
        cleanup.push(() => intake.stop());
        let finished = false;
        const terminal = task
          .start({ ...briefing, softDueAt: new Date(Date.now() + 40000).toISOString() })
          .then((result) => {
            finished = true;
            return result;
          });
        cleanup.push(async () => {
          await task.abort();
          await terminal;
        });
        intake.start();
        await Promise.race([
          waiting.promise,
          terminal.then((result) => {
            throw new Error(`question_missing:${JSON.stringify(result)}`);
          }),
        ]);
        expect(finished).toBe(false);
        const question = await durable.mailbox.readQuestion(durable.first.taskId);
        expect(question).toMatchObject({
          text: 'Which result should I use?',
          answerCommandId: null,
        });
        // Bypass the cooperative shim too: hostile Pod frames must still be
        // refused by core, with only one durable open question per task.
        const floods = await Promise.all(
          Array.from({ length: 20 }, async (_, i) => {
            try {
              await durable.mailbox.append(
                {
                  taskId: durable.first.taskId,
                  attemptId: durable.first.attemptId,
                  direction: 'task_to_core',
                  messageId: `flood-${i}`,
                  sequence: 100 + i,
                  kind: 'question',
                  payload: { questionId: `flood-${i}`, text: 'Another question?' },
                },
                durable.first
              );
              return 'accepted';
            } catch (error) {
              return (error as { code: string }).code;
            }
          })
        );
        expect(floods).toEqual(Array(20).fill('question_open'));
        expect(
          (
            await durable.stores.postgres.query(
              'SELECT 1 FROM core.task_questions WHERE task_id=$1 AND answer_command_id IS NULL',
              [durable.first.taskId]
            )
          ).rowCount
        ).toBe(1);
        const latencies = await durable.responsiveness();
        console.info(`T07 ${kind} ACK milliseconds ${JSON.stringify(latencies)}`);
        expect(finished).toBe(false);
        const stored = await durable.stores.postgres.query(
          'SELECT kind,payload FROM core.task_mailbox WHERE task_id=$1 ORDER BY sequence',
          [durable.first.taskId]
        );
        expect(stored.rows).toEqual([
          { kind: 'step', payload: { line: 'MCP step contract' } },
          {
            kind: 'question',
            payload: { questionId: question!.questionId, text: 'Which result should I use?' },
          },
        ]);
        expect(durable.attempts).toHaveLength(4);
        await durable.mailbox.enqueueCommand({
          taskId: durable.first.taskId,
          attemptId: durable.first.attemptId,
          commandId: 'question-answer',
          kind: 'answer',
          questionId: question!.questionId,
          text: STEER,
        });
        expect(await terminal).toMatchObject({
          outcome: 'succeeded',
          result: 'Steered terminal result.',
        });
        await intake.stop();
        expect(tools.question.isOpen()).toBe(false);
        expect(events).toContainEqual({
          type: 'transcript',
          entry: expect.objectContaining({ role: 'answer', text: expect.stringContaining(STEER) }),
        });
        expect((await durable.mailbox.readCommand('question-answer'))?.disposition).toBe(
          'accepted'
        );
      }, 60000);

      it('transcript: real session tool output and inserted steer/answer reach the durable read view', async () => {
        const durable = await taskToolsContract(certificate, directory);
        cleanup.push(() => durable.close());
        const pending = new Set<Promise<unknown>>();
        let sequence = 0;
        const task = await harness(kind, 'steer-long', {
          onEvent(event) {
            if (event.type !== 'transcript') return;
            const entry = event.entry;
            const flight = durable.mailbox.append(
              {
                taskId: durable.first.taskId,
                attemptId: durable.first.attemptId,
                direction: 'task_to_core',
                messageId: entry.id,
                sequence: ++sequence,
                kind: 'transcript',
                payload: entry,
              },
              durable.first
            );
            pending.add(flight);
            // Test drains and checks every write; no fire-and-forget assertion.
            void flight.catch(() => undefined);
          },
        });
        const terminal = task.start(briefing);
        cleanup.push(async () => {
          await task.abort();
          await terminal;
        });
        await vi.waitFor(() => access(join(work, 'start-0')), { timeout: 20000, interval: 20 });
        await task.intakeReady;
        const steered = `${STEER} STEER-READ-VIEW`;
        const answered = `[question:transcript-question]\n${STEER} ANSWER-READ-VIEW`;
        expect(await task.steer({ commandId: 'chat-steer', kind: 'steer', text: steered })).toBe(
          'accepted'
        );
        expect(await task.steer({ commandId: 'chat-answer', kind: 'answer', text: answered })).toBe(
          'accepted'
        );
        expect(await terminal).toMatchObject({ outcome: 'succeeded' });
        await Promise.all([...pending]);
        const view = await createSteerTaskTool(durable.service).execute({
          action: 'read',
          view: 'transcript',
          taskId: durable.first.taskId,
          limit: 50,
        });
        expect(view).toMatchObject({
          success: true,
          transcript: {
            entries: expect.arrayContaining([
              expect.objectContaining({
                role: 'tool',
                tool: expect.objectContaining({
                  status: 'completed',
                  outputTail: expect.stringContaining('done-0'),
                }),
              }),
              expect.objectContaining({ role: 'steer', text: expect.stringContaining(steered) }),
              expect.objectContaining({ role: 'answer', text: expect.stringContaining(answered) }),
              expect.objectContaining({ role: 'assistant', text: RESULT }),
            ]),
          },
        });
      }, 60000);

      it('settles a delayed admission ACK after ACP reply dispatch on the real adapter', async () => {
        const adapter = await import(
          new URL(
            taskHarnessRegistry[kind]!.adapterModule,
            new URL('../../loader/src/task-harness-registry.ts', import.meta.url)
          ).href
        );
        const admit = adapter.admit;
        const reconcile = adapter.reconcileEndTurn;
        let release!: () => void;
        const dispatched = new Promise<void>((done) => {
          release = done;
        });
        let sending: Promise<string> | undefined;
        let task: TaskHarness;
        let first = true;
        const reconciliations: string[][] = [];
        const admissionSpy = vi
          .spyOn(adapter, 'admit')
          .mockImplementation(async (input: unknown) => {
            // Real native send is held until the reply-dispatch event, not by the
            // sink. The sink returns immediately and ACP remains free to settle.
            await dispatched;
            return admit(input);
          });
        const reconcileSpy = vi
          .spyOn(adapter, 'reconcileEndTurn')
          .mockImplementation(async (input: { commandIds: string[] }) => {
            reconciliations.push([...input.commandIds]);
            return reconcile(input);
          });
        try {
          task = await harness(kind, 'barrier', {
            onEvent: (event) => {
              if (event.type === 'step' && event.text === 'Task is working' && first) {
                first = false;
                sending = task.steer({ commandId: 'delayed-ack', text: STEER });
              }
              if (event.type === 'step' && event.text === 'Settling task turn') release();
            },
          });
          expect(await task.start(briefing)).toEqual({
            outcome: 'succeeded',
            result: 'Steered terminal result.',
          });
          expect(await sending).toBe('accepted');
          expect(reconciliations[0]).toEqual(['delayed-ack']);
        } finally {
          release();
          admissionSpy.mockRestore();
          reconcileSpy.mockRestore();
        }
      }, 60000);

      it.each(['tail', 'late', 'late-tool'] as const)(
        'settles a %s final-answer steer without losing or resending it',
        async (point) => {
          let open = point !== 'tail';
          let sent = false;
          let disposition: string | undefined;
          let task: TaskHarness;
          const question = {
            isOpen: () => open,
            waitForChange: (signal: AbortSignal) =>
              new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
                if (signal.aborted) resolve();
              }),
          };
          task = await harness(kind, point === 'late-tool' ? 'barrier-tool' : 'barrier', {
            question,
            onEvent: async (event) => {
              const target = point === 'tail' ? 'Task is working' : 'Waiting for task answer';
              if (!sent && event.type === 'step' && event.text === target) {
                sent = true;
                disposition = await task.steer({ commandId: 'final-race', text: STEER });
                open = false;
              }
            },
          });
          const terminal = await task.start({
            ...briefing,
            softDueAt: new Date(Date.now() + 40000).toISOString(),
          });
          expect(sent).toBe(true);
          expect(disposition).toBe('accepted');
          expect(terminal).toEqual({ outcome: 'succeeded', result: 'Steered terminal result.' });
          if (point !== 'tail' && kind !== 'prime-agent')
            expect(events).toContainEqual({
              type: 'receipt',
              commandId: 'final-race',
              disposition: 'deferred-to-next-turn',
            });
          if (point === 'late-tool' && kind === 'prime-agent')
            expect(
              events.some((event) => event.type === 'tool' && event.status === 'completed')
            ).toBe(true);
          expect(await task.steer({ commandId: 'after-close', text: STEER })).toBe('rejected');
          if (activeFixture?.usesModelEndpoint) {
            const bodies = requests.map((request) => JSON.parse(request.body));
            expect(bodies.length).toBeGreaterThanOrEqual(2);
            const last = bodies.at(-1);
            const rows = last.messages.filter(
              (message: { role: string; content: unknown }) =>
                message.role === 'user' && JSON.stringify(message.content).includes(STEER)
            );
            expect(rows).toHaveLength(1);
            expect(JSON.stringify(rows[0])).not.toContain('Continue with any already queued input');
            if (point === 'late-tool') expect(toolSent).toBe(true);
          }
        },
        60000
      );

      it('fails closed when successor tool evidence is missing', async () => {
        const loseEvidence = contractFixtures[kind]?.loseSuccessorEvidence;
        if (!loseEvidence) return; // Only the native-successor adapter owns this evidence surface.
        let open = true;
        let task: TaskHarness;
        let injected = false;
        task = await harness(kind, 'barrier-tool', {
          question: {
            isOpen: () => open,
            waitForChange: (signal) =>
              new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              }),
          },
          onEvent: async (event) => {
            if (!injected && event.type === 'step' && event.text === 'Waiting for task answer') {
              injected = true;
              cleanup.push(await loseEvidence(work));
              expect(await task.steer({ commandId: 'missing-evidence', text: STEER })).toBe(
                'accepted'
              );
              open = false;
            }
          },
        });
        expect(await task.start(briefing)).toMatchObject({
          outcome: 'failed',
          reasonCode: 'end_turn_uncertain',
        });
        expect(injected).toBe(true);
        expect(requests.some((request) => request.body.includes('successor-tool-ok'))).toBe(true);
      }, 60000);

      it('keeps an unanswered question waiting until softDueAt and fails as timeout', async () => {
        let waiting = false;
        let finished = false;
        const task = await harness(kind, 'success', {
          question: {
            isOpen: () => true,
            waitForChange: (signal) =>
              new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
                if (signal.aborted) resolve();
              }),
          },
          onEvent: (event) => {
            if (event.type === 'step' && event.text === 'Waiting for task answer') waiting = true;
          },
        });
        // Deadline starts before agent startup, as in the accepted task intent.
        const terminal = task
          .start({ ...briefing, softDueAt: new Date(Date.now() + 30000).toISOString() })
          .then((result) => {
            finished = true;
            return result;
          });
        cleanup.push(async () => {
          await task.abort();
          await terminal;
        });
        await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 20000 });
        expect(finished).toBe(false);
        expect(await terminal).toMatchObject({ outcome: 'failed', reasonCode: 'timeout' });
      }, 45000);

      it('returns one semantic success with a result and refuses a second start', async () => {
        const task = await harness(kind, 'success');
        const terminal = await task.start(briefing);
        expect(terminal).toEqual({ outcome: 'succeeded', result: RESULT });
        await expect(task.start(briefing)).rejects.toThrow('harness_already_started');
        expect(events.some((event) => event.type === 'step')).toBe(true);
        expect(JSON.stringify(events)).not.toContain(TOKEN);
        expect(JSON.stringify(events)).not.toContain(BRIEFING);
        expect(events).toContainEqual({
          type: 'transcript',
          entry: expect.objectContaining({ role: 'assistant', text: RESULT }),
        });
        expect(
          JSON.stringify(
            events.filter((event) => event.type !== 'trace' && event.type !== 'transcript')
          )
        ).not.toContain(RESULT);
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
          await task.intakeReady;
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
          expect(events.filter((event) => event.type === 'receipt')).toEqual([]);
          expect(await task.steer(command)).toBe('accepted');
          if (activeFixture?.nativeReplay) {
            // Bypass the launcher's journal to exercise OpenCode's own same-ID
            // pending replay. Both the native queue and journal must dedupe.
            const native = { ...command, workDirectory: work, sessionId: nativeSessionId };
            expect(await activeFixture.nativeReplay(native)).toBe('accepted');
            expect(await activeFixture.nativeReplay(native)).toBe('accepted');
            // The duplicate really was replayed while still pending, not parked
            // beyond the model request inspected below.
            for (let i = 0; i < count; i++)
              await expect(access(join(work, `done-${i}`))).rejects.toThrow();
            expect(events.filter((event) => event.type === 'receipt')).toEqual([]);
          }
          expect(await task.steer({ ...command, text: 'changed' })).toBe('rejected');
          expect(await terminal).toEqual({ outcome: 'succeeded', result: RESULT });
          expect(prematureInsertion).toBe(false);
          expect(events).toContainEqual({
            type: 'transcript',
            entry: expect.objectContaining({ role: 'steer', text: expect.stringContaining(STEER) }),
          });
          const chatTools = events.filter(
            (event) => event.type === 'transcript' && event.entry.role === 'tool'
          );
          expect(chatTools.length).toBeGreaterThanOrEqual(count * 2);
          for (let i = 0; i < count; i++)
            expect(chatTools).toContainEqual({
              type: 'transcript',
              entry: expect.objectContaining({
                role: 'tool',
                tool: expect.objectContaining({
                  name: expect.any(String),
                  status: 'completed',
                  outputTail: expect.stringContaining(`done-${i}`),
                }),
              }),
            });
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
          await rm(join(work, '.launcher/daemon.sock'));
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
