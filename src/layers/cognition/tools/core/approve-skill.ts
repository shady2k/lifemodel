/**
 * Core Approve-Skill Tool
 *
 * Allows Cognition to approve or reject skills that are in pending_review
 * or unknown trust state. Without this tool, skills extracted by Motor Cortex
 * remain stuck in pending_review because Motor can't self-approve and
 * Cognition had no mechanism to change trust.
 *
 * Approval sets trust to 'approved' with provenance (approvedBy, approvedAt).
 * Rejection resets trust to 'unknown'.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import {
  loadSkill,
  savePolicy,
  updateSkillIndex,
} from '../../../../runtime/skills/skill-loader.js';
import type { SkillPolicy } from '../../../../runtime/skills/skill-types.js';

/**
 * Result from core.approveSkill tool execution.
 */
export interface ApproveSkillResult {
  success: boolean;
  error?: string | undefined;
  skill?: string | undefined;
  trust?: string | undefined;
  allowedTools?: string[] | undefined;
  allowedDomains?: string[] | undefined;
}

/**
 * Dependencies for the approve-skill tool.
 */
export interface ApproveSkillToolDeps {
  /** Base directory for skills (e.g., data/skills) */
  skillsDir: string;
}

/**
 * Create the core.approveSkill tool.
 */
export function createApproveSkillTool(deps: ApproveSkillToolDeps): Tool {
  const { skillsDir } = deps;

  const parameters: ToolParameter[] = [
    {
      name: 'skill',
      type: 'string',
      required: true,
      description: 'Skill name to approve or reject',
    },
    {
      name: 'approve',
      type: 'boolean',
      required: true,
      description: 'true = approve the skill, false = reject (reset to unknown)',
    },
  ];

  return {
    name: 'core.approveSkill',
    maxCallsPerTurn: 3,
    description:
      'Approve or reject a skill that is pending review. Approved skills can be executed by Motor Cortex. Rejection resets trust to unknown.',
    tags: ['skills', 'security', 'approval'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args): Promise<ApproveSkillResult> => {
      const skillName = args['skill'] as string | undefined;
      const approve = args['approve'] as boolean | undefined;

      // Validate required params
      if (!skillName || typeof skillName !== 'string') {
        return { success: false, error: 'Missing required parameter: skill' };
      }
      if (approve === undefined || typeof approve !== 'boolean') {
        return { success: false, error: 'Missing required parameter: approve (must be boolean)' };
      }

      // Load the skill
      const loaded = await loadSkill(skillName, skillsDir);
      if ('error' in loaded) {
        return { success: false, error: loaded.error };
      }

      // Validate: must have a policy
      if (!loaded.policy) {
        return {
          success: false,
          error: `Skill "${skillName}" has no policy.json — cannot change trust`,
        };
      }

      // Validate: trust must be pending_review or unknown
      if (loaded.policy.trust === 'approved') {
        return {
          success: false,
          error: `Skill "${skillName}" is already approved`,
        };
      }

      // Build updated policy
      const updatedPolicy: SkillPolicy = { ...loaded.policy };

      if (approve) {
        updatedPolicy.trust = 'approved';
        updatedPolicy.approvedBy = 'user';
        updatedPolicy.approvedAt = new Date().toISOString();
      } else {
        updatedPolicy.trust = 'unknown';
        // Clear approval metadata on rejection
        delete updatedPolicy.approvedBy;
        delete updatedPolicy.approvedAt;
      }

      // Save policy
      await savePolicy(loaded.path, updatedPolicy);

      // Update index
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
