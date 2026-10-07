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
  loadPendingSignals,
  persistPendingSignals,
  pendingSignalsPath,
  clearPendingSignals,
} from '../../src/core/pending-signal-journal.js';
import { shutdownSequence } from '../../src/core/container.js';
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

  constructor(private readonly mode: 'immediate' | 'hang') {}

  // CoreLoop calls this on construction (no-op for the fake)
  setDependencies(_deps: unknown): void {}

  process(context: CognitionContext): Promise<CognitionResult> {
    const deferred = makeDeferred<CognitionResult>();
    this.calls.push({ context, done: deferred.promise });
    this.deferreds.push(deferred);
    if (this.mode === 'immediate') {
      deferred.resolve({ confidence: 1, intents: [], response: undefined });
    }
    return deferred.promise;
  }

  /** Finish every pending turn (test cleanup, or with a chosen result). */
  settleAll(result?: CognitionResult): void {
    const withResult: CognitionResult = result ?? { confidence: 1, intents: [], response: undefined };
    for (const d of this.deferreds.splice(0)) {
      d.resolve(withResult);
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

  process(signals: Signal[], _state: unknown) {
    this.batches.push([...signals]);
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
 */
export class FakeTestChannel {
  readonly name = 'test';
  intakeStopped = false;
  fullyStopped = false;
  readonly events: string[] = [];
  readonly sent: { target: string; text: string; messageId: string }[] = [];

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

  sendMessage(target: string, text: string): Promise<{ success: boolean; messageId?: string }> {
    if (this.fullyStopped) {
      // like the real channel: a full stop releases the client, sends refuse
      this.events.push('send-refused');
      return Promise.resolve({ success: false });
    }
    this.events.push('send');
    this.sent.push({ target, text, messageId: 'test-msg-1' });
    return Promise.resolve({ success: true, messageId: 'test-msg-1' });
  }
}

export function thoughtSignal(text: string): Signal {
  return createSignal(
    'thought',
    'cognition.thought',
    { value: 1 },
    {
      priority: 2,
      data: { kind: 'thought', text, triggerSource: 'test', depth: 0, rootThoughtId: 'root' },
    }
  );
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
  cognition: FakeCognitionLayer;
  autonomic: FakeAutonomicLayer;
  aggregation: FakeAggregationLayer;
  channel: FakeTestChannel;
  recipientId: string;
  logger: Logger;
}

export interface HarnessOptions {
  drainTimeoutMs?: number;
  cognitionMode?: 'immediate' | 'hang';
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
  const logger = createLogger({ logDir, level: 'warn', pretty: false });

  const storage = await openStorage(storagePath, logger);

  // ── the three layer doubles (processing/LLM boundary) ──
  const cognition = new FakeCognitionLayer(opts.cognitionMode ?? 'immediate');
  const autonomic = new FakeAutonomicLayer();
  const aggregation = new FakeAggregationLayer();
  const layers = { autonomic, aggregation, cognition: cognition as never };

  const agent = createAgent({ logger, metrics: createMetrics() });
  const eventBus = createEventBus(logger);
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
  return { coreLoop, cognition, autonomic, aggregation, channel, recipientId, logger };
}

/**
 * Stop an instance the way container.ts shuts down: the production
 * shutdown sequence with the real journal and real DeferredStorage.
 */
export async function stopInstance(
  instance: CoreLoopInstance,
  storage: DeferredStorage,
  storagePath: string
): Promise<void> {
  await shutdownSequence({
    logger: instance.logger,
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
