/**
 * Skill System Types
 *
 * Skills are reusable task templates stored as SKILL.md files.
 *
 * ## Agent Skills Standard
 *
 * SKILL.md follows the Agent Skills standard format:
 * - YAML frontmatter: name (required), description (required), optional license/compatibility/metadata
 * - Markdown body: instructions for the LLM
 *
 * ## Policy Sidecar
 *
 * policy.json is an auto-generated, user-approved security policy:
 * - allowedTools, allowedDomains, requiredCredentials
 * - trust state: 'needs_reapproval' | 'pending_review' | 'approved'
 * - contentHash binding to detect SKILL.md modifications
 *
 * ## Architecture
 *
 * Content (SKILL.md) and policy (policy.json) are separate concerns.
 * SKILL.md is portable and immutable by our system.
 * policy.json is managed locally and controls runtime permissions.
 */

import type { MotorTool } from '../motor-cortex/motor-protocol.js';

/**
 * Agent Skills standard frontmatter (portable).
 *
 * Only name and description are required per the standard.
 * Additional fields are allowed but not required.
 */
export interface SkillFrontmatter {
  /** Unique skill name */
  name: string;

  /** Human-readable description (max ~1024 chars recommended) */
  description: string;

  /** Optional license identifier (e.g., "MIT", "Apache-2.0") */
  license?: string | undefined;

  /** Compatibility version or identifier */
  compatibility?: string | undefined;

  /** Additional metadata (arbitrary key-value pairs) */
  metadata?: Record<string, string> | undefined;

  /** Optional: tools hint (non-standard, may be used by skill publishers) */
  'allowed-tools'?: string | undefined;
}

/**
 * Trust state for a skill's security policy.
 *
 * - needs_reapproval: Content hash changed since approval (has policy) or no policy exists
 * - pending_review: User has not yet approved this skill (extracted from Motor Cortex)
 * - approved: User has approved these permissions
 */
export type SkillTrust = 'needs_reapproval' | 'pending_review' | 'approved';

/**
 * Security policy sidecar (policy.json).
 *
 * This file is auto-generated and user-approved.
 * It controls runtime permissions for the skill.
 */
export interface SkillPolicy {
  /** Policy schema version */
  schemaVersion: number;

  /** Trust state — 'approved' means user confirmed these permissions */
  trust: SkillTrust;

  /** Motor tools this skill is allowed to use */
  allowedTools: MotorTool[];

  /** Network domains this skill may access (enforced via iptables) */
  allowedDomains?: string[] | undefined;

  /** Credential names this skill requires */
  requiredCredentials?: string[] | undefined;

  /** Pre-installed dependency packages (npm/pip) */
  dependencies?:
    | {
        npm?: { packages: { name: string; version: string }[] } | undefined;
        pip?: { packages: { name: string; version: string }[] } | undefined;
      }
    | undefined;

  /** Input parameters the skill accepts (optional) */
  inputs?: SkillInput[] | undefined;

  /** Provenance: where this skill came from */
  provenance?:
    | {
        /** Source URL or identifier */
        source: string;

        /** When this skill was fetched */
        fetchedAt: string;

        /** SHA-256 hash of SKILL.md content at approval time */
        contentHash?: string | undefined;
      }
    | undefined;

  /** Who approved this policy */
  approvedBy?: 'user' | undefined;

  /** When this policy was approved */
  approvedAt?: string | undefined;
}

/**
 * Input parameter for a skill.
 */
export interface SkillInput {
  /** Parameter name */
  name: string;

  /** Value type */
  type: 'string' | 'number' | 'boolean';

  /** Human-readable description */
  description: string;

  /** Whether this input is required */
  required: boolean;

  /** Default value (when not required) */
  default?: string | number | boolean;
}

/**
 * Skill index entry (metadata for discovery).
 *
 * Used by discoverSkills() which scans data/skills/ on each call (auto-discovery).
 */
export interface SkillIndexEntry {
  /** Skill description */
  description: string;

  /** Trust state from policy */
  trust: SkillTrust;

  /** Whether a policy.json exists for this skill */
  hasPolicy: boolean;

  /** Last time this skill was used (ISO timestamp) */
  lastUsed?: string | undefined;
}

/**
 * Discovered skill entry — index entry with name attached.
 *
 * Used by discoverSkills() — attaches the directory name to the index entry.
 */
export interface DiscoveredSkill extends SkillIndexEntry {
  /** Skill name (directory name) */
  name: string;
}

/**
 * A loaded skill: frontmatter + optional policy + body + source path.
 *
 * The policy is optional — skills work without it (onboarding generates on first use).
 * Content hash is verified on load: if policy.contentHash !== sha256(SKILL.md),
 * the trust is reset to 'needs_reapproval'.
 */
export interface LoadedSkill {
  /** Parsed frontmatter from SKILL.md */
  frontmatter: SkillFrontmatter;

  /** Security policy from policy.json (if exists) */
  policy?: SkillPolicy | undefined;

  /** Markdown body (instructions for the LLM) */
  body: string;

  /** Absolute path to the skill directory */
  path: string;

  /** Absolute path to the SKILL.md file */
  skillPath: string;
}
