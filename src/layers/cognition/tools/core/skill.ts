/**
 * Core Skill Tool
 *
 * Unified tool for skill operations:
 * - read: inspect skill content (frontmatter, body, policy, trust)
 * - review: get deterministic security review (evidence, files, provenance)
 * - approve: approve a pending/needs_reapproval skill for Motor Cortex execution
 * - reject: reset trust to needs_reapproval
 * - delete: permanently remove a skill directory
 *
 * Replaces the old core.approveSkill tool, following the same merge pattern
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
import type { SkillPolicy } from '../../../../runtime/skills/skill-types.js';
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
  trust?: string | undefined;
  // review action fields
  review?: SkillReview | undefined;
  // approve/reject action fields
  allowedDomains?: string[] | undefined;
}

/**
 * Dependencies for the skill tool.
 */
export interface SkillToolDeps {
  /** Base directory for skills (e.g., data/skills) */
  skillsDir: string;
}

/**
 * Create the core.skill tool.
 */
export function createSkillTool(deps: SkillToolDeps): Tool {
  const { skillsDir } = deps;

  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      required: true,
      description:
        'Action to perform: read (inspect skill content), review (security review with evidence), approve (approve for execution), reject (reset trust to needs_reapproval), delete (permanently remove skill)',
      enum: ['read', 'review', 'approve', 'reject', 'delete'],
    },
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Skill name from <available_skills>',
    },
  ];

  return {
    name: 'core.skill',
    maxCallsPerTurn: 3,
    description:
      "Read skill content, review for approval, approve/reject/delete a skill. Use action=read to inspect a skill's instructions and policy. Use action=review for security review with evidence. Use action=approve or reject to change trust state. Use action=delete to permanently remove a skill. IMPORTANT: Skills with trust pending_review cannot be approved directly — you must first run action=review for deterministic facts, then dispatch core.act(skill_review:true) for file analysis, present both to the user, and only approve after their explicit confirmation.",
    tags: ['skills'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, context): Promise<SkillResult> => {
      const action = args['action'] as string | undefined;
      const skillName = args['name'] as string | undefined;

      if (!action || !['read', 'review', 'approve', 'reject', 'delete'].includes(action)) {
        return {
          success: false,
          error:
            'Missing or invalid parameter: action (must be read, review, approve, reject, or delete)',
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
          trust: loaded.policy?.trust ?? 'no_policy',
          body: loaded.body,
          policy: loaded.policy ? sanitizePolicyForDisplay(loaded.policy) : undefined,
        };
      }

      // --- review (always allowed) ---
      if (action === 'review') {
        const review = await reviewSkill(loaded);

        // Transition pending_review → needs_reapproval so approve is unblocked after review
        if (loaded.policy?.trust === 'pending_review') {
          await savePolicy(loaded.path, { ...loaded.policy, trust: 'needs_reapproval' });
        }

        return { success: true, skill: skillName, review };
      }

      // --- CONSENT GATE: approve, reject, delete require user_message trigger ---
      if (context?.triggerType !== 'user_message') {
        return {
          success: false,
          error:
            'Skill mutations require user interaction. Present the review (action="review") and wait for user response before calling approve/reject/delete.',
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
      if (!loaded.policy) {
        return {
          success: false,
          error: `Skill "${skillName}" has no policy — cannot change trust`,
        };
      }

      if (action === 'approve' && loaded.policy.trust === 'approved') {
        return {
          success: false,
          error: `Skill "${skillName}" is already approved`,
        };
      }

      // Gate: pending_review skills must be reviewed before approval
      if (action === 'approve' && loaded.policy.trust === 'pending_review') {
        return {
          success: false,
          error: `Skill "${skillName}" has trust "pending_review" and must be reviewed before approval. Run core.skill(action:"review", name:"${skillName}") for deterministic facts, then core.act(mode:"agentic", skill:"${skillName}", skill_review:true, task:"Read all files and report findings") for file analysis. Present both to the user, then call approve after their confirmation.`,
        };
      }

      const updatedPolicy: SkillPolicy = { ...loaded.policy };

      if (action === 'approve') {
        updatedPolicy.trust = 'approved';
        updatedPolicy.approvedBy = 'user';
        updatedPolicy.approvedAt = new Date().toISOString();

        // Stamp the current content hash so loadSkill() won't reset trust on next load
        const currentHash = await computeDirectoryHash(loaded.path);
        if (updatedPolicy.provenance) {
          updatedPolicy.provenance = { ...updatedPolicy.provenance, contentHash: currentHash };
        }
      } else {
        updatedPolicy.trust = 'needs_reapproval';
        delete updatedPolicy.approvedBy;
        delete updatedPolicy.approvedAt;
      }

      await savePolicy(loaded.path, updatedPolicy);

      // No index.json update needed — auto-discovery reads from disk directly

      return {
        success: true,
        skill: skillName,
        trust: updatedPolicy.trust,
        allowedDomains: updatedPolicy.allowedDomains,
      };
    },
  };
}
