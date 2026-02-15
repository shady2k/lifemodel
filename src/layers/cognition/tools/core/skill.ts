/**
 * Core Skill Tool
 *
 * Unified tool for skill operations:
 * - read: inspect skill content (frontmatter, body, policy, status)
 * - review: deterministic security review + Motor deep review dispatch
 * - approve: approve a pending/needs_reapproval skill for Motor Cortex execution
 * - reject: reset status to needs_reapproval
 * - delete: permanently remove a skill directory
 * - update: modify policy fields (domains, credentials, tools, dependencies)
 *
 * Replaces old core.approveSkill tool, following the same merge pattern
 * used for core.task (formerly core.tasks).
 *
 * Consent gating: approve, reject, and delete require user_message trigger.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import { rm } from 'node:fs/promises';
import {
  loadSkill,
  savePolicy,
  computeDirectoryHash,
} from '../../../../runtime/skills/skill-loader.js';
import type { SkillPolicy, MotorToolName } from '../../../../runtime/skills/skill-types.js';
import { sanitizePolicyForDisplay } from '../../../../runtime/skills/skill-types.js';
import { reviewSkill } from '../../../../runtime/skills/skill-review.js';
import type { SkillReview } from '../../../../runtime/skills/skill-review.js';
import type { MotorCortex } from '../../../../runtime/motor-cortex/motor-cortex.js';
import type { MotorTool } from '../../../../runtime/motor-cortex/motor-protocol.js';
import { buildMotorSystemPrompt } from '../../../../runtime/motor-cortex/motor-prompt.js';
import { prepareSkillWorkspace } from '../../../../runtime/skills/skill-workspace.js';
import { randomUUID } from 'node:crypto';

/**
 * Result from core.skill tool execution.
 */
export interface SkillResult {
  success: boolean;
  error?: string | undefined;
  skill?: string | undefined;
  // read action fields
  frontmatter?: Record<string, unknown> | undefined;
  body?: string | undefined;
  policy?: SkillPolicy | undefined;
  status?: string | undefined;
  // review action fields
  review?: SkillReview | undefined;
  motorReviewDispatched?: boolean | undefined;
  runId?: string | undefined;
  // approve/reject action fields
  domains?: string[] | undefined;
  // update action fields
  credentials?: string[] | undefined;
  tools?: unknown[] | undefined;
  dependencies?: unknown;
  warnings?: string[] | undefined;
}

/**
 * Dependencies for skill tool.
 */
export interface SkillToolDeps {
  /** Base directory for skills (e.g., data/skills) */
  skillsDir: string;

  /** Motor Cortex service (for dispatching deep review runs) */
  motorCortex?: MotorCortex;

  /** Base directory for motor workspaces (for review workspace prep) */
  workspacesDir?: string;

