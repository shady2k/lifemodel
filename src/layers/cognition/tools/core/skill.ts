/**
 * Core Skill Tool
 *
 * Unified tool for skill operations:
 * - read: inspect skill content (frontmatter, body, policy, trust)
 * - approve: approve a pending/needs_reapproval skill for Motor Cortex execution
 * - reject: reset trust to needs_reapproval
 *
 * Replaces the old core.approveSkill tool, following the same merge pattern
 * used for core.task (formerly core.tasks).
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import {
  loadSkill,
  savePolicy,
  updateSkillIndex,
  computeDirectoryHash,
} from '../../../../runtime/skills/skill-loader.js';
import type { SkillPolicy } from '../../../../runtime/skills/skill-types.js';

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
  // approve/reject action fields
  allowedTools?: string[] | undefined;
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
        'Action to perform: read (inspect skill content), approve (approve for execution), reject (reset trust to needs_reapproval)',
      enum: ['read', 'approve', 'reject'],
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
      "Read skill content or approve/reject a skill for execution. Use action=read to inspect a skill's instructions and policy. Use action=approve or reject to change trust state.",
    tags: ['skills'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args): Promise<SkillResult> => {
      const action = args['action'] as string | undefined;
      const skillName = args['name'] as string | undefined;

      if (!action || !['read', 'approve', 'reject'].includes(action)) {
        return {
          success: false,
          error: 'Missing or invalid parameter: action (must be read, approve, or reject)',
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

      // --- read ---
      if (action === 'read') {
        return {
          success: true,
          skill: skillName,
          frontmatter: loaded.frontmatter as unknown as Record<string, unknown>,
          trust: loaded.policy?.trust ?? 'no_policy',
          body: loaded.body,
          policy: loaded.policy,
        };
      }

      // --- approve / reject ---
      if (!loaded.policy) {
        return {
          success: false,
          error: `Skill "${skillName}" has no policy.json — cannot change trust`,
        };
      }

      if (action === 'approve' && loaded.policy.trust === 'approved') {
        return {
          success: false,
          error: `Skill "${skillName}" is already approved`,
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

      await updateSkillIndex(skillsDir, skillName, {
        description: loaded.frontmatter.description,
        trust: updatedPolicy.trust,
        hasPolicy: true,
      });

      return {
        success: true,
        skill: skillName,
        trust: updatedPolicy.trust,
        allowedTools: updatedPolicy.allowedTools,
        allowedDomains: updatedPolicy.allowedDomains,
      };
    },
  };
}
