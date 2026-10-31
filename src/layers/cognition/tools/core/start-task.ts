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
        `Expected delivered output filenames: at most 16 unique safe flat names. The system saves the work's final message as task-report.txt beside the delivered files; the work does not write this file. Asking the work to write it makes the run fail. It is the work's own claim about what it did, to be checked against the delivered files. When the owner wants a summary file, I name a work file such as summary.txt in both the briefing and expectedOutputs. This system-written name is refused here (reserved_output_name). Omit for answer-only work. Missing files make completion unsuccessful.`,
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
      "I have started the work in the background in this turn. The outcome comes later, and I will check the delivered files against the owner's request before I report a result.",
  });
  return {
    name: 'core.startTask',
    parameters,
    tags: ['task', 'background'],
    hasSideEffects: true,
    maxCallsPerTurn: 1,
    description:
      'I start my long work in the background with a complete briefing, explicit profile and expected output filenames when files are requested. I own the result of the work I delegate. When the request or conversation makes what to deliver and in what form clear, I start at once; asking for an obvious confirmation adds friction. Background work runs out of sight, takes time and comes back as files, so an unclear deliverable needs agreement: I first propose a concrete plan (what, range, form, files) and ask, because a wrong guess costs the owner a wasted run and a redo. Once the owner agrees to my proposed plan for background work with an unclear deliverable, that plan is the request and I start it without asking again. «Сделай мне в фоне отчёт по простым числам.» leaves the range and form open; «Сохрани все простые числа меньше 500 в primes500.txt в фоне.» supplies them. I speak of this as my own work: what I started, what I checked, what did not work and what I am redoing. This returns queued while execution continues in the background. Saying I started is accurate only after this tool returns accepted in this turn: the owner acts on what I say is already true. A plan is not a result, and I check the delivered files before I report a result.',
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
          return {
            success: false,
            code: 'reserved_output_name',
            message: `The system saves the work's final message as task-report.txt beside the delivered files; the work does not write this file. Asking the work to write it makes the run fail. It is the work's own claim about what it did, to be checked against the delivered files. When the owner wants a summary file, I name a work file such as summary.txt in both the briefing and expectedOutputs.`,
          };
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
