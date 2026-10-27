/** Generic ACP JSON-RPC client. Agent-specific launch/config lives in registry modules. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createTaskModelRelay } from './task-model-relay.js';
import { AcpTaskTrace } from './task-trace.js';
import { TASK_PROCESS_SUPERVISOR } from './task-process.js';
import { TaskSteeringJournal } from './task-steering-journal.js';
import type { AgentConfiguration } from './task-harness-registry.js';
import type {
  TaskBriefing,
  TaskHarness,
  TaskHarnessEventSink,
  TaskHarnessResult,
  TaskSteerCommand,
  TaskSteerDisposition,
} from './task-harness.js';

type Json = Record<string, unknown>;
const record = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const failed = (reasonCode: string): TaskHarnessResult => ({
  outcome: 'failed',
  result: '',
  reasonCode,
});
const aborted = (): TaskHarnessResult => ({
  outcome: 'aborted',
  result: '',
  reasonCode: 'aborted',
});

/** One turn only. Unsettled calls block success; later agent work can recover failures. */
export class AcpTurn {
  private readonly tools = new Map<string, Json & { status: string }>();
  private unresolvedFailureId: string | undefined;
  private protocolFailureSpanId: string | undefined;
  private readonly trace: AcpTaskTrace;
  private final = '';
  private providerFailed = false;
  constructor(
    private readonly toolOutputFailed: (output: unknown, input?: unknown) => boolean = () => false,
    onEvent?: TaskHarnessEventSink
  ) {
    this.trace = new AcpTaskTrace(onEvent);
  }

  begin(model: string): void {
    this.trace.begin(model);
  }
  cleanupFailed(): void {
    this.trace.failModel('harness_cleanup_failed');
  }
  failureSpanId(): string | undefined {
    return this.protocolFailureSpanId ?? this.trace.modelSpanId();
  }
  finish(result: TaskHarnessResult, response: Json): void {
    this.trace.finish(result, response, this.final, this.providerFailed);
  }

