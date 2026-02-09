/**
 * Skill System Types
 *
 * Skills are reusable task templates stored as SKILL.md files.
 * Each skill has YAML frontmatter (definition) and a markdown body (instructions).
 *
 * YAML parser supports a strict subset:
 * - Single-level keys: `key: value`
 * - String values: `name: agentmail` (unquoted) or `name: "agent mail"` (quoted)
 * - Number values: `version: 1`
 * - Boolean values: `required: true`
 * - Inline arrays: `tools: [shell, code, filesystem]`
 * - Nested objects are NOT supported
 */

import type { MotorTool } from '../motor-cortex/motor-protocol.js';

/**
 * Skill definition parsed from YAML frontmatter.
 */
export interface SkillDefinition {
  /** Unique skill name (lowercase, alphanumeric + hyphens) */
  name: string;

  /** Skill version (integer) */
  version: number;

  /** Human-readable description */
  description: string;

  /** Motor tools this skill requires */
  tools: MotorTool[];

  /** Input parameters the skill accepts (optional) */
  inputs?: SkillInput[];

  /** Credential names this skill needs (optional) */
  credentials?: string[];
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
 * A loaded skill: definition + body + source path.
 */
export interface LoadedSkill {
  /** Parsed definition from frontmatter */
  definition: SkillDefinition;

  /** Markdown body (instructions for the LLM) */
  body: string;

  /** Absolute path to the SKILL.md file */
  path: string;
}

/**
 * Valid motor tools for validation.
 */
export const VALID_MOTOR_TOOLS: readonly string[] = [
  'code',
  'filesystem',
  'ask_user',
  'shell',
  'grep',
  'patch',
] as const;
