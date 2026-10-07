/**
 * Harness for the durable inbound log (lifemodel-ctc.2.1): a real CoreLoop
 * wired the way the container wires it - real DeferredStorage over
 * JSONStorage, the REAL durable inbound log, the real shutdown sequence -
 * with doubles only at the boundaries:
 * - the three layer processors (cognition: fake or real with a scripted
 *   fake LLM provider - no network),
 * - the channel, a FakeTestChannel whose inbound callback is AWAITED the
 *   way the Telegram channel now awaits it (the log flushes at emit time).
 *
 * Start/stop mirror src/core/container.ts:
 * start = load the log, replay uncommitted entries, restore+journal-filter,
 *         clear the journal, start the loop;
 * stop  = the production shutdownSequence().
 */
import {
  createCoreLoop,
  type CoreLoopConfig,
  type CoreLoopDeps,
} from '../../src/core/core-loop.js';
import { createAgent } from '../../src/core/agent.js';
import { RecipientRegistry } from '../../src/core/recipient-registry.js';
import { createConversationManager } from '../../src/storage/index.js';

import { createEventBus } from '../../src/core/event-bus.js';
import { createMetrics } from '../../src/core/metrics.js';
import { createLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/types/logger.js';
import type { Channel } from '../../src/types/index.js';
import type { CognitionResult } from '../../src/types/layers.js';
import {
  createUserMessageSignal,
  type Signal,
  type UserMessageData,
} from '../../src/types/signal.js';
import type { DeferredStorage } from '../../src/storage/index.js';
import { createInboundLog, dedupKeyOf, type InboundLog } from '../../src/core/inbound-log.js';
import { loadPendingSignals, clearPendingSignals } from '../../src/core/pending-signal-journal.js';
import { shutdownSequence } from '../../src/core/container.js';
import { RealCognitionFacade, createRealCognitionProcessor } from './core-loop-real-cognition.js';
import {
  FakeAutonomicLayer,
  FakeAggregationLayer,
  FakeCognitionLayer,
  makeDeferred,
  makeScratchDir,
  openStorage,
  rmDir,
  waitFor,
} from './core-loop-drain-harness.js';

export {
  FakeAutonomicLayer,
  FakeAggregationLayer,
  FakeCognitionLayer,
  RealCognitionFacade,
  makeDeferred,
  makeScratchDir,
  openStorage,
  rmDir,
  waitFor,
};

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
  level: 'silent',
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as unknown as Logger;

/**
 * Channel double whose inbound path mirrors the real Telegram channel: the
 * emit awaits the registered callback (so the durable log flushes before
 * emit() resolves), stopIntake is separated from stop, and sends can be
 * delayed, held (hung), or failed.
 */
export class InboundFakeChannel {
  readonly name = 'test';
  intakeStopped = false;
  fullyStopped = false;
  sendDelayMs = 0;
  /** Holds every sendMessage until released (a hung send) */
  sendGate: { promise: Promise<void>; release: () => void } | null = null;
  /** Next sendMessage fails with this reason */
  failNextSend: string | undefined;
  readonly events: string[] = [];
  readonly sent: { target: string; text: string; messageId: string }[] = [];
  readonly failed: { target: string; text: string; reason: string }[] = [];

  private signalCallback: ((signal: Signal) => void | Promise<void>) | null = null;
  private readonly inFlightEmits = new Set<Promise<unknown>>();

  setSignalCallback(callback: (signal: Signal) => void | Promise<void>): void {
    this.signalCallback = callback;
  }

  /** Awaits the callback exactly like TelegramChannel.emitSignal does. */
  async emit(signal: Signal): Promise<void> {
    const emit = (async () => {
      const result = this.signalCallback?.(signal);
      if (result instanceof Promise) {
        await result;
      }
    })();
    this.inFlightEmits.add(emit);
    try {
      await emit;
    } finally {
      this.inFlightEmits.delete(emit);
    }
  }

  async stopIntake(): Promise<void> {
    this.intakeStopped = true;
    const pending = [...this.inFlightEmits];
    if (pending.length > 0) {
      // Bounded like the real channel: the in-flight handlers get a moment to
      // reach the log. The bound is CLEARED (no timer outlives the test).
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
        });
        await Promise.race([Promise.allSettled(pending).then(() => undefined), bound]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    this.events.push('stopIntake');
  }

  async stop(): Promise<void> {
    if (this.fullyStopped) return;
    this.fullyStopped = true;
    this.events.push('stop');
  }

  /** sendMessage calls ENTERED (before any gate/delay) - observable even
   * when the send then hangs. */
  readonly sendStarted: { target: string; text: string }[] = [];

  /** When true, completePhotoReceipt re-fetches like the real channel would. */
  photoCompletionFails = false;
  readonly photoCompletions: string[] = [];

  /** A receipt replayed after a restart is re-fetched by the channel. */
  async completePhotoReceipt(receipt: Signal): Promise<boolean> {
    const data = receipt.data as
      | (UserMessageData & { pendingPhoto?: { fileId: string } })
      | undefined;
    if (!data?.pendingPhoto || this.photoCompletionFails) {
      return false;
    }
    this.photoCompletions.push(data.pendingPhoto.fileId);
    const full = createUserMessageSignal({
      text: data.text,
      channel: 'telegram',
      userId: data.userId,
      recipientId: data.recipientId,
      ...(data.updateId !== undefined && { updateId: data.updateId }),
      images: [{ data: 're-fetched-image-data', mediaType: 'image/png' }],
    });
    await this.emit(full);
    return true;
  }

  async sendMessage(
    target: string,
    text: string
  ): Promise<{ success: boolean; messageId?: string }> {
    this.sendStarted.push({ target, text });
    if (this.sendDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.sendDelayMs));
    }
    if (this.sendGate) {
      await this.sendGate.promise;
    }
    if (this.fullyStopped) {
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

  isAvailable(): boolean {
    return true;
  }
}

export function userMessage(text: string, recipientId: string, updateId?: string): Signal {
  return createUserMessageSignal({
    text,
    recipientId,
    ...(updateId !== undefined && { updateId }),
  });
}

export interface InboundInstance {
  coreLoop: ReturnType<typeof createCoreLoop>;
  inboundLog: InboundLog;
  storagePath: string;
  channel: InboundFakeChannel;
  cognition: FakeCognitionLayer | RealCognitionFacade;
  autonomic: FakeAutonomicLayer;
  aggregation: FakeAggregationLayer;
  registry: RecipientRegistry;
  recipientId: string;
  /**
   * Recipient ids the replay had to re-register because the fresh registry
   * did not know them: the route was rebuilt from the log entry's routing
   * (finding 1).
   */
  routesRestoredFromLog: string[];
  recordedLogs: RecordedLog[];
  logger: Logger;
}

export interface HarnessOptions {
  drainTimeoutMs?: number;
  cognitionMode?: 'immediate' | 'hang' | 'real-scripted';
  /**
   * How an `immediate` fake turn ends (finding 4): its `disposition` decides
   * whether the turn may settle its inbound log entries without a delivered
   * send. Default: no disposition, which never settles.
   */
  cognitionResult?: Partial<CognitionResult>;
  /** make completePhotoReceipt fail like a broken channel (finding 7 fallback) */
  photoCompletionFails?: boolean;
  hang?: boolean;
  script?: {
    content?: string | null;
    toolCalls?: { name: string; args: Record<string, unknown> }[];
    finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  }[];
  tickIntervalMs?: number;
  recordLogs?: boolean;
  /**
   * Runs after the fresh registry exists and BEFORE any replay: the place to
   * prove the instance really starts without the route under test.
   */
  onBeforeReplay?: (registry: RecipientRegistry) => void;
}

const TEST_TICK_INTERVAL = 5;
/** How many ticks to expect for settlement (5 ms tick interval). */
export const SETTLE_TICKS = 5;

/**
 * Start one instance the way createContainerAsync starts it (with the
 * durable inbound log wired).
 */
export async function startInboundInstance(
  storagePath: string,
  logDir: string,
  opts: HarnessOptions = {}
): Promise<InboundInstance> {
  const base = createLogger({ logDir, level: 'warn', pretty: false });
  const recordedLogs: RecordedLog[] = [];
  const logger = opts.recordLogs ? recordingLogger(base, recordedLogs) : base;

  const storage = await openStorage(storagePath, logger);
  const inboundLog = createInboundLog({ storage, logger, storagePath });
  await inboundLog.load();

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
    cognitionDeps = { agent, cognitionLLM: real.adapter };
  } else {
    const fake = new FakeCognitionLayer(opts.cognitionMode ?? 'immediate');
    if (opts.cognitionResult) {
      fake.result = { ...fake.result, ...opts.cognitionResult };
    }
    cognition = fake;
  }
  const layers = { autonomic, aggregation, cognition: cognition as never };
  const config: Partial<CoreLoopConfig> = {
    tickInterval: opts.tickIntervalMs ?? TEST_TICK_INTERVAL,
    ...(opts.drainTimeoutMs !== undefined && { shutdownDrainTimeoutMs: opts.drainTimeoutMs }),
  };
  const registry = new RecipientRegistry();
  const conversationManager = createConversationManager(storage as never, logger);
  const channel = new InboundFakeChannel();
  channel.photoCompletionFails = opts.photoCompletionFails ?? false;
  const coreLoop = createCoreLoop(
    agent as never,
    eventBus as never,
    layers as never,
    logger,
    createMetrics(),
    config,
    {
      recipientRegistry: registry as never,
      inboundLog,
      conversationManager: conversationManager as never,
      ...cognitionDeps,
    } as CoreLoopDeps
  );
  coreLoop.registerChannel(channel as never);
  const recipientId = registry.getOrCreate('test', 'chat-42');

  // Inbound wiring BEFORE the replay: a completing channel re-fetched
  // during the replay emits its full signal through the same callback path
  // the live channel uses (the container wires the callback at channel
  // creation, before the replay block).
  channel.setSignalCallback((signal) => coreLoop.pushInboundSignal(signal));

  // container start path: replay uncommitted entries, restore the journal
  // (filtered against the log), clear it, then run (container.ts).
  opts.onBeforeReplay?.(registry);
  const routesRestoredFromLog: string[] = [];
  const replay = inboundLog.replayable();
  for (const entry of replay) {
    // same as the container: re-register the route the entry carries
    if (entry.routing && registry.resolve(entry.recipientId) === null) {
      registry.getOrCreate(entry.routing.channel, entry.routing.destination);
      routesRestoredFromLog.push(entry.recipientId);
    }
    // same as the container: a pending photo receipt is re-fetched by the
    // channel; on re-fetch failure the receipt itself is queued
    const data = entry.signal.data as { pendingPhoto?: { fileId?: unknown } } | undefined;
    if (typeof data?.pendingPhoto?.fileId === 'string') {
      const completed = await channel.completePhotoReceipt(entry.signal);
      if (completed) {
        continue;
      }
    }
    coreLoop.pushSignal(entry.signal);
  }
  const restored = await loadPendingSignals(storage, storagePath, logger);
  for (const signal of restored) {
    if (inboundLog.hasKey(dedupKeyOf(signal))) continue;
    coreLoop.pushSignal(signal);
  }
  await clearPendingSignals(storage, logger);
  await storage.flush();

  coreLoop.start();
  return {
    coreLoop,
    inboundLog,
    channel,
    cognition,
    autonomic,
    aggregation,
    registry,
    recipientId,
    routesRestoredFromLog,
    recordedLogs,
    logger,
    storagePath,
  };
}

