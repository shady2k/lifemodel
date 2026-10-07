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

import { FakeCognitionLayer } from '../helpers/core-loop-drain-harness.js';
import {
  startInboundInstance,
  stopInboundInstance,
  receiveMessage,
  readLogSize,
  freshScratch,
  waitFor,
  llmRequests,
  SETTLE_TICKS,
  type InboundInstance,
} from '../helpers/inbound-log-harness.js';
import { openStorage } from '../helpers/core-loop-drain-harness.js';

const DRAIN_DEADLINE_MS = 150;

const scratchRoots: { storagePath: string; logDir: string }[] = [];
const instances: InboundInstance[] = [];

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

describe('durable inbound log (lifemodel-ctc.2.1)', () => {
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
    await waitFor(() => h1.coreLoop.isRunning() && h1.inboundLog.size().uncommitted === 1, 'not committed');

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

  it('a turn that answers nothing (deferral) commits its entry: no endless replay', async () => {
    const { storagePath, logDir } = await fresh('ctc2-defer-');
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'immediate', // the fake turn settles with NO intents
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
      drainTimeoutMs: 5_000,
    });
    instances.push(h2);
    await waitFor(() => h2.autonomic.ticks() >= SETTLE_TICKS, 'instance 2 ran ticks');
    expect(h2.cognition.calls.length).toBe(0);
    expect(h2.inboundLog.size()).toEqual({ total: 1, uncommitted: 0 });
  });

  it("per-recipient offsets: one recipient's failed send does not replay the other", async () => {
    const { storagePath, logDir } = await fresh('ctc2-two-recv-');
    // SLOW first tick: both messages are queued (and logged) before the
    // turn starts, so ONE wake owns them - one per recipient.
    const h1 = await startInboundInstance(storagePath, logDir, {
      cognitionMode: 'real-scripted',
      hang: true,
      script: [{ content: 'one answer, one silence' }],
      drainTimeoutMs: 5_000,
      tickIntervalMs: 500,
    });
    instances.push(h1);
    const otherRecipientId = h1.registry.getOrCreate('test', 'chat-43');
    await receiveMessage(h1, 'message that gets a failing answer', 'u-1');
    await h1.channel.emit(
      createUserMessageSignal({
        text: 'message that needs no reply',
        recipientId: otherRecipientId,
      })
    );
    await waitFor(() => h1.inboundLog.size().total === 2, 'both messages logged');
    await waitFor(() => llmRequests(h1) === 1, 'turn started (LLM held)');
    h1.cognition.settleHangingTurn();

    // the single send (to the first trigger's recipient) FAILS
    h1.channel.failNextSend = 'telegram is down';
    await waitFor(() => h1.channel.failed.length === 1, 'the send failed');
    await waitFor(
      () => h1.inboundLog.size().uncommitted === 1,
      'only the failed recipient stays uncommitted'
    );

    await stopInboundInstance(h1, await openStorage(storagePath), storagePath);
    instances.pop();

    // the no-reply recipient's entry was committed; only the failed one replays
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
});
