/**
 * Core Task Tool
 *
 * Unified tool for Motor Cortex run management.
 * Replaces the former core.tasks (list) and core.task (control) split.
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
        'Action: list (all runs), status (one run), cancel, respond, approve, log (view run log)',
      required: true,
      enum: ['list', 'status', 'cancel', 'respond', 'approve', 'log'] as const,
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
  ];

  return {
    name: 'core.task',
    description:
      'Manage Motor Cortex runs. list: show all runs (filterable by status). status: get details of one run. cancel: stop a running run. respond: answer a question from an awaiting_input run. log: view execution log for a run.',
    tags: ['motor', 'control'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, _context) => {
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

            const runs = result.runs.map((run) => ({
              id: run.id,
              status: run.status,
              task: run.task,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              iterations: run.trace.totalIterations,
              tools: run.tools,
            }));

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

          return {
            success: true,
            data: {
              id: run.id,
              status: run.status,
              task: run.task,
              tools: run.tools,
              stepCursor: run.stepCursor,
              maxIterations: run.maxIterations,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              energyConsumed: run.energyConsumed,
              iterations: run.trace.totalIterations,
              errors: run.trace.errors,
              pendingQuestion: run.pendingQuestion,
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
          const runId = args['runId'] as string;
          const answer = args['answer'] as string;
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
            const result = await motorCortex.respondToRun(runId, answer);
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

        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Use list, status, cancel, respond, approve, or log.`,
          };
      }
    },
  };
}
