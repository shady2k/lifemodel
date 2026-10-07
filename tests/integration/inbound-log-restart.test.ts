/**
 * Integration tests for the durable inbound log (lifemodel-ctc.2.1).
 *
 * Real CoreLoop + real durable inbound log + real storage chain
 * (JSONStorage behind DeferredStorage), doubles only at the boundaries:
 * - the channel (inbound callback AWAITED like the real Telegram channel),
 * - the LLM provider (scripted fake through the REAL cognition loop).
 *
 * Every scenario is a restart chain: the message must be answered exactly
 * once, or (named window) delivered but committed late - documented in the
 * stage report.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createUserMessageSignal } from '../../src/types/signal.js';
import type { SendMessageIntent } from '../../src/types/intent.js';

import { FakeCognitionLayer } from '../helpers/core-loop-drain-harness.js';
import {
  startInboundInstance,
  stopInboundInstance,
  receiveMessage,
  readLogSize,
  freshScratch,
  waitFor,
  llmRequests,
  seedAssistantAnswer,
  seedDeliveredEntry,
  SETTLE_TICKS,
  type InboundInstance,
} from '../helpers/inbound-log-harness.js';
import { openStorage } from '../helpers/core-loop-drain-harness.js';

const DRAIN_DEADLINE_MS = 150;

/** The text of the trigger the turn is running on (the replayed message). */
function triggerTextOf(instance: InboundInstance): string | undefined {
  const data = instance.cognition.calls[0]?.context.triggerSignals[0]?.data as
    | { text?: string }
    | undefined;
  return data?.text;
}

const scratchRoots: { storagePath: string; logDir: string }[] = [];
const instances: InboundInstance[] = [];
/**
 * kill -9 emulation: the instance is killed WITHOUT any stop - no drain, no
 * applied intents, no commit - and its loop timer is cleared, so the dead
 * instance cannot keep ticking behind the restart under test. Deterministic:
 * the instance keeps no timer at all after this call (review round 2, item
 * 10: the photo restart test was load-dependent because every killed
 * instance left a 5ms tick timer running).
 */
function die(instance: InboundInstance): void {
  instance.coreLoop.haltForTest();
  instances.splice(instances.indexOf(instance), 1);
}

async function fresh(prefix: string): Promise<{ storagePath: string; logDir: string }> {
  const paths = await freshScratch(prefix);
  scratchRoots.push(paths);
  return paths;
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await openStorage(root.storagePath).then(async (s) => {
      await s.flush();
    });
    // abandoned (kill -9 style) instances: stop the loops without commits
    for (const instance of instances.splice(0)) {
      if (instance.coreLoop.isRunning()) {
        // a hanging cognition turn overruns the small deadline; its entries
        // stay uncommitted - exactly the kill -9 semantics under test.
        await instance.coreLoop.stop(Date.now() + 50).catch(() => undefined);
      }
    }
    const { rmDir } = await import('../helpers/core-loop-drain-harness.js');
    await rmDir(root.storagePath);
    await rmDir(root.logDir);
  }
});

