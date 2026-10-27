import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpTaskHarness } from '../../loader/src/task-acp.js';
import { ScriptedTaskHarness, type TaskHarnessEvent } from '../../loader/src/task-harness.js';
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
    let finishSend!: (value: 'uncertain') => void;
    const send = vi.fn(
      () =>
        new Promise<'uncertain'>((resolve) => {
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
      onEvent: async (event) => {
        if (event.type === 'step' && event.text === 'Running task') {
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
      await running;
      const steering = harness.steer({ commandId: 'cmd', text: 'continue' });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      allowPrompt();
      // Wait for the actual journal close boundary, not an assumed tick count.
      await vi.waitFor(() =>
        expect((harness as unknown as { steering?: unknown }).steering).toBeUndefined()
      );
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
});
