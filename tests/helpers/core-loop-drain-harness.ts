/**
 * Harness for shutdown-drain tests: a real CoreLoop wired the way the
 * container wires it (real Agent, EventBus, Metrics, DeferredStorage over
 * JSONStorage, the pending-signal journal and the production shutdown
 * sequence), with doubles only at the boundaries:
 * - the three layer processors are the processing boundary (no LLM, no network)
 * - the persistence services (state manager, registries) are step recorders
 *
 * Start/stop mirror exactly what src/core/container.ts does on both paths:
 * start = restore the journal, push restored signals, start the loop;
 * stop  = the production shutdownSequence().
 */
import { mkdir, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoreLoop, type CoreLoopConfig, type CoreLoopDeps } from '../../src/core/core-loop.js';
import { createAgent } from '../../src/core/agent.js';
import { RecipientRegistry } from '../../src/core/recipient-registry.js';
import { createEventBus } from '../../src/core/event-bus.js';
import { createMetrics } from '../../src/core/metrics.js';
import { createLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/types/logger.js';
import {
  createJSONStorage,
  createDeferredStorage,
  type DeferredStorage,
} from '../../src/storage/index.js';
import {
  RealCognitionFacade,
  createRealCognitionProcessor,
} from './core-loop-real-cognition.js';
import {
  loadPendingSignals,
  persistPendingSignals,
  pendingSignalsPath,
  clearPendingSignals,
} from '../../src/core/pending-signal-journal.js';
import { makeIdempotentShutdown, shutdownSequence } from '../../src/core/container.js';
import type { CognitionContext, CognitionResult } from '../../src/types/layers.js';
import type { Signal } from '../../src/types/signal.js';
import { createSignal } from '../../src/types/signal.js';
import type { Channel } from '../../src/types/index.js';

export function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll an observable condition with a bounded deadline (no sleeps on the happy path). */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

export interface CognitionCall {
  context: CognitionContext;
  /** Resolves when the turn finishes; 'hang' turns stay pending until settled. */
  done: Promise<CognitionResult>;
}

/**
 * The LLM boundary. In 'hang' mode the turn never finishes until
 * settleAll() resolves it — that is the overrunning turn.
 */
export class FakeCognitionLayer {
  readonly name = 'cognition';
  readonly calls: CognitionCall[] = [];
  private readonly deferreds: {
    resolve: (value: CognitionResult) => void;
    reject: (reason?: unknown) => void;
  }[] = [];

  /**
   * Result every immediately settling turn resolves with. Override it to say
   * HOW the turn ended (disposition): only a delivered answer or a deliberate
   * no-reply settles the turn's inbound log entries (finding 4).
   */
  result: CognitionResult = { confidence: 1, intents: [], response: undefined };

  constructor(private readonly mode: 'immediate' | 'hang') {}

  // CoreLoop calls this on construction (no-op for the fake)
  setDependencies(_deps: unknown): void {}

  process(context: CognitionContext): Promise<CognitionResult> {
    const deferred = makeDeferred<CognitionResult>();
    this.calls.push({ context, done: deferred.promise });
    this.deferreds.push(deferred);
    if (this.mode === 'immediate') {
      deferred.resolve(this.withTurnTrace(this.result, context));
    }
    return deferred.promise;
  }

  /**
   * The real intent compiler stamps every SEND_MESSAGE of a turn with the
   * turn's trace (`{tickId, parentSignalId}`); CoreLoop attributes a send to
   * its turn through that trace. A fake result without it would look like a
   * send from nowhere, so the double mirrors the compiler.
   */
  private withTurnTrace(result: CognitionResult, context: CognitionContext): CognitionResult {
    const trigger = context.triggerSignals[0];
    return {
      ...result,
      intents: result.intents.map((intent) =>
        intent.type === 'SEND_MESSAGE' && intent.trace === undefined
          ? { ...intent, trace: { tickId: context.tickId, parentSignalId: trigger?.id ?? '' } }
          : intent
      ),
    };
  }

  /** Finish every pending turn (test cleanup, or with a chosen result). */
  settleAll(result?: CognitionResult): void {
    const withResult: CognitionResult = result ?? this.result;
    for (const d of this.deferreds.splice(0)) {
      d.resolve(withResult);
    }
  }

  /** Make every pending turn REJECT (the drain failure path). */
  rejectAll(reason = new Error('turn exploded')): void {
    for (const d of this.deferreds.splice(0)) {
      d.reject(reason);
    }
  }

  triggerIds(): string[] {
    const ids: string[] = [];
    for (const call of this.calls) {
      for (const s of call.context.triggerSignals) ids.push(s.id);
    }
    return ids;
  }
}

/** AUTONOMIC boundary: records what it sees each tick, emits nothing. */
export class FakeAutonomicLayer {
  readonly name = 'autonomic';
  readonly seen: Signal[][] = [];

  ticks(): number {
    return this.seen.length;
  }

  process(_state: unknown, incomingSignals: Signal[], _correlationId: string) {
    this.seen.push([...incomingSignals]);
    // pass the incoming signals through unchanged (AUTONOMIC emits nothing)
    return { signals: [...incomingSignals], intents: [] };
  }

  /** A later tick saw exactly these signals drained again (they were re-queued) */
  sawAgainInOrder(...signals: Signal[]): boolean {
    if (this.seen.length < 2) return false; // first tick: first sight, not yet re-drained
    const wanted = signals.map((s) => s.id).join('|');
    return this.seen
      .slice(1) // re-drains happen from the second batch on
      .some((batch) => batch.map((s) => s.id).join('|') === wanted);
  }
}

/**
 * AGGREGATION boundary: wakes COGNITION for any positive batch (like a
 * user message), passing the batch through as trigger signals — so every
 * signal that reaches AGGREGATION shows up in the cognition context and
 * can be counted by the test.
 */
export class FakeAggregationLayer {
  readonly name = 'aggregation';
  readonly batches: Signal[][] = [];
  /** When set, process() parks here (the tick has taken the batch already) */
  processGate: Promise<void> | null = null;

  process(signals: Signal[], _state: unknown) {
    this.batches.push([...signals]);
    if (this.processGate) {
      const gate = this.processGate;
      this.processGate = null; // park only the first call
      return gate.then(() => this.wake(signals));
    }
    return this.wake(signals);
  }

  private wake(signals: Signal[]) {
    if (signals.length === 0) {
      return { wakeCognition: false, aggregates: [], triggerSignals: [], intents: [] };
    }
    return {
      wakeCognition: true,
      wakeReason: 'test',
      aggregates: [],
      triggerSignals: [...signals],
      intents: [],
    };
  }

  getAggregate(): undefined {
    return undefined;
  }

  prune(): number {
    return 0;
  }

  sawAllOf(...signals: Signal[]): boolean {
    return signals.every((s) => this.batches.some((b) => b.some((x) => x.id === s.id)));
  }
}

/**
 * Channel boundary double that separates intake from full stop the way the
 * Telegram channel now does: after stopIntake no input arrives but sending
 * keeps working; stop() releases everything.
 *
 * `sendDelayMs` makes a send slow enough to expose the release race; a send
 * released before it ran records 'send-refused' (failure), never a delivery.
 */
export class FakeTestChannel {
  readonly name = 'test';
  intakeStopped = false;
  fullyStopped = false;
  sendDelayMs = 0;
  /** Next sendMessage fails with this reason (a failed send must be reported) */
  failNextSend: string | undefined;
  readonly events: string[] = [];
  readonly sent: { target: string; text: string; messageId: string }[] = [];
  readonly failed: { target: string; text: string; reason: string }[] = [];

  isAvailable(): boolean {
    return true;
  }

  async stopIntake(): Promise<void> {
    this.intakeStopped = true;
    this.events.push('stopIntake');
  }

  async stop(): Promise<void> {
    if (this.fullyStopped) return;
    this.fullyStopped = true;
    this.events.push('stop');
  }

  async sendMessage(
    target: string,
    text: string
  ): Promise<{ success: boolean; messageId?: string }> {
    if (this.sendDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.sendDelayMs));
    }
    if (this.fullyStopped) {
      // like the real channel: a full stop releases the client, sends refuse
      this.events.push('send-refused');
      this.failed.push({ target, text, reason: 'channel-released-before-send' });
      return { success: false };
    }
    if (this.failNextSend !== undefined) {
      const reason = this.failNextSend;
      this.failNextSend = undefined;
      this.failed.push({ target, text, reason });
      return { success: false };
    }
    this.events.push('send');
    this.sent.push({ target, text, messageId: 'test-msg-1' });
    return { success: true, messageId: 'test-msg-1' };
  }
}

