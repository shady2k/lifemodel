import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpTaskHarness } from '../../loader/src/task-acp.js';
import { ScriptedTaskHarness, type TaskHarnessEvent } from '../../loader/src/task-harness.js';
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
