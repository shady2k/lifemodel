/**
 * Core Act Tool
 *
 * Execute tasks via Motor Cortex.
 * "oneshot" runs JS code synchronously.
 * "agentic" starts an async sub-agent task.
 *
 * All sandboxed tools are always granted — container isolation is the security boundary.
 * Policy-aware skill loading handles trust gating and domain resolution.
 */

import type { Tool } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type { MotorCortex } from '../../../../runtime/motor-cortex/motor-cortex.js';
import type { MotorTool, SyntheticTool } from '../../../../runtime/motor-cortex/motor-protocol.js';
import { loadSkill, validateSkillInputs } from '../../../../runtime/skills/skill-loader.js';
import { isValidDomain } from '../../../../runtime/container/network-policy.js';
import type { LoadedSkill } from '../../../../runtime/skills/skill-types.js';

/**
 * All sandboxed tools are always granted.
 * Container isolation (--read-only, --network none, --cap-drop ALL) is the security boundary.
 * Restricting tools at the policy level caused the agent to waste iterations
 * (e.g., doing `cat` via bash when `read` tool was not granted).
 */
const ALL_MOTOR_TOOLS: MotorTool[] = [
  'read',
  'write',
  'list',
  'glob',
  'bash',
  'grep',
  'patch',
  'fetch',
];

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
      name: 'maxIterations',
      type: 'number' as const,
      description: 'Max iterations for agentic mode (default: 30)',
      required: false,
    },
    {
      name: 'skill',
      type: 'string' as const,
      description:
        'Skill name to load. Must have approved policy. Domains from policy are used automatically.',
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
    {
      name: 'skill_review',
      type: 'boolean' as const,
      description:
        'Skill security review mode: read-only tools, no network, no synthetic tools. Only callable from motor_result trigger. Requires skill param and mode:agentic.',
      required: false,
    },
  ];

  return {
    name: 'core.act',
    description:
      'Execute a task via Motor Cortex. "oneshot" runs ONLY executable JavaScript (e.g., Date.now(), JSON.parse(...)). "agentic" starts an async sub-agent for everything else: file creation, research, API calls, skill creation. All tools are always available: read, write, list, glob, bash, grep, patch, ask_user, fetch. Skills with approved policy provide domains automatically. To save or create a skill, use agentic mode. Results arrive via motor_result signal. IMPORTANT: When starting an agentic task, always tell the user the run ID so they can track it.',
    tags: ['motor', 'execution', 'async'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, context) => {
      const mode = args['mode'] as string;
      const task = args['task'] as string;
      const skillReview = args['skill_review'] as boolean | undefined;
      const triggerType = context?.triggerType;

      if (!mode || !task) {
        return {
          success: false,
          error: 'Missing required parameters: mode, task',
        };
      }

      // skill_review requires agentic mode
      if (skillReview === true && mode !== 'agentic') {
        return {
          success: false,
          error: 'skill_review requires mode:"agentic"',
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
          const explicitDomains = (args['domains'] as string[] | undefined) ?? [];

          // Handle skill_review mode
          if (skillReview === true) {
            // Trigger gate: allow from motor_result (after creation) or user_message (user-requested review)
            if (triggerType !== 'motor_result' && triggerType !== 'user_message') {
              return {
                success: false,
                error:
                  'skill_review mode can only be called from motor_result or user_message trigger.',
              };
            }

            // Require skill param
            if (!skillName) {
              return {
                success: false,
                error:
                  'skill_review mode requires the skill parameter to specify which skill to review.',
              };
            }

            // Load skill (skip trust gating for review)
            const skillResult = await loadSkill(skillName);
            if ('error' in skillResult) {
              return {
                success: false,
                error: skillResult.error,
              };
            }
            const loadedSkill = skillResult;

            // Skip input validation for review mode

            // Force read-only tools, empty domains, limited iterations
            const reviewTools: MotorTool[] = ['read', 'list', 'glob', 'grep'];
            const reviewDomains: string[] = [];
            const reviewMaxIterations = 30;

            // Build review task
            const reviewTask = `SECURITY REVIEW: Read ALL files in the workspace for skill "${skillName}".
For each file, report:
1. File path and purpose
2. Any credentials referenced (env vars like process.env.NAME, $NAME, etc.)
3. Any domains referenced (URLs, hostnames)
4. Any security concerns or suspicious patterns

Files to read: SKILL.md, and any files in scripts/ or references/ directories.
Start by listing the directory structure, then read each file.`;

            const { runId } = await motorCortex.startRun({
              task: reviewTask,
              tools: reviewTools,
              maxIterations: reviewMaxIterations,
              maxAttempts: 1,
              skill: loadedSkill,
              domains: reviewDomains,
              config: {
                syntheticTools: [],
                installDependencies: false,
                mergePolicyDomains: false,
              },
            });

            return {
              success: true,
              data: {
                mode: 'agentic',
                runId,
                status: 'started',
                skill: skillName,
                message: `Security review started for skill "${skillName}" (run: ${runId}). Results will arrive via motor_result signal.`,
              },
            };
          }

          // Normal execution (not skill_review)
          const maxIterations = (args['maxIterations'] as number | undefined) ?? 30;

          // Load skill if specified
          let loadedSkill: LoadedSkill | undefined = undefined;
          const tools: MotorTool[] = ALL_MOTOR_TOOLS;
          let domains = explicitDomains;
          const warnings: string[] = [];

          if (skillName) {
            const skillResult = await loadSkill(skillName);
            if ('error' in skillResult) {
              // Guide the model: if skill doesn't exist, it needs to be created
              // via core.act WITHOUT skill param (Scenario 7 from skill-lifecycle.md)
              const isNotFound = skillResult.error.includes('ENOENT');
              return {
                success: false,
                error: isNotFound
                  ? `Skill "${skillName}" does not exist yet. ` +
                    `To CREATE a new skill, call core.act WITHOUT the skill parameter: ` +
                    `core.act(mode:"agentic", task:"Fetch skill from [URL]...", domains:[...]).` +
                    ` The skill param is only for loading EXISTING skills.`
                  : skillResult.error,
              };
            }
            loadedSkill = skillResult;

            const policy = loadedSkill.policy;

            // Trust gating — block unapproved skills
            if (policy && policy.trust !== 'approved') {
              const trustLabel =
                policy.trust === 'pending_review'
                  ? 'pending approval (new skill)'
                  : 'needs re-approval (content changed)';
              return {
                success: false,
                error:
                  `Skill "${skillName}" is ${trustLabel}. ` +
                  `If the user has already consented, call core.skill(action:"approve", name:"${skillName}") now. ` +
                  `Otherwise, use core.skill(action:"read", name:"${skillName}") to show them what it does first. ` +
                  `Do not retry core.act until the skill is approved.`,
              };
            }

            if (!policy) {
              // No policy at all — needs onboarding
              return {
                success: false,
                error:
                  `Skill "${skillName}" has no policy. ` +
                  `Run onboarding first. ` +
                  `Example: core.skill(action:"read", name:"${skillName}") to inspect it.`,
              };
            }

            // Merge domains: policy + explicit
            if (policy.allowedDomains) {
              domains = [...new Set([...policy.allowedDomains, ...explicitDomains])];
            }

            // Note: credentials are handled by Motor Cortex via CredentialStore

            // Validate inputs against skill schema
            const inputErrors = validateSkillInputs(loadedSkill, inputs);
            if (inputErrors.length > 0) {
              return {
                success: false,
                error: `Skill input validation failed: ${inputErrors.join('; ')}`,
              };
            }
          }

          // Validate domains before starting — catch wildcards, IPs, etc.
          const invalidDomains = domains.filter((d) => !isValidDomain(d));
          if (invalidDomains.length > 0) {
            return {
              success: false,
              error:
                `Invalid domain names: ${invalidDomains.join(', ')}. ` +
                `Wildcards (*.example.com) are not supported — enumerate specific subdomains ` +
                `(e.g., "github.com", "api.github.com", "raw.githubusercontent.com").`,
            };
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
            config: {
              syntheticTools: [
                'ask_user',
                'save_credential',
                'request_approval',
              ] as SyntheticTool[],
              installDependencies: true,
              mergePolicyDomains: true,
            },
          });

          // Note: Auto-discovery mode - no index.json to update
          // Skill metadata is read directly from SKILL.md on each access

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
