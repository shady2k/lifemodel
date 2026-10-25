import { describe, expect, it, vi } from 'vitest';
import type { TaskOutcomeEvent, TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import { createTaskFinalizer } from '../../src/core/task-finalize.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';

const event: TaskOutcomeEvent = {
  taskId: 'task_relay_failure',
  outcomeKey: 'outcome_relay_failure',
  state: 'done',
  reasonCode: 'completed',
  summary: 'Finished',
  objects: [],
};

describe('task finalizer disposable diagnostics', () => {
  it.each(['append', 'mark'] as const)(
    'settles and retries an outcome %s failure without awaiting an extra registry read',
    async (failure) => {
      const diagnosticRead = Promise.withResolvers<TaskRecord | null>();
      const read = vi.fn(() => diagnosticRead.promise);
      const appendTaskSignal = vi.fn(async () => '1-0');
      const markOutcomeSignalled = vi.fn(async () => undefined);
      if (failure === 'append') appendTaskSignal.mockRejectedValueOnce(new Error('append failed'));
      else markOutcomeSignalled.mockRejectedValueOnce(new Error('mark failed'));
      const registry = {
        listFinalizationWork: async () => [],
        listOutcomeWork: async () => [event],
        markOutcomeSignalled,
        read,
      } as unknown as TaskRegistry;
      const logs: RecordedLog[] = [];
      const finalizer = createTaskFinalizer({
        registry,
        executor: createFakeTaskExecutor(),
        mailbox: { readTerminal: async () => null },
        storage: { allocate: vi.fn(), seal: vi.fn(), close: vi.fn() },
        bus: { appendTaskSignal },
        logger: recordingLogger(createTestLogger(), logs),
      });
      const pass = finalizer.runOnce();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          pass,
          new Promise<'deadline'>((resolve) => {
            deadline = setTimeout(() => resolve('deadline'), 100);
          }),
        ]);
        expect(result, 'relay failure must settle while diagnostic reads remain unsettled').toBe(
          false
        );
        expect(read).not.toHaveBeenCalled();
        expect(logs).toContainEqual({
          level: 'warn',
          obj: { taskId: event.taskId, code: 'outcome_relay_pending', count: 1 },
          msg: 'Task outcome relay remains pending',
        });
        expect(await finalizer.runOnce()).toBe(true);
        expect(appendTaskSignal).toHaveBeenCalledTimes(2);
        expect(markOutcomeSignalled).toHaveBeenCalledTimes(failure === 'append' ? 1 : 2);
      } finally {
        clearTimeout(deadline);
        diagnosticRead.resolve(null);
        await pass;
        await finalizer.stop();
      }
    }
  );
});
