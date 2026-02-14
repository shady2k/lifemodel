/**
 * Core Task Tool
 *
 * Unified tool for Motor Cortex run management.
 * Replaces the former core.tasks (list) and core.task (control) split.
 *
 * Consent gating: respond and approve actions require user_message trigger.
 */

import type { Tool } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type { MotorCortex } from '../../../../runtime/motor-cortex/motor-cortex.js';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * Create the core.task tool.
 */
export function createTaskTool(motorCortex: MotorCortex, artifactsBaseDir?: string): Tool {
  const parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description:
        'Action: list (all runs), status (one run), cancel, respond, approve, log (view run log), retry (retry failed run with guidance)',
      required: true,
      enum: ['list', 'status', 'cancel', 'respond', 'approve', 'log', 'retry'] as const,
    },
    {
      name: 'runId',
      type: 'string' as const,
      description: 'Run ID (required for status, cancel, respond)',
      required: false,
    },
    {
      name: 'status',
      type: 'string' as const,
      description: 'Filter by status (for list action only)',
      required: false,
      enum: [
        'created',
        'running',
        'awaiting_input',
        'awaiting_approval',
        'completed',
        'failed',
      ] as const,
    },
    {
      name: 'limit',
      type: 'number' as const,
      description: 'Max runs to return (for list action only)',
      required: false,
    },
    {
      name: 'answer',
      type: 'string' as const,
      description: 'Answer to provide (for respond action)',
      required: false,
    },
    {
      name: 'approved',
      type: 'boolean' as const,
      description: 'Whether to approve (true) or deny (false) (for approve action)',
      required: false,
    },
    {
      name: 'guidance',
      type: 'string' as const,
      description:
        'Corrective instructions for retry attempt (for retry action). Explain what went wrong and what to try differently.',
      required: false,
    },
    {
      name: 'constraints',
      type: 'array' as const,
      description:
        'Optional constraints for retry attempt (e.g. "do not retry login more than once")',
      required: false,
    },
    {
      name: 'domains',
      type: 'array' as const,
      description:
        'Optional additional network domains to allow (for respond or retry actions). Merged with existing run domains. Use when the sub-agent asked for network access via ask_user.',
      required: false,
    },
  ];

  return {
    name: 'core.task',
    description:
      'Manage Motor Cortex runs. list: show all runs (filterable by status). status: get details of one run. cancel: stop a running run. respond: answer a question from an awaiting_input run. log: view execution log for a run. retry: retry a failed run with corrective guidance.',
    tags: ['motor', 'control'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, context) => {
      const action = args['action'] as string;

      if (!action) {
        return {
          success: false,
          error: 'Missing required parameter: action',
        };
      }

      switch (action) {
        case 'list': {
          try {
            const statusFilter = args['status'] as string | undefined;
            const limit = args['limit'] as number | undefined;
            const filter: {
              status?: 'completed' | 'failed' | 'awaiting_input' | 'created' | 'running';
              limit?: number;
            } = {};
            if (statusFilter !== undefined) {
              filter.status = statusFilter as
                | 'completed'
                | 'failed'
                | 'awaiting_input'
                | 'created'
                | 'running';
            }
            if (limit !== undefined) {
              filter.limit = limit;
            }
            const result = await motorCortex.listRuns(filter);

            const runs = result.runs.map((run) => {
              const currentAttempt = run.attempts[run.currentAttemptIndex];
              return {
                id: run.id,
                status: run.status,
                task: run.task,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                attemptIndex: run.currentAttemptIndex,
                totalAttempts: run.attempts.length,
                iterations: currentAttempt?.trace.totalIterations ?? 0,
                tools: run.tools,
              };
            });

            return {
              success: true,
              data: { total: result.total, runs },
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        case 'status': {
          const runId = args['runId'] as string;
          if (!runId) {
            return {
              success: false,
              error: 'Missing required parameter: runId (for status action)',
            };
          }

          const run = await motorCortex.getRunStatus(runId);
          if (!run) {
            return {
              success: false,
              error: `Run not found: ${runId}`,
            };
          }

          const currentAttempt = run.attempts[run.currentAttemptIndex];
          return {
            success: true,
            data: {
              id: run.id,
              status: run.status,
              task: run.task,
              tools: run.tools,
              attemptIndex: run.currentAttemptIndex,
              totalAttempts: run.attempts.length,
              maxAttempts: run.maxAttempts,
              stepCursor: currentAttempt?.stepCursor ?? 0,
              maxIterations: currentAttempt?.maxIterations ?? 0,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              energyConsumed: run.energyConsumed,
              iterations: currentAttempt?.trace.totalIterations ?? 0,
              errors: currentAttempt?.trace.errors ?? 0,
              pendingQuestion: currentAttempt?.pendingQuestion,
              failure: currentAttempt?.failure,
            },
          };
        }

        case 'cancel': {
          const runId = args['runId'] as string;
          if (!runId) {
            return {
              success: false,
              error: 'Missing required parameter: runId (for cancel action)',
            };
          }

          try {
            const result = await motorCortex.cancelRun(runId);
            return {
              success: true,
              data: result,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        case 'respond': {
          // CONSENT GATE: respond requires user_message trigger
          if (context?.triggerType !== 'user_message') {
            return {
              success: false,
              error:
                'This action requires user input. Relay the question to the user first, then wait for their response.',
            };
          }

          const runId = args['runId'] as string;
          const answer = args['answer'] as string;
          const domains = args['domains'] as string[] | undefined;
          if (!runId) {
            return {
              success: false,
              error: 'Missing required parameter: runId (for respond action)',
            };
          }
          if (!answer) {
            return {
              success: false,
              error: 'Missing required parameter: answer (for respond action)',
            };
          }

          try {
            const result = await motorCortex.respondToRun(runId, answer, domains);
            return {
              success: true,
              data: result,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        case 'approve': {
          // CONSENT GATE: approve requires user_message trigger
          if (context?.triggerType !== 'user_message') {
            return {
              success: false,
              error:
                'This action requires user input. Present the approval request to the user first, then wait for their decision.',
            };
          }

          const runId = args['runId'] as string;
          const approved = args['approved'] as boolean | undefined;
          if (!runId) {
            return {
              success: false,
              error: 'Missing required parameter: runId (for approve action)',
            };
          }
          if (approved === undefined) {
            return {
              success: false,
              error: 'Missing required parameter: approved (for approve action)',
            };
          }

          try {
            const result = await motorCortex.respondToApproval(runId, approved);
            return {
              success: true,
              data: result,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        case 'log': {
          const runId = args['runId'] as string;
          if (!runId) {
            return {
              success: false,
              error: 'Missing required parameter: runId (for log action)',
            };
          }
          if (!artifactsBaseDir) {
            return {
              success: false,
              error: 'Task logging is not configured (no artifacts base dir)',
            };
          }

          // Validate run exists first (prevents path traversal)
          const run = await motorCortex.getRunStatus(runId);
          if (!run) {
            return {
              success: false,
              error: `Run not found: ${runId}`,
            };
          }

          try {
            const logPath = join(artifactsBaseDir, runId, 'log.txt');
            const resolved = resolve(logPath);
            const resolvedBase = resolve(artifactsBaseDir) + sep;
            if (!resolved.startsWith(resolvedBase)) {
              return { success: false, error: 'Invalid run ID' };
            }

            const content = await readFile(resolved, 'utf-8');
            const MAX_LOG_SIZE = 16 * 1024;
            const truncated =
              content.length > MAX_LOG_SIZE ? content.slice(-MAX_LOG_SIZE) : content;

            return {
              success: true,
              data: { log: truncated },
            };
          } catch {
            return {
              success: false,
              error: `No log file found for run ${runId}`,
            };
          }
        }

        case 'retry': {
          const runId = args['runId'] as string;
          const guidance = args['guidance'] as string;
          if (!runId) {
            return {
              success: false,
              error: 'Missing required parameter: runId (for retry action)',
            };
          }
          if (!guidance) {
            return {
              success: false,
              error: 'Missing required parameter: guidance (for retry action)',
            };
          }

          try {
            const constraints = args['constraints'] as string[] | undefined;
            const domains = args['domains'] as string[] | undefined;
            const result = await motorCortex.retryRun(runId, guidance, constraints, domains);
            return {
              success: true,
              data: result,
            };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Use list, status, cancel, respond, approve, retry, or log.`,
          };
      }
    },
  };
}
