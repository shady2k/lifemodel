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
 * - tools, domains, requiredCredentials, inputs
 * - status: 'pending_review' | 'reviewed' | 'needs_reapproval' | 'approved'
 * - contentHash binding to detect SKILL.md modifications
 *
 * ## Schema Version 2
 *
 * Breaking changes from v1:
 * - `trust` renamed to `status`
 * - `allowedDomains` renamed to `domains`
 * - `runEvidence` removed (runtime evidence is no longer stored in policy)
 * - `tools` field added (optional array of MotorToolName or "ALL")
 *
 * ## Architecture
 *
 * Content (SKILL.md) and policy (policy.json) are separate concerns.
 * SKILL.md is portable and immutable by our system.
 * policy.json is managed locally and controls runtime permissions.
 */

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

  /** Input parameters the skill accepts (from frontmatter) */
  inputs?: SkillInput[] | undefined;
}

/**
 * Status of a skill's security policy.
 *
 * - pending_review: Freshly created by Motor Cortex, never reviewed
 * - reviewed: Security review done, waiting for user approval
 * - needs_reapproval: Content changed since last approval
 * - approved: User has approved these permissions
 */
export type SkillStatus = 'pending_review' | 'reviewed' | 'needs_reapproval' | 'approved';

/**
 * Motor tool names (mirrors MotorTool from motor-protocol.ts).
 * Duplicated here to avoid circular imports.
 */
export type MotorToolName =
  | 'read'
  | 'write'
  | 'list'
  | 'glob'
  | 'bash'
  | 'grep'
  | 'patch'
  | 'fetch';

/**
 * Security policy sidecar (policy.json).
 *
 * This file is auto-generated and user-approved.
 * It controls runtime permissions for the skill.
 *
 * Schema version 2: status (not trust), domains (not allowedDomains), no runEvidence.
 */
export interface SkillPolicy {
  /** Policy schema version (must be 2) */
  schemaVersion: number;

  /** Status — 'approved' means user confirmed these permissions */
  status: SkillStatus;

  /** Motor tools this skill may use (read, write, list, glob, bash, grep, patch, fetch).
   *  Special value "ALL" expands to all tools. Undefined = ALL (backward compat). */
  tools?: ('ALL' | MotorToolName)[] | undefined;

  /** Network domains this skill may access (enforced via iptables) */
  domains?: string[] | undefined;

  /** Credential names this skill requires */
  requiredCredentials?: string[] | undefined;

  /** Credential values obtained by this skill at runtime (e.g., API keys from signup).
   *  Stored in policy.json for persistence across restarts. Redacted in display. */
  credentialValues?: Record<string, string> | undefined;

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

  /** Extraction metadata (set when skill is extracted from Motor Cortex) */
  extractedFrom?: {
    runId: string;
    timestamp: string;
    changedFiles: string[];
    deletedFiles: string[];
  };
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

  /** Status from policy */
  status: SkillStatus;

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
 * the status is reset to 'needs_reapproval'.
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

/**
 * Sanitize a policy for display to the model/user.
 *
 * Redacts credential values to prevent key leakage in logs and LLM responses.
 * Returns a shallow copy with credentialValues values replaced by "[set]".
 */
export function sanitizePolicyForDisplay(policy: SkillPolicy): SkillPolicy {
  if (!policy.credentialValues) return policy;
  const { credentialValues, ...rest } = policy;
  return {
    ...rest,
    credentialValues: Object.fromEntries(Object.keys(credentialValues).map((k) => [k, '[set]'])),
  };
}
