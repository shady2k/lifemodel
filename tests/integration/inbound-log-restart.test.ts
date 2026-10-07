/**
 * Integration tests for the durable inbound log (lifemodel-ctc.2.1).
 *
 * Real CoreLoop + real durable inbound log + real storage chain
 * (JSONStorage behind DeferredStorage), doubles only at the boundaries:
 * - the channel (inbound callback AWAITED like the real Telegram channel),
 * - the LLM provider (scripted fake through the REAL cognition loop).
 *
 * The guarantee under test is the owner's proportionality decision (comment
 * 54): a GRACEFUL restart loses no turn and no message and answers none
 * twice; a CRASH is best effort. An entry leaves the log when its turn
 * reached a recorded outcome - answered, deliberately silent (core.defer /
 * explicit no-reply), failed send, failed turn (error disposition) - and a
 * failed outcome is never retried, it is reported at warn with the recipient
 * and the reason. Only a message whose turn recorded NO outcome (a crash
 * mid-turn, a rejected turn, a turn overrunning the stop deadline, a hung
 * send) is replayed, once, at the next start.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createUserMessageSignal } from '../../src/types/signal.js';
import type { SendMessageIntent } from '../../src/types/intent.js';

import { FakeCognitionLayer, thoughtSignal } from '../helpers/core-loop-drain-harness.js';
import {
  makeDeferred,
  makeScratchDir,
  startInboundInstance,
  stopInboundInstance,
  receiveMessage,
  readLogSize,
  waitFor,
  llmRequests,
  seedAssistantAnswer,
  harnessRecipientId,
  activityOf,
  fenceKilledInstance,
  SETTLE_TICKS,
  type InboundInstance,
} from '../helpers/inbound-log-harness.js';
import { rmDir } from '../helpers/core-loop-drain-harness.js';

const DRAIN_DEADLINE_MS = 150;

/** The text of the trigger the first turn is running on. */
function triggerTextOf(instance: InboundInstance): string | undefined {
  const data = instance.cognition.calls[0]?.context.triggerSignals[0]?.data as
    | { text?: string }
    | undefined;
  return data?.text;
}

/** The recipient of the trigger the n-th turn is running on. */
function triggerRecipientOf(instance: InboundInstance, turn: number): string | undefined {
  const data = instance.cognition.calls[turn]?.context.triggerSignals[0]?.data as
    | { recipientId?: string }
    | undefined;
  return data?.recipientId;
}

/** The texts that really went out. */
function sentTexts(instance: InboundInstance): string[] {
  return instance.channel.sent.map((s) => s.text);
}

/** The outcome record of one instance (settle log lines). */
function settleLogs(
  instance: InboundInstance
): { level: string; obj: Record<string, unknown>; msg: string }[] {
  return instance.recordedLogs.filter(
    (l) => typeof l.msg === 'string' && l.msg.includes('Inbound messages settled')
  );
}

/**
 * Wait for the core's record of a turn outcome (the settle log line). The
 * line is an EVENT of the turn's settlement; a tick count is not: the tick
 * counter rises when a tick STARTS, while the settlement it carries happens
 * later in that same tick, so asserting after `ticks >= SETTLE_TICKS` races
 * the very line the test reads (measured: 4 of 8 loaded runs, the line landed
 * 4-22 ms after the tick wait returned).
 */
async function waitForSettleLogs(instance: InboundInstance, count = 1): Promise<void> {
  await waitFor(
    () => settleLogs(instance).length >= count,
    `${String(count)} turn outcome(s) recorded`
  );
}

/** Wait for a log line the instance recorded (an event, never a tick count). */
async function waitForLog(instance: InboundInstance, needle: string): Promise<void> {
  await waitFor(
    () => instance.recordedLogs.some((l) => typeof l.msg === 'string' && l.msg.includes(needle)),
    `the instance logged "${needle}"`
  );
}

const scratchRoots: string[] = [];
const instances: InboundInstance[] = [];

/**
 * kill -9 emulation: the instance is killed WITHOUT any stop - no drain, no
 * applied intents, no commit - and then FENCED: its timers and subscription
 * stop, its late effects are dropped, the work it had in flight (the tick, the
 * scheduler callback) is joined, and its STORAGE is closed, so work that is
 * still running (a conversation save of a send chain, a log flush) cannot
 * write anything to the data directory any more - every later write is dropped
 * and counted on the handle (review round 5: an unfenced killed instance kept
 * writing conversation state and raced the teardown's rmdir with ENOTEMPTY /
 * ENOENT).
 */
