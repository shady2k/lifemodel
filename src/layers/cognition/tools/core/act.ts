/**
 * Core Act Tool
 *
 * Execute tasks via Motor Cortex.
 * "oneshot" runs JS code synchronously.
 * "agentic" starts an async sub-agent task.
 *
 * For skill runs, resolves everything from policy and passes explicit config to Motor Cortex.
 * For non-skill runs, passes full tools and explicit domains.
 */

import type { Tool } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type { MotorCortex } from '../../../../runtime/motor-cortex/motor-cortex.js';
import type { MotorTool, SyntheticTool } from '../../../../runtime/motor-cortex/motor-protocol.js';
import type { MotorToolName } from '../../../../runtime/skills/skill-types.js';
import { loadSkill, validateSkillInputs } from '../../../../runtime/skills/skill-loader.js';
import { isValidDomain } from '../../../../runtime/container/network-policy.js';
import type { LoadedSkill } from '../../../../runtime/skills/skill-types.js';
import type { CredentialStore } from '../../../../runtime/vault/credential-store.js';
import { installSkillDependencies } from '../../../../runtime/dependencies/dependency-manager.js';
import { buildMotorSystemPrompt } from '../../../../runtime/motor-cortex/motor-prompt.js';
import { prepareSkillWorkspace } from '../../../../runtime/skills/skill-workspace.js';

/**
 * Build skill-specific instructions for the Motor Cortex sub-agent.
 *
 * This is business logic about skills — Motor Cortex doesn't know about it.
 * The result is passed as `callerInstructions` to the prompt builder.
 */
function buildSkillInstructions(opts: {
  hasWriteTool: boolean;
  skillName?: string;
  skillDescription?: string;
  hasDependencies: boolean;
  credentialNames?: string[];
}): string {
  const parts: string[] = [];

  // Skill creation/modification instructions (when write tool is available)
  if (opts.hasWriteTool) {
    parts.push(`You create and maintain Agent Skills — modular, filesystem-based capabilities. A Skill packages instructions, metadata, and optional resources (scripts, templates, reference docs) so the agent can reuse them automatically.

Skill directory structure:
  SKILL.md           — required: frontmatter metadata + step-by-step instructions
  references/        — optional: API docs, schemas, examples
  scripts/           — optional: helper scripts the instructions reference

SKILL.md format:
---
name: skill-name
description: What this skill does and when to use it (max 1024 chars). Include BOTH what the skill does AND when the agent should trigger it.
---
# Skill Name

## Quick start
[Minimal working example]

## Instructions
[Step-by-step procedures, organized by task type]

## Examples
[Concrete usage examples with expected inputs/outputs]

## Edge cases
[Error handling, fallbacks, known limitations]

The frontmatter (name + description) is always loaded at startup so the agent knows the skill exists.
The body is only loaded when the skill is triggered, so keep it focused and actionable.
Reference files (references/, scripts/) are loaded on demand — link to them from the instructions.

If an official SDK (npm or pip package) exists for the API, ALWAYS prefer it over raw HTTP calls.
Mention the SDK in SKILL.md with installation instructions: "npm install package-name@x.y.z" or "pip install package-name==x.y.z".
SKILL.md examples should use the SDK, not raw curl/fetch. Find the latest package version from the API documentation.

Status is always "pending_review" for new skills — the user reviews and approves before first use.

Save files at the workspace root (e.g. write({path: "SKILL.md", content: "..."})).
Reference files go in subdirectories: write({path: "references/api-docs.md", content: "..."}).
These files will be automatically extracted and installed after your run completes.
Name rules: must start with letter, lowercase a-z, numbers, hyphens. No leading/trailing/consecutive hyphens. Max 64 chars.`);
  }

  // Skill execution instructions (when running a specific skill)
  if (opts.skillName && opts.skillDescription) {
    const firstCred = opts.credentialNames?.[0] ?? '';
    const credSection =
      opts.credentialNames && opts.credentialNames.length > 0
        ? `\nAvailable credentials (as env vars):\n${opts.credentialNames.map((c) => `- ${c}`).join('\n')}\nUsage:\n  Node script: const apiKey = process.env.${firstCred};\n  Python:      api_key = os.environ["${firstCred}"]\n  bash:        curl -H "Authorization: Bearer $${firstCred}"\n  fetch tool:  {"Authorization": "Bearer $${firstCred}"}`
        : '';

    const depSection = opts.hasDependencies
      ? `IMPORTANT: SKILL.md contains tested, working code examples. Use them EXACTLY as written — copy constructors, method names, and argument shapes from the examples. Do NOT guess or invent API usage. If something fails, re-read SKILL.md and compare your code against the examples before trying alternatives.
Pre-installed packages are available — use require() or import directly.`
      : `No SDK packages are pre-installed for this skill. SKILL.md examples may use SDK calls — do NOT copy them directly. Instead, use the fetch tool or Node's built-in global fetch() for raw HTTP API calls. Check the API documentation or reference files for the correct HTTP endpoints, methods, and request formats. Do NOT guess URL paths from SDK method names.`;

    parts.push(`A skill is available for this task. Read its files before starting work.
Skill: ${opts.skillName} — ${opts.skillDescription}
Start by reading SKILL.md: read({path: "SKILL.md"}). Check for reference files too: list({path: "."}).
${depSection}
You can modify skill files directly in the workspace using write or patch. Changes are automatically extracted and installed after your run completes.
Do NOT run npm install or pip install — package registries are not reachable at runtime.
${credSection}

SKILL IMPROVEMENT REQUIREMENT:
After completing the task, if ANY of these occurred, you MUST update the skill files before finishing:
- You encountered errors following SKILL.md (wrong endpoints, incorrect parameters, deprecated methods)
- You had to fetch external docs or reference files to figure out how to do something SKILL.md should have covered
- SKILL.md only has SDK examples but you had to use raw HTTP (add HTTP examples alongside SDK ones)
- You discovered missing information (correct URL paths, required headers, response formats)
Update SKILL.md and/or reference files in the workspace using write or patch. Changes are reviewed before replacing the current version.
Do NOT skip this step — future runs should not repeat the same discovery process.

WORKSPACE CLEANUP:
Before finishing, delete any temporary files you created (test scripts, debug files, scratch files) that are NOT part of the skill.
All files left in the workspace are permanently saved as part of the skill.
Keep: SKILL.md, references/, scripts/ (reusable helpers referenced by SKILL.md).
Delete: one-off test scripts, debug output, temp files.

Note: you can only reach domains approved for this run.
If you need a new domain, use ask_user to request it.`);
  }

  return parts.join('\n\n');
}

