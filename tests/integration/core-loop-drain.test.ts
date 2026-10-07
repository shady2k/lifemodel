/**
 * Integration tests for shutdown draining (lifemodel-ctc.1.1).
 *
 * Real CoreLoop + real storage chain (JSONStorage behind DeferredStorage) +
 * real journal, doubles only at the layer boundary (no LLM, no network).
 *
 * Required scenarios:
 * 1. Stop while a cognition turn is in flight and the turn finishes within
 *    the drain deadline -> turn completed once, nothing persisted for redo.
 * 2. Stop while a turn overruns the deadline -> after a fresh start the
 *    trigger is processed exactly once.
 * 3. Signals accepted but not yet processed at stop -> processed after a
 *    fresh start, in order, once.
 */
import type { Signal } from '../../src/types/signal.js';
import type { SendMessageIntent } from '../../src/types/intent.js';
import { createUserMessageSignal } from '../../src/types/signal.js';

import {
  FakeAutonomicLayer,
  FakeCognitionLayer,
  FakeAggregationLayer,
  startInstance,
  stopInstance,
  openStorage,
  readJournal,
  makeScratchDir,
  makeDeferred,
  makeContainerShutdown,
  rmDir,
  waitFor,
  thoughtSignal,
} from '../helpers/core-loop-drain-harness.js';

const DRAIN_DEADLINE_MS = 100;

// How many ticks to expect: 5 ms tick interval, generous deadline
const SETTLE_TICKS = 5;

const scratchRoots: string[] = [];

async function freshScratch(prefix: string): Promise<{ storagePath: string; logDir: string }> {
  const root = await makeScratchDir(prefix);
  scratchRoots.push(root);
  const storagePath = root;
  const logDir = `${root}-logs`;
  return { storagePath, logDir };
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rmDir(root);
    await rmDir(`${root}-logs`);
  }
});

