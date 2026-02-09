/**
 * Skill Loader
 *
 * Parses SKILL.md files, validates definitions, and discovers available skills.
 * Skills are stored in `data/skills/<name>/SKILL.md`.
 *
 * File format:
 * ```
 * ---
 * name: agentmail
 * version: 1
 * description: Send and receive emails via AgentMail API
 * tools: [shell, code, filesystem]
 * credentials: [agentmail_api_key]
 * ---
 * # AgentMail Skill
 * Instructions for the LLM...
 * ```
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MotorTool } from '../motor-cortex/motor-protocol.js';
import type { SkillDefinition, SkillInput, LoadedSkill } from './skill-types.js';
import { VALID_MOTOR_TOOLS } from './skill-types.js';

/**
 * Default skills base directory.
 */
const DEFAULT_SKILLS_DIR = 'data/skills';

/**
 * Parse a SKILL.md file content into definition + body.
 *
 * Uses inline regex-based YAML parser (strict subset, no dependencies).
 */
export function parseSkillFile(
  content: string
): { definition: Record<string, unknown>; body: string } | { error: string } {
  // Split on --- delimiters
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { error: 'SKILL.md must start with --- (YAML frontmatter delimiter)' };
  }

  const secondDelimiter = trimmed.indexOf('---', 3);
  if (secondDelimiter === -1) {
    return { error: 'Missing closing --- delimiter for YAML frontmatter' };
  }

  const yamlBlock = trimmed.slice(3, secondDelimiter).trim();
  const body = trimmed.slice(secondDelimiter + 3).trim();

  // Parse YAML (strict subset)
  const definition: Record<string, unknown> = {};
  const lines = yamlBlock.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) {
      return { error: `Invalid YAML line (no colon): ${trimmedLine}` };
    }

    const key = trimmedLine.slice(0, colonIdx).trim();
    const rawValue = trimmedLine.slice(colonIdx + 1).trim();

    // Check for multi-line nested objects (reject them)
    if (!rawValue && lines.indexOf(line) < lines.length - 1) {
      // Could be a multi-line value — check next line for indentation
      const nextIdx = lines.indexOf(line) + 1;
      if (
        nextIdx < lines.length &&
        (lines[nextIdx]?.startsWith('  ') || lines[nextIdx]?.startsWith('\t'))
      ) {
        return { error: `Nested YAML objects not supported. Key: ${key}` };
      }
    }

    definition[key] = parseYamlValue(rawValue);
  }

  return { definition, body };
}

/**
 * Parse a single YAML value (strict subset).
 *
 * Supports:
 * - Strings: unquoted or "quoted"
 * - Numbers: integer or float
 * - Booleans: true/false
 * - Inline arrays: [a, b, c]
 */
function parseYamlValue(raw: string): unknown {
  // Empty value
  if (!raw) return '';

  // Inline array: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseYamlValue(item.trim()));
  }

  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;

  // Unquoted string
  return raw;
}

/**
 * Validate a parsed skill definition.
 *
 * @returns Array of validation errors (empty = valid)
 */
export function validateSkillDefinition(def: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Required: name
  if (!def['name'] || typeof def['name'] !== 'string') {
    errors.push('Missing or invalid "name" (must be a string)');
  } else if (!/^[a-z0-9-]+$/.test(def['name'])) {
    errors.push('Invalid "name": must be lowercase alphanumeric with hyphens');
  }

  // Required: version
  if (def['version'] == null || typeof def['version'] !== 'number') {
    errors.push('Missing or invalid "version" (must be a number)');
  }

  // Required: tools (non-empty array of valid MotorTool values)
  if (!Array.isArray(def['tools']) || def['tools'].length === 0) {
    errors.push('Missing or empty "tools" (must be a non-empty array)');
  } else {
    for (const tool of def['tools'] as unknown[]) {
      if (typeof tool !== 'string' || !VALID_MOTOR_TOOLS.includes(tool)) {
        errors.push(`Invalid tool: "${String(tool)}". Valid: ${VALID_MOTOR_TOOLS.join(', ')}`);
      }
    }
  }

  // Optional: description (string)
  if (def['description'] != null && typeof def['description'] !== 'string') {
    errors.push('"description" must be a string');
  }

  // Optional: credentials (array of strings)
  if (def['credentials'] != null) {
    if (!Array.isArray(def['credentials'])) {
      errors.push('"credentials" must be an array');
    } else {
      for (const cred of def['credentials'] as unknown[]) {
        if (typeof cred !== 'string') {
          errors.push(`Invalid credential name: "${String(cred)}" (must be a string)`);
        }
      }
    }
  }

  // Optional: inputs (array — validated separately)
  if (def['inputs'] != null && !Array.isArray(def['inputs'])) {
    errors.push('"inputs" must be an array');
  }

  // Optional: domains (array of strings — accepted but not enforced yet)
  if (def['domains'] != null) {
    if (!Array.isArray(def['domains'])) {
      errors.push('"domains" must be an array');
    } else {
      for (const domain of def['domains'] as unknown[]) {
        if (typeof domain !== 'string') {
          errors.push(`Invalid domain: "${String(domain)}" (must be a string)`);
        }
      }
    }
  }

  return errors;
}

