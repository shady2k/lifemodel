/** Generic ACP JSON-RPC client. Agent-specific launch/config lives in registry modules. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskModelRelay } from './task-model-relay.js';
import { AcpTaskTrace } from './task-trace.js';
import { TASK_PROCESS_SUPERVISOR } from './task-process.js';
import { TaskSteeringJournal } from './task-steering-journal.js';
import type { TaskMcpServer } from './task-tools.js';
import type { AgentConfiguration } from './task-harness-registry.js';
import type {
  TaskBriefing,
  TaskHarness,
  TaskHarnessEventSink,
  TaskHarnessResult,
  TaskSteerCommand,
  TaskSteerDisposition,
  TaskEndTurnInput,
  TaskEndTurnReconciliation,
  TaskQuestionState,
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
  private messageId: string | undefined;
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
  continueTurn(): void {
    this.messageId = undefined;
    this.final = '';
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
      // Some ACP agents identify distinct assistant messages in one prompt.
      // Chunks of the same message append; a new identity replaces old prose.
      const id = update['messageId'];
      if (typeof id === 'string' && id) {
        if (this.messageId !== undefined && this.messageId !== id) this.final = '';
        this.messageId = id;
      }
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
  release?: (input: { workDirectory: string; sessionId: string }) => void;
  failOnUncertain?: boolean;
  observeInsertion?: (input: {
    workDirectory: string;
    sessionId: string;
    commandId: string;
    signal: AbortSignal;
  }) => Promise<boolean>;
  reconcileEndTurn?: (input: TaskEndTurnInput) => Promise<TaskEndTurnReconciliation>;
  question?: TaskQuestionState;
  mcpServers?: TaskMcpServer[];
  timeoutMs?: number;
  storageEnv?: {
    LIFEMODEL_STORAGE_ENDPOINT: string;
    LIFEMODEL_STORAGE_SPACE: string;
    LIFEMODEL_STORAGE_TOKEN_FILE: string;
    LIFEMODEL_STORAGE_CA_FILE: string;
  };
}

export class AcpTaskHarness implements TaskHarness {
  private readonly intake: PromiseWithResolvers<void> = Promise.withResolvers();
  readonly intakeReady = this.intake.promise;
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
    const softDueAt = briefing.softDueAt === undefined ? undefined : Date.parse(briefing.softDueAt);
    if (softDueAt !== undefined && !Number.isFinite(softDueAt)) return failed('timeout');
    const timeout = Math.min(
      this.options.timeoutMs ?? 3600000,
      softDueAt === undefined ? Infinity : softDueAt - Date.now()
    );
    if (timeout <= 0) return failed('timeout');
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(timeout)]);
    let child: ChildProcess | undefined;
    let processClosed: Promise<void> | undefined;
    let stdoutEnded = false;
    let relay: Awaited<ReturnType<typeof createTaskModelRelay>> | undefined;
    let journal: TaskSteeringJournal | undefined;
    const receiptObserver = new AbortController();
    const observedCommands = new Set<string>();
    const insertedCommands = new Map<string, number>();
    let assistantVersion = 0;
    const continuedCommands = new Set<string>();
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
    let intakeOpen = false;
    let promptID: number | undefined;
    const admissions = new Set<Promise<TaskSteerDisposition>>();
    const accepted = new Set<string>();
    let wakeAdmission: (() => void) | undefined;
    let admissionVersion = 0;
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
      intakeOpen = false;
      fail(this.cancelled ? 'aborted' : 'timeout');
      wakeAdmission?.();
    };
    signal.addEventListener('abort', stop, { once: true });
    const emit = async (
      event: Parameters<TaskHarnessEventSink>[0],
      bestEffort = false
    ): Promise<void> => {
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
          if (!bestEffort) fail('harness_event_timeout');
          done(new Error('harness_event_timeout'));
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
        ['home', 'tmp', '.launcher'].map((name) =>
          mkdir(join(work, name), { recursive: true, mode: 0o700 })
        )
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
      const request = (
        method: string,
        params: Json,
        deadline = 30000,
        onWritten?: () => void
      ): Promise<Json> => {
        if (fault) return Promise.reject(fault ?? new Error('harness_write_timeout'));
        const id = ++nextID;
        if (method === 'session/prompt') promptID = id;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              fail('harness_request_timeout');
            },
            Math.min(deadline, timeout)
          );
          pending.set(id, { resolve, reject, timer });
          void write({ jsonrpc: '2.0', id, method, params })
            .then(() => {
              if (!fault && !signal.aborted && !closing && pending.has(id)) onWritten?.();
            })
            .catch(() => {
              fail('harness_stream_failed');
            });
        });
      };
      const applyUpdate = async (update: Json): Promise<void> => {
        if (update['sessionUpdate'] === 'agent_message_chunk') assistantVersion++;
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
      };
      const dispatch = async (message: Json) => {
        if (fault) return;
        if (promptSettled) throw new Error('harness_after_terminal');
        if (message['jsonrpc'] !== '2.0') throw new Error('harness_protocol_error');
        if (message['method'] === 'session/update') {
          const params = record(message['params']);
          if (params['sessionId'] !== sessionID) throw new Error('harness_session_invalid');
          const update = record(params['update']);
          await applyUpdate(update);
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
        // This is the intake linearization point, before resolving the ACP waiter.
        if (id === promptID) intakeOpen = false;
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
      const created = await request('session/new', {
        cwd: work,
        mcpServers: this.options.mcpServers ?? [],
      });
      if (typeof created['sessionId'] !== 'string' || !created['sessionId'])
        throw new Error('harness_session_invalid');
      sessionID = created['sessionId'];
      if (this.options.bind) await this.options.bind({ workDirectory: work, sessionId: sessionID });
      let steering: typeof this.steering;
      if (this.options.admit) {
        journal = await TaskSteeringJournal.open(join(work, '.launcher', 'steering.journal'), {
          capacity: 1024,
          create: true,
        });
        const boundSession = sessionID;
        const steeringJournal = journal;
        const admit = this.options.admit;
        const send = async (command: TaskSteerCommand): Promise<TaskSteerDisposition> => {
          if (
            !command.commandId.trim() ||
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
                  if (inserted && !receiptObserver.signal.aborted) {
                    // Only insertion observed inside the ACP turn is covered
                    // by that turn's final. Late idle successor prose still
                    // needs native evidence even if its receipt already arrived.
                    if (promptID !== undefined && pending.has(promptID))
                      insertedCommands.set(command.commandId, assistantVersion);
                    await emit(
                      {
                        type: 'receipt',
                        commandId: command.commandId,
                        disposition: 'inserted',
                      },
                      true
                    );
                  }
                })
                .catch(() => {
                  // Observation is best-effort. Missing history or receipt
                  // evidence must never interrupt a native turn.
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
          if (
            steeringJournal.hasFailed() ||
            (disposition === 'uncertain' && this.options.failOnUncertain)
          ) {
            fail('steer_uncertain');
            this.cancellation.abort();
          }
          return disposition;
        };
        steering = (command) => {
          // Known IDs remain replayable while the barrier owns intake. send()
          // checks the text hash and joins the journal's in-flight disposition.
          if (fault || signal.aborted || (!intakeOpen && !commandTexts.has(command.commandId)))
            return Promise.resolve('rejected');
          const replay = commandTexts.has(command.commandId);
          const flight = send(command).then((disposition) => {
            if (disposition !== 'rejected' && !replay) {
              accepted.add(command.commandId);
              admissionVersion++;
              wakeAdmission?.();
            }
            return disposition;
          });
          admissions.add(flight);
          void flight.finally(() => admissions.delete(flight));
          return flight;
        };
      }
      this.cancelRequest = () =>
        write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionID } });
      await emit({ type: 'step', text: 'Running task' });
      turn.begin(briefing.model);
      const prompt = async (text: string) => {
        const response = await request(
          'session/prompt',
          { sessionId: sessionID, prompt: [{ type: 'text', text }] },
          timeout,
          () => {
            intakeOpen = true;
            this.steering = steering;
            if (steering) this.intake.resolve();
          }
        );
        promptResponse = response;
        stopReason = response['stopReason'];
        await queue;
        if (fault) throw fault;
      };
      await prompt(briefing.text);
      while (stopReason === 'end_turn') {
        intakeOpen = false;
        await emit({ type: 'step', text: 'Settling task turn' });
        // Every call registered before closure must settle, including journal sync.
        await Promise.all([...admissions]);
        if (fault || signal.aborted) throw fault ?? new Error('timeout');
        const commandIds = [...accepted];
        accepted.clear();
        const reconciliation = this.options.reconcileEndTurn
          ? await this.options.reconcileEndTurn({
              workDirectory: work,
              sessionId: sessionID,
              commandIds,
              insertedCommandIds: [...insertedCommands]
                .filter(([, version]) => version < assistantVersion)
                .map(([id]) => id),
              continuedCommandIds: [...continuedCommands],
              signal,
            })
          : { state: commandIds.length ? ('unknown' as const) : ('idle' as const) };
        if (fault || signal.aborted) throw fault ?? new Error('timeout');
        if (reconciliation.state === 'unknown') throw new Error('end_turn_uncertain');
        if (reconciliation.state === 'continue') {
          for (const commandId of reconciliation.commandIds) {
            accepted.add(commandId);
            continuedCommands.add(commandId);
          }
          for (const commandId of reconciliation.commandIds)
            await emit({ type: 'receipt', commandId, disposition: 'deferred-to-next-turn' }, true);
          turn.continueTurn();
          await prompt('Continue.');
          continue;
        }
        if (reconciliation.state === 'successor') {
          // Native admission may itself wake work. Own that work until native idle.
          turn.continueTurn();
          intakeOpen = true;
          const evidence = await reconciliation.wait({
            closeIntake: async () => {
              intakeOpen = false;
              await Promise.all([...admissions]);
              const ids = [...accepted];
              accepted.clear();
              return ids;
            },
            reopenIntake: () => {
              intakeOpen = true;
            },
          });
          intakeOpen = false;
          if (fault || signal.aborted) throw fault ?? new Error('timeout');
          if (!evidence) throw new Error('end_turn_uncertain');
          await queue;
          turn.continueTurn();
          for (const update of evidence.updates) {
            if (update.kind === 'reset') turn.continueTurn();
            else if (update.kind === 'text')
              await applyUpdate({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: update.text },
              });
            else
              await applyUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: update.id,
                status: update.status,
                rawInput: update.input,
                rawOutput: update.output,
              });
          }
          stopReason = evidence.stopReason;
          continue;
        }
        if (!this.options.question?.isOpen()) break;
        // Questions retain the same task budget. Wake on either admitted input
        // or a question-state change; register before reopening to avoid lost wakes.
        const version = admissionVersion;
        const waiting = new AbortController();
        const waitingSignal = AbortSignal.any([signal, waiting.signal]);
        let wake: (() => void) | undefined;
        const changed = new Promise<void>((resolve) => {
          wake = resolve;
        });
        wakeAdmission = wake;
        intakeOpen = true;
        try {
          await emit({ type: 'step', text: 'Waiting for task answer' });
          // wakeAdmission is installed synchronously before intake reopens.
          // Even an admission completed inside emit() resolves changed; there
          // is no unregistered interval requiring a second version wake.
          await Promise.race([changed, this.options.question.waitForChange(waitingSignal)]);
          // Defensive rate limit for an implementation that signals an unchanged
          // level immediately. Keep intake open and the admission wake active.
          if (version === admissionVersion && this.options.question.isOpen())
            await Promise.race([changed, delay(100, undefined, { signal: waitingSignal })]);
        } finally {
          intakeOpen = false;
          wakeAdmission = undefined;
          waiting.abort();
        }
        if (fault || signal.aborted) throw fault ?? new Error('timeout');
        await Promise.all([...admissions]);
        // A correlated answer must be admitted as text, not merely a local flag.
        if (version === admissionVersion && !this.options.question.isOpen())
          throw new Error('end_turn_uncertain');
      }
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
                : (fault?.message ??
                    (error instanceof Error &&
                    ['end_turn_uncertain', 'timeout'].includes(error.message)
                      ? error.message
                      : 'harness_failed'))
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
      intakeOpen = false;
      // Failure and abort paths also own in-flight sends. Never close their
      // journal or declare success while admission can still become uncertain.
      await journal?.close().catch(() => {
        fail('steer_uncertain');
      });
      if (fault?.message === 'steer_uncertain') result = failed('steer_uncertain');
      receiptObserver.abort();
      await Promise.all(observers);
      if (sessionID) this.options.release?.({ workDirectory: work, sessionId: sessionID });
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