  /** Logger for diagnostics */
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Create core.skill tool.
 */
export function createSkillTool(deps: SkillToolDeps): Tool {
  const { skillsDir, motorCortex, workspacesDir, logger: skillLogger } = deps;

  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      required: true,
      description:
        'Action to perform: read (inspect skill content), review (security review), approve (approve for execution), reject (reset status to needs_reapproval), delete (permanently remove skill), update (modify policy fields: domains, credentials, tools, dependencies)',
      enum: ['read', 'review', 'approve', 'reject', 'delete', 'update'],
    },
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Skill name from <available_skills>',
    },
    {
      name: 'addDomains',
      type: 'array',
      required: false,
      description: 'Network domains to add to the skill policy (e.g., ["api.example.com"])',
    },
    {
      name: 'removeDomains',
      type: 'array',
      required: false,
      description: 'Network domains to remove from the skill policy (e.g., ["old-api.com"])',
    },
    {
      name: 'addCredentials',
      type: 'array',
      required: false,
      description: 'Credential names to add to the skill policy (e.g., ["api_key", "webhook_url"])',
    },
    {
      name: 'removeCredentials',
      type: 'array',
      required: false,
      description: 'Credential names to remove from the skill policy (e.g., ["old_key"])',
    },
    {
      name: 'addDependencies',
      type: 'array',
      required: false,
      description:
        'Dependencies to add (e.g., [{ecosystem:"npm", packages:[{name:"package-name", version:"1.2.3"}]}])',
    },
    {
      name: 'removeDependencies',
      type: 'array',
      required: false,
      description:
        'Dependencies to remove (e.g., [{ecosystem:"npm", packages:[{name:"old-package", version:"1.0.0"}]}])',
    },
    {
      name: 'addTools',
      type: 'array',
      required: false,
      description: 'Motor tools to add to the skill policy (e.g., ["fetch", "bash"])',
    },
    {
      name: 'removeTools',
      type: 'array',
      required: false,
      description: 'Motor tools to remove from the skill policy (e.g., ["bash"])',
    },
  ];

  return {
    name: 'core.skill',
    maxCallsPerTurn: 3,
    description:
      "Read skill content, review for approval, approve/reject/delete/update a skill. Use action=read to inspect a skill's instructions and policy. Use action=review for full security review: runs deterministic extraction AND dispatches a Motor deep review automatically (pending_review/needs_reapproval → reviewing). Call again after Motor completes to transition reviewing → reviewed. Use action=approve or reject to change status. Use action=delete to permanently remove a skill. Use action=update to modify policy fields: domains, credentials, tools, dependencies. Status lifecycle: pending_review → reviewing (review dispatched) → reviewed (Motor review done) → approved (user approval). Content changes → needs_reapproval → same cycle.",
    tags: ['skills'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, context): Promise<SkillResult> => {
      const action = args['action'] as string | undefined;
      const skillName = args['name'] as string | undefined;

      if (
        !action ||
        !['read', 'review', 'approve', 'reject', 'delete', 'update'].includes(action)
      ) {
        return {
          success: false,
          error:
            'Missing or invalid parameter: action (must be read, review, approve, reject, delete, or update)',
        };
      }
      if (!skillName || typeof skillName !== 'string') {
        return { success: false, error: 'Missing required parameter: name' };
      }

      // Load the skill
      const loaded = await loadSkill(skillName, skillsDir);
      if ('error' in loaded) {
        return { success: false, error: loaded.error };
      }

      // --- read (always allowed) ---
      if (action === 'read') {
        return {
          success: true,
          skill: skillName,
          frontmatter: loaded.frontmatter as unknown as Record<string, unknown>,
          status: loaded.policy?.status ?? 'no_policy',
          body: loaded.body,
          policy: loaded.policy ? sanitizePolicyForDisplay(loaded.policy) : undefined,
        };
      }

      // --- review (always allowed) ---
      if (action === 'review') {
        const review = await reviewSkill(loaded);

        if (!loaded.policy) {
          return { success: true, skill: skillName, review };
        }

        const status = loaded.policy.status;

        // Phase 1: dispatch Motor deep review for skills needing first review,
        // or when user explicitly re-reviews (reviewed status + user_message trigger only)
        const needsFirstReview = status === 'pending_review' || status === 'needs_reapproval';
        const userReReview = status === 'reviewed' && context?.triggerType === 'user_message';
        if (needsFirstReview || userReReview) {
          // Dispatch Motor deep review if Motor Cortex is available
          if (motorCortex && workspacesDir) {
            try {
              const reviewTools: MotorTool[] = ['read', 'list', 'glob', 'grep'];
              const reviewTask = `SECURITY REVIEW for skill "${skillName}".
Read ALL files in the workspace (SKILL.md, scripts/, references/) and produce a structured report for the user.

Steps:
1. List the workspace to find all files
2. Read each file completely
3. Use grep to find credentials (process.env, os.environ, $VAR) and domains (URLs, hostnames)
4. Use grep to find package references: require(), import statements, package.json dependencies, pip install references

Output format — produce EXACTLY this structure:

**What this skill does:** 1-2 sentences describing concrete capabilities.

**Files:**
- filename (size) — purpose

**Credentials needed:**
- ENV_VAR_NAME — what it's for, where to get it (e.g. "register at console.example.com")

**Domains used:**
- domain.com — what the skill uses it for

**Packages referenced:**
- ecosystem: package-name@version — what it's used for (e.g. "npm: agentmail@1.0.0 — SDK client")

**Security assessment:**
- Note any concerns or confirm no suspicious patterns found

**Setup steps for user:**
1. Numbered steps the user must complete (get API key, set env var, add domain to policy, etc.)

Be specific and actionable. Do NOT give generic advice. Every credential, domain, package, and setup step must come from actual file content you read.`;

              // Prepare workspace with skill files
              const prepared = await prepareSkillWorkspace(
                loaded.path,
                workspacesDir,
                randomUUID(),
                skillLogger as Parameters<typeof prepareSkillWorkspace>[3]
              );

              // Build system prompt for review mode
              const reviewSystemPrompt = buildMotorSystemPrompt({
                task: reviewTask,
                tools: reviewTools,
                syntheticTools: [],
                domains: [],
                maxIterations: 30,
              });

              // Dispatch Motor run — status transition happens AFTER successful startRun
              const { runId } = await motorCortex.startRun({
                task: reviewTask,
                tools: reviewTools,
                maxIterations: 30,
                maxAttempts: 1,
                domains: [],
                syntheticTools: [],
                systemPrompt: reviewSystemPrompt,
                workspacePath: prepared.workspacePath,
                skillName,
                skillReview: true,
              });

              // Only transition status after successful dispatch (atomic — no stuck reviewing state)
              await savePolicy(loaded.path, { ...loaded.policy, status: 'reviewing' });

              return {
                success: true,
                skill: skillName,
                review,
                motorReviewDispatched: true,
                runId,
              };
            } catch (err) {
              // Motor dispatch failed — don't transition status
              return {
                success: false,
                error: `Deterministic review succeeded but Motor deep review failed to start: ${err instanceof Error ? err.message : String(err)}. Skill status unchanged (${status}).`,
                skill: skillName,
                review,
              };
            }
          }

          // No Motor available — just do deterministic review and transition
          await savePolicy(loaded.path, { ...loaded.policy, status: 'reviewing' });
          return { success: true, skill: skillName, review, motorReviewDispatched: false };
        }

        // Phase 2: reviewing → reviewed (Motor deep review complete)
        if (status === 'reviewing') {
          await savePolicy(loaded.path, { ...loaded.policy, status: 'reviewed' });
          return { success: true, skill: skillName, review };
        }

        // approved → no-op, return fresh deterministic review data
        return { success: true, skill: skillName, review };
      }

      // --- CONSENT GATE ---
      // approve, reject, delete: always require user_message trigger
      // update: require user_message only for approved skills (seeding unapproved policy is allowed from any trigger)
      const alwaysGated = action === 'approve' || action === 'reject' || action === 'delete';
      const updateGated = action === 'update' && loaded.policy?.status === 'approved';
      if ((alwaysGated || updateGated) && context?.triggerType !== 'user_message') {
        return {
          success: false,
          error:
            'Skill mutations require user interaction. Present the review (action="review") and wait for user response before calling approve/reject/delete/update.',
        };
      }

      // --- delete ---
      if (action === 'delete') {
        try {
          await rm(loaded.path, { recursive: true, force: true });
          return { success: true, skill: skillName };
        } catch (err) {
          return {
            success: false,
            error: `Failed to delete skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      // --- approve / reject ---
      if (action === 'approve' || action === 'reject') {
        if (!loaded.policy) {
          return {
            success: false,
            error: `Skill "${skillName}" has no policy — cannot change status`,
          };
        }

        if (action === 'approve' && loaded.policy.status === 'approved') {
          return {
            success: false,
            error: `Skill "${skillName}" is already approved`,
          };
        }

        const updatedPolicy: SkillPolicy = { ...loaded.policy };

        if (action === 'approve') {
          updatedPolicy.status = 'approved';
          updatedPolicy.approvedBy = 'user';
          updatedPolicy.approvedAt = new Date().toISOString();

          // Stamp current content hash so loadSkill() won't reset status on next load
          const currentHash = await computeDirectoryHash(loaded.path);
          if (updatedPolicy.provenance) {
            updatedPolicy.provenance = { ...updatedPolicy.provenance, contentHash: currentHash };
          }
        } else {
          // action === 'reject'
          updatedPolicy.status = 'needs_reapproval';
          delete updatedPolicy.approvedBy;
          delete updatedPolicy.approvedAt;
        }

        await savePolicy(loaded.path, updatedPolicy);

        // No index.json update needed — auto-discovery reads from disk directly

        return {
          success: true,
          skill: skillName,
          status: updatedPolicy.status,
          domains: updatedPolicy.domains,
        };
      }

      // --- update (modify policy fields: domains, credentials, tools, dependencies) ---
      if (action === 'update') {
        // Validate: requires skill with existing policy
        if (!loaded.policy) {
          return {
            success: false,
            error: `Skill "${skillName}" has no policy. Cannot update without policy. Use action=read to inspect it first.`,
          };
        }

        // Validate action sub-parameters
        const addDomains = args['addDomains'] as string[] | undefined;
        const removeDomains = args['removeDomains'] as string[] | undefined;
        const addCredentials = args['addCredentials'] as string[] | undefined;
        const removeCredentials = args['removeCredentials'] as string[] | undefined;
        const addDependencies = args['addDependencies'] as
          | { ecosystem: string; packages: { name: string; version: string }[] }[]
          | undefined;
        const removeDependencies = args['removeDependencies'] as
          | { ecosystem: string; packages: { name: string; version: string }[] }[]
          | undefined;
        const addTools = args['addTools'] as string[] | undefined;
        const removeTools = args['removeTools'] as string[] | undefined;

        const hasUpdateFields = [
          addDomains?.length ?? 0,
          removeDomains?.length ?? 0,
          addCredentials?.length ?? 0,
          removeCredentials?.length ?? 0,
          addDependencies?.length ?? 0,
          removeDependencies?.length ?? 0,
          addTools?.length ?? 0,
          removeTools?.length ?? 0,
        ].some((count) => count > 0);

        if (!hasUpdateFields) {
          return {
            success: false,
            error:
              'Update action requires at least one sub-parameter: addDomains, removeDomains, addCredentials, removeCredentials, addDependencies, removeDependencies, addTools, removeTools',
          };
        }

        // Import validators
        const { isValidDomain } = await import('../../../../runtime/container/network-policy.js');

        // Apply updates to policy, collecting warnings for invalid fields.
        // Valid fields are applied even if other fields fail validation —
        // this prevents data loss when the model sends a single update call
        // with a mix of valid and invalid fields.
        const updatedPolicy: SkillPolicy = { ...loaded.policy };
        const warnings: string[] = [];

        // Domains — validate format and DNS then apply
        if (addDomains ?? removeDomains) {
          const invalidDomains: string[] = [];
          const unresolvableDomains: string[] = [];
          const formatValid = (addDomains ?? []).filter((d) => {
            if (!isValidDomain(d)) {
              invalidDomains.push(d);
              return false;
            }
            return true;
          });
          // DNS-validate: reject domains that don't resolve (likely hallucinated by LLM)
          const dns = await import('node:dns/promises');
          const validAddDomains: string[] = [];
          for (const d of formatValid) {
            try {
              await dns.resolve4(d);
              validAddDomains.push(d);
            } catch {
              unresolvableDomains.push(d);
            }
          }
          if (invalidDomains.length > 0) {
            warnings.push(
              `Invalid domains skipped: ${invalidDomains.join(', ')}. Wildcards (*.example.com) are not supported — enumerate specific subdomains.`
            );
          }
          if (unresolvableDomains.length > 0) {
            warnings.push(
              `Unresolvable domains skipped (DNS lookup failed): ${unresolvableDomains.join(', ')}. Check for typos.`
            );
          }
          if (validAddDomains.length > 0) {
            updatedPolicy.domains = [
              ...new Set([...(updatedPolicy.domains ?? []), ...validAddDomains]),
            ];
          }
          if (removeDomains && removeDomains.length > 0) {
            updatedPolicy.domains = (updatedPolicy.domains ?? []).filter(
              (d) => !removeDomains.includes(d)
            );
          }
        }

        // Credentials — no validation needed, apply directly
        if (addCredentials && addCredentials.length > 0) {
          updatedPolicy.requiredCredentials = [
            ...new Set([...(updatedPolicy.requiredCredentials ?? []), ...addCredentials]),
          ];
        }
        if (removeCredentials && removeCredentials.length > 0) {
          updatedPolicy.requiredCredentials = (updatedPolicy.requiredCredentials ?? []).filter(
            (c) => !removeCredentials.includes(c)
          );
        }

        // Dependencies — validate then apply
        if (addDependencies ?? removeDependencies) {
          const validAddDeps: typeof addDependencies = [];
          for (const dep of addDependencies ?? []) {
            const { ecosystem, packages } = dep;
            if (ecosystem.length === 0 || packages.length === 0) {
              warnings.push(
                `Invalid dependency skipped: ${JSON.stringify(dep)}. Must specify ecosystem ("npm" or "pip") and packages array.`
              );
              continue;
            }
            const validPkgs = [];
            for (const pkg of packages) {
              if (!pkg.name || !pkg.version) {
                warnings.push(
                  `Invalid dependency package skipped: ${JSON.stringify(pkg)}. Must specify name and version.`
                );
              } else {
                validPkgs.push(pkg);
              }
            }
            if (validPkgs.length > 0) {
              validAddDeps.push({ ecosystem, packages: validPkgs });
            }
          }
          if (validAddDeps.length > 0) {
            updatedPolicy.dependencies ??= {};
            const deps = updatedPolicy.dependencies;
            for (const dep of validAddDeps) {
              const eco = dep.ecosystem as 'npm' | 'pip';
              deps[eco] ??= { packages: [] };
              const pkgList = deps[eco].packages;
              for (const pkg of dep.packages) {
                const idx = pkgList.findIndex((p: { name: string }) => p.name === pkg.name);
                if (idx >= 0) {
                  pkgList[idx] = pkg; // Update version
                } else {
                  pkgList.push(pkg);
                }
              }
            }
          }
          if (removeDependencies && removeDependencies.length > 0 && updatedPolicy.dependencies) {
            const deps = updatedPolicy.dependencies;
            for (const dep of removeDependencies) {
              const eco = dep.ecosystem as 'npm' | 'pip';
              const ecoEntry = deps[eco];
              if (ecoEntry) {
                const names = new Set(dep.packages.map((p: { name: string }) => p.name));
                ecoEntry.packages = ecoEntry.packages.filter(
                  (p: { name: string }) => !names.has(p.name)
                );
              }
            }
          }
        }

        // Tools — no validation needed, apply directly
        if (addTools && addTools.length > 0) {
          const allTools = [...(updatedPolicy.tools ?? []), ...addTools] as (
            | MotorToolName
            | 'ALL'
          )[];
          updatedPolicy.tools = [...new Set(allTools)];
        }
        if (removeTools && removeTools.length > 0) {
          const removeSet = new Set(removeTools);
          updatedPolicy.tools = (updatedPolicy.tools ?? []).filter((t) => !removeSet.has(t));
        }

        // Persist updated policy
        await savePolicy(loaded.path, updatedPolicy);

        // No index.json update needed — auto-discovery reads from disk directly

        const result: SkillResult = {
          success: true,
          skill: skillName,
          status: updatedPolicy.status,
          domains: updatedPolicy.domains,
          credentials: updatedPolicy.requiredCredentials,
          tools: updatedPolicy.tools,
          dependencies: updatedPolicy.dependencies,
        };
        if (warnings.length > 0) {
          result.warnings = warnings;
        }
        return result;
      }

      return { success: false, error: `Unknown action: ${action}` };
    },
  };
}