/**
 * Convert raw parsed definition to typed SkillDefinition.
 */
function toSkillDefinition(raw: Record<string, unknown>): SkillDefinition {
  const def: SkillDefinition = {
    name: raw['name'] as string,
    version: raw['version'] as number,
    description: (raw['description'] as string | undefined) ?? '',
    tools: raw['tools'] as MotorTool[],
  };
  if (Array.isArray(raw['inputs'])) {
    def.inputs = raw['inputs'] as SkillInput[];
  }
  if (Array.isArray(raw['credentials'])) {
    def.credentials = raw['credentials'] as string[];
  }
  if (Array.isArray(raw['domains'])) {
    def.domains = raw['domains'] as string[];
  }
  return def;
}

/**
 * Load a skill by name from the skills directory.
 *
 * @param skillName - Skill name (directory name under data/skills/)
 * @param baseDir - Base directory (default: data/skills)
 * @returns LoadedSkill or error string
 */
export async function loadSkill(
  skillName: string,
  baseDir?: string
): Promise<LoadedSkill | { error: string }> {
  const dir = resolve(baseDir ?? DEFAULT_SKILLS_DIR);
  const skillPath = join(dir, skillName, 'SKILL.md');

  try {
    const content = await readFile(skillPath, 'utf-8');
    const parsed = parseSkillFile(content);

    if ('error' in parsed) {
      return { error: `Parse error in ${skillName}/SKILL.md: ${parsed.error}` };
    }

    const errors = validateSkillDefinition(parsed.definition);
    if (errors.length > 0) {
      return { error: `Validation errors in ${skillName}/SKILL.md: ${errors.join('; ')}` };
    }

    return {
      definition: toSkillDefinition(parsed.definition),
      body: parsed.body,
      path: skillPath,
    };
  } catch (error) {
    return {
      error: `Failed to load skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Discover all available skills in the skills directory.
 *
 * Scans for subdirectories containing SKILL.md files.
 *
 * @param baseDir - Base directory (default: data/skills)
 * @returns Array of skill names
 */
export async function discoverSkills(baseDir?: string): Promise<string[]> {
  const dir = resolve(baseDir ?? DEFAULT_SKILLS_DIR);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillNames: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Check if SKILL.md exists in this directory
      try {
        await readFile(join(dir, entry.name, 'SKILL.md'), 'utf-8');
        skillNames.push(entry.name);
      } catch {
        // No SKILL.md — skip
      }
    }

    return skillNames.sort();
  } catch {
    // Skills directory doesn't exist yet
    return [];
  }
}

/**
 * Validate provided inputs against a skill's input schema.
 *
 * @param skill - Loaded skill with input definitions
 * @param inputs - Provided input values
 * @returns Array of validation errors (empty = valid)
 */
export function validateSkillInputs(skill: LoadedSkill, inputs: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const inputDefs = skill.definition.inputs ?? [];

  // Check required inputs
  for (const def of inputDefs) {
    if (def.required && !(def.name in inputs)) {
      errors.push(`Missing required input: "${def.name}"`);
      continue;
    }

    const value = inputs[def.name];
    if (value == null) continue;

    // Type check
    switch (def.type) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push(`Input "${def.name}" must be a string, got ${typeof value}`);
        }
        break;
      case 'number':
        if (typeof value !== 'number') {
          errors.push(`Input "${def.name}" must be a number, got ${typeof value}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`Input "${def.name}" must be a boolean, got ${typeof value}`);
        }
        break;
    }
  }

  // Warn about unknown inputs
  const knownNames = new Set(inputDefs.map((d) => d.name));
  for (const key of Object.keys(inputs)) {
    if (!knownNames.has(key)) {
      errors.push(`Unknown input: "${key}"`);
    }
  }

  return errors;
}
