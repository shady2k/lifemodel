/**
 * Core Act Tool
 *
 * Execute tasks via Motor Cortex.
 * "oneshot" runs JS code synchronously.
 * "agentic" starts an async sub-agent task.
 */

import type { Tool } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type { MotorCortex } from '../../../../runtime/motor-cortex/motor-cortex.js';
import type { MotorTool } from '../../../../runtime/motor-cortex/motor-protocol.js';
import { loadSkill, validateSkillInputs } from '../../../../runtime/skills/skill-loader.js';

/**
 * Create the core.act tool.
 */
export function createActTool(motorCortex: MotorCortex): Tool {
  const parameters = [
    {
      name: 'mode',
      type: 'string' as const,
      description:
        'Execution mode: "oneshot" for synchronous JS code, "agentic" for async sub-agent task',
      required: true,
      enum: ['oneshot', 'agentic'] as const,
    },
    {
      name: 'task',
      type: 'string' as const,
      description: 'JS code (oneshot) or natural language task (agentic)',
      required: true,
    },
    {
      name: 'tools',
      type: 'array' as const,
      description:
        'Tools for agentic mode (code, filesystem, shell, grep, patch, ask_user). Default: [code]',
      required: false,
    },
    {
      name: 'maxIterations',
      type: 'number' as const,
      description: 'Max iterations for agentic mode (default: 20)',
      required: false,
    },
    {
      name: 'skill',
      type: 'string' as const,
      description:
        'Skill name to load and inject (loads from data/skills/<name>/SKILL.md). Overrides tools with skill-defined tools.',
      required: false,
    },
    {
      name: 'inputs',
      type: 'object' as const,
      description: 'Input values for skill execution (validated against skill input schema)',
      required: false,
    },
    {
      name: 'domains',
      type: 'array' as const,
      description:
        'Network domains to allow access to (e.g., ["api.example.com"]). Merged with skill-defined domains if provided.',
      required: false,
    },
  ];

  return {
    name: 'core.act',
    description:
      'Execute a task via Motor Cortex. "oneshot" runs JS code synchronously and returns the result. "agentic" starts an async sub-agent task that can use tools like code, filesystem, shell, grep, and patch. Agentic tasks run in the background and results come back via signals. Optionally load a skill for guided execution.',
    tags: ['motor', 'execution', 'async'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, _context) => {
      const mode = args['mode'] as string;
      const task = args['task'] as string;

      if (!mode || !task) {
        return {
          success: false,
          error: 'Missing required parameters: mode, task',
        };
      }

      if (mode === 'oneshot') {
        // Execute JS code synchronously
        try {
          const result = await motorCortex.executeOneshot(task);
          return {
            success: result.ok,
            data: {
              mode: 'oneshot',
              result: result.result,
              durationMs: result.durationMs,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (mode === 'agentic') {
        // Start agentic run
        try {
          const skillName = args['skill'] as string | undefined;
          const inputs = (args['inputs'] as Record<string, unknown> | undefined) ?? {};
          let tools = (args['tools'] as MotorTool[] | undefined) ?? ['code'];
          const maxIterations = (args['maxIterations'] as number | undefined) ?? 20;
          const domains = (args['domains'] as string[] | undefined) ?? [];

          // Load skill if specified
          let loadedSkill = undefined;
          if (skillName) {
            const skillResult = await loadSkill(skillName);
            if ('error' in skillResult) {
              return {
                success: false,
                error: skillResult.error,
              };
            }
            loadedSkill = skillResult;

            // Override tools with skill-defined tools
            tools = loadedSkill.definition.tools;

            // Validate inputs against skill schema
            const inputErrors = validateSkillInputs(loadedSkill, inputs);
            if (inputErrors.length > 0) {
              return {
                success: false,
                error: `Skill input validation failed: ${inputErrors.join('; ')}`,
              };
            }
          }

          // Build task with inputs if provided
          let fullTask = task;
          if (Object.keys(inputs).length > 0) {
            const inputStr = Object.entries(inputs)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join('\n');
            fullTask = `${task}\n\nInputs:\n${inputStr}`;
          }

          const { runId } = await motorCortex.startRun({
            task: fullTask,
            tools,
            maxIterations,
            ...(loadedSkill && { skill: loadedSkill }),
            ...(domains.length > 0 && { domains }),
          });

          return {
            success: true,
            data: {
              mode: 'agentic',
              runId,
              status: 'started',
              ...(skillName && { skill: skillName }),
              message: 'Task started in background. Results will arrive via motor_result signal.',
            },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return {
        success: false,
        error: `Unknown mode: ${mode}. Use "oneshot" or "agentic".`,
      };
    },
  };
}
