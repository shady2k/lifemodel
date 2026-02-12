/**
 * Core Act Tool
 *
 * Execute tasks via Motor Cortex.
 * "oneshot" runs JS code synchronously.
 * "agentic" starts an async sub-agent task.
 *
 * Policy-aware skill loading:
 * - Skills with approved policy use policy.allowedTools as default
 * - Skills without policy or needs_reapproval trust require explicit tools/domains
 * - Content hash verification triggers trust reset on mismatch
 */

import type { Tool } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type { MotorCortex } from '../../../../runtime/motor-cortex/motor-cortex.js';
import type { MotorTool } from '../../../../runtime/motor-cortex/motor-protocol.js';
import {
  loadSkill,
  validateSkillInputs,
  updateSkillIndex,
} from '../../../../runtime/skills/skill-loader.js';
import type { LoadedSkill } from '../../../../runtime/skills/skill-types.js';

/**
 * Default skills base directory.
 */
const DEFAULT_SKILLS_DIR = 'data/skills';

/**
 * Create the core.act tool.
 */
export function createActTool(motorCortex: MotorCortex): Tool {
  const parameters = [
    {
      name: 'mode',
      type: 'string' as const,
      description:
        'Execution mode: "oneshot" for executable JavaScript only (eval), "agentic" for all other tasks (file ops, research, skill creation)',
      required: true,
      enum: ['oneshot', 'agentic'] as const,
    },
    {
      name: 'task',
      type: 'string' as const,
      description:
        'Executable JavaScript code (oneshot) or natural language task description (agentic). Never pass non-JS content to oneshot.',
      required: true,
    },
    {
      name: 'tools',
      type: 'array' as const,
      description:
        'Tools for agentic mode (read, write, list, glob, bash, grep, patch, fetch, search). Required if skill has no approved policy.',
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
        'Skill name to load (from data/skills/<name>/SKILL.md). If skill has approved policy, tools/domains from policy are used automatically.',
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
        'Network domains to allow access to (e.g., ["api.example.com"]). Merged with skill policy domains if provided.',
      required: false,
    },
  ];

  return {
    name: 'core.act',
    description:
      'Execute a task via Motor Cortex. "oneshot" runs ONLY executable JavaScript (e.g., Date.now(), JSON.parse(...)). "agentic" starts an async sub-agent for everything else: file creation, research, API calls, skill creation. Tools: read, write, list, glob, bash, grep, patch, ask_user, fetch, search. Skills with approved policy provide tools/domains automatically. To save or create a skill, use agentic mode with bash tool. Results arrive via motor_result signal. IMPORTANT: When starting an agentic task, always tell the user the run ID so they can track it.',
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
          const explicitTools = args['tools'] as MotorTool[] | undefined;
          const maxIterations = (args['maxIterations'] as number | undefined) ?? 20;
          const explicitDomains = (args['domains'] as string[] | undefined) ?? [];

          // Load skill if specified
          let loadedSkill: LoadedSkill | undefined = undefined;
          let tools: MotorTool[];
          let domains = explicitDomains;
          const warnings: string[] = [];

          if (skillName) {
            const skillResult = await loadSkill(skillName);
            if ('error' in skillResult) {
              return {
                success: false,
                error: skillResult.error,
              };
            }
            loadedSkill = skillResult;

            const policy = loadedSkill.policy;

            // Policy-aware tool/domain resolution
            if (policy?.trust === 'approved') {
              // Use policy defaults
              tools = explicitTools ?? policy.allowedTools;

              // Merge domains: policy + explicit
              if (policy.allowedDomains) {
                domains = [...new Set([...policy.allowedDomains, ...explicitDomains])];
              }

              // Note: credentials are handled by Motor Cortex via CredentialStore
            } else {
              // No policy or needs_reapproval trust — require explicit tools
              if (!explicitTools) {
                if (policy) {
                  // Has policy but not approved — trust-specific error with recovery path
                  const trustLabel =
                    policy.trust === 'pending_review'
                      ? 'pending approval (new skill)'
                      : 'needs re-approval (content changed)';
                  return {
                    success: false,
                    error:
                      `Skill "${skillName}" is ${trustLabel}. ` +
                      `Use core.skill(action:"read", name:"${skillName}") to show the user ` +
                      `its content and permissions, then core.skill(action:"approve") after user consent. ` +
                      `Do not retry this call until the skill is approved.`,
                  };
                } else {
                  // No policy at all — needs onboarding
                  return {
                    success: false,
                    error:
                      `Skill "${skillName}" has no policy. ` +
                      `Provide tools explicitly or run onboarding. ` +
                      `Example: tools: ["bash", "read", "write"]`,
                  };
                }
              }
              tools = explicitTools;

              if (policy?.trust === 'needs_reapproval') {
                warnings.push(
                  `Skill "${skillName}" trust state is "needs_reapproval". ` +
                    `Content may have changed since approval. Re-approval recommended.`
                );
              }
            }

            // Validate inputs against skill schema
            const inputErrors = validateSkillInputs(loadedSkill, inputs);
            if (inputErrors.length > 0) {
              return {
                success: false,
                error: `Skill input validation failed: ${inputErrors.join('; ')}`,
              };
            }
          } else {
            // No skill — use explicit tools or default
            tools = explicitTools ?? ['bash'];
          }

          // Auto-include bash if domains are specified (network access requires bash for curl/git)
          if (domains.length > 0 && !tools.includes('bash')) {
            tools = [...tools, 'bash'];
          }

          // Auto-include fetch if domains are specified (network access requires fetch for HTTP)
          if (domains.length > 0 && !tools.includes('fetch')) {
            tools = [...tools, 'fetch'];
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

          // Update index.json with lastUsed timestamp
          if (skillName && loadedSkill) {
            try {
              await updateSkillIndex(DEFAULT_SKILLS_DIR, skillName, {
                description: loadedSkill.frontmatter.description,
                trust: loadedSkill.policy?.trust ?? 'needs_reapproval',
                hasPolicy: loadedSkill.policy !== undefined,
                lastUsed: new Date().toISOString(),
              });
            } catch {
              // Non-fatal: skill index update failed, run continues
            }
          }

          return {
            success: true,
            data: {
              mode: 'agentic',
              runId,
              status: 'started',
              ...(skillName && { skill: skillName }),
              ...(warnings.length > 0 && { warnings }),
              message: `Task started in background (run: ${runId}). Results will arrive via motor_result signal. Include the run ID when telling the user.`,
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