/**
 * How many LLM completions the cognition boundary asked for: the real
 * scripted provider's request count, or the fake layer's turn count.
 */
export function llmRequests(instance: InboundInstance): number {
  const cognition = instance.cognition;
  if ('provider' in cognition) {
    return cognition.provider.requests.length;
  }
  return cognition.calls.length;
}

/** Stop like the container does: the production shutdown sequence. */
export async function stopInboundInstance(
  instance: InboundInstance,
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

/** Emit a user message through the channel (the real, awaited path). */
export async function receiveMessage(
  instance: InboundInstance,
  text: string,
  updateId?: string
): Promise<void> {
  await instance.channel.emit(userMessage(text, instance.recipientId, updateId));
}

/**
 * Seed the persisted conversation history with an assistant message, as if
 * the answer had been delivered before the crash named window (finding 10).
 * Uses the REAL ConversationManager over the instance's own data dir.
 */
export async function seedAssistantAnswer(
  storagePath: string,
  text: string,
  recipientId: string
): Promise<void> {
  const storage = await openStorage(storagePath);
  const manager = createConversationManager(storage as never, noopLogger);
  await manager.addMessage(recipientId, { role: 'assistant', content: text });
  const last = await manager.getLastAssistantMessage(recipientId);
  if (last !== text) {
    throw new Error(`conversation seeding failed: stored ${String(last)}`);
  }
  await storage.flush();
}

/**
 * Fence an instance whose process is treated as killed (owner decision
 * comment 54; review round 3): its timers and subscription stop, its
 * late effects are dropped, and the work it had in flight (the tick, the
 * scheduler callback) is joined. After this resolves the instance can write
 * NOTHING into the data or log directories behind the restart under test -
 * without it a "killed" instance could keep ticking or flush its cache and
 * invalidate the restart claims (the reported teardown ENOTEMPTY).
 */
export async function fenceKilledInstance(instance: InboundInstance): Promise<void> {
  await instance.coreLoop.fenceForTest();
}

/**
 * What an instance has observably done, for the "no old-instance activity
 * after the restart" assertion: a killed instance must show the same numbers
 * before and after the restart under test.
 */
export function activityOf(instance: InboundInstance): {
  running: boolean;
  ticks: number;
  turns: number;
  sends: number;
  sendsStarted: number;
  entries: number;
} {
  return {
    running: instance.coreLoop.isRunning(),
    ticks: instance.autonomic.ticks(),
    turns: llmRequests(instance),
    sends: instance.channel.sent.length,
    sendsStarted: instance.channel.sendStarted.length,
    entries: instance.inboundLog.size().total,
  };
}

/**
 * Best-effort teardown: flush the instance's pino transport, so no log write
 * is still in flight when the test removes its log directory.
 */
export async function flushInstanceLogs(instance: InboundInstance): Promise<void> {
  const logger = instance.logger as unknown as { flush?: (cb?: (err?: Error) => void) => void };
  if (typeof logger.flush !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        try {
          logger.flush?.(() => {
            resolve();
          });
        } catch {
          resolve();
        }
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read the log's size through a FRESH storage handle (what a new process sees). */
export async function readLogSize(
  storagePath: string
): Promise<{ total: number; uncommitted: number }> {
  const storage = await openStorage(storagePath);
  const log = createInboundLog({ storage, logger: noopLogger, storagePath });
  try {
    await log.load();
    return log.size();
  } finally {
    await storage.flush();
  }
}

/** Scratch paths for one restart chain. */
export async function freshScratch(
  prefix: string
): Promise<{ storagePath: string; logDir: string }> {
  const root = await makeScratchDir(prefix);
  return { storagePath: root, logDir: `${root}-logs` };
}
