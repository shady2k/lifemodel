/**
 * Integration tests for the bounded, best-effort stop (lifemodel-ctc.1.1,
 * lifemodel-ctc.1.2).
 *
 * Real CoreLoop + real storage chain (JSONStorage behind DeferredStorage),
 * doubles only at the layer boundary (no LLM, no network). Required
 * scenarios:
 * 1. Stop while a cognition turn is in flight and the turn finishes within
 *    the drain deadline -> completed once, its answer delivered.
 * 2. An internal signal is NOT persisted across a stop: a turn the deadline
 *    cut loose is abandoned and nothing replays (the ticks of the next run
 *    regenerate internal signals; inbound messages are carried by the durable
 *    inbound log - tests/integration/inbound-log-restart.test.ts).
 * 3. A hang the deadline cuts loose does not hang the stop, and neither a
 *    slow nor a hung send outlives the release by accident.
 * 4. The stop is idempotent.
 *
 * The hard exit that leaves the process at the deadline is tested in
 * tests/integration/stop-hard-exit.test.ts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SendMessageIntent } from '../../src/types/intent.js';
import { createUserMessageSignal } from '../../src/types/signal.js';

import {
  FakeTestChannel,
  makeContainerShutdown,
  makeDeferred,
  makeScratchDir,
  openStorage,
  rmDir,
  startInstance,
  stopInstance,
  thoughtSignal,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

const DRAIN_DEADLINE_MS = 100;

// How many ticks to expect: 5 ms tick interval, generous deadline
const SETTLE_TICKS = 5;

const scratchRoots: string[] = [];

async function freshScratch(prefix: string): Promise<string> {
  const root = await makeScratchDir(prefix);
  scratchRoots.push(root);
  return root;
}

/** What the old pending-signal journal wrote; a stop must never write it. */
function journalPath(storagePath: string): string {
  return join(storagePath, 'core', 'pending_signals.json');
}

afterEach(async () => {
  // Only the data directory: the instance logger has no transport, so it
  // creates no log file and needs no flush before the directory goes
  // (test-logger.ts).
  for (const root of scratchRoots.splice(0)) {
    await rmDir(root);
  }
});

