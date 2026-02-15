/**
 * Core Skill Tool
 *
 * Unified tool for skill operations:
 * - read: inspect skill content (frontmatter, body, policy, status)
 * - review: get deterministic security review (files, provenance)
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
  // approve/reject action fields
  domains?: string[] | undefined;
  // update action fields
  credentials?: string[] | undefined;
  tools?: unknown[] | undefined;
  dependencies?: unknown;
}

/**
 * Dependencies for skill tool.
 */
export interface SkillToolDeps {
  /** Base directory for skills (e.g., data/skills) */
  skillsDir: string;
}

/**
 * Create core.skill tool.
 */
export function createSkillTool(deps: SkillToolDeps): Tool {
  const { skillsDir } = deps;

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
      "Read skill content, review for approval, approve/reject/delete/update a skill. Use action=read to inspect a skill's instructions and policy. Use action=review for security review (transitions status to 'reviewed'). Use action=approve or reject to change status. Use action=delete to permanently remove a skill. Use action=update to modify policy fields: domains, credentials, tools, dependencies). Status lifecycle: pending_review → reviewed (after review) → approved (after user approval). Content changes → needs_reapproval → reviewed → approved. If user asks to approve a pending_review skill without review, ask them to confirm first — they may skip to review if they wish.",
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

        // Transition pending_review/needs_reapproval → reviewed after security review
        if (
          loaded.policy?.status === 'pending_review' ||
          loaded.policy?.status === 'needs_reapproval'
        ) {
          await savePolicy(loaded.path, { ...loaded.policy, status: 'reviewed' });
        }

        return { success: true, skill: skillName, review };
      }

      // --- CONSENT GATE: approve, reject, delete, update require user_message trigger ---
      if (context?.triggerType !== 'user_message') {
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
        // Validate: requires skill with existing policy (except pending_review)
        if (!loaded.policy) {
          return {
            success: false,
            error: `Skill "${skillName}" has no policy. Cannot update without policy. Use action=read to inspect it first.`,
          };
        }
        if (loaded.policy.status === 'pending_review') {
          return {
            success: false,
            error: `Skill "${skillName}" status is "pending_review". Cannot update without policy. Use action=review first.`,
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

        // Validate domains (if specified)
        if (addDomains ?? removeDomains) {
          const domains = [...(addDomains ?? []), ...(removeDomains ?? [])];
          for (const domain of domains) {
            if (!isValidDomain(domain)) {
              return {
                success: false,
                error: `Invalid domain: ${domain}. Wildcards (*.example.com) are not supported — enumerate specific subdomains (e.g., "github.com", "api.github.com", "raw.githubusercontent.com").`,
              };
            }
          }
        }

        // Validate dependencies (if specified)
        if (addDependencies ?? removeDependencies) {
          const toValidate = [...(addDependencies ?? []), ...(removeDependencies ?? [])];
          for (const dep of toValidate) {
            const { ecosystem, packages } = dep;
            if (ecosystem.length === 0 || packages.length === 0) {
              return {
                success: false,
                error: `Invalid dependency: ${JSON.stringify(dep)}. Must specify ecosystem ("npm" or "pip") and packages array.`,
              };
            }
            for (const pkg of packages) {
              if (!pkg.name || !pkg.version) {
                return {
                  success: false,
                  error: `Invalid dependency package: ${JSON.stringify(pkg)}. Must specify name and version.`,
                };
              }
            }
          }
        }

        // Apply updates to policy
        const updatedPolicy: SkillPolicy = { ...loaded.policy };

        if (addDomains && addDomains.length > 0) {
          updatedPolicy.domains = [...(updatedPolicy.domains ?? []), ...addDomains];
        }
        if (removeDomains && removeDomains.length > 0) {
          updatedPolicy.domains = (updatedPolicy.domains ?? []).filter(
            (d) => !removeDomains.includes(d)
          );
        }

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

        if (addDependencies && addDependencies.length > 0) {
          updatedPolicy.dependencies ??= {};
          const deps = updatedPolicy.dependencies;
          // Merge: for each ecosystem, union-add packages (deduped by name)
          for (const dep of addDependencies) {
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

        return {
          success: true,
          skill: skillName,
          status: updatedPolicy.status,
          domains: updatedPolicy.domains,
          credentials: updatedPolicy.requiredCredentials,
          tools: updatedPolicy.tools,
          dependencies: updatedPolicy.dependencies,
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    },
  };
}