export function thoughtSignal(text: string, recipientId?: string): Signal {
  return createSignal(
    'thought',
    'cognition.thought',
    { value: 1 },
    {
      priority: 2,
      data: {
        kind: 'thought',
        content: text,
        text,
        triggerSource: 'test',
        depth: 0,
        rootThoughtId: 'root',
        ...(recipientId && { recipientId }),
      },
    }
  );
}

/** Log lines a test wants to observe (the failure reporting contract). */
export interface RecordedLog {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}

function recordingLogger(base: Logger, calls: RecordedLog[]): Logger {
  const record = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    calls.push({ level, obj, msg });
    base[level](obj, msg);
  };
  return {
    child: (bindings: Record<string, unknown>) =>
      recordingLogger(base.child(bindings as never), calls),
    info: record('info'),
    debug: record('debug'),
    warn: record('warn'),
    error: record('error'),
    trace: record('trace'),
  } as unknown as Logger;
}

const noopLogger = {
  child: () => noopLogger,
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;
const noopLoggerForJournal = noopLogger;

export interface CoreLoopInstance {
  coreLoop: ReturnType<typeof createCoreLoop>;
  recordedLogs: RecordedLog[];
  cognition: FakeCognitionLayer;
  autonomic: FakeAutonomicLayer;
  aggregation: FakeAggregationLayer;
  channel: FakeTestChannel;
  recipientId: string;
  logger: Logger;
}

export interface HarnessOptions {
  drainTimeoutMs?: number;
  /** Record log lines on the instance (instance.recordedLogs) */
  recordLogs?: boolean;
  cognitionMode?: 'immediate' | 'hang' | 'real-scripted';
  /** Hold the fake LLM's next completion (the overrunning turn) */
  hang?: boolean;
  /** Script of fake-LLM responses for cognitionMode 'real-scripted' */
  script?: {
    content?: string | null;
    toolCalls?: { name: string; args: Record<string, unknown> }[];
    finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  }[];
  tickIntervalMs?: number;
}

const TEST_TICK_INTERVAL = 5;

/**
 * Create one instance of the agent the way container.ts starts it:
 * restore persisted pending signals, push them into the (stopped) loop,
 * clear the journal, then run.
 */
export async function startInstance(
  storagePath: string,
  logDir: string,
  opts: HarnessOptions = {}
): Promise<CoreLoopInstance> {
  const base = createLogger({ logDir, level: 'warn', pretty: false });
  const recordedLogs: RecordedLog[] = [];
  const logger = opts.recordLogs ? recordingLogger(base, recordedLogs) : base;

  const storage = await openStorage(storagePath, logger);

  // ── the three layers (cognition: fake processor boundary, or REAL
  // cognition with a scripted fake LLM provider - no network) ──
  const agent = createAgent({ logger, metrics: createMetrics() });
  const eventBus = createEventBus(logger);
  const autonomic = new FakeAutonomicLayer();
  const aggregation = new FakeAggregationLayer();
  let cognition: FakeCognitionLayer | RealCognitionFacade;
  let cognitionDeps: Record<string, unknown> = {};
  if (opts.cognitionMode === 'real-scripted') {
    const real = createRealCognitionProcessor(logger, agent as never, opts.script ?? []);
    real.hang = opts.hang ?? false;
    cognition = real;
    cognitionDeps = {
      agent,
      cognitionLLM: real.adapter,
    };
  } else {
    cognition = new FakeCognitionLayer(opts.cognitionMode ?? 'immediate');
  }
  const layers = { autonomic, aggregation, cognition: cognition as never };
  const config: Partial<CoreLoopConfig> = {
    tickInterval: opts.tickIntervalMs ?? TEST_TICK_INTERVAL,
    ...(opts.drainTimeoutMs !== undefined && { shutdownDrainTimeoutMs: opts.drainTimeoutMs }),
  };
  const registry = new RecipientRegistry();
  const channel = new FakeTestChannel();
  const coreLoop = createCoreLoop(
    agent as never,
    eventBus as never,
    layers as never,
    logger,
    createMetrics(),
    config,
    {
      recipientRegistry: registry as never,
      ...cognitionDeps,
    } as CoreLoopDeps
  );
  coreLoop.registerChannel(channel as never);
  const recipientId = registry.getOrCreate('test', 'chat-42');

  // ── container start path: restore then clear (container.ts) ──
  const restored = await loadPendingSignals(storage, storagePath, logger);
  for (const signal of restored) {
    coreLoop.pushSignal(signal);
  }
  await clearPendingSignals(storage, logger);
  if ('flush' in storage) {
    await (storage as { flush: () => Promise<void> }).flush();
  }

  coreLoop.start();
  return {
    coreLoop,
    cognition,
    autonomic,
    aggregation,
    channel,
    recipientId,
    recordedLogs,
    logger,
  };
}

/**
 * Stop an instance the way container.ts shuts down: the production
 * shutdown sequence with the real journal and real DeferredStorage.
 */
/**
 * A container-shaped memoized shutdown over one instance: the first call runs
 * the sequence, later calls (sequential or concurrent) return the SAME promise
 * - what src/core/container.ts builds internally.
 */
export function makeContainerShutdown(
  instance: CoreLoopInstance,
  storage: DeferredStorage,
  storagePath: string
): () => Promise<void> {
  // the SAME memoization the real container wraps its sequence in
  return makeIdempotentShutdown(() =>
    shutdownSequence({
      logger: instance.logger,
      deadline: Date.now() + instance.coreLoop.getStopDrainTimeoutMs(),
      channels: [instance.channel] as never,
      coreLoop: instance.coreLoop as never,
      storage: storage as never,
      storagePath,
      stateManager: { shutdown: async () => undefined } as never,
      recipientRegistry: { flush: async () => undefined } as never,
      ackRegistry: { flush: async () => undefined } as never,
    })
  );
}

export async function stopInstance(
  instance: CoreLoopInstance,
  storage: DeferredStorage,
  storagePath: string
): Promise<void> {
  await shutdownSequence({
    logger: instance.logger,
    deadline: Date.now() + instance.coreLoop.getStopDrainTimeoutMs(),
    channels: [instance.channel] as never,
    coreLoop: instance.coreLoop as never,
    storage: storage as never,
    storagePath,
    stateManager: { shutdown: async () => undefined } as never,
    recipientRegistry: { flush: async () => undefined } as never,
    ackRegistry: { flush: async () => undefined } as never,
  });
}

export async function openStorage(
  storagePath: string,
  logger?: Logger
): Promise<DeferredStorage> {
  const json = createJSONStorage(storagePath, { logger });
  return createDeferredStorage(json, logger ?? noopLoggerForJournal, { flushIntervalMs: 60_000 });
}

/** Read what the journal holds right now, using a fresh storage handle. */
export async function readJournal(storagePath: string): Promise<Signal[]> {
  const storage = await openStorage(storagePath);
  try {
    return await loadPendingSignals(storage as never, storagePath, noopLoggerForJournal);
  } finally {
    await storage.flush();
  }
}

export const testPaths = { pendingSignalsPath };

export async function makeScratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return dir;
}

export async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