describe('bounded best-effort stop (lifemodel-ctc.1.2)', () => {
  it('stop during a turn that finishes within the deadline: applied once, its answer delivered', async () => {
    const storagePath = await freshScratch('ctc-drain-finish-');
    const h1 = await startInstance(storagePath, {
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

    await stopInstance(h1, await openStorage(storagePath));

    expect(h1.cognition.calls.length).toBe(callsBeforeStop);

    // Fresh start: nothing was replayed, nothing was redone
    const h2 = await startInstance(storagePath, { cognitionMode: 'immediate' });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });

  it('a turn the deadline cut loose is abandoned: its internal trigger is dropped, not persisted', async () => {
    const storagePath = await freshScratch('ctc-drain-overrun-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    await stopInstance(h1, await openStorage(storagePath));
    h1.cognition.settleAll();

    // nothing is written for the next run to redo
    expect(existsSync(journalPath(storagePath))).toBe(false);

    const h2 = await startInstance(storagePath, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 500,
    });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([]);
    await h2.coreLoop.stop();
    h2.cognition.settleAll();
  });

  it('signals queued at the stop are dropped: no journal file is written at all', async () => {
    const storagePath = await freshScratch('ctc-drain-pending-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    const trigger = thoughtSignal('turn trigger');
    h1.coreLoop.pushSignal(trigger);
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    // Signals arrive while COGNITION is busy: they are accepted as pending
    // signals and deferred, not consumed.
    const first = thoughtSignal('queued first');
    const second = thoughtSignal('queued second');
    h1.coreLoop.pushSignal(first);
    h1.coreLoop.pushSignal(second);
    await waitFor(
      () => h1.autonomic.sawAgainInOrder(first, second),
      'queued signals re-drained untouched while COGNITION is busy'
    );
    expect(h1.cognition.calls.length).toBe(1); // consumed nothing

    await stopInstance(h1, await openStorage(storagePath));

    expect(existsSync(journalPath(storagePath))).toBe(false);
    const h2 = await startInstance(storagePath, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 500,
    });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.triggerIds()).toEqual([]);
    await h2.coreLoop.stop();
    h1.cognition.settleAll();
    h2.cognition.settleAll();
  });

  it('a user message that overruns the stop deadline is replayed once by the durable log', async () => {
    // The message guarantee lives in the log, not in the stop: the harness of
    // the log proves the whole path (answered once across a graceful stop,
    // lifemodel-ctc.2.1). Here the same turn is shown to leave NOTHING in the
    // data directory that a stop would replay.
    const storagePath = await freshScratch('ctc-drain-log-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    h1.coreLoop.pushSignal(
      createUserMessageSignal({
        text: 'a question the turn never answers',
        chatId: 'chat-42',
        recipientId: h1.recipientId,
      })
    );
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');

    await stopInstance(h1, await openStorage(storagePath));
    h1.cognition.settleAll();

    expect(existsSync(journalPath(storagePath))).toBe(false);
    const h2 = await startInstance(storagePath, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 500,
    });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    // without the log (this harness has none) the message is not replayed -
    // with the log it is, exactly once (inbound-log-restart.test.ts)
    expect(h2.cognition.triggerIds()).toEqual([]);
    await h2.coreLoop.stop();
    h2.cognition.settleAll();
  });

  it('a turn that finishes during the drain delivers its answer through a channel that has stopped intake (sent once, success)', async () => {
    const storagePath = await freshScratch('ctc-drain-deliver-');
    const h1 = await startInstance(storagePath, {
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
    await stopInstance(h1, await openStorage(storagePath));

    // Intake stopped before the send; the slow send was awaited and delivered;
    // the full stop came after it
    expect(h1.channel.events).toEqual(['stopIntake', 'send', 'stop']);
    expect(h1.channel.sent).toEqual([
      { target: 'chat-42', text: expect.stringContaining(text), messageId: 'test-msg-1' },
    ]);
    expect(h1.channel.failed).toEqual([]);
  });

  it('a FAILED send during the drain is reported, not silently dropped', async () => {
    const storagePath = await freshScratch('ctc-drain-failsend-');
    const h1 = await startInstance(storagePath, {
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
    await stopInstance(h1, await openStorage(storagePath));

    expect(h1.channel.sent).toEqual([]);
    expect(h1.channel.failed).toEqual([
      { target: 'chat-42', text: expect.any(String), reason: 'transport-error' },
    ]);
  });

  it('a HUNG send does not hang the stop: the deadline releases the channels', async () => {
    const storagePath = await freshScratch('ctc-drain-hungsend-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    h1.coreLoop.pushSignal(thoughtSignal('turn trigger', h1.recipientId));
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    // the send never returns
    h1.channel.sendGate = new Promise<void>(() => undefined);
    h1.cognition.settleAll({
      confidence: 1,
      intents: [
        { type: 'SEND_MESSAGE', payload: { recipientId: h1.recipientId, text: 'the answer' } },
      ],
      response: undefined,
    });

    const started = Date.now();
    await stopInstance(h1, await openStorage(storagePath));
    expect(Date.now() - started).toBeLessThan(5_000); // the deadline, not the hang
    // the stop finished its own steps: the channels were released and the
    // sends were abandoned (the hard exit leaves the process at the deadline)
    expect(h1.channel.fullyStopped).toBe(true);
    expect(h1.coreLoop.stopReport().sendsOutstanding).toBe(1);
  });

  it('stop past the overall deadline continues: a stalled tick and a stalled scheduler do not hang it', async () => {
    const storagePath = await freshScratch('ctc-drain-stall-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 150,
    });
    // stall the tick and the scheduler callback
    const release = makeDeferred<void>();
    h1.coreLoop.setStallForTest({ tickGate: release.promise, schedulerGate: release.promise });

    const started = Date.now();
    await stopInstance(h1, await openStorage(storagePath));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000); // the deadline (150 ms), not the stall
    release.resolve(); // the stalled waits still settle for test cleanup
  });

  it('container shutdown is idempotent: the sequence runs once, however often it is called', async () => {
    const storagePath = await freshScratch('ctc-drain-idem-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 500,
    });
    const storage = await openStorage(storagePath);
    const containerShutdown = makeContainerShutdown(h1, storage);
    const p1 = containerShutdown();
    const p2 = containerShutdown();
    expect(p2).toBe(p1); // concurrent callers share the first call's promise
    await Promise.all([p1, p2]);
    await containerShutdown(); // sequential again: still the same promise

    // the stop happened exactly once: intake stopped and the channel was
    // released once, not three times
    expect(h1.channel.events).toEqual(['stopIntake', 'stop']);
  });

  // ── real cognition (agentic loop) with a scripted fake LLM provider ──

  it('REAL cognition: a turn completing during the stop drain delivers its reply', async () => {
    const storagePath = await freshScratch('ctc-real-finish-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'The real loop reply' }],
      drainTimeoutMs: 5_000,
    });
    // a user_message trigger: the real agentic loop answers it
    h1.coreLoop.pushSignal(
      createUserMessageSignal({
        text: 'hello there',
        chatId: 'chat-42',
        recipientId: h1.recipientId,
      })
    );
    // the real agentic loop ran exactly once (one LLM completion) ...
    await waitFor(() => h1.cognition.provider.requests.length === 1, 'LLM called once');
    // ... and its reply is delivered through the channel exactly once
    await waitFor(() => h1.channel.sent.length === 1, 'reply delivered');
    expect(h1.channel.sent[0]?.text).toBe('The real loop reply');

    await stopInstance(h1, await openStorage(storagePath));
    // delivered (before the full release) and never refused
    expect(h1.channel.events).not.toContain('send-refused');
    expect(h1.channel.events.indexOf('send')).toBeLessThan(h1.channel.events.indexOf('stop'));
    expect(existsSync(journalPath(storagePath))).toBe(false);
  });

  it('REAL cognition: a turn overrunning the drain is abandoned and nothing is redone', async () => {
    const storagePath = await freshScratch('ctc-real-overrun-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true, // the turn never completes: LLM held
      script: [{ content: 'never reached' }],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    h1.coreLoop.pushSignal(
      createUserMessageSignal({
        text: 'hello there',
        chatId: 'chat-42',
        recipientId: h1.recipientId,
      })
    );
    await waitFor(() => h1.cognition.provider.requests.length === 1, 'LLM held (turn in flight)');

    await stopInstance(h1, await openStorage(storagePath));
    expect(existsSync(journalPath(storagePath))).toBe(false);
    h1.cognition.settleHangingTurn();

    // fresh start: nothing is redone (this harness has no inbound log; with
    // one, the message replays exactly once - inbound-log-restart.test.ts)
    const h2 = await startInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'The redone real-loop reply' }],
      drainTimeoutMs: 500,
    });
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.provider.requests.length).toBe(0);
    expect(h2.channel.sent).toEqual([]);
    await h2.coreLoop.stop();
  });

  it('a turn that REJECTS during the drain is logged with the error (err) and its tick id', async () => {
    const storagePath = await freshScratch('ctc-drain-reject-');
    const h1 = await startInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    h1.coreLoop.pushSignal(thoughtSignal('turn trigger', h1.recipientId));
    await waitFor(() => h1.cognition.calls.length === 1, 'cognition started');
    // reject WHILE the drain is in flight (before stop, the tick path already
    // logs 'COGNITION failed (async)' - that is not the drain's log)
    const stopping = stopInstance(h1, await openStorage(storagePath));
    await waitFor(() => h1.channel.intakeStopped, 'intake stopped (drain running)');
    // reject while the DRAIN's race is running (20 ms past intake stop is
    // well inside it: the drain starts within a tick of the intake stop)
    await new Promise((r) => setTimeout(r, 20));
    h1.cognition.rejectAll(new Error('the turn exploded'));
    await stopping;

    const failLine = h1.recordedLogs.find(
      (c) =>
        c.level === 'error' && c.msg === 'COGNITION rejected unexpectedly during the stop drain'
    );
    expect(failLine).toBeDefined();
    expect((failLine?.obj as Record<string, unknown>)['err']).toBeInstanceOf(Error);
    expect(typeof failLine?.obj['tickId']).toBe('string');
  });
});
