import type { Tool, ToolContext, ToolParameter } from '../types.js';
import { UncertainMutationError } from '../mutation-error.js';
import { validateAgainstParameters } from '../validation.js';
import { TASK_REPORT_NAME } from '../../../../ports/task-output-names.mjs';
import { TASK_PROFILES } from '../../../../ports/task-profiles.js';
import {
  isTaskExpectedOutputs,
  TaskRegistryError,
  type TaskRecord,
} from '../../../../ports/tasks.js';
import type { StartTaskIntent } from '../../../../types/intent.js';
import { getTraceContext } from '../../../../core/trace-context.js';

export interface StartTaskToolDeps {
  readByLaunchKey: (launchKey: string) => Promise<TaskRecord | null>;
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
      description: 'Complete task briefing: goal, context, constraints and output files to save.',
    },
    {
      name: 'profile',
      type: 'string',
      required: true,
      description: `Allowed resource profile: ${Object.keys(TASK_PROFILES).join(', ')}. Unknown names are refused.`,
    },
    {
      name: 'expectedOutputs',
      type: 'array',
      required: false,
      description:
        'Expected delivered output filenames: at most 16 unique safe flat names. task-report.txt is reserved for my report (reserved_output_name). Omit for answer-only work. Missing files make completion unsuccessful.',
    },
  ];
  // Only the outcome-specific advertised schema exposes this trusted capability.
  const outcomeParameters: ToolParameter[] = [
    ...parameters,
    {
      name: 'redoOf',
      type: 'string',
      required: false,
      description:
        'Original finished task ID for one corrected redo. Inherit its expected files: omit expectedOutputs or repeat the original names in any order.',
    },
  ];
  // The slot belongs to the persisted deciding turn, never regenerated arguments.
  const launchKeyFor = (context?: ToolContext) =>
    context?.correlationId && context.recipientId
      ? `task|${context.recipientId}|${context.correlationId}|0`
      : undefined;
  const acceptedReceipt = (task: TaskRecord) => ({
    success: true,
    taskId: task.id,
    state: task.state,
    message:
      'Accepted in background in this turn. You may now say I started. The outcome will arrive later; verify delivered files before claiming a result.',
  });
  return {
    name: 'core.startTask',
    parameters,
    tags: ['task', 'background'],
    hasSideEffects: true,
    maxCallsPerTurn: 1,
    description:
      'Start my long work in the background with a complete briefing, explicit profile and expected output filenames when files are requested. If the request does not name what to deliver and in what form, or has several reasonable readings, first propose a concrete plan (what, range, files) and ask for agreement before launch. For example, «Сделай мне в фоне отчёт по простым числам.» needs agreement; do not invent its range or files. Launch at once when the request is clear; do not ask again. Speak of the work as my own: «готово», «содержимое файла проверено», «с первого раза не вышло, переделываю», never «задача завершилась» or «задача остановилась». Returns queued without waiting for execution. Say I started only after this tool returns accepted in this turn, never before or after a refusal. A plan is not a result.',
    validate: (args) =>
      validateAgainstParameters(args as Record<string, unknown>, outcomeParameters),
    recoverAcceptedEffect: async (context) => {
      const launchKey = launchKeyFor(context);
      if (!launchKey) return undefined;
      try {
        const task = await deps.readByLaunchKey(launchKey);
        if (
          (task?.redoOf &&
            (context.triggerType !== 'task_outcome' ||
              !context.taskOutcome?.redoAllowed ||
              task.redoOf !== context.taskOutcome.taskId)) ||
          (context.triggerType === 'task_outcome' &&
            (!context.taskOutcome?.redoAllowed || task?.redoOf !== context.taskOutcome.taskId))
        )
          return undefined;
        return task ? acceptedReceipt(task) : undefined;
      } catch {
        // A failed fenced read must not become a refusal or an unfenced write.
        throw new UncertainMutationError();
      }
    },
    execute: async (args, context) => {
      const launchKey = launchKeyFor(context);
      if (!launchKey || !context) return { success: false, code: 'missing_turn' };
      if (
        args['redoOf'] !== undefined &&
        (context.triggerType !== 'task_outcome' ||
          !context.taskOutcome?.redoAllowed ||
          args['redoOf'] !== context.taskOutcome.taskId)
      )
        return { success: false, code: 'redo_not_allowed' };
      try {
        const profile =
          typeof args['profile'] === 'string' && Object.hasOwn(TASK_PROFILES, args['profile'])
            ? TASK_PROFILES[args['profile']]
            : undefined;
        if (!profile) return { success: false, code: 'unknown_profile' };
        if (typeof args['briefing'] !== 'string' || !args['briefing'].trim())
          return { success: false, code: 'invalid_briefing' };
        if (
          Array.isArray(args['expectedOutputs']) &&
          args['expectedOutputs'].includes(TASK_REPORT_NAME)
        )
          return { success: false, code: 'reserved_output_name' };
        if (args['expectedOutputs'] != null && !isTaskExpectedOutputs(args['expectedOutputs']))
          return { success: false, code: 'invalid_expected_outputs' };
        const trace = getTraceContext();
        const task = await deps.applyStartTask({
          type: 'START_TASK',
          payload: {
            launchKey,
            briefing: args['briefing'],
            profile,
            ...(Array.isArray(args['expectedOutputs'])
              ? { expectedOutputs: args['expectedOutputs'] as string[] }
              : {}),
            ...(typeof args['redoOf'] === 'string' ? { redoOf: args['redoOf'] } : {}),
            imageRevision: deps.imageRevision,
            traceId: trace?.traceId ?? context.correlationId,
            parentSpanId: trace?.spanId ?? context.correlationId,
          },
          trace: { tickId: context.correlationId },
        });
        return acceptedReceipt(task);
      } catch (error) {
        if (error instanceof TaskRegistryError && error.code !== 'storage_error')
          return { success: false, code: error.code };
        // Infrastructure failures must fail the turn, not claim acceptance or silently lose its effect.
        throw new UncertainMutationError();
      }
    },
  };
}