describe('durable inbound log (lifemodel-ctc.2.1)', { timeout: 20_000 }, () => {
  it('kill -9 right after receipt: the message is answered after restart exactly once', async () => {
    const { storagePath, logDir } = await fresh('ctc2-kill-');
    // the turn hangs forever: this process dies before it answers anything
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    // emit at the awaited callback: when it resolves the entry IS on disk
    await receiveMessage(h1, 'hello there', 'u-1');
    // crash: the process objects are dropped without any stop
    await waitFor(() => h1.inboundLog.size().total === 1, 'entry durably logged');

    // a fresh container on the SAME data dir replays and answers once
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the recovered answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the recovered answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'entry committed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);

    // a third start: nothing replays - answered exactly once
    const h3 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [],
      drainTimeoutMs: 5_000,
    });
    instances.push(h3);
    await waitFor(() => h3.autonomic.ticks() >= SETTLE_TICKS, 'instance 3 ran ticks');
    expect(llmRequests(h3)).toBe(0);
    expect(h3.channel.sent).toEqual([]);
  });

  it('kill -9 right after the FIRST message of a NEW chat: the route lives in the entry (finding 1)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-newchat-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    // a NEW chat's FIRST message: the route is created (as the real telegram
    // handler does with getOrCreate) but never persisted - the process dies
    const newRecipient = h1.registry.getOrCreate('test', 'chat-77');
    await h1.channel.emit(
      createUserMessageSignal({
        text: 'first ever message from chat 77',
        channel: 'telegram',
        userId: '77',
        recipientId: newRecipient,
        updateId: 'u-77-1',
      })
    );
    die(h1);
    await waitFor(
      async () => (await readLogSize(storagePath)).uncommitted === 1,
      'the entry (with its route) is on disk'
    );

    // restart: NO pre-registered route for chat-77 anywhere - the replay
    // re-registers it from the entry's routing data and the answer lands.
    // The hook runs on the FRESH registry before any replay, so the empty
    // state is asserted, not assumed (recipient ids are a pure function of
    // channel+destination, so chat-77's id is the same in the new process).
    let routeBeforeReplay: unknown = 'hook did not run';
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'welcome to chat 77' }],
      drainTimeoutMs: 5_000,
      onBeforeReplay: (registry) => {
        routeBeforeReplay = registry.resolve(newRecipient);
      },
    });
    instances.push(h2);
    expect(routeBeforeReplay).toBeNull();
    expect(h2.routesRestoredFromLog).toEqual([newRecipient]);
    expect(h2.registry.resolve(newRecipient)?.destination).toBe('chat-77');
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('welcome to chat 77');
    expect(h2.channel.sent[0]?.target).toBe('chat-77');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed once delivered');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a hung send: nothing commits, the message is answered after restart exactly once', async () => {
    const { storagePath, logDir } = await fresh('ctc2-hungsend-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the first answer' }],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h1);
    h1.channel.sendGate = { promise: new Promise(() => undefined), release: () => undefined };
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.channel.sendStarted.length === 1, 'send started (now hung)');

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();
    // the answer was never delivered -> not committed
    expect(h1.channel.sent).toEqual([]);
    expect((await readLogSize(storagePath)).uncommitted).toBe(1);
    // a late success must not commit either: the turn was evicted at stop
    h1.channel.sendGate = null;
    h1.channel.events.length = 0;
    h1.channel.sent.length = 0;

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the redone answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the redone answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed once delivered');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a failed send: not committed, answered after restart exactly once', async () => {
    const { storagePath, logDir } = await fresh('ctc2-failsend-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'a doomed answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    h1.channel.failNextSend = 'telegram is down';
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.channel.failed.length === 1, 'send failed');
    await waitFor(
      () => h1.coreLoop.isRunning() && h1.inboundLog.size().uncommitted === 1,
      'not committed'
    );

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the retry answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the retry answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed once delivered');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a turn that rejects: not committed, answered after restart exactly once', async () => {
    const { storagePath, logDir } = await fresh('ctc2-reject-');
    // the fake cognition boundary rejects its turn - the core paths under
    // test (no commit on rejection, replay once) do not depend on the LLM
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.cognition.calls.length === 1, 'turn started');
    (h1.cognition as FakeCognitionLayer).rejectAll(new Error('the turn exploded'));
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 1,
      'the rejected turn left its entry uncommitted'
    );

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'answered on redo' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('answered on redo');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed once delivered');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a message absorbed into a turn that never completes is answered after restart', async () => {
    const { storagePath, logDir } = await fresh('ctc2-absorb-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h1);
    await receiveMessage(h1, 'first message', 'u-1');
    await waitFor(() => h1.cognition.calls.length === 1, 'turn started');
    // the second message waits while COGNITION is busy, then is absorbed
    // through the turn's own drainer (what the agentic loop calls mid-loop)
    await receiveMessage(h1, 'absorbed message', 'u-2');
    await waitFor(() => h1.coreLoop.pendingSignalCount() === 1, 'second message queued');
    const drained = h1.cognition.calls[0]?.context.drainPendingUserMessages;
    const absorbedNow = drained?.() ?? [];
    expect(absorbedNow.map((s) => s.id)).toHaveLength(1);
    // both entries are in the log, neither committed (the turn hangs)
    expect(h1.inboundLog.size()).toEqual({ total: 2, uncommitted: 2 });

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'one answer for both' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    // both messages replay in order and are answered by ONE delivered turn
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('one answer for both');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'both entries committed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
    expect(h2.channel.sent).toHaveLength(1);
  });

  it('restore then crash before processing: still answered exactly once', async () => {
    const { storagePath, logDir } = await fresh('ctc2-recrash-');
    // first process: logs the message and dies before answering
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'u-1');

    // second process: restores (replays into its queue) and crashes
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => llmRequests(h2) === 1, 'restored and taken into a (hung) turn');
    // crash WITHOUT processing: nothing is committed (the turn hangs)
    expect((await readLogSize(storagePath)).uncommitted).toBe(1);

    // third process: answers exactly once
    const h3 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'third time is the charm' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h3);
    await waitFor(() => h3.channel.sent.length === 1, 'answered once');
    expect(h3.channel.sent[0]?.text).toContain('third time is the charm');
    await waitFor(() => h3.inboundLog.size().uncommitted === 0, 'committed once delivered');
    await waitFor(() => h3.autonomic.ticks() >= SETTLE_TICKS, 'instance 3 ran ticks');
    expect(llmRequests(h3)).toBe(1);
  });

  it('the same update_id delivered twice is answered exactly once', async () => {
    const { storagePath, logDir } = await fresh('ctc2-dup-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'only once' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'dup-1');
    await receiveMessage(h1, 'hello there', 'dup-1'); // re-delivered update
    await receiveMessage(h1, 'hello there again', 'dup-1'); // a NEWER update id? no: same key -> dropped
    await waitFor(() => h1.channel.sent.length === 1, 'answered once');
    // the commit follows the send asynchronously (durable delivery evidence,
    // then the commit flush): wait for THAT, not for a tick count
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'the delivered answer commits');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(llmRequests(h1)).toBe(1);
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 0 });

    // a restart also does not re-answer the re-delivered update
    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await receiveMessage(h2, 'hello there', 'dup-1');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a turn that deliberately answers nothing (no_reply) commits its entry: no endless replay', async () => {
    const { storagePath, logDir } = await fresh('ctc2-defer-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'immediate', // the fake turn settles with NO intents
      cognitionResult: { disposition: 'no_reply' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'just so you know', 'u-1');
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'committed at resolution');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.channel.sent).toEqual([]);

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      cognitionResult: { disposition: 'no_reply' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.calls.length).toBe(0);
    expect(h2.inboundLog.size()).toEqual({ total: 1, uncommitted: 0 });
  });

  it('a deferring turn (disposition defer) commits its entry: the agent chose to wait', async () => {
    const { storagePath, logDir } = await fresh('ctc2-defer-disp-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      cognitionResult: { disposition: 'defer' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'not now', 'u-1');
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'deferral settles the entry');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.channel.sent).toEqual([]);
  });

  it('a turn that neither answers nor says it chose not to does NOT commit (finding 4)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-nodisp-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'immediate', // settles with NO disposition and NO send
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'just so you know', 'u-1');
    await waitFor(() => h1.cognition.calls.length === 1, 'turn ran');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.channel.sent).toEqual([]);
    // No delivered answer and no deliberate no-reply: the entry stays
    // uncommitted, so a restart answers it instead of losing it.
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();
    // HANG the replayed turn: nothing settles, so the replayed entry is
    // observable (a settling turn would commit it within the same tick).
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h2);
    await waitFor(() => h2.cognition.calls.length === 1, 'the unanswered message was replayed');
    expect(triggerTextOf(h2)).toBe('just so you know');
    expect(h2.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });
    expect(h2.channel.sent).toEqual([]);
  });

  it('an ERROR turn does not commit, even when it delivered an error message (finding 4)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-error-turn-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'immediate',
      cognitionResult: { disposition: 'error' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    // The turn DOES send (the forced-refusal path sends an error text): the
    // send is delivered, yet the turn is an error - the entry must stay for
    // replay, exactly like the owner decision says.
    const send: SendMessageIntent = {
      type: 'SEND_MESSAGE',
      payload: { recipientId: h1.recipientId, text: 'sorry, something went wrong' },
    };
    (h1.cognition as FakeCognitionLayer).result = {
      confidence: 0,
      intents: [send],
      response: undefined,
      disposition: 'error',
    };
    await receiveMessage(h1, 'please answer me', 'u-1');
    await waitFor(() => h1.channel.sent.length === 1, 'the error message was delivered');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h2);
    await waitFor(() => h2.cognition.calls.length === 1, 'the errored message was replayed');
    expect(triggerTextOf(h2)).toBe('please answer me');
    expect(h2.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });
  });

  it('per-recipient offsets: a turn owns ONLY the recipient it answers (finding 2)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-two-recv-');
    // SLOW first tick: both messages are queued (and logged) before the
    // turn starts, so the wake BUNDLES one message per recipient. TWO turns
    // will run: one per recipient, hence a two-entry script.
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'the answer for the first' }, { content: 'the answer for the second' }],
      drainTimeoutMs: 5_000,
      tickIntervalMs: 500,
    });
    instances.push(h1);
    const otherRecipientId = h1.registry.getOrCreate('test', 'chat-43');
    await receiveMessage(h1, 'message that gets a failing answer', 'u-1');
    await h1.channel.emit(
      createUserMessageSignal({
        text: 'message bundled with the first',
        recipientId: otherRecipientId,
      })
    );
    await waitFor(() => h1.inboundLog.size().total === 2, 'both messages logged');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');
    h1.cognition.settleHangingTurn();
    (h1.cognition as { hang: boolean }).hang = false;

    // The turn answers the FIRST recipient only; the bundled message of the
    // other recipient is requeued for ITS OWN turn. While the first send
    // fails, BOTH entries are uncommitted (finding 2: the turn never owned
    // the other recipient, so it can never commit it).
    h1.channel.failNextSend = 'telegram is down';
    await waitFor(() => h1.channel.failed.length === 1, 'the first send failed');
    expect(h1.inboundLog.size().uncommitted).toBe(2);
    expect(h1.inboundLog.replayable().map((e) => e.recipientId)).toContain(otherRecipientId);

    // The requeued message gets its own turn, delivers, and commits ONLY its
    // own entry - the failed recipient's answer is never borrowed.
    await waitFor(() => llmRequests(h1) === 2, 'the second recipient got its own turn');
    await waitFor(() => h1.channel.sent.length === 1, 'the second recipient answered once');
    await waitFor(() => h1.inboundLog.size().uncommitted === 1, 'only the failed one remains');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.inboundLog.replayable().map((e) => e.recipientId)).toEqual([h1.recipientId]);

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();

    // only the failed recipient replays; the answered one does not
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the isolated redo' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'the failed recipient answered once');
    expect(h2.channel.sent[0]?.text).toContain('the isolated redo');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'all committed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a send that cannot start (no channel) is a FAILED delivery (finding 3)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-nochannel-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'an undeliverable answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'u-1');
    // the route still exists, but the CHANNEL is gone: the send cannot start
    expect(h1.coreLoop.unregisterChannel('test')).toBe(true);
    await waitFor(() => llmRequests(h1) === 1, 'turn ran');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 1,
      'the entry stays uncommitted: no send ever started'
    );
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the retry after the repair' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the retry after the repair');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a message absorbed DURING the stop drain keeps its turn; the immediate answer commits it (finding 9)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-drainabsorb-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'the drained answer' }],
      drainTimeoutMs: 2_000,
      recordLogs: true,
    });
    instances.push(h1);
    await receiveMessage(h1, 'the first message', 'u-1');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');

    const stopping = stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    await waitFor(() => h1.channel.intakeStopped, 'intake stopped (drain running)');
    // GATE: the drain CLAIMS the turn (clears pendingCognition) before it
    // awaits it - the absorb below happens after that, deterministically
    await waitFor(
      () => h1.coreLoop.pendingCognitionTickId() === null,
      'the drain claimed the turn (pendingCognition cleared)'
    );
    // a message arrives and is absorbed WHILE pendingCognition is cleared
    await receiveMessage(h1, 'absorbed during the drain', 'u-2');
    await waitFor(() => h1.coreLoop.pendingSignalCount() === 1, 'second message queued');
    expect(h1.coreLoop.pendingCognitionTickId()).toBeNull();
    const drained = h1.cognition.calls[0]?.context.drainPendingUserMessages;
    const absorbedNow = drained?.() ?? [];
    expect(absorbedNow.map((s) => s.id)).toHaveLength(1);
    // release the turn INSIDE the drain: it answers the primary recipient
    // immediately (no-trace immediate send) and delivers
    h1.cognition.settleHangingTurn();
    await stopping;

    expect(h1.channel.sent.length).toBe(1);
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'trigger AND mid-drain absorbed message committed: the immediate send kept the turn attribution'
    );

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a real core.say send during the stop drain keeps the turn and commits it (finding 9)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-drainsay-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [
        // 1. the turn speaks IMMEDIATELY through the real core.say tool, with
        //    NO trace on the send - its turn can only be resolved through the
        //    active-turn bookkeeping the drain just took over
        { toolCalls: [{ name: 'core.say', args: { text: 'working on it' } }] },
        // 2. the message absorbed mid-drain is pulled into this same turn and
        //    answered by its final response
        { content: 'here is the answer' },
      ],
      drainTimeoutMs: 2_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'the first message', 'u-1');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');

    const stopping = stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    await waitFor(() => h1.channel.intakeStopped, 'intake stopped (drain running)');
    await waitFor(
      () => h1.coreLoop.pendingCognitionTickId() === null,
      'the drain claimed the turn (pendingCognition cleared)'
    );
    await receiveMessage(h1, 'absorbed during the drain', 'u-2');
    await waitFor(() => h1.coreLoop.pendingSignalCount() === 1, 'second message queued');

    // release the turn INSIDE the drain: core.say sends with NO trace, so its
    // turn must be resolved through the ACTIVE turn bookkeeping (the drain
    // already cleared pendingCognition) - otherwise the send is untracked and
    // neither entry could ever commit
    h1.cognition.hang = false;
    h1.cognition.settleHangingTurn();
    await stopping;

    // BOTH sends go out: the acknowledgement does not swallow the answer
    expect(h1.channel.sent.map((s) => s.text)).toEqual([
      expect.stringContaining('working on it'),
      expect.stringContaining('here is the answer'),
    ]);
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'trigger AND mid-drain absorbed message committed: the immediate core.say send kept the turn attribution'
    );

    // nothing left to replay: the restart runs no turn and sends nothing
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a delivered-but-uncommitted answer is not sent again on replay (finding 10)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-dupsuppress-');
    // the message was logged; the process died before answering
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'asking something', 'u-1');

    // ...and the answer had ALREADY been delivered before the crash: the
    // DURABLE evidence the send path writes for the entry (the named window
    // is between that write and the turn's commit). The seeds go straight to
    // the storage - an instance here would replay the entry itself.
    die(h1);
    await seedDeliveredEntry(storagePath, 'u-1');

    // restart: the loop answers again, but the log proves this entry was
    // already answered - nothing is sent a second time and the entry
    // settles. Deliberately DIFFERENT text: durability, not text equality,
    // is what settles it.
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'a completely different rewording' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => llmRequests(h2) === 1, 'the redone turn ran');
    // the send never even reaches the channel
    expect(h2.channel.sendStarted).toEqual([]);
    expect(h2.channel.sent).toEqual([]);
    await waitFor(
      () => h2.inboundLog.size().uncommitted === 0,
      'committed (durable delivery evidence)'
    );
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('an unrelated earlier answer with identical text does NOT settle a new entry (finding 10)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-unrelated-');
    // the new question is logged; the process dies before answering it
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'tell me something', 'u-1');

    // ...and an UNRELATED earlier turn had already answered with exactly the
    // text this question is about to get. Only the history knows it: there
    // is no delivery evidence for THIS entry.
    die(h1);
    await seedAssistantAnswer(storagePath, 'the very same answer', h1.recipientId);

    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the very same answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    // identical text is not proof: the answer IS really sent...
    await waitFor(() => h2.channel.sent.length === 1, 'the answer is really sent');
    expect(h2.channel.sent[0]?.text).toContain('the very same answer');
    // ...and only that real send settles the entry
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed by the real send');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
    expect(h2.channel.sent).toHaveLength(1);
  });

  it('kill -9 during a photo download: the receipt replays and the channel re-fetches (finding 7)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-photoreceipt-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    // the handler emitted its durable RECEIPT (still downloading); kill
    const receipt = createUserMessageSignal({
      text: 'look at the picture',
      channel: 'telegram',
      userId: '7',
      recipientId: h1.recipientId,
      updateId: 'u-photo-1',
      pendingPhoto: { fileId: 'photo-file-1' },
    });
    await h1.channel.emit(receipt);
    die(h1);
    await waitFor(
      async () => (await readLogSize(storagePath)).uncommitted === 1,
      'receipt on disk'
    );
    expect((await readLogSize(storagePath)).total).toBe(1);

    // restart: the channel re-fetches the receipt and QUEUES the full photo;
    // the turn answers exactly once and the receipt settles committed
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'nice picture' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    expect(h2.channel.photoCompletions).toEqual(['photo-file-1']);
    await waitFor(() => h2.channel.sent.length === 1, 'answered once');
    expect(h2.channel.sent[0]?.text).toContain('nice picture');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'the receipt entry committed');
    expect(h2.inboundLog.size().total).toBe(1);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a photo receipt whose re-fetch fails is queued as its caption text (finding 7 fallback)', async () => {
    const { storagePath, logDir } = await fresh('ctc2-photofail-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    const receipt = createUserMessageSignal({
      text: 'look at the picture',
      channel: 'telegram',
      userId: '7',
      recipientId: h1.recipientId,
      updateId: 'u-photo-2',
      pendingPhoto: { fileId: 'photo-file-2' },
    });
    await h1.channel.emit(receipt);
    die(h1);

    // the channel is broken: re-fetch fails; the caption-only message is
    // queued as a plain message, answered once, and no receipt loops forever
    const h2 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'plain reply' }],
      drainTimeoutMs: 5_000,
      photoCompletionFails: true,
    });
    instances.push(h2);
    expect(h2.channel.photoCompletions).toEqual([]);
    await waitFor(() => h2.channel.sent.length === 1, 'answered once');
    expect(h2.channel.sent[0]?.text).toContain('plain reply');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'committed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });
});