  update(value: unknown): 'step' | 'tool' | undefined {
    const update = record(value);
    if (update['sessionUpdate'] === 'usage_update') this.trace.reportUsage(update);
    if (update['sessionUpdate'] === 'agent_message_chunk') {
      const content = record(update['content']);
      if (content['type'] === 'text' && typeof content['text'] === 'string') {
        if (content['text'].trim()) this.unresolvedFailureId = undefined;
        this.final += content['text'];
        if (Buffer.byteLength(this.final) > 1_048_576) throw new Error('harness_result_limit');
      }
      return 'step';
    }
    if (update['sessionUpdate'] === 'tool_call' || update['sessionUpdate'] === 'tool_call_update') {
      const id = update['toolCallId'];
      if (typeof id !== 'string' || !id || (!this.tools.has(id) && this.tools.size >= 10000))
        throw new Error('harness_protocol_error');
      const previous = this.tools.get(id);
      const status = update['status'];
      if (
        status !== undefined &&
        status !== null &&
        (typeof status !== 'string' ||
          !['pending', 'in_progress', 'completed', 'failed'].includes(status))
      ) {
        // Preserve the bad host status as failed evidence before rejecting ACP.
        this.trace.tool(id, { ...previous, ...update }, true);
        this.protocolFailureSpanId = this.trace.toolSpanId(id);
        throw new Error('harness_protocol_error');
      }
      // ACP v1 updates are patches: omitted/null fields leave prior values in
      // place, including rawInput needed to interpret a later rawOutput.
      const tool: Json & { status: string } = {
        ...previous,
        status: previous?.status ?? 'pending',
      };
      for (const [key, value] of Object.entries(update)) {
        if (key !== 'sessionUpdate' && value !== undefined && value !== null) tool[key] = value;
      }
      this.tools.set(id, tool);
      const outputFailed = this.toolOutputFailed(tool['rawOutput'], tool['rawInput']);
      this.trace.tool(id, tool, outputFailed);
      const previousPending = previous?.status === 'pending' || previous?.status === 'in_progress';
      const pending = tool.status === 'pending' || tool.status === 'in_progress';
      // Only new/resumed work is an agent action. A concurrent call settling,
      // or a presentation patch for a settled call, is not recovery evidence.
      const agentWork = !previous || (!previousPending && pending);
      if (agentWork) this.unresolvedFailureId = undefined;
      const previousFailed =
        previous?.status === 'failed' ||
        (previous !== undefined &&
          this.toolOutputFailed(previous['rawOutput'], previous['rawInput']));
      const changedEvidence =
        !isDeepStrictEqual(previous?.['rawInput'], tool['rawInput']) ||
        !isDeepStrictEqual(previous?.['rawOutput'], tool['rawOutput']) ||
        (tool.status === 'failed' && previous?.status !== 'failed');
      // Do not reopen a recovered call from retained failed output when it
      // resumes. Its eventual settlement (or changed raw evidence) decides anew.
      if (
        (tool.status === 'failed' || outputFailed) &&
        (!previousFailed || changedEvidence || (previousPending && !pending))
      )
        this.unresolvedFailureId = id;
      // Work invalidates earlier prose. Presentation/output patches for an
      // already settled call do not erase the final answer that followed it.
      if (
        !previous ||
        previous.status === 'pending' ||
        previous.status === 'in_progress' ||
        tool.status === 'pending' ||
        tool.status === 'in_progress'
      )
        this.final = '';
      return 'tool';
    }
    return undefined;
  }
  toolStatus(id: unknown): string | undefined {
    return typeof id === 'string' ? this.tools.get(id)?.status : undefined;
  }
  error(): void {
    this.providerFailed = true;
  }
  result(stopReason: unknown): TaskHarnessResult {
    if (stopReason === 'cancelled') return aborted();
    if (this.providerFailed) return failed('provider_error');
    const offendingId =
      [...this.tools].find(
        ([, tool]) => tool.status === 'pending' || tool.status === 'in_progress'
      )?.[0] ?? this.unresolvedFailureId;
    if (offendingId !== undefined) {
      const failureSpanId = this.trace.toolSpanId(offendingId);
      return { ...failed('required_tool_failed'), ...(failureSpanId ? { failureSpanId } : {}) };
    }
    if (stopReason !== 'end_turn' || !this.final.trim()) return failed('no_final_result');
    return { outcome: 'succeeded', result: this.final.trim() };
  }
}

export interface AcpTaskHarnessOptions {
  modelEndpoint: string;
  modelTokenFile: string;
  modelCaFile: string;
  workDirectory?: string;
  onEvent?: TaskHarnessEventSink;
  agent?: AgentConfiguration;
  configure?: (input: {
    workDirectory: string;
    configFile: string;
    relayBaseURL: string;
    adapterConfig?: AgentConfiguration['adapterConfig'];
  }) => NodeJS.ProcessEnv;
  toolOutputFailed?: (output: unknown, input?: unknown) => boolean;
  admit?: (input: {
    workDirectory: string;
    sessionId: string;
    commandId: string;
    text: string;
  }) => Promise<TaskSteerDisposition>;
  bind?: (input: { workDirectory: string; sessionId: string }) => Promise<void>;
  observeInsertion?: (input: {
    workDirectory: string;
    sessionId: string;
    commandId: string;
    signal: AbortSignal;
  }) => Promise<boolean>;
  timeoutMs?: number;
  storageEnv?: {
    LIFEMODEL_STORAGE_ENDPOINT: string;
    LIFEMODEL_STORAGE_SPACE: string;
    LIFEMODEL_STORAGE_TOKEN_FILE: string;
    LIFEMODEL_STORAGE_CA_FILE: string;
  };
}

