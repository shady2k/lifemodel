import { describe, expect, it } from 'vitest';
import { isTaskCommandText, validateTaskCommandInput } from '../../src/ports/task-channel.js';
import { createSteerTaskTool } from '../../src/layers/cognition/tools/core/steer-task.js';
import type { TaskService } from '../../src/ports/tasks.js';
import { vi } from 'vitest';

describe('shared task command text validity', () => {
  it.each([undefined, '', '  ', 'bad\0text', 'x'.repeat(60_001), '\n'.repeat(30_000)])(
    'refuses invalid text before recovery or writing (%#)',
    async (text) => {
      expect(isTaskCommandText(text)).toBe(false);
      const readCommand = vi.fn();
      const steer = vi.fn();
      const answer = vi.fn();
      const tool = createSteerTaskTool({ readCommand, steer, answer } as unknown as TaskService);
      const context = {
        recipientId: 'owner',
        correlationId: 'turn',
        taskSteerCounts: new Map<string, number>(),
      };
      const args = { action: 'steer', taskId: 'task', text };
      expect(await tool.recoverAcceptedEffect!(context, args)).toBeUndefined();
      expect(await tool.execute(args, context)).toEqual({ success: false, code: 'invalid_text' });
      expect(
        await tool.execute({ ...args, action: 'answer', questionId: 'question' }, context)
      ).toEqual({ success: false, code: 'invalid_text' });
      expect(readCommand).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
      expect(answer).not.toHaveBeenCalled();
      expect(context.taskSteerCounts.size).toBe(0);
      expect(() =>
        validateTaskCommandInput({
          taskId: 'task',
          attemptId: 'attempt',
          commandId: 'command',
          kind: 'steer',
          text,
        })
      ).toThrow();
    }
  );
  it('uses the configured response limit before recovery, including JSON escaping', async () => {
    expect(isTaskCommandText('hello')).toBe(true);
    const readCommand = vi.fn();
    const tool = createSteerTaskTool({ readCommand } as unknown as TaskService, 1024);
    const args = { action: 'steer', taskId: 'task', text: 'a\n'.repeat(400) };
    const context = { recipientId: 'owner', correlationId: 'turn' };
    expect(isTaskCommandText(args.text)).toBe(true);
    expect(isTaskCommandText(args.text, 1024)).toBe(false);
    expect(await tool.recoverAcceptedEffect!(context, args)).toBeUndefined();
    expect(await tool.execute(args, context)).toEqual({ success: false, code: 'invalid_text' });
    expect(readCommand).not.toHaveBeenCalled();
  });
});