/**
 * All sandboxed tools for non-skill runs.
 * Container isolation (--read-only, --network none, --cap-drop ALL) is the security boundary.
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
 * Dependencies for the act tool.
 */
export interface ActToolDeps {
  /** Motor Cortex service */
  motorCortex: MotorCortex;

  /** Credential store for resolving credentials */
  credentialStore?: CredentialStore;

  /** Skills directory absolute path */
  skillsDir: string;

  /** Base directory for motor workspaces */
  workspacesDir: string;

  /** Logger for diagnostics */
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Resolve policy.tools to actual MotorTool array.
 * - undefined → ALL (backward compat)
 * - ["ALL"] → ALL
 * - ["read", "write", ...] → as-is
 * - ["ALL", "read"] → error (ambiguous)
 */
function resolveTools(policyTools: ('ALL' | MotorToolName)[] | undefined): MotorTool[] {
  if (!policyTools || policyTools.length === 0) {
    return ALL_MOTOR_TOOLS;
  }

  if (policyTools.includes('ALL')) {
    if (policyTools.length > 1) {
      throw new Error('policy.tools cannot combine "ALL" with specific tools (ambiguous)');
    }
    return ALL_MOTOR_TOOLS;
  }

  return policyTools as MotorTool[];
}

/**
 * Create the core.act tool.
 */
export function createActTool(deps: ActToolDeps): Tool {
  const { motorCortex, credentialStore, skillsDir, workspacesDir, logger: actLogger } = deps;
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
        'Network domains to allow access to (e.g., ["api.example.com"]). For non-skill runs only; ignored for skill runs (use core.skill action:"update" to set policy domains).',
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
          const explicitDomains = (args['domains'] as string[] | undefined) ?? [];

          const maxIterations = (args['maxIterations'] as number | undefined) ?? 30;

          // Load skill if specified
          let loadedSkill: LoadedSkill | undefined = undefined;
          let tools: MotorTool[] = ALL_MOTOR_TOOLS;
          let domains = explicitDomains;
          let credentials: Record<string, string> | undefined;
          let credentialNames: string[] | undefined;
          let preparedDeps: Awaited<ReturnType<typeof installSkillDependencies>> | undefined;
          const warnings: string[] = [];

          if (skillName) {
            const skillResult = await loadSkill(skillName, skillsDir);
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

            // Status gating — block unapproved skills
            if (policy && policy.status !== 'approved') {
              const statusLabels: Record<string, string> = {
                pending_review: 'pending approval (new skill, not yet reviewed)',
                reviewing: 'under review (Motor deep review in progress)',
                reviewed: 'reviewed but not yet approved',
                needs_reapproval: 'needs re-approval (content changed)',
              };
              const statusLabel = statusLabels[policy.status] ?? policy.status;
              return {
                success: false,
                error:
                  `Skill "${skillName}" is ${statusLabel}. ` +
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

            // Resolve tools from policy
            try {
              tools = resolveTools(policy.tools);
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }

            // Domains: policy is authoritative for approved skills.
            // Cognition cannot grant arbitrary network access by passing explicit domains.
            if (policy.domains && policy.domains.length > 0) {
              domains = [...policy.domains]; // Clone — don't mutate policy object
            } else {
              domains = [];
            }
            if (explicitDomains.length > 0) {
              warnings.push(
                `Explicit domains ignored for skill "${skillName}" — use policy.domains instead.`
              );
            }

            // Resolve credentials: policy.credentialValues + credentialStore
            credentialNames = policy.requiredCredentials;
            if (credentialNames && credentialNames.length > 0 && credentialStore) {
              credentials = {};
              for (const name of credentialNames) {
                // Policy-stored values take precedence
                const policyValue = policy.credentialValues?.[name];
                if (policyValue) {
                  credentials[name] = policyValue;
                } else {
                  const storeValue = credentialStore.get(name);
                  if (storeValue) {
                    credentials[name] = storeValue;
                  }
                }
              }
            }

            // Fail-fast if required credentials are missing
            if (credentialNames && credentialNames.length > 0) {
              const missingCreds = credentialNames.filter((name) => !credentials?.[name]);
              if (missingCreds.length > 0) {
                return {
                  success: false,
                  error:
                    `Missing required credentials for skill "${skillName}": ` +
                    missingCreds
                      .map((n) => {
                        const upper = n.toUpperCase();
                        return upper.startsWith('VAULT_') ? upper : `VAULT_${upper}`;
                      })
                      .join(', ') +
                    '. Set them as environment variables and restart.',
                };
              }
            }

            // Pre-install dependencies if present
            if (policy.dependencies) {
              try {
                const { join: pathJoin, dirname: pathDirname } = await import('node:path');
                const cacheDir = pathJoin(pathDirname(skillsDir), 'dependency-cache');
                preparedDeps = await installSkillDependencies(
                  policy.dependencies,
                  cacheDir,
                  skillName,
                  actLogger as Parameters<typeof installSkillDependencies>[3]
                );
              } catch (err) {
                return {
                  success: false,
                  error: `Failed to install skill dependencies: ${err instanceof Error ? err.message : String(err)}`,
                };
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

          // Prepare workspace for skill runs (copy skill files + baseline)
          let workspacePath: string | undefined;
          if (loadedSkill) {
            try {
              const prepared = await prepareSkillWorkspace(
                loadedSkill.path,
                workspacesDir,
                crypto.randomUUID(),
                actLogger as Parameters<typeof prepareSkillWorkspace>[3]
              );
              workspacePath = prepared.workspacePath;
            } catch (err) {
              return {
                success: false,
                error: `Failed to prepare skill workspace: ${err instanceof Error ? err.message : String(err)}`,
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

          // Build system prompt
          const syntheticTools: SyntheticTool[] = [
            'ask_user',
            'save_credential',
            'request_approval',
          ];
          const hasDependencies = preparedDeps !== undefined;

          // Build skill-specific instructions (business logic — Motor doesn't know about this)
          const callerInstructions = buildSkillInstructions({
            hasWriteTool: tools.includes('write'),
            ...(loadedSkill && { skillName: loadedSkill.frontmatter.name }),
            ...(loadedSkill && { skillDescription: loadedSkill.frontmatter.description }),
            hasDependencies,
            ...(credentialNames && { credentialNames }),
          });

          const systemPrompt = buildMotorSystemPrompt({
            task: fullTask,
            tools,
            syntheticTools,
            ...(domains.length > 0 && { domains }),
            maxIterations,
            ...(callerInstructions && { callerInstructions }),
          });

          const { runId } = await motorCortex.startRun({
            task: fullTask,
            tools,
            maxIterations,
            ...(domains.length > 0 && { domains }),
            syntheticTools,
            systemPrompt,
            // Credentials (passed explicitly)
            ...(credentials && { credentials }),
            ...(credentialNames && { credentialNames }),
            // Dependencies (pre-installed)
            ...(preparedDeps && { preparedDeps }),
            // Workspace (pre-prepared for skill runs)
            ...(workspacePath && { workspacePath }),
            // Skill name (for extraction middleware)
            ...(skillName && { skillName }),
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