describe('shutdown drain (lifemodel-ctc.1.1)', () => {
  it('stop during a turn that finishes within the deadline: turn completed once, nothing persisted for redo', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-finish-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 5_000,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);

    // The turn starts and completes
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'turn settled');
    expect(h1.cognition.triggerIds()).toEqual([trigger.id]);

    // ...and stays completed (its result is not re-run)
    const callsBeforeStop = h1.cognition.calls.length;

    await stopInstance(h1, await openStorage(storagePath), storagePath);

    expect(h1.cognition.calls.length).toBe(callsBeforeStop);
    // nothing persisted for redo
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([]);

    // Fresh start: no redo
    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
  });

  it('stop during a turn that overruns the deadline: the trigger is processed exactly once after a fresh start', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-overrun-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // Stop overruns the deadline and requeues the trigger
    await stopInstance(h1, await openStorage(storagePath), storagePath);

    // the overrunning turn's trigger is what got persisted
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([trigger.id]);

    // Fresh start processes it exactly once
    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.cognition.triggerIds().includes(trigger.id), 'trigger redone');
    expect(h2.cognition.triggerIds()).toEqual([trigger.id]);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    // ...and no second redo ever appears
    expect(h2.cognition.triggerIds()).toEqual([trigger.id]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });

  it('an overrunning turn requeues ALL its triggers and the message it absorbed mid-turn', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-own-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger1 = thoughtSignal('first trigger', h1.recipientId);
    const trigger2 = thoughtSignal('second trigger', h1.recipientId);
    h1.coreLoop.pushSignal(trigger1);
    h1.coreLoop.pushSignal(trigger2);
    // both triggers go into ONE turn (one wake, two trigger signals)
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    const drained = h1.cognition.calls[0]?.context.drainPendingUserMessages;
    expect(typeof drained).toBe('function');
    // a real user_message: exactly what the drainer absorbs mid-turn
    const absorbed = createUserMessageSignal({
      text: 'absorbed mid-turn',
      chatId: 'chat-42',
      recipientId: h1.recipientId,
    });
    h1.coreLoop.pushSignal(absorbed);
    await waitFor(() => h1.coreLoop.pendingSignalCount() === 1, 'message accepted');
    // absorb through the turn's own drainer (what the agentic loop calls)
    const drainedNow = drained?.() ?? [];
    expect(drainedNow.map((s) => s.id)).toEqual([absorbed.id]);

    await stopInstance(h1, await openStorage(storagePath), storagePath);

    // FIFO redo: both triggers then the absorbed message, each exactly once
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([
      trigger1.id,
      trigger2.id,
      absorbed.id,
    ]);

    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.cognition.triggerIds().includes(absorbed.id), 'redone');
    const ids = h2.cognition.triggerIds();
    expect(ids).toEqual([trigger1.id, trigger2.id, absorbed.id]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });

  it('pending signals at stop: processed after a fresh start, in order, once', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-pending-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // Messages arrive while COGNITION is busy: they are accepted as pending
    // signals and deferred, not consumed.
    const first = thoughtSignal('queued first');
    const second = thoughtSignal('queued second');
    h1.coreLoop.pushSignal(first);
    h1.coreLoop.pushSignal(second);
    await waitFor(
      () => h1.autonomic.sawAgainInOrder(first, second),
      'queued messages re-drained untouched while COGNITION is busy'
    );
    expect(h1.cognition.calls.length).toBe(1); // consumed nothing
    expect(h1.cognition.triggerIds()).toEqual([trigger.id]);

    await stopInstance(h1, await openStorage(storagePath), storagePath);

    // FIFO with the requeued trigger in front (it was accepted first)
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([
      trigger.id,
      first.id,
      second.id,
    ]);

    // Fresh start processes all three, in order, each exactly once
    const h2 = await startInstance(storagePath, logDir, { cognitionMode: 'immediate' });
    await waitFor(() => h2.cognition.triggerIds().includes(second.id), 'messages redone');
    expect(h2.cognition.triggerIds()).toEqual([trigger.id, first.id, second.id]);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([trigger.id, first.id, second.id]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });

  it('a turn that finishes during the drain delivers its answer through a channel that has stopped intake (sent once, success)', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-deliver-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: 5_000,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // the turn's answer is a SEND_MESSAGE intent; the turn finishes exactly
    // once during the stop drain (the resolved turn is consumed either by the
    // next tick or by the drain - both before the channel's full stop), so the
    // answer is delivered exactly once through the channel
    const text = 'the drained turn answer';
    const send: SendMessageIntent = {
      type: 'SEND_MESSAGE',
      payload: { recipientId: h1.recipientId, text },
    };
    h1.cognition.settleAll({ confidence: 1, intents: [send], response: undefined });

    // a SLOW send: the stop must await the in-flight chain before releasing
    h1.channel.sendDelayMs = 80;
    await stopInstance(h1, await openStorage(storagePath), storagePath);

    // Intake stopped before the send; the slow send was awaited and delivered;
    // the full stop came after it
    expect(h1.channel.events).toEqual(['stopIntake', 'send', 'stop']);
    expect(h1.channel.sent).toEqual([
      { target: 'chat-42', text: expect.stringContaining(text), messageId: 'test-msg-1' },
    ]);
    expect(h1.channel.failed).toEqual([]);
  });

  it('a FAILED send during the drain is reported, not silently dropped', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-failsend-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: 5_000,
    });
    h1.coreLoop.pushSignal(thoughtSignal('turn trigger', h1.recipientId));
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    const send: SendMessageIntent = {
      type: 'SEND_MESSAGE',
      payload: { recipientId: h1.recipientId, text: 'the answer' },
    };
    h1.cognition.settleAll({ confidence: 1, intents: [send], response: undefined });

    // the send itself fails (like Telegram: transport error) - the drain must
    // surface the failure, not swallow it
    h1.channel.failNextSend = 'transport-error';
    await stopInstance(h1, await openStorage(storagePath), storagePath);

    expect(h1.channel.sent).toEqual([]);
    expect(h1.channel.failed).toEqual([
      { target: 'chat-42', text: expect.any(String), reason: 'transport-error' },
    ]);
  });

  it('a tick suspended after taking signals has its batch journaled, not discarded', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-tickbatch-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 200,
    });
    // the AGGREGATION gate parks the tick AFTER it took the batch off the queue
    const releaseTick = makeDeferred<void>();
    h1.aggregation.processGate = releaseTick.promise;
    const taken = thoughtSignal('taken by the tick', h1.recipientId);
    h1.coreLoop.pushSignal(taken);
    await waitFor(() => h1.aggregation.batches.length > 0, 'the tick took the batch');
    expect(h1.coreLoop.takenBatchCount()).toBe(1);

    // Stop must NOT wait for the suspended tick forever: the deadline cuts it
    // loose and the taken batch is journaled, not discarded.
    await stopInstance(h1, await openStorage(storagePath), storagePath);
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([taken.id]);
    releaseTick.resolve();
  });

  it('stop past the overall deadline continues: a stalled tick and a stalled scheduler do not hang it', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-stall-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 150,
    });
    // stall the tick and the scheduler callback
    const release = makeDeferred<void>();
    h1.coreLoop.setStallForTest({ tickGate: release.promise, schedulerGate: release.promise });

    const started = Date.now();
    await stopInstance(h1, await openStorage(storagePath), storagePath);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000); // the deadline (150 ms), not the stall
    release.resolve(); // the stalled waits still settle for test cleanup
  });

  it('container shutdown is idempotent: a second call never overwrites the journal', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-idem-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger', h1.recipientId);
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // drive the shutdown through the container-shaped memoized path
    const storage = await openStorage(storagePath);
    const containerShutdown = makeContainerShutdown(h1, storage, storagePath);
    await containerShutdown();
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([trigger.id]);

    // re-calls (sequential) never run the sequence again - the journal below
    // proves the first stop's data survived them
    await containerShutdown();
    await containerShutdown();
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([trigger.id]);
    h1.cognition.settleAll();
  });

  it('container.shutdown called twice (sequential and concurrent) keeps the journal', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-idem2-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger', h1.recipientId);
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // drive the container-level shutdown (the memoized path)
    const storage = await openStorage(storagePath);
    const containerShutdown = makeContainerShutdown(h1, storage, storagePath);
    const p1 = containerShutdown();
    const p2 = containerShutdown();
    expect(p2).toBe(p1); // concurrent callers share the first call's promise
    await Promise.all([p1, p2]);
    await containerShutdown(); // sequential again: still the same promise

    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([trigger.id]);
    h1.cognition.settleAll();
  });

  // ── real cognition (agentic loop) with a scripted fake LLM provider ──

  it('REAL cognition: a turn completing during the stop drain delivers its reply', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-real-finish-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'The real loop reply' }],
      drainTimeoutMs: 5_000,
    });
    // a user_message trigger: the real agentic loop answers it
    h1.coreLoop.pushSignal(
      createUserMessageSignal({ text: 'hello there', chatId: 'chat-42', recipientId: h1.recipientId })
    );
    // the real agentic loop ran exactly once (one LLM completion) ...
    await waitFor(() => h1.cognition.provider.requests.length === 1, 'LLM called once');
    // ... and its reply is delivered through the channel exactly once
    await waitFor(() => h1.channel.sent.length === 1, 'reply delivered');
    expect(h1.channel.sent[0]?.text).toBe('The real loop reply');

    await stopInstance(h1, await openStorage(storagePath), storagePath);
    // delivered (before the full release) and never refused
    expect(h1.channel.events).not.toContain('send-refused');
    expect(h1.channel.events.indexOf('send')).toBeLessThan(h1.channel.events.indexOf('stop'));
    // nothing persisted for redo
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([]);
  });

  it('REAL cognition: an overrunning turn is redone exactly once after a fresh start', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-real-overrun-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true, // the turn never completes: LLM held
      script: [{ content: 'never reached' }],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = createUserMessageSignal({
      text: 'hello there',
      chatId: 'chat-42',
      recipientId: h1.recipientId,
    });
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.provider.requests.length === 1, 'LLM held (turn in flight)');

    await stopInstance(h1, await openStorage(storagePath), storagePath);
    // the trigger is journaled for the redo
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([trigger.id]);
    h1.cognition.settleHangingTurn();

    // fresh start: the real loop redoes the trigger exactly once and delivers
    const h2 = await startInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'The redone real-loop reply' }],
      drainTimeoutMs: 5_000,
    });
    await waitFor(() => h2.cognition.provider.requests.length === 1, 'redo LLM called once');
    await waitFor(() => h2.channel.sent.length === 1, 'redo delivered');
    expect(h2.channel.sent[0]?.text).toBe('The redone real-loop reply');
    // no second redo: ticks keep running, no further LLM call
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.provider.requests.length).toBe(1);
    expect((await readJournal(storagePath)).map((s) => s.id)).toEqual([]);
    await h2.coreLoop.stop();
  });

  it('a turn that REJECTS during the drain is logged with the error (err) and its tick id', async () => {
    const { storagePath, logDir } = await freshScratch('ctc-drain-reject-');
    const h1 = await startInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    h1.coreLoop.pushSignal(thoughtSignal('turn trigger', h1.recipientId));
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    // reject WHILE the drain is in flight (before stop, the tick path already
    // logs 'COGNITION failed (async)' - that is not the drain's log)
    const stopping = stopInstance(h1, await openStorage(storagePath), storagePath);
    await waitFor(() => h1.channel.intakeStopped, 'intake stopped (drain running)');
    // reject while the DRAIN's race is running (20 ms past intake stop is
    // well inside it: the drain starts within a tick of the intake stop)
    await new Promise((r) => setTimeout(r, 20));
    h1.cognition.rejectAll(new Error('the turn exploded'));
    await stopping;

    const failLine = h1.recordedLogs.find(
      (c) => c.level === 'error' && c.msg === 'COGNITION rejected unexpectedly during the stop drain'
    );
    expect(failLine).toBeDefined();
    expect((failLine?.obj as Record<string, unknown>)['err']).toBeInstanceOf(Error);
    expect(typeof failLine?.obj['tickId']).toBe('string');
  });
});
