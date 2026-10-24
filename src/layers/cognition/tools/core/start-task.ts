import type { Tool, ToolParameter } from '../types.js';
import { UncertainMutationError } from '../mutation-error.js';
import { validateAgainstParameters } from '../validation.js';
import { TASK_PROFILES } from '../../../../ports/task-profiles.js';
import { TaskRegistryError, type TaskRecord } from '../../../../ports/tasks.js';
import type { StartTaskIntent } from '../../../../types/intent.js';

export interface StartTaskToolDeps {
  applyStartTask: (intent: StartTaskIntent) => Promise<TaskRecord>;
  imageRevision: string;
}

/** Accepts work only; allocation, execution and sealing never block this turn. */
export function createStartTaskTool(deps: StartTaskToolDeps): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'briefing',
      type: 'string',
      required: true,
      description: 'Complete task briefing: goal, context, constraints and result file to save.',
    },
    {
      name: 'profile',
      type: 'string',
      required: true,
      description: `Allowed resource profile: ${Object.keys(TASK_PROFILES).join(', ')}. Unknown names are refused.`,
    },
  ];
  return {
    name: 'core.startTask',
    parameters,
    tags: ['task', 'background'],
    hasSideEffects: true,
    maxCallsPerTurn: 1,
    description:
      'Start long work in the background with a briefing and an explicit profile. Returns queued immediately, without waiting for execution. After acceptance, tell the owner now that work has started and you will reply with the result file when done. A refusal is not a started task.',
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, context) => {
      const profile =
        typeof args['profile'] === 'string' && Object.hasOwn(TASK_PROFILES, args['profile'])
          ? TASK_PROFILES[args['profile']]
          : undefined;
      if (!profile) return { success: false, code: 'unknown_profile' };
      if (typeof args['briefing'] !== 'string' || !args['briefing'].trim())
        return { success: false, code: 'invalid_briefing' };
      if (!context?.correlationId || !context.recipientId)
        return { success: false, code: 'missing_turn' };
      try {
        const task = await deps.applyStartTask({
          type: 'START_TASK',
          payload: {
            // One explicit task effect slot per deciding turn. Never use model call IDs.
            launchKey: `task|${context.recipientId}|${context.correlationId}|0`,
            briefing: args['briefing'],
            profile,
            imageRevision: deps.imageRevision,
          },
          trace: { tickId: context.correlationId },
        });
        return {
          success: true,
          taskId: task.id,
          state: task.state,
          message:
            'Accepted in background. Reply now; the outcome will arrive later with the result attachment.',
        };
      } catch (error) {
        if (error instanceof TaskRegistryError && error.code !== 'storage_error')
          return { success: false, code: error.code };
        // Infrastructure failures must fail the turn, not claim acceptance or silently lose its effect.
        throw new UncertainMutationError();
      }
    },
  };
}