export class AcpTaskHarness implements TaskHarness {
  private started = false;
  private cancelled = false;
  private cancelRequest: (() => Promise<void>) | undefined;
  private readonly cancellation = new AbortController();
  constructor(private readonly options: AcpTaskHarnessOptions) {}
  private steering: ((command: TaskSteerCommand) => Promise<TaskSteerDisposition>) | undefined;
  steer(command: TaskSteerCommand): Promise<TaskSteerDisposition> {
    return this.steering?.(command) ?? Promise.resolve('rejected');
  }
  wrap(): Promise<'not_supported'> {
    return Promise.resolve('not_supported');
  }
  async abort(): Promise<void> {
    this.cancelled = true;
    await this.cancelRequest?.().catch(() => undefined);
    this.cancellation.abort();
  }
  async start(briefing: TaskBriefing): Promise<TaskHarnessResult> {
    if (this.started) throw new Error('harness_already_started');
    this.started = true;
    if (this.cancelled) return aborted();
    const agent = this.options.agent;
    if (!agent || !this.options.configure) return failed('harness_not_configured');
    const work = this.options.workDirectory ?? '/work';
    const timeout = this.options.timeoutMs ?? 3600000;
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(timeout)]);
    let child: ChildProcess | undefined;
    let processClosed: Promise<void> | undefined;
    let stdoutEnded = false;
    let relay: Awaited<ReturnType<typeof createTaskModelRelay>> | undefined;
    let journal: TaskSteeringJournal | undefined;
    const receiptObserver = new AbortController();
    const observedCommands = new Set<string>();
    const commandTexts = new Map<string, string>();
    const observers = new Set<Promise<void>>();
    const turn = new AcpTurn(this.options.toolOutputFailed, this.options.onEvent);
    let result: TaskHarnessResult = failed('harness_failed');
    const pending = new Map<
      number,
      {
        resolve: (v: Json) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let nextID = 0;
    let sessionID: string | undefined;
    let fault: Error | undefined;
    let queue = Promise.resolve();
    let queuedBytes = 0;
    let closing = false;
    let promptSettled = false;
    let stopReason: unknown;
    let promptResponse: Json = {};
    const fail = (code: string) => {
      fault ??= new Error(code);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(fault ?? new Error('harness_write_timeout'));
      }
      pending.clear();
    };
    const stop = () => {
      fail(this.cancelled ? 'aborted' : 'harness_timeout');
    };
    signal.addEventListener('abort', stop, { once: true });
    const emit = async (event: Parameters<TaskHarnessEventSink>[0]): Promise<void> => {
      if (fault || signal.aborted) throw fault ?? new Error('harness_timeout');
      await new Promise<void>((resolve, reject) => {
        const done = (error?: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          if (error) reject(error instanceof Error ? error : new Error('harness_event_failed'));
          else resolve();
        };
        const cancel = () => {
          done(new Error('harness_timeout'));
        };
        const timer = setTimeout(() => {
          fail('harness_event_timeout');
          done(fault);
        }, 5000);
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve()
          .then(() => this.options.onEvent?.(event))
          .then(() => {
            done();
          }, done);
        if (signal.aborted) cancel();
      });
    };

    try {
      await Promise.all(
        ['home', 'tmp'].map((name) => mkdir(join(work, name), { recursive: true, mode: 0o700 }))
      );
      relay = await createTaskModelRelay({
        modelEndpoint: this.options.modelEndpoint,
        modelTokenFile: this.options.modelTokenFile,
        modelCaFile: this.options.modelCaFile,
        timeoutMs: Math.min(timeout, 300000),
        onError: () => {
          turn.error();
        },
      });
      const storage = this.options.storageEnv;
      const env: NodeJS.ProcessEnv = {
        ...(storage
          ? {
              LIFEMODEL_STORAGE_ENDPOINT: storage.LIFEMODEL_STORAGE_ENDPOINT,
              LIFEMODEL_STORAGE_SPACE: storage.LIFEMODEL_STORAGE_SPACE,
              LIFEMODEL_STORAGE_TOKEN_FILE: storage.LIFEMODEL_STORAGE_TOKEN_FILE,
              LIFEMODEL_STORAGE_CA_FILE: storage.LIFEMODEL_STORAGE_CA_FILE,
            }
          : {}),
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: join(work, 'home'),
        TMPDIR: join(work, 'tmp'),
        ...this.options.configure({
          workDirectory: work,
          configFile: agent.configFile,
          relayBaseURL: relay.baseURL,
          adapterConfig: agent.adapterConfig,
        }),
      };
      if (signal.aborted) throw new Error('aborted');
      child = spawn('python3', ['-c', TASK_PROCESS_SUPERVISOR, agent.command, ...agent.args], {
        cwd: work,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const running = child;
      // Unlike exit, close waits for the stdout pipe to finish draining.
      processClosed = new Promise<void>((resolve) => {
        running.once('close', () => {
          resolve();
        });
      });
      const { stdin, stdout, stderr } = running;
      if (!stdin || !stdout || !stderr) throw new Error('harness_stream_failed');
      child.on('error', () => {
        fail('harness_process_failed');
      });
      child.on('exit', () => {
        if (!closing) fail('harness_process_failed');
      });
      for (const stream of [stdin, stdout, stderr])
        stream.on('error', () => {
          fail('harness_stream_failed');
        });
      stderr.resume(); // raw agent logs never reach launcher diagnostics
      const write = (message: Json): Promise<void> =>
        new Promise((resolve, reject) => {
          if (fault || !child?.stdin?.writable) {
            reject(fault ?? new Error('harness_stream_failed'));
            return;
          }
          const timer = setTimeout(() => {
            fail('harness_write_timeout');
            reject(fault ?? new Error('harness_write_timeout'));
          }, 2000);
          child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
            clearTimeout(timer);
            if (error) {
              fail('harness_stream_failed');
              reject(error);
            } else resolve();
          });
        });
      const request = (method: string, params: Json, deadline = 30000): Promise<Json> => {
        if (fault) return Promise.reject(fault ?? new Error('harness_write_timeout'));
        const id = ++nextID;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              fail('harness_request_timeout');
            },
            Math.min(deadline, timeout)
          );
          pending.set(id, { resolve, reject, timer });
          void write({ jsonrpc: '2.0', id, method, params }).catch(() => {
            fail('harness_stream_failed');
          });
        });
      };
      const dispatch = async (message: Json) => {
        if (fault) return;
        if (promptSettled) throw new Error('harness_after_terminal');
        if (message['jsonrpc'] !== '2.0') throw new Error('harness_protocol_error');
        if (message['method'] === 'session/update') {
          const params = record(message['params']);
          if (params['sessionId'] !== sessionID) throw new Error('harness_session_invalid');
          const update = record(params['update']);
          const event = turn.update(update);
          if (event === 'step') await emit({ type: 'step', text: 'Task is working' });
          if (event === 'tool') {
            const toolStatus = turn.toolStatus(update['toolCallId']);
            const status =
              toolStatus === 'failed'
                ? 'error'
                : toolStatus === 'completed'
                  ? 'completed'
                  : 'running';
            await emit({ type: 'tool', name: 'task_tool', status });
          }
          return;
        }
        if (typeof message['method'] === 'string') {
          if (!Object.hasOwn(message, 'id')) return; // unknown optional notification
          if (message['method'] === 'session/request_permission') {
            const params = record(message['params']);
            // Noninteractive, task-scoped permission only; reject every requested approval.
            // Normal task tools use the baked allow rules; questions/external paths stay denied.
            if (params['sessionId'] !== sessionID) throw new Error('harness_session_invalid');
            await write({
              jsonrpc: '2.0',
              id: message['id'],
              result: { outcome: { outcome: 'cancelled' } },
            });
          } else
            await write({
              jsonrpc: '2.0',
              id: message['id'],
              error: { code: -32601, message: 'Method not supported' },
            });
          return;
        }
        const id = message['id'];
        if (typeof id !== 'number' || !pending.has(id)) throw new Error('harness_protocol_error');
        const waiter = pending.get(id);
        if (!waiter) throw new Error('harness_protocol_error');
        pending.delete(id);
        clearTimeout(waiter.timer);
        if (Object.hasOwn(message, 'error')) {
          turn.error();
          waiter.reject(new Error('provider_error'));
        } else if (!Object.hasOwn(message, 'result'))
          waiter.reject(new Error('harness_protocol_error'));
        else waiter.resolve(record(message['result']));
      };
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffered = '';
      stdout.on('data', (chunk: Buffer) => {
        try {
          buffered += decoder.decode(chunk, { stream: true });
        } catch {
          fail('harness_protocol_error');
          return;
        }
        if (Buffer.byteLength(buffered) > 4_194_304) {
          fail('harness_frame_limit');
          return;
        }
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          queuedBytes += Buffer.byteLength(line);
          if (queuedBytes > 4_194_304) {
            fail('harness_frame_limit');
            return;
          }
          queue = queue
            .then(() => dispatch(record(JSON.parse(line))))
            .catch(() => {
              fail('harness_protocol_error');
            })
            .finally(() => {
              queuedBytes -= Buffer.byteLength(line);
            });
        }
      });
      stdout.on('end', () => {
        stdoutEnded = true;
        try {
          buffered += decoder.decode();
          if (buffered.trim()) fail('harness_protocol_error');
        } catch {
          // Fatal decoding also rejects an incomplete UTF-8 code point at EOF.
          fail('harness_protocol_error');
        }
        if (!closing) fail('harness_process_failed');
      });
      const initialized = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'lifemodel', version: '1' },
      });
      if (initialized['protocolVersion'] !== 1) throw new Error('harness_protocol_error');
      const created = await request('session/new', { cwd: work, mcpServers: [] });
      if (typeof created['sessionId'] !== 'string' || !created['sessionId'])
        throw new Error('harness_session_invalid');
      sessionID = created['sessionId'];
      if (this.options.bind) await this.options.bind({ workDirectory: work, sessionId: sessionID });
      if (this.options.admit) {
        journal = await TaskSteeringJournal.open(join(work, 'tmp', 'steering.journal'), {
          capacity: 1024,
          create: true,
        });
        const boundSession = sessionID;
        const steeringJournal = journal;
        const admit = this.options.admit;
        this.steering = async (command) => {
          if (
            !command.commandId ||
            !command.text.trim() ||
            Buffer.byteLength(command.commandId) > 256 ||
            Buffer.byteLength(command.text) > 60000
          )
            return 'rejected';
          const textHash = createHash('sha256').update(command.text).digest('hex');
          const previousText = commandTexts.get(command.commandId);
          if (previousText !== undefined && previousText !== textHash) return 'rejected';
          if (previousText === undefined) {
            if (commandTexts.size >= 1024) return 'rejected';
            commandTexts.set(command.commandId, textHash);
          }
          const disposition = await steeringJournal.admit(command, () =>
            admit({ workDirectory: work, sessionId: boundSession, ...command })
          );
          if (!observedCommands.has(command.commandId)) {
            observedCommands.add(command.commandId);
            if (disposition === 'accepted' && this.options.observeInsertion) {
              const observer = this.options
                .observeInsertion({
                  workDirectory: work,
                  sessionId: boundSession,
                  commandId: command.commandId,
                  signal: receiptObserver.signal,
                })
                .then(async (inserted) => {
                  if (inserted && !receiptObserver.signal.aborted)
                    await emit({
                      type: 'receipt',
                      commandId: command.commandId,
                      disposition: 'inserted',
                    });
                })
                .catch(() => {
                  if (!receiptObserver.signal.aborted) {
                    fail('harness_receipt_failed');
                    this.cancellation.abort();
                  }
                });
              observers.add(observer);
              void observer.finally(() => observers.delete(observer));
            } else if (disposition !== 'accepted') {
              void Promise.resolve()
                .then(() =>
                  this.options.onEvent?.({
                    type: 'receipt',
                    commandId: command.commandId,
                    disposition: disposition === 'uncertain' ? 'uncertain' : 'failed',
                  })
                )
                .catch(() => undefined);
            }
          }
          if (disposition === 'uncertain') {
            fail('steer_uncertain');
            this.cancellation.abort();
          }
          return disposition;
        };
      }
      this.cancelRequest = () =>
        write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionID } });
      await emit({ type: 'step', text: 'Running task' });
      turn.begin(briefing.model);
      const response = await request(
        'session/prompt',
        { sessionId: sessionID, prompt: [{ type: 'text', text: briefing.text }] },
        timeout
      );
      promptResponse = response;
      stopReason = response['stopReason'];
      // Finish the batch containing the reply before planning shutdown. Frames
      // coalesced behind it cannot hide a malformed message or late tool error.
      await queue;
      if (fault) throw fault;
      promptSettled = true;
      result = this.cancelled ? aborted() : turn.result(stopReason);
    } catch (error) {
      result = this.cancelled ? aborted() : turn.result(undefined);
      if (result.reasonCode !== 'provider_error')
        result = this.cancelled
          ? aborted()
          : failed(
              error instanceof Error && error.message === 'provider_error'
                ? 'provider_error'
                : (fault?.message ?? 'harness_failed')
            );
      try {
        await emit({
          type: 'error',
          code: result.reasonCode ?? 'harness_failed',
        });
      } catch {
        /* preserve cleanup */
      }
    } finally {
      turn.finish(result, promptResponse);
      closing = true;
      this.cancelRequest = undefined;
      this.steering = undefined;
      // Cleanup owns already-started sends even before the later end-turn
      // reconciliation barrier is implemented. Never close their journal or
      // declare success while admission can still become uncertain.
      await journal?.close().catch(() => {
        fail('steer_uncertain');
      });
      if (fault?.message === 'steer_uncertain') result = failed('steer_uncertain');
      receiptObserver.abort();
      await Promise.all(observers);
      let cleanupFailed = false;
      try {
        const cleanupChild = child;
        if (cleanupChild?.pid) {
          const cleanupPid = cleanupChild.pid;
          if (cleanupChild.exitCode === null && cleanupChild.signalCode === null) {
            try {
              process.kill(-cleanupPid, 'SIGTERM');
            } catch {
              /* already exited */
            }
          }
          const hard = setTimeout(() => {
            try {
              process.kill(-cleanupPid, 'SIGKILL');
            } catch {
              /* already exited */
            }
          }, 5000);
          let last: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              processClosed,
              new Promise<never>((_resolve, reject) => {
                last = setTimeout(() => {
                  reject(new Error('harness_cleanup_timeout'));
                }, 6000);
              }),
            ]);
          } finally {
            clearTimeout(hard);
            clearTimeout(last);
          }
        }
        // Keep stdout live until close/EOF, then validate every queued frame
        // and the final framing/UTF-8 boundary before accepting success.
        await queue;
        if (fault || (child && !stdoutEnded)) cleanupFailed = true;
        await relay?.close();
        cleanupFailed ||=
          !!child &&
          (child.signalCode !== null || (child.exitCode !== 0 && child.exitCode !== 143));
      } catch {
        cleanupFailed = true;
      } finally {
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        await relay?.close().catch(() => {
          cleanupFailed = true;
        });
      }
      // Journal was closed after intake stopped and before process cleanup.
      signal.removeEventListener('abort', stop);
      fail('harness_closed');
      if (cleanupFailed && result.outcome === 'succeeded') {
        result = failed('harness_cleanup_failed');
        turn.cleanupFailed();
      }
    }
    const failureSpanId = result.outcome === 'failed' ? turn.failureSpanId() : undefined;
    return failureSpanId && !result.failureSpanId ? { ...result, failureSpanId } : result;
  }
}
