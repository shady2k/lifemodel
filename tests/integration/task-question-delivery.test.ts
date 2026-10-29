import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { createSnapshotStore, type SnapshotOutboxEvent } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { createSignal } from '../../src/types/signal.js';
import { createSteerTaskTool } from '../../src/layers/cognition/tools/core/steer-task.js';
import type { TaskService } from '../../src/ports/tasks.js';
import type { RealCognitionFacade } from '../helpers/core-loop-real-cognition.js';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  stopInstance,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

const question = {
  taskId: 'task_question_relay',
  attemptId: 'attempt_1',
  questionId: 'question_17',
  text: 'Which destination should I use?',
  answerCommandId: null,
};
const relay = `Task ${question.taskId}, question ${question.questionId}: ${question.text}`;
const empty = { content: '{"response":""}' };

describe('task question owner delivery', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it.each([
    'tools-only',
    'empty',
    'relayed',
    'said',
    'ack-only',
    'provider-error',
    'answered',
    'refused-answer',
    'retry',
  ] as const)('commits an owner relay unless already relayed or answered (%s)', async (mode) => {
    const prefix = `question-relay:${mode}:${stores.workerId}:${Date.now()}:`;
    const store = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    store.register(bus);
    const epoch = await store.takeEpoch();
    const path = await makeScratchDir('question-relay-');
    let failBeforeCommit = mode === 'retry';
    let attempted: SnapshotOutboxEvent[] = [];
    let saved = bus.exportSnapshot();
    const start = async () => {
      const script =
        mode === 'provider-error'
          ? []
          : mode === 'relayed'
            ? [{ content: JSON.stringify({ response: relay }) }]
            : mode === 'empty'
              ? [empty, empty, empty, empty]
              : [
                  {
                    toolCalls: [
                      mode === 'said' || mode === 'ack-only'
                        ? {
                            name: 'core.say',
                            args: { text: mode === 'said' ? relay : 'Checking the task.' },
                          }
                        : mode === 'answered' || mode === 'refused-answer'
                          ? {
                              name: 'core.steerTask',
                              args: {
                                action: 'answer',
                                taskId: question.taskId,
                                questionId: question.questionId,
                                text: 'Use the destination the owner already named.',
                              },
                            }
                          : { name: 'core.time', args: { action: 'now' } },
                    ],
                  },
                  empty,
                  empty,
                  empty,
                  empty,
                ];
      const h = await startInstance(path, {
        cognitionMode: 'real-scripted',
        hang: true,
        script,
        busSignalStream: bus,
        commitSnapshot: async (tick, events) => {
          if (failBeforeCommit && events.length) {
            attempted = structuredClone(events);
            failBeforeCommit = false;
            throw new Error('crash before question relay CAS');
          }
          await store.commitOwners(epoch, tick, events);
          saved = bus.exportSnapshot();
        },
      });
      h.coreLoop.setTaskQuestionReader(async () => question);
      const cognition = h.cognition as unknown as RealCognitionFacade;
      cognition.processor.getToolRegistry().registerTool(
        createSteerTaskTool({
          readCommand: async () => null,
          answer: async () => {
            if (mode === 'refused-answer') {
              const { TaskChannelError } = await import('../../src/ports/task-channel.js');
              throw new TaskChannelError(409, 'question_absent');
            }
            return { taskId: question.taskId, commandId: 'answer_1' };
          },
        } as unknown as TaskService)
      );
      cognition.hang = false;
      cognition.settleHangingTurn();
      return h;
    };
    const id = await bus.appendTaskSignal(
      createSignal(
        'task_report',
        'task.mailbox',
        { value: 1 },
        {
          data: {
            kind: 'task_report',
            taskId: question.taskId,
            attemptId: question.attemptId,
            messageId: question.questionId,
            eventKind: 'question',
          },
        }
      ),
      question.questionId
    );
    let h = await start();
    try {
      if (mode === 'retry') {
        await waitFor(() => !h.coreLoop.isRunning(), 'crash before relay commit');
        expect(attempted).toHaveLength(1);
        await store.hydrate(await store.read());
        h = await start();
      }
      await waitFor(() => saved.watermark === id, 'question outcome committed');
      const rows = await stores.redis.xrange(`${prefix}outbound`, '-', '+');
      expect(rows).toHaveLength(mode === 'answered' ? 0 : mode === 'ack-only' ? 2 : 1);
      if (mode !== 'answered') {
        const fields = rows.at(-1)![1];
        const event = JSON.parse(fields[fields.indexOf('event') + 1]!);
        expect(event.payload.text).toContain(question.text);
        expect(event.payload.text).toContain(question.questionId);
        expect(event.payload.text).toContain(question.taskId);
        if (mode === 'relayed') expect(event.payload.text).toBe(relay);
        if (mode === 'retry') expect(event.eventId).toBe(attempted[0]!.eventId);
      }
      await stopInstance(h);
      await store.hydrate(await store.read());
      const before = saved;
      h = await start();
      await waitFor(() => saved !== before, 'restart commits without replaying question');
      expect(h.cognition.calls).toHaveLength(0);
      expect(await stores.redis.xlen(`${prefix}outbound`)).toBe(rows.length);
    } finally {
      h.coreLoop.haltForTest();
      await rmDir(path);
    }
  });
});
