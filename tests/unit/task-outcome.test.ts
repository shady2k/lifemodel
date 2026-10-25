import { describe, expect, it } from 'vitest';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';
import {
  taskOutcomeAttachments,
  taskOutcomeFallback,
  validateTaskOutcome,
} from '../../src/ports/task-outcome.js';

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

describe('task outcome attachments', () => {
  const result = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'result.md',
    size: 42,
    sha256: 'a'.repeat(64),
    mark: 'result',
  };
  const artifact = {
    ...result,
    id: '22222222-2222-4222-8222-222222222222',
    name: 'budget chart.svg',
    mark: 'artifact',
    contentType: 'image/svg+xml',
  };
  const log = {
    ...result,
    id: '33333333-3333-4333-8333-333333333333',
    name: 'private.log',
    mark: 'log',
  };
  const event = {
    taskId: 'task-outputs',
    outcomeKey: 'outcome_outputs',
    state: 'done',
    reasonCode: 'completed',
    summary: 'Files ready.',
    objects: [artifact, log, result],
  };

  it('preserves sealed output order, plain names and MIME types without exposing logs', () => {
    expect(taskOutcomeAttachments(validateTaskOutcome(event))).toEqual([
      [
        {
          artifactId: artifact.id,
          name: 'budget chart.svg',
          size: 42,
          contentType: 'image/svg+xml',
        },
        {
          artifactId: result.id,
          name: 'result.md',
          size: 42,
          contentType: 'application/octet-stream',
        },
      ],
    ]);
  });

  it('does not treat artifact files as a substitute for the required completed result', () => {
    expect(() => validateTaskOutcome({ ...event, objects: [artifact, log] })).toThrow(
      'Task outcome missing result'
    );
  });

  it.each(['failed', 'stopped'])('does not attach retained outputs for %s', (state) => {
    expect(taskOutcomeAttachments(validateTaskOutcome({ ...event, state }))).toEqual([]);
  });
});
