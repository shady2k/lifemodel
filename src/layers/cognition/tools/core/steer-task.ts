import { createHash } from 'node:crypto';
import type { Tool, ToolContext, ToolParameter } from '../types.js';
import type { TaskService } from '../../../../ports/tasks.js';
import { TaskRegistryError } from '../../../../ports/tasks.js';
import { TaskChannelError, type TaskCommand } from '../../../../ports/task-channel.js';
import { UncertainMutationError } from '../mutation-error.js';
import { validateAgainstParameters } from '../validation.js';

export function createSteerTaskTool(service: TaskService): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      required: true,
      enum: ['read', 'steer', 'answer'],
      description: 'Read task status, steer its next work, or answer its open question.',
    },
    { name: 'taskId', type: 'string', required: true, description: 'Exact task ID.' },
    {
      name: 'text',
      type: 'string',
      required: false,
      description: 'Steering or answer text. Never grants privileged effects.',
    },
    {
      name: 'questionId',
      type: 'string',
      required: false,
      description: 'Required correlation ID for answer.',
    },
  ];
  const commandIdFor = (context?: ToolContext) =>
    context?.recipientId && context.correlationId
      ? `command_${createHash('sha256')
          .update(
            JSON.stringify([
              context.recipientId,
              context.correlationId,
              context.effectCallIndex ?? 0,
            ])
          )
          .digest('hex')}`
      : undefined;
  const permitted = (taskId: string, context?: ToolContext) =>
    !context?.taskQuestion || context.taskQuestion.taskId === taskId;
  const receipt = (command: TaskCommand) => ({
    success: true,
    taskId: command.taskId,
    commandId: command.commandId,
    state: 'queued',
    message:
      'Committed to the task mailbox. Queued is not execution or obedience. Read task status for ACKs and receipts.',
  });
  return {
    name: 'core.steerTask',
    parameters,
    tags: ['task'],
    hasSideEffects: true,
    description:
      'Read a background task and its command dispositions, steer it, or answer its question. Returns queued after commit; never waits for the launcher. A rejected command is retryable in a new turn. Uncertain is not safe to resend automatically. In a task-question turn commands may target only that task. Privileged effects still require exact-scope grants.',
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    recoverAcceptedEffect: async (context) => {
      const commandId = commandIdFor(context);
      if (!commandId) return undefined;
      try {
        const command = await service.readCommand(commandId);
        if (!command) return undefined;
        if (!permitted(command.taskId, context))
          return { success: false, code: 'cross_task_question' };
        return receipt(command);
      } catch {
        throw new UncertainMutationError();
      }
    },
    execute: async (args, context) => {
      const taskId = args['taskId'];
      if (typeof taskId !== 'string') return { success: false, code: 'invalid_task' };
      if (args['action'] === 'read') {
        try {
          return { success: true, task: await service.read(taskId) };
        } catch {
          throw new UncertainMutationError();
        }
      }
      if (!permitted(taskId, context)) return { success: false, code: 'cross_task_question' };
      const commandId = commandIdFor(context);
      if (!commandId) return { success: false, code: 'missing_turn' };
      if (typeof args['text'] !== 'string' || !args['text'].trim())
        return { success: false, code: 'invalid_text' };
      try {
        if (args['action'] === 'steer')
          return receipt(await service.steer(taskId, commandId, args['text']));
        if (args['action'] === 'answer' && typeof args['questionId'] === 'string')
          return receipt(await service.answer(taskId, commandId, args['questionId'], args['text']));
        return { success: false, code: 'invalid_action' };
      } catch (error) {
        if (
          (error instanceof TaskChannelError &&
            error.code !== 'storage_error' &&
            error.status < 500) ||
          (error instanceof TaskRegistryError && error.code !== 'storage_error')
        )
          return { success: false, code: error.code };
        throw new UncertainMutationError();
      }
    },
  };
}