async function die(instance: InboundInstance): Promise<void> {
  await fenceKilledInstance(instance);
}

async function fresh(prefix: string): Promise<string> {
  const storagePath = await makeScratchDir(prefix);
  scratchRoots.push(storagePath);
  return storagePath;
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    // EVERY instance of this scratch root - killed, stopped or still running -
    // is fenced before the directory goes: no instance may write into it while
    // (or after) it is removed. The instance logger needs no teardown of its
    // own: it has no transport, so it holds no worker thread and creates no
    // file (see test-logger.ts).
    for (const instance of instances.splice(0)) {
      await fenceKilledInstance(instance).catch(() => undefined);
    }
    await rmDir(root);
  }
});

describe('durable inbound log (lifemodel-ctc.2.1)', { timeout: 30_000 }, () => {
  // ── crash (best effort): a killed process is fenced, and the next start
  //    replays the entries whose turn recorded no outcome ──

  it('kill -9 right after receipt: the message is answered after restart exactly once', async () => {
    const storagePath = await fresh('ctc2-kill-');
    // the turn hangs forever: this process dies before it answers anything
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    // emit at the awaited callback: when it resolves the entry IS on disk
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.inboundLog.size().total === 1, 'entry durably logged');
    // crash: the objects are dropped without any stop, and fenced
    await die(h1);
    const killed = activityOf(h1);
    expect(killed.running).toBe(false);
    expect(h1.storage.isFenced).toBe(true);

    // a fresh container on the SAME data dir replays and answers once
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the recovered answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the recovered answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'the outcome removed the entry');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
    // the killed instance did nothing behind the restart
    expect(activityOf(h1)).toEqual(killed);

    // a third start: nothing replays - answered exactly once. h2 is STOPPED
    // first, as a real restart does: its commit is in memory before its flush
    // reaches the disk (commitNow advances the offsets, then persists), so a
    // third process started beside a LIVE h2 can read the entry back and
    // answer it again (measured, 2 of 32 loaded runs). A graceful stop flushes
    // last - exactly the boundary a restart is defined on.
    await stopInboundInstance(h2);
    const h3 = await startInboundInstance(storagePath, {
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
    const storagePath = await fresh('ctc2-newchat-');
    const h1 = await startInboundInstance(storagePath, {
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
    await die(h1);
    // the emit is awaited, so the entry (with its route) is already on disk
    expect(await readLogSize(storagePath)).toEqual({ total: 1, uncommitted: 1 });

    // restart: NO pre-registered route for chat-77 anywhere - the replay
    // re-registers it from the entry's routing data and the answer lands.
    // The hook runs on the FRESH registry before any replay, so the empty
    // state is asserted, not assumed (recipient ids are a pure function of
    // channel+destination, so chat-77's id is the same in the new process).
    let routeBeforeReplay: unknown = 'hook did not run';
    const h2 = await startInboundInstance(storagePath, {
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
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by the turn outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('restore then crash before processing: still answered exactly once', async () => {
    const storagePath = await fresh('ctc2-recrash-');
    // first process: logs the message and dies before answering
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'u-1');

    // second process: restores (replays into its queue) and crashes
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => llmRequests(h2) === 1, 'restored and taken into a (hung) turn');
    await die(h1);
    await die(h2);
    const killed = activityOf(h2);
    expect(h2.storage.isFenced).toBe(true);
    // crash WITHOUT an outcome: nothing settled (the turn hangs)
    expect(await readLogSize(storagePath)).toEqual({ total: 1, uncommitted: 1 });

    // a third process: answers exactly once
    const h3 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'third time is the charm' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h3);
    await waitFor(() => h3.channel.sent.length === 1, 'answered once');
    expect(h3.channel.sent[0]?.text).toContain('third time is the charm');
    await waitFor(() => h3.inboundLog.size().uncommitted === 0, 'removed by the turn outcome');
    await waitFor(() => h3.autonomic.ticks() >= SETTLE_TICKS, 'instance 3 ran ticks');
    expect(llmRequests(h3)).toBe(1);
    expect(activityOf(h2)).toEqual(killed);
  });

  it('kill -9 during a photo download: the receipt replays and the channel re-fetches (finding 7)', async () => {
    const storagePath = await fresh('ctc2-photoreceipt-');
    const h1 = await startInboundInstance(storagePath, {
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
    await die(h1);
    expect(await readLogSize(storagePath)).toEqual({ total: 1, uncommitted: 1 });

    // restart: the channel re-fetches the receipt and QUEUES the full photo;
    // the turn answers exactly once and the receipt entry is removed
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'nice picture' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    expect(h2.channel.photoCompletions).toEqual(['photo-file-1']);
    await waitFor(() => h2.channel.sent.length === 1, 'answered once');
    expect(h2.channel.sent[0]?.text).toContain('nice picture');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'the receipt entry removed');
    expect(h2.inboundLog.size().total).toBe(1);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a photo receipt whose re-fetch fails is queued as its caption text (finding 7 fallback)', async () => {
    const storagePath = await fresh('ctc2-photofail-');
    const h1 = await startInboundInstance(storagePath, {
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
    await die(h1);

    // the channel is broken: re-fetch fails; the caption-only message is
    // queued as a plain message, answered once, and no receipt loops forever
    const h2 = await startInboundInstance(storagePath, {
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
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('the same update_id delivered twice is answered exactly once', async () => {
    const storagePath = await fresh('ctc2-dup-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'only once' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'dup-1');
    await receiveMessage(h1, 'hello there', 'dup-1'); // re-delivered update
    await receiveMessage(h1, 'hello there again', 'dup-1'); // same key -> dropped
    await waitFor(() => h1.channel.sent.length === 1, 'answered once');
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'removed by the turn outcome');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(llmRequests(h1)).toBe(1);
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 0 });

    // a restart also does not re-answer the re-delivered update
    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
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

  // ── the graceful guarantee, through the real cognition loop with a
  //    scripted fake LLM: strict - no message lost, none answered twice ──

  it('graceful stop during a turn that finishes: the answer goes out once and the entry is removed', async () => {
    const storagePath = await fresh('ctc2-graceful-finish-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'the answer of the drained turn' }],
      drainTimeoutMs: 2_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'the message that arrives before the stop', 'u-1');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');

    const stopping = stopInboundInstance(h1);
    await waitFor(() => h1.channel.intakeStopped, 'intake stopped (drain running)');
    // the turn finishes INSIDE the drain deadline
    h1.cognition.hang = false;
    h1.cognition.settleHangingTurn();
    await stopping;

    // delivered exactly once, during the drain, before the channels were freed
    expect(sentTexts(h1)).toEqual([expect.stringContaining('the answer of the drained turn')]);
    expect(h1.channel.events.indexOf('send')).toBeLessThan(h1.channel.events.indexOf('stop'));
    // ... and its outcome removed the entry: the restart replays nothing
    expect((await readLogSize(storagePath)).uncommitted).toBe(0);

    const h2 = await startInboundInstance(storagePath, {
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

  it('graceful stop whose turn overruns the deadline: replayed once after the next start', async () => {
    const storagePath = await fresh('ctc2-graceful-overrun-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'never reached' }],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h1);
    await receiveMessage(h1, 'the overrunning message', 'u-1');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');

    await stopInboundInstance(h1);
    // the turn recorded no outcome: nothing was sent and the entry stays
    expect(h1.channel.sent).toEqual([]);
    expect(await readLogSize(storagePath)).toEqual({ total: 1, uncommitted: 1 });

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the redone answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered once after the restart');
    expect(h2.channel.sent[0]?.text).toContain('the redone answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by its outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
    expect(triggerTextOf(h2)).toBe('the overrunning message');
  });

  it('a message queued at the stop is handled exactly once after the next start', async () => {
    const storagePath = await fresh('ctc2-queued-');
    // a SLOW tick: the message is durably logged and the stop arrives before
    // any tick could take it (no turn is in flight)
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [],
      tickIntervalMs: 5_000,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'queued when the stop arrives', 'u-1');
    expect(h1.coreLoop.pendingSignalCount()).toBe(1);

    await stopInboundInstance(h1);
    // it never got a turn: still uncommitted in the log (the queue it also sat
    // in is not durable - internal signals never are)
    expect(await readLogSize(storagePath)).toEqual({ total: 1, uncommitted: 1 });

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the queued answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    // exactly ONE turn, one answer: the replayed entry is the only copy of the
    // message (nothing else is restored)
    await waitFor(() => h2.channel.sent.length === 1, 'answered once after the restart');
    expect(h2.channel.sent[0]?.text).toContain('the queued answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by its outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
    expect(triggerTextOf(h2)).toBe('queued when the stop arrives');
    expect(sentTexts(h2)).toHaveLength(1);
  });

  // ── the acknowledgement (core.say) and the answer: two sends, two gates
  //    (review round 4, findings 1 and 3) ──

  it('a held core.say acknowledgement with an empty final response: answered once across a graceful stop (finding 1)', async () => {
    const storagePath = await fresh('ctc2-sayonly-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [
        // the turn answers ONLY through core.say: that message IS the answer
        { toolCalls: [{ name: 'core.say', args: { text: 'working on it' } }] },
        // an empty final response after core.say is a valid answer: disposition
        // `answer` with NO final SEND_MESSAGE intent (agentic-loop.ts)
        { content: null },
      ],
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    const gate = makeDeferred<void>();
    h1.channel.sendGate = { promise: gate.promise, release: () => gate.resolve(undefined) };
    await receiveMessage(h1, 'the message the acknowledgement answers', 'u-1');
    await waitFor(() => h1.channel.sendStarted.length === 1, 'the acknowledgement started (held)');
    await waitFor(() => llmRequests(h1) === 2, 'the turn ran to its empty final response');
    // the turn has resolved with the acknowledgement STILL in flight: the entry
    // is not settled on a guess
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(sentTexts(h1)).toEqual([]);
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });

    const stopping = stopInboundInstance(h1);
    await waitFor(() => h1.channel.intakeStopped, 'intake stopped (drain running)');
    // the held acknowledgement delivers INSIDE the drain: with it the turn's
    // outcome (answered) is recorded before the channels are released
    h1.channel.sendGate = null;
    gate.resolve(undefined);
    await stopping;

    expect(sentTexts(h1)).toEqual([expect.stringContaining('working on it')]);
    expect((await readLogSize(storagePath)).uncommitted).toBe(0);

    // a restart does not replay it: the message was answered exactly once
    const h2 = await startInboundInstance(storagePath, {
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

  it('an acknowledgement that settles first does not answer for a final send still in flight (finding 3)', async () => {
    const storagePath = await fresh('ctc2-ackthenhang-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [
        { toolCalls: [{ name: 'core.say', args: { text: 'working on it' } }] },
        { content: 'the answer that never lands' },
      ],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h1);
    // TWO independent gates: the acknowledgement and the answer are held on
    // their own, so the acknowledgement can settle AFTER the turn resolved and
    // while the answer is still in flight - the window of finding 3.
    const ackGate = makeDeferred<void>();
    const answerGate = makeDeferred<void>();
    h1.channel.sendGates.set(1, {
      promise: ackGate.promise,
      release: () => ackGate.resolve(undefined),
    });
    h1.channel.sendGates.set(2, {
      promise: answerGate.promise,
      release: () => answerGate.resolve(undefined),
    });
    await receiveMessage(h1, 'the message the answer is for', 'u-1');
    await waitFor(() => h1.channel.sendStarted.length === 2, 'both sends started and held');

    // release ONLY the acknowledgement: it lands while the answer is still in
    // flight, and the entry must stay (the acknowledgement is not the answer)
    ackGate.resolve(undefined);
    await waitFor(() => h1.channel.sent.length === 1, 'the acknowledgement delivered');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(sentTexts(h1)).toEqual([expect.stringContaining('working on it')]);
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });

    // the answer hangs past the stop deadline: still no outcome, so it is kept
    await stopInboundInstance(h1);
    expect(sentTexts(h1)).toEqual([expect.stringContaining('working on it')]);
    expect(await readLogSize(storagePath)).toEqual({ total: 1, uncommitted: 1 });

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the redone answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered once after the restart');
    expect(h2.channel.sent[0]?.text).toContain('the redone answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by its outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a FAILED final send after a delivered acknowledgement: failed_send, warned, not retried (finding 3)', async () => {
    const storagePath = await fresh('ctc2-ackthenfail-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [
        { toolCalls: [{ name: 'core.say', args: { text: 'working on it' } }] },
        { content: 'the answer that fails' },
      ],
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    h1.channel.failSendAt = { index: 2, reason: 'telegram is down' };
    await receiveMessage(h1, 'the message the answer is for', 'u-1');
    await waitFor(() => h1.channel.sent.length === 1, 'the acknowledgement delivered');
    await waitFor(() => h1.channel.failed.length === 1, 'the final send failed');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'the failed FINAL send is the outcome, not the acknowledgement'
    );
    await waitForSettleLogs(h1);
    const settled = settleLogs(h1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.level).toBe('warn');
    expect(settled[0]?.obj).toMatchObject({
      recipientId: h1.recipientId,
      outcome: 'failed_send',
      reason: 'returned_false',
    });

    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'never sent: the outcome was already recorded' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  // ── the outcome rule: what settles an entry, what is replayed ──

  it('a turn that deliberately answers nothing (no_reply) settles its entry: no endless replay', async () => {
    const storagePath = await fresh('ctc2-defer-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate', // the fake turn settles with NO intents
      cognitionResult: { disposition: 'no_reply' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'just so you know', 'u-1');
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'settled at resolution');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.channel.sent).toEqual([]);

    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate',
      cognitionResult: { disposition: 'no_reply' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.calls.length).toBe(0);
    expect(h2.inboundLog.size()).toEqual({ total: 1, uncommitted: 0 });
  });

  it('a deferring turn (disposition defer) settles its entry: the agent chose to wait', async () => {
    const storagePath = await fresh('ctc2-defer-disp-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate',
      cognitionResult: { disposition: 'defer' },
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'not now', 'u-1');
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'the deferral settles the entry');
    await waitFor(() => h1.autonomic.ticks() >= SETTLE_TICKS, 'ticks ran');
    expect(h1.channel.sent).toEqual([]);
  });

  it('a turn with NO outcome (no send, no disposition) keeps its entry for replay', async () => {
    const storagePath = await fresh('ctc2-nodisp-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate', // settles with NO disposition and NO send
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    await receiveMessage(h1, 'just so you know', 'u-1');
    await waitFor(() => h1.cognition.calls.length === 1, 'turn ran');
    // The turn's EVALUATION is the event to wait for, not a tick count: it is
    // what records "no outcome" (a tick count rises before the settlement the
    // same tick carries - see waitForSettleLogs).
    await waitForLog(h1, 'reached no outcome');
    expect(h1.channel.sent).toEqual([]);
    // No send and no deliberate silence: no outcome, so the entry stays for
    // one replay - and the core says so.
    expect(h1.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });
    expect(
      h1.recordedLogs.filter((l) => l.level === 'warn' && l.msg.includes('reached no outcome'))
    ).toHaveLength(1);

    await stopInboundInstance(h1);
    // HANG the replayed turn: nothing settles, so the replayed entry is
    // observable (a settling turn would remove it within the same tick).
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h2);
    await waitFor(() => h2.cognition.calls.length === 1, 'the unanswered message was replayed');
    expect(triggerTextOf(h2)).toBe('just so you know');
    expect(h2.inboundLog.size()).toEqual({ total: 1, uncommitted: 1 });
    expect(h2.channel.sent).toEqual([]);
  });

  it('an ERROR turn is a failed outcome: removed, warned, never retried', async () => {
    const storagePath = await fresh('ctc2-error-turn-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate',
      cognitionResult: { disposition: 'error' },
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    // The turn DOES send (the forced-refusal path sends an error text): the
    // send is delivered, yet the turn is an error - the outcome is FAILED and
    // the owner decision is that a failed outcome is not retried.
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
    await waitFor(() => h1.channel.sent.length === 1, 'the error message went out');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'the failed turn removed the entry'
    );
    await waitForSettleLogs(h1);
    const settled = settleLogs(h1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.level).toBe('warn');
    expect(settled[0]?.obj).toMatchObject({ recipientId: h1.recipientId, outcome: 'failed_turn' });

    // the restart does NOT retry it
    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.calls.length).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a result send that carries NO trace is still attributed to its turn (review round 8)', async () => {
    const storagePath = await fresh('ctc2-notrace-');
    // A producer that hands back its answer without the turn's trace: CoreLoop
    // attributes the intents of the turn it resolved, so the send still
    // reports start and settle and the turn's entry leaves the log through it.
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate',
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    const fake = h1.cognition as FakeCognitionLayer;
    fake.stampTurnTrace = false;
    const send: SendMessageIntent = {
      type: 'SEND_MESSAGE',
      payload: { recipientId: h1.recipientId, text: 'an untraced answer' },
    };
    fake.result = { confidence: 1, intents: [send], response: undefined };

    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.channel.sent.length === 1, 'the untraced answer went out');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'the turn settled through a send that named no turn'
    );
    await waitForSettleLogs(h1);
    expect(settleLogs(h1)[0]?.obj).toMatchObject({
      recipientId: h1.recipientId,
      outcome: 'answered',
    });

    // a graceful stop and a restart replay nothing: it was answered once
    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a THROWN agentic loop: its apology is the outcome, and a graceful restart replays nothing (review round 8)', async () => {
    const storagePath = await fresh('ctc2-realerror-');
    // The REAL agentic loop, with a provider that has nothing to say: its
    // completion throws, and the processor answers with its apology and the
    // disposition 'error' - a FAILED turn. That apology is a user-facing send
    // produced by the turn, so the turn's entry must leave the log through it.
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [],
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    await receiveMessage(h1, 'are you there?', 'u-1');

    // the apology reached the chat exactly once...
    await waitFor(() => h1.channel.sent.length === 1, 'the apology went out');
    expect(sentTexts(h1)[0]).toContain('произошла ошибка');
    // ...and it IS the turn's outcome: the entry leaves the log as a failure
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'the failed turn removed the entry instead of leaving it to replay'
    );
    await waitForSettleLogs(h1);
    const settled = settleLogs(h1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.obj).toMatchObject({ recipientId: h1.recipientId, outcome: 'failed_turn' });

    // a GRACEFUL stop and a restart: nothing replays, so no second apology
    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
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

  it('a FAILED send is an outcome: removed, warned with the reason, never retried', async () => {
    const storagePath = await fresh('ctc2-failsend-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'a doomed answer' }],
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    h1.channel.failNextSend = 'telegram is down';
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.channel.failed.length === 1, 'the send failed');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'the failed outcome removed the entry (no automatic retry)'
    );
    expect(sentTexts(h1)).toEqual([]);
    await waitForSettleLogs(h1);
    const settled = settleLogs(h1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.obj).toMatchObject({
      recipientId: h1.recipientId,
      outcome: 'failed_send',
      reason: 'returned_false',
    });

    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'never sent: the outcome was already recorded' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a send that cannot start is a failed outcome: removed, warned with its reason (finding 3)', async () => {
    const storagePath = await fresh('ctc2-nochannel-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'an undeliverable answer' }],
      drainTimeoutMs: 5_000,
      recordLogs: true,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'u-1');
    // the route still exists, but the CHANNEL is gone: the send cannot start
    expect(h1.coreLoop.unregisterChannel('test')).toBe(true);
    await waitFor(() => llmRequests(h1) === 1, 'turn ran');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 0,
      'the send that never started is a failed outcome'
    );
    await waitForSettleLogs(h1);
    const settled = settleLogs(h1);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.obj).toMatchObject({
      recipientId: h1.recipientId,
      outcome: 'failed_send',
      reason: 'channel_not_found',
    });

    await stopInboundInstance(h1);
    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'never sent' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(0);
    expect(h2.channel.sent).toEqual([]);
  });

  it('a hung send never records an outcome: nothing is settled and the message replays once', async () => {
    const storagePath = await fresh('ctc2-hungsend-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the first answer' }],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
    });
    instances.push(h1);
    h1.channel.sendGate = { promise: new Promise(() => undefined), release: () => undefined };
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.channel.sendStarted.length === 1, 'send started (now hung)');

    await stopInboundInstance(h1);
    // the send never settled -> no outcome -> the entry is still there
    expect(h1.channel.sent).toEqual([]);
    expect((await readLogSize(storagePath)).uncommitted).toBe(1);

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the redone answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the redone answer');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by its outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a send settling AFTER the stop commits nothing: the entry stays for the redo (lifemodel-ctc.1.2)', async () => {
    const storagePath = await fresh('ctc2-latesend-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the answer of the stop' }],
      drainTimeoutMs: DRAIN_DEADLINE_MS,
      recordLogs: true,
    });
    instances.push(h1);
    // The send is HELD: the stop's drain deadline cuts it loose, and the stop
    // runs to its final flush with the send still in flight.
    const gate = makeDeferred<void>();
    h1.channel.sendGate = { promise: gate.promise, release: () => gate.resolve() };
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.channel.sendStarted.length === 1, 'send started (now held)');

    await stopInboundInstance(h1);
    expect(h1.inboundLog.size().uncommitted).toBe(1);

    // NOW the send settles - after the storage flush. It must not write into a
    // storage that already shut down: the outcome is refused and the message
    // stays for the next start (the same window as a crash between the answer
    // and its removal).
    gate.resolve();
    await waitForLog(h1, 'nothing is written after it');
    expect(h1.inboundLog.size().uncommitted).toBe(1);
    expect((await readLogSize(storagePath)).uncommitted).toBe(1);

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the answer after the redo' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('the answer after the redo');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by its outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a turn that rejects records no outcome: its entry replays once after the restart', async () => {
    const storagePath = await fresh('ctc2-reject-');
    // the fake cognition boundary rejects its turn - the core paths under
    // test (no outcome on rejection, replay once) do not depend on the LLM
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'hang',
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'hello there', 'u-1');
    await waitFor(() => h1.cognition.calls.length === 1, 'turn started');
    (h1.cognition as FakeCognitionLayer).rejectAll(new Error('the turn exploded'));
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 1,
      'the rejected turn left its entry in the log'
    );

    await stopInboundInstance(h1);

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'answered on redo' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('answered on redo');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'removed by its outcome');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
  });

  it('a message absorbed into a turn that never completes is answered after restart', async () => {
    const storagePath = await fresh('ctc2-absorb-');
    const h1 = await startInboundInstance(storagePath, {
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
    // both entries are in the log, neither settled (the turn has no outcome)
    expect(h1.inboundLog.size()).toEqual({ total: 2, uncommitted: 2 });

    await stopInboundInstance(h1);

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'one answer for both' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    // both messages replay in order and are answered by ONE turn
    await waitFor(() => h2.channel.sent.length === 1, 'answered after restart');
    expect(h2.channel.sent[0]?.text).toContain('one answer for both');
    await waitFor(() => h2.inboundLog.size().uncommitted === 0, 'both entries removed');
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(llmRequests(h2)).toBe(1);
    expect(sentTexts(h2)).toHaveLength(1);
  });

  it('a turn owns ONLY the recipient it answers: the bundled other recipient gets its own turn (finding 2)', async () => {
    const storagePath = await fresh('ctc2-two-recv-');
    // SLOW first tick: both messages are queued (and logged) before the
    // turn starts, so the wake BUNDLES one message per recipient.
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'the answer for the first' }, { content: 'the answer for the second' }],
      drainTimeoutMs: 5_000,
      tickIntervalMs: 500,
      recordLogs: true,
    });
    instances.push(h1);
    const otherRecipientId = h1.registry.getOrCreate('test', 'chat-43');
    await receiveMessage(h1, 'message for the first recipient', 'u-1');
    await h1.channel.emit(
      createUserMessageSignal({
        text: 'message bundled with the first',
        recipientId: otherRecipientId,
      })
    );
    await waitFor(() => h1.inboundLog.size().total === 2, 'both messages logged');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');

    // The turn answers the FIRST recipient only; the bundled message of the
    // other recipient is NOT served by it - requeued for its own turn, its
    // entry still in the log.
    expect(triggerRecipientOf(h1, 0)).toBe(h1.recipientId);
    await waitFor(() => h1.coreLoop.pendingSignalCount() === 1, 'the other message is requeued');
    expect(h1.inboundLog.size().uncommitted).toBe(2);

    h1.cognition.settleHangingTurn();
    (h1.cognition as { hang: boolean }).hang = false;

    // Each recipient's own turn settles only its own entries.
    await waitFor(() => llmRequests(h1) === 2, 'the second recipient got its own turn');
    expect(triggerRecipientOf(h1, 1)).toBe(otherRecipientId);
    await waitFor(() => h1.channel.sent.length === 2, 'both answered');
    await waitFor(() => h1.inboundLog.size().uncommitted === 0, 'both entries removed');
    await waitForSettleLogs(h1, 2);
    const settledRecipients = settleLogs(h1).map((l) => l.obj['recipientId']);
    expect(settledRecipients.sort()).toEqual([h1.recipientId, otherRecipientId].sort());
  });

  it('a message absorbed DURING the stop drain keeps its turn; the answer settles it (finding 9)', async () => {
    const storagePath = await fresh('ctc2-drainabsorb-');
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'the drained answer' }],
      drainTimeoutMs: 2_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'the first message', 'u-1');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');

    const stopping = stopInboundInstance(h1);
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
      'trigger AND mid-drain absorbed message removed: the immediate send kept the turn attribution'
    );

    const h2 = await startInboundInstance(storagePath, {
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

  it('a real core.say send during the stop drain keeps the turn and settles it (finding 9)', async () => {
    const storagePath = await fresh('ctc2-drainsay-');
    const h1 = await startInboundInstance(storagePath, {
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

    const stopping = stopInboundInstance(h1);
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
    // neither entry could ever settle
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
      'trigger AND mid-drain absorbed message removed: the immediate core.say send kept the turn attribution'
    );

    // nothing left to replay: the restart runs no turn and sends nothing
    const h2 = await startInboundInstance(storagePath, {
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

  it('a new question whose answer repeats the last one is SENT all the same (lifemodel-q4f)', async () => {
    const storagePath = await fresh('ctc2-duptext-');
    // the new question is logged; the process dies before answering it
    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    await receiveMessage(h1, 'tell me something', 'u-1');
    await die(h1);
    // an earlier answer with EXACTLY the text this question will get: it
    // answers a DIFFERENT message, so the duplicate guard must not touch it -
    // the same words are the right answer to a question never answered before
    await seedAssistantAnswer(storagePath, 'the very same answer', h1.recipientId);

    const h2 = await startInboundInstance(storagePath, {
      cognitionMode: 'real-scripted',
      hang: false,
      script: [{ content: 'the very same answer' }],
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.channel.sent.length === 1, 'the replayed question is answered');
    // ...and it really reached the channel: no guard stopped it
    expect(sentTexts(h2)).toEqual([expect.stringContaining('the very same answer')]);
    expect(h2.channel.sendStarted).toHaveLength(1);
    await waitFor(
      () => h2.inboundLog.size().uncommitted === 0,
      'the sent answer settles its entry'
    );
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance ran ticks');
    expect(llmRequests(h2)).toBe(1);

    // the answer is the last assistant message now, so a graceful restart
    // neither replays the entry nor answers the question twice
    await stopInboundInstance(h2);
    const h3 = await startInboundInstance(storagePath, {
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

  it('a proactive repeat of the last assistant message is still suppressed (lifemodel-q4f)', async () => {
    const storagePath = await fresh('q4f-proactive-');
    // the last thing the agent said, in an EARLIER session: a proactive turn
    // that would repeat it verbatim answers no inbound message, so the guard
    // holds - a user must not be told the same thing twice
    const recipientId = harnessRecipientId();
    const text = 'the proactive line';
    await seedAssistantAnswer(storagePath, text, recipientId);

    const h1 = await startInboundInstance(storagePath, {
      cognitionMode: 'immediate',
      recordLogs: true,
      drainTimeoutMs: 5_000,
    });
    instances.push(h1);
    // the seeded recipient is the one this instance answers (no coupling
    // asserted by hand: the same channel+destination the harness registers)
    expect(h1.recipientId).toBe(recipientId);
    const fake = h1.cognition as FakeCognitionLayer;
    const proactive = (body: string): void => {
      const send: SendMessageIntent = {
        type: 'SEND_MESSAGE',
        payload: { recipientId: h1.recipientId, text: body },
      };
      fake.result = { confidence: 1, intents: [send], response: undefined };
    };

    // a proactive turn repeating the seeded last assistant message: stopped
    // before the channel, and reported as a skip, never as a failure
    proactive(text);
    h1.coreLoop.pushSignal(thoughtSignal('proactive 1', h1.recipientId));
    await waitFor(
      () =>
        h1.recordedLogs.some(
          (l) => typeof l.msg === 'string' && l.msg.includes('Skipping duplicate message')
        ),
      'the duplicate guard stopped the proactive repeat'
    );
    expect(h1.channel.sendStarted).toEqual([]);
    expect(h1.channel.sent).toEqual([]);

    // the same proactive turn with different words goes out: the guard is
    // about the TEXT, not about proactive sends in general
    proactive('a different proactive line');
    h1.coreLoop.pushSignal(thoughtSignal('proactive 2', h1.recipientId));
    await waitFor(() => h1.channel.sent.length === 1, 'the new proactive message went out');
    expect(sentTexts(h1)).toEqual([expect.stringContaining('a different proactive line')]);
  });
});
