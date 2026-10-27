import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpTaskHarness } from '../../loader/src/task-acp.js';
import {
  ScriptedTaskHarness,
  type TaskHarnessEvent,
  type TaskQuestionState,
  type TaskEndTurnInput,
  type TaskEndTurnReconciliation,
} from '../../loader/src/task-harness.js';
import { TaskSteeringJournal } from '../../loader/src/task-steering-journal.js';
import { failOnUncertain as primePolicy } from '../../loader/src/task-prime-agent.js';
import { failOnUncertain as openCodePolicy } from '../../loader/src/task-opencode.js';
import { createStorageCertificate } from '../helpers/storage-certificate.js';

// Lifecycle faults use the scripted ACP process. Real adapter behavior lives in
// the shared contract suite; these tests isolate cleanup and callback failures.
describe('steering lifecycle', () => {
  it('the in-process scripted port dedupes steering and stops admitting on abort', async () => {
    const events: TaskHarnessEvent[] = [];
    const harness = new ScriptedTaskHarness({
      waitForAbort: true,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const terminal = harness.start({ text: 'brief', model: 'task' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const command = { commandId: 'cmd', text: 'continue' };
    expect(await harness.steer(command)).toBe('accepted');
    expect(await harness.steer(command)).toBe('accepted');
    expect(await harness.steer({ ...command, text: 'conflict' })).toBe('rejected');
    await harness.abort();
    expect(await terminal).toMatchObject({ outcome: 'aborted' });
    expect(await harness.steer(command)).toBe('rejected');
    expect(events.filter((event) => event.type === 'receipt')).toEqual([
      { type: 'receipt', commandId: 'cmd', disposition: 'inserted' },
    ]);
  });

  it('does not finish while an admitted native call is in flight, and late uncertainty overrides success', async () => {
    const certificate = await createStorageCertificate(['localhost']);
    const work = await mkdtemp(join(tmpdir(), 'steering-lifecycle-'));
    await writeFile(join(work, 'ca'), certificate.ca);
    await writeFile(join(work, 'token'), 'test-only');
    let reached!: () => void;
    const running = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let barrierReached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      barrierReached = resolve;
    });
    let finishSend!: (value: 'uncertain') => void;
    const send = vi.fn((command: { commandId: string }) =>
      command.commandId === 'too-early'
        ? Promise.resolve('accepted' as const)
        : new Promise<'uncertain'>((resolve) => {
            finishSend = resolve;
          })
    );
    const harness = new AcpTaskHarness({
      workDirectory: work,
      modelEndpoint: 'https://localhost:1',
      modelCaFile: join(work, 'ca'),
      modelTokenFile: join(work, 'token'),
      timeoutMs: 10000,
      agent: {
        label: 'Scripted',
        protocol: 'acp',
        command: 'python3',
        args: [resolve('tests/fixtures/task-scripted-acp.py'), 'success'],
        configFile: '',
        version: '',
        versionOutput: '',
        versionArgs: [],
        adapterModule: '',
      },
      configure: () => ({}),
      admit: send,
      failOnUncertain: true,
      onEvent: async (event) => {
        if (event.type === 'step' && event.text === 'Settling task turn') barrierReached();
        if (event.type === 'step' && event.text === 'Running task') {
          expect(await harness.steer({ commandId: 'too-early', text: 'alone' })).toBe('rejected');
          expect(send).not.toHaveBeenCalled();
        }
        if (event.type === 'step' && event.text === 'Task is working') {
          reached();
          await startedSend;
        }
      },
    });
    let allowPrompt!: () => void;
    const startedSend = new Promise<void>((resolve) => {
      allowPrompt = resolve;
    });
    let completed = false;
    const terminal = harness.start({ text: 'brief', model: 'task' }).then((result) => {
      completed = true;
      return result;
    });
    try {
      await Promise.race([
        running,
        terminal.then((result) => {
          throw new Error(`finished_before_prompt:${result.reasonCode}`);
        }),
      ]);
      const steering = harness.steer({ commandId: 'cmd', text: 'continue' });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      allowPrompt();
      // Wait for closure, then check rejection without creating another flight.
      await barrier;
      expect(await harness.steer({ commandId: 'after-close', text: 'late' })).toBe('rejected');
      expect(completed).toBe(false);
      finishSend('uncertain');
      expect(await steering).toBe('uncertain');
      expect(await terminal).toMatchObject({ outcome: 'failed', reasonCode: 'steer_uncertain' });
    } finally {
      allowPrompt();
      finishSend?.('uncertain');
      await harness.abort();
      await terminal;
      await rm(work, { recursive: true, force: true });
      certificate.cleanup();
    }
  }, 15000);
  it.each([
    { name: 'OpenCode', policy: openCodePolicy, expected: 'succeeded' },
    { name: 'Prime', policy: primePolicy, expected: 'failed' },
  ])(
    '$name owns its native-ambiguity policy',
    async ({ policy, expected }) => {
      await runFaultCase({ policy, disposition: 'uncertain', expected });
    },
    15000
  );

  it.each([openCodePolicy, primePolicy])(
    'journal I/O fails even under policy %s',
    async (policy) => {
      await runFaultCase({
        policy,
        diskFailure: true,
        disposition: 'accepted',
        expected: 'failed',
      });
    },
    15000
  );

  it('a stalled insertion-receipt sink does not fail task cleanup', async () => {
    await runFaultCase({
      policy: primePolicy,
      receiptSinkStalls: true,
      disposition: 'accepted',
      expected: 'succeeded',
    });
  }, 15000);

  it('an insertion observer error never aborts a running turn', async () => {
    await runFaultCase({
      policy: primePolicy,
      observerError: true,
      disposition: 'accepted',
      expected: 'succeeded',
    });
  }, 15000);
});

async function runFaultCase(input: {
  policy: boolean;
  disposition: 'accepted' | 'uncertain';
  expected: string;
  diskFailure?: boolean;
  observerError?: boolean;
  receiptSinkStalls?: boolean;
}): Promise<void> {
  const certificate = await createStorageCertificate(['localhost']);
  const work = await mkdtemp(join(tmpdir(), 'steering-fault-'));
  await writeFile(join(work, 'ca'), certificate.ca);
  await writeFile(join(work, 'token'), 'test-only');
  let reached!: () => void;
  const working = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const events: TaskHarnessEvent[] = [];
  const release = vi.fn();
  const observer = vi.fn(async () => {
    throw new Error('unreadable history');
  });
  const send = vi.fn(async () => input.disposition);
  const open = TaskSteeringJournal.open.bind(TaskSteeringJournal);
  const spy = vi.spyOn(TaskSteeringJournal, 'open').mockImplementation(async (...args) => {
    const journal = await open(...args);
    if (input.diskFailure) {
      const handle = (journal as unknown as { file: import('node:fs/promises').FileHandle }).file;
      vi.spyOn(handle, 'sync').mockRejectedValue(new Error('disk full'));
    }
    return journal;
  });
  const harness = new AcpTaskHarness({
    workDirectory: work,
    modelEndpoint: 'https://localhost:1',
    modelCaFile: join(work, 'ca'),
    modelTokenFile: join(work, 'token'),
    timeoutMs: 10000,
    agent: {
      label: 'Scripted',
      protocol: 'acp',
      command: 'python3',
      args: [resolve('tests/fixtures/task-scripted-acp.py'), 'success'],
      configFile: '',
      version: '',
      versionOutput: '',
      versionArgs: [],
      adapterModule: '',
    },
    configure: () => ({}),
    admit: send,
    release,
    failOnUncertain: input.policy,
    reconcileEndTurn: async () => ({ state: 'idle' }),
    ...(input.observerError
      ? { observeInsertion: observer }
      : input.receiptSinkStalls
        ? { observeInsertion: async () => true }
        : {}),
    onEvent: async (event) => {
      events.push(event);
      if (input.receiptSinkStalls && event.type === 'receipt') return new Promise<void>(() => {});
      if (event.type === 'step' && event.text === 'Running task') {
        expect(await harness.steer({ commandId: 'early', text: 'wrong turn' })).toBe('rejected');
      }
      if (event.type === 'step' && event.text === 'Task is working') {
        reached();
        await gate;
      }
    },
  });
  const terminal = harness.start({ text: 'brief', model: 'task' });
  try {
    await Promise.race([
      working,
      terminal.then((result) => {
        throw new Error(`finished_before_prompt:${result.reasonCode}`);
      }),
    ]);
    // An ordinary tool's TMPDIR cleanup must not remove launcher files.
    for (const name of await readdir(join(work, 'tmp')))
      await rm(join(work, 'tmp', name), { recursive: true, force: true });
    const disposition = await harness.steer({ commandId: 'cmd', text: 'continue' });
    expect(disposition).toBe(input.diskFailure ? 'uncertain' : input.disposition);
    expect(send).toHaveBeenCalledTimes(input.diskFailure ? 0 : 1);
    if (input.observerError) {
      await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
      expect(events.filter((event) => event.type === 'receipt')).toEqual([]);
    }
    if (input.receiptSinkStalls) {
      await vi.waitFor(() => expect(events.some((event) => event.type === 'receipt')).toBe(true));
      // Cleanup must bound this callback without changing task success.
    }
    resume();
    expect(await terminal).toMatchObject({
      outcome: input.expected,
      ...(input.expected === 'failed' ? { reasonCode: 'steer_uncertain' } : {}),
    });
    expect(release).toHaveBeenCalledWith({ workDirectory: work, sessionId: 'scripted-session' });
  } finally {
    resume();
    await harness.abort();
    await terminal;
    spy.mockRestore();
    vi.restoreAllMocks();
    await rm(work, { recursive: true, force: true });
    certificate.cleanup();
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function barrierFixture(input: {
  admit?: (command: {
    commandId: string;
    text: string;
  }) => Promise<'accepted' | 'rejected' | 'uncertain'>;
  reconcile?: (input: TaskEndTurnInput) => Promise<TaskEndTurnReconciliation>;
  question?: TaskQuestionState;
  onEvent?: (event: TaskHarnessEvent) => void | Promise<void>;
}) {
  const certificate = await createStorageCertificate(['localhost']);
  const work = await mkdtemp(join(tmpdir(), 'barrier-race-'));
  await writeFile(join(work, 'ca'), certificate.ca);
  await writeFile(join(work, 'token'), 'test');
  const harness = new AcpTaskHarness({
    workDirectory: work,
    modelEndpoint: 'https://localhost:1',
    modelCaFile: join(work, 'ca'),
    modelTokenFile: join(work, 'token'),
    timeoutMs: 10000,
    agent: {
      label: 'Scripted',
      protocol: 'acp',
      command: 'python3',
      args: [resolve('tests/fixtures/task-scripted-acp.py'), 'barrier-gated'],
      configFile: '',
      version: '',
      versionOutput: '',
      versionArgs: [],
      adapterModule: '',
    },
    configure: () => ({}),
    admit: input.admit ?? (async () => 'accepted'),
    reconcileEndTurn: input.reconcile ?? (async () => ({ state: 'idle' })),
    question: input.question,
    onEvent: input.onEvent,
  });
  const terminal = harness.start({ text: 'brief', model: 'task' });
  await vi.waitFor(() => access(join(work, 'prompt-tail')));
  return {
    harness,
    terminal,
    work,
    release: () => writeFile(join(work, 'release-prompt'), ''),
    cleanup: async () => {
      await harness.abort();
      await terminal;
      await rm(work, { recursive: true, force: true });
      certificate.cleanup();
    },
  };
}

describe('end-turn barrier race regressions', () => {
  it('maps unknown reconciliation to end_turn_uncertain, never successful prose', async () => {
    const f = await barrierFixture({ reconcile: async () => ({ state: 'unknown' }) });
    try {
      await f.release();
      expect(await f.terminal).toMatchObject({
        outcome: 'failed',
        reasonCode: 'end_turn_uncertain',
      });
    } finally {
      await f.cleanup();
    }
  });

  it.each(['continue', 'successor'] as const)(
    'settles an accepted admission after reply dispatch before %s reconciliation',
    async (state) => {
      const native = deferred<'accepted'>();
      const entered = deferred();
      const barrier = deferred();
      const reconciled = vi.fn(
        async (input: TaskEndTurnInput): Promise<TaskEndTurnReconciliation> => {
          // The first reconciliation must include the late ACK, not declare idle.
          if (reconciled.mock.calls.length === 1) {
            expect(input.commandIds).toEqual(['cmd']);
            if (!input.commandIds.length) return { state: 'idle' };
            return state === 'continue'
              ? { state, commandIds: ['cmd'] }
              : {
                  state,
                  wait: async (control) => {
                    await control.closeIntake();
                    return {
                      updates: [{ kind: 'text', text: 'Successor result' }],
                      stopReason: 'end_turn',
                    };
                  },
                };
          }
          return { state: 'idle' };
        }
      );
      const events: TaskHarnessEvent[] = [];
      const f = await barrierFixture({
        admit: async () => {
          entered.resolve();
          return native.promise;
        },
        reconcile: reconciled,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'step' && event.text === 'Settling task turn') barrier.resolve();
        },
      });
      try {
        const sending = f.harness.steer({ commandId: 'cmd', text: 'late' });
        await entered.promise;
        await f.release();
        await barrier.promise;
        // Give the barrier a full event-loop pass with native admission held.
        await new Promise<void>((done) => setImmediate(done));
        expect(reconciled).not.toHaveBeenCalled();
        native.resolve('accepted');
        expect(await sending).toBe('accepted');
        expect(await f.terminal).toMatchObject({
          outcome: 'succeeded',
          result: state === 'continue' ? 'First result' : 'Successor result',
        });
        expect(reconciled).toHaveBeenCalledTimes(2);
        if (state === 'continue')
          expect(events).toContainEqual({
            type: 'receipt',
            commandId: 'cmd',
            disposition: 'deferred-to-next-turn',
          });
      } finally {
        native.resolve('accepted');
        await f.cleanup();
      }
    }
  );

  it('emits progress for adapter-neutral successor tools and only keeps the last final text', async () => {
    let first = true;
    const events: TaskHarnessEvent[] = [];
    const f = await barrierFixture({
      reconcile: async () => {
        if (!first) return { state: 'idle' };
        first = false;
        return {
          state: 'successor',
          wait: async (control) => {
            await control.closeIntake();
            return {
              stopReason: 'end_turn',
              updates: [
                { kind: 'text', text: 'Earlier successor final' },
                { kind: 'reset' },
                { kind: 'tool', id: 'native-tool', status: 'in_progress', input: {} },
                { kind: 'tool', id: 'native-tool', status: 'completed', output: [] },
                { kind: 'text', text: 'Last final' },
              ],
            };
          },
        };
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      await f.release();
      expect(await f.terminal).toMatchObject({ outcome: 'succeeded', result: 'Last final' });
      expect(events.filter((event) => event.type === 'tool')).toEqual([
        { type: 'tool', name: 'task_tool', status: 'running' },
        { type: 'tool', name: 'task_tool', status: 'completed' },
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it('closed intake joins an in-flight replay and returns the stored disposition without another send', async () => {
    const native = deferred<'accepted'>();
    const entered = deferred();
    const barrier = deferred();
    const releaseReconcile = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      return native.promise;
    });
    const f = await barrierFixture({
      admit: send,
      reconcile: async () => {
        await releaseReconcile.promise;
        return { state: 'idle' };
      },
      onEvent: (event) => {
        if (event.type === 'step' && event.text === 'Settling task turn') barrier.resolve();
      },
    });
    const command = { commandId: 'cmd', text: 'same text' };
    try {
      const first = f.harness.steer(command);
      await entered.promise;
      await f.release();
      await barrier.promise;
      let replaySettled = false;
      const replay = f.harness.steer(command).then((value) => {
        replaySettled = true;
        return value;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(replaySettled).toBe(false);
      expect(await f.harness.steer({ ...command, text: 'conflict' })).toBe('rejected');
      expect(await f.harness.steer({ commandId: 'new', text: 'new' })).toBe('rejected');
      native.resolve('accepted');
      expect(await first).toBe('accepted');
      expect(await replay).toBe('accepted');
      expect(await f.harness.steer(command)).toBe('accepted');
      expect(send).toHaveBeenCalledOnce();
      releaseReconcile.resolve();
      expect(await f.terminal).toMatchObject({ outcome: 'succeeded' });
    } finally {
      native.resolve('accepted');
      releaseReconcile.resolve();
      await f.cleanup();
    }
  });

  it('fails uncertain if the question closes without admitted answer text', async () => {
    let open = true;
    const change = deferred();
    const f = await barrierFixture({
      question: { isOpen: () => open, waitForChange: () => change.promise },
      onEvent: (event) => {
        if (event.type === 'step' && event.text === 'Waiting for task answer') {
          open = false;
          change.resolve();
        }
      },
    });
    try {
      await f.release();
      expect(await f.terminal).toMatchObject({
        outcome: 'failed',
        reasonCode: 'end_turn_uncertain',
      });
    } finally {
      await f.cleanup();
    }
  });

  it('does not lose an admission completed by the waiting event before wait subscription', async () => {
    let open = true;
    let f!: Awaited<ReturnType<typeof barrierFixture>>;
    const wait = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }))
    );
    const fReady = deferred();
    f = await barrierFixture({
      question: { isOpen: () => open, waitForChange: wait },
      onEvent: async (event) => {
        if (event.type === 'step' && event.text === 'Waiting for task answer') {
          await fReady.promise;
          expect(await f.harness.steer({ commandId: 'answer', text: 'answer' })).toBe('accepted');
          open = false;
        }
      },
    });
    fReady.resolve();
    try {
      await f.release();
      expect(await f.terminal).toMatchObject({ outcome: 'succeeded' });
    } finally {
      await f.cleanup();
    }
  });

  it('rate limits a question seam that resolves immediately without a change', async () => {
    const wait = vi.fn(async () => {});
    const waiting = deferred();
    const f = await barrierFixture({
      question: { isOpen: () => true, waitForChange: wait },
      onEvent: (event) => {
        if (event.type === 'step' && event.text === 'Waiting for task answer') waiting.resolve();
      },
    });
    try {
      await f.release();
      await waiting.promise;
      await new Promise<void>((done) => setTimeout(done, 250));
      expect(wait.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      await f.cleanup();
    }
  });
});
