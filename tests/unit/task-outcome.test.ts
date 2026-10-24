import { describe, expect, it } from 'vitest';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';
import { taskOutcomeFallback, validateTaskOutcome } from '../../src/ports/task-outcome.js';

describe('task outcome fallback', () => {
  it.each(['constructor', 'unknown_failure'])(
    'uses the fixed generic explanation for allowed unknown reason code %s',
    (reasonCode) => {
      const summary = 'The task could not finish.';
      expect(
        validateTaskChannelFrame({
          taskId: 'task-1',
          attemptId: 'attempt-1',
          direction: 'task_to_core',
          messageId: 'message-1',
          sequence: 1,
          kind: 'terminal',
          payload: {
            outcome: 'failed',
            reasonCode,
            summary,
            resultObjectId: null,
            logObjectId: null,
            artifactObjectIds: [],
          },
        })
      ).toMatchObject({ payload: { reasonCode } });
      const outcome = validateTaskOutcome({
        taskId: 'task-1',
        outcomeKey: 'outcome_task-1',
        state: 'failed',
        reasonCode,
        summary,
        objects: [],
      });

      expect(taskOutcomeFallback(outcome)).toBe(
        'Task failed. The task ended without a more specific explanation.\n' +
          'Task output (quoted): "The task could not finish."\n' +
          'No completed result is available.'
      );
    }
  );
});
