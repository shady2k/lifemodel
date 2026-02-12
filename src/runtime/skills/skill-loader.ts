/**
 * Skill Loader
 *
 * Parses SKILL.md files (Agent Skills standard), manages policy.json sidecars,
 * and discovers skills via directory scan (auto-discovery, no index.json).
 *
 * ## File Format (Agent Skills Standard)
 * ```
 * ---
 * name: weather-report
 * description: Fetch weather data from a public API
 * license: MIT
 * ---
 * # Weather Report Skill
 * Instructions for the LLM...
 * ```
 *
 * ## Policy Sidecar (policy.json)
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "trust": "approved",
 *   "allowedTools": ["bash"],
 *   "allowedDomains": ["api.weather.com"]
 * }
 * ```
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, stat, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { JSONStorage } from '../../storage/json-storage.js';
import type {
  SkillFrontmatter,
  SkillPolicy,
  SkillIndexEntry,
  DiscoveredSkill,
  LoadedSkill,
} from './skill-types.js';

/**
 * Default skills base directory.
 */
const DEFAULT_SKILLS_DIR = 'data/skills';

/**
 * Recursively collect all files in a directory, excluding policy.json.
 *
 * @param dirPath - Absolute path to directory
 * @param relativeDir - Relative path from base (for recursion)
 * @returns Array of relative file paths
 */
async function collectFiles(dirPath: string, relativeDir = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relativePath = join(relativeDir, entry.name);

    // Reject symlinks - use lstat to detect symlinks (stat follows them)
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Symlink detected and rejected: ${relativePath}`);
    }

    if (entry.isDirectory()) {
      // Skip directories starting with dot (e.g., .git)
      if (entry.name.startsWith('.')) continue;
      // Recursively collect files
      const nested = await collectFiles(fullPath, relativePath);
      files.push(...nested);
    } else {
      // Skip policy.json (excluded from content hash)
      if (entry.name === 'policy.json') continue;
      // Skip dotfiles (e.g., .DS_Store)
      if (entry.name.startsWith('.')) continue;
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Compute SHA-256 hash of a directory's content.
 *
 * Recursively hashes all files in the directory, excluding policy.json.
 * File paths are sorted lexicographically for determinism.
 * Rejects any symlinks during traversal.
 *
 * @param dirPath - Absolute path to directory
 * @returns Hash string in format "sha256:<hex>"
 */
export async function computeDirectoryHash(dirPath: string): Promise<string> {
  const hash = createHash('sha256');

  // Collect all files (excludes policy.json, dotfiles, dotdirs)
  const files = await collectFiles(dirPath);

  // Sort lexicographically for deterministic hashing
  files.sort();

  // Feed each file's content into the hash
  for (const relativePath of files) {
    const fullPath = join(dirPath, relativePath);
    const content = await readFile(fullPath, 'utf-8');
    // Format: "relativePath\0content" for uniqueness
    hash.update(relativePath + '\0' + content, 'utf-8');
  }

  return `sha256:${hash.digest('hex')}`;
}

/**
 * Parse a SKILL.md file content into frontmatter + body.
 *
 * Uses inline regex-based YAML parser (lenient — skips nested blocks).
 * This allows the Agent Skills standard format while handling extensions gracefully.
 */
export function parseSkillFile(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | { error: string } {
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

  // Parse YAML (lenient — skip nested blocks)
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlBlock.split('\n');
  let skipNested = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      // Skip blank lines and comments
      continue;
    }

    // Check for nested block (skip it leniently)
    if (skipNested) {
      if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        // Back to root level
        skipNested = false;
      } else {
        // Still in nested block — skip this line
        continue;
      }
    }

    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) {
      // No colon — invalid YAML line, skip it leniently
      continue;
    }

    const key = trimmedLine.slice(0, colonIdx).trim();
    const rawValue = trimmedLine.slice(colonIdx + 1).trim();

    // Check if this key starts a nested block (value empty + next line indented)
    if (!rawValue) {
      const lineIdx = lines.indexOf(line);
      const nextIdx = lineIdx + 1;
      if (nextIdx < lines.length) {
        const nextLine = lines[nextIdx];
        if (nextLine !== undefined && (nextLine.startsWith('  ') || nextLine.startsWith('\t'))) {
          // This is a nested block header (like metadata:) — skip it
          skipNested = true;
          continue;
        }
      }
    }

    frontmatter[key] = parseYamlValue(rawValue);
  }

  return { frontmatter, body };
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
 * Validate skill frontmatter (Agent Skills standard).
 *
 * Only name and description are required.
 *
 * @returns Array of validation errors (empty = valid)
 */
export function validateSkillFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Required: name
  // Rules: must start with letter, lowercase a-z, numbers, hyphens allowed
  // No leading/trailing/consecutive hyphens, max 64 chars
  // Pattern: [a-z][a-z0-9]*(-[a-z0-9]+)*
  if (!frontmatter['name'] || typeof frontmatter['name'] !== 'string') {
    errors.push('Missing or invalid "name" (must be a string)');
  } else if (frontmatter['name'].length > 64) {
    errors.push('Invalid "name": must be at most 64 characters');
  } else if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(frontmatter['name'])) {
    errors.push(
      'Invalid "name": must start with a letter, contain only lowercase letters, numbers, and hyphens (no consecutive/leading/trailing hyphens)'
    );
  }

  // Required: description
  if (!frontmatter['description'] || typeof frontmatter['description'] !== 'string') {
    errors.push('Missing or invalid "description" (must be a string)');
  }

  // Optional: allowed-tools (if present, validate)
  if (frontmatter['allowed-tools'] != null) {
    if (typeof frontmatter['allowed-tools'] !== 'string') {
      errors.push('"allowed-tools" must be a string');
    }
  }

  // Optional: inputs (array — validated separately)
  if (frontmatter['inputs'] != null && !Array.isArray(frontmatter['inputs'])) {
    errors.push('"inputs" must be an array');
  }

  return errors;
}

/**
 * Convert raw parsed frontmatter to typed SkillFrontmatter.
 */
function toSkillFrontmatter(raw: Record<string, unknown>): SkillFrontmatter {
  return {
    name: raw['name'] as string,
    description: raw['description'] as string,
    license: raw['license'] as string | undefined,
    compatibility: raw['compatibility'] as string | undefined,
    'allowed-tools': raw['allowed-tools'] as string | undefined,
  };
}

/**
 * Load policy.json from a skill directory.
 *
 * @param skillDir - Absolute path to skill directory
 * @returns SkillPolicy or null if absent/invalid
 */
export async function loadPolicy(skillDir: string): Promise<SkillPolicy | null> {
  const policyPath = join(skillDir, 'policy.json');

  try {
    const content = await readFile(policyPath, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;

    // Validate schema version
    if (typeof raw['schemaVersion'] !== 'number') {
      return null;
    }

    // Validate trust (accept legacy 'unknown' for migration)
    if (
      raw['trust'] !== 'needs_reapproval' &&
      raw['trust'] !== 'pending_review' &&
      raw['trust'] !== 'approved' &&
      raw['trust'] !== 'unknown' // Accept legacy value for migration
    ) {
      return null;
    }

    // Migrate legacy trust name: unknown → needs_reapproval
    if (raw['trust'] === 'unknown') {
      raw['trust'] = 'needs_reapproval';
    }

    // Validate allowedTools
    if (!Array.isArray(raw['allowedTools'])) {
      return null;
    }

    // Migrate legacy tool names: filesystem → read, write, list (with dedup)
    const policy = raw as unknown as SkillPolicy;
    if (Array.isArray(policy.allowedTools) && policy.allowedTools.includes('filesystem' as never)) {
      const expanded = policy.allowedTools.flatMap((t: string) =>
        t === 'filesystem' ? ['read', 'write', 'list'] : [t]
      );
      policy.allowedTools = [...new Set(expanded)] as SkillPolicy['allowedTools'];
    }

    return policy;
  } catch {
    return null;
  }
}

/**
 * Save policy.json to a skill directory (atomic write via JSONStorage).
 *
 * @param skillDir - Absolute path to skill directory
 * @param policy - Policy to save
 */
export async function savePolicy(skillDir: string, policy: SkillPolicy): Promise<void> {
  // Ensure directory exists
  await mkdir(skillDir, { recursive: true });

  const storage = new JSONStorage({ basePath: skillDir, createBackup: false });
  await storage.save('policy', policy);
}

/**
 * Discover all available skills by scanning the skills directory.
 *
 * Auto-discovery mode: always scans the directory, no index.json caching.
 *
 * @param baseDir - Base directory (default: data/skills)
 * @returns Array of discovered skills with names
 */
export async function discoverSkills(baseDir?: string): Promise<DiscoveredSkill[]> {
  const dir = resolve(baseDir ?? DEFAULT_SKILLS_DIR);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skills: DiscoveredSkill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(dir, entry.name);
      const skillMdPath = join(skillDir, 'SKILL.md');

      try {
        const statResult = await stat(skillMdPath);
        if (!statResult.isFile()) continue;

        const content = await readFile(skillMdPath, 'utf-8');
        const parsed = parseSkillFile(content);

        if ('error' in parsed) continue;

        const frontmatter = toSkillFrontmatter(parsed.frontmatter);
        const policy = await loadPolicy(skillDir);

        // Build index entry
        // extractedFrom is an ad-hoc field added by skill-extraction.ts (not in SkillPolicy type)
        const extractedFrom = (policy as Record<string, unknown> | null)?.['extractedFrom'] as
          | { timestamp?: string }
          | undefined;
        const indexEntry: SkillIndexEntry = {
          description: frontmatter.description,
          hasPolicy: policy !== null,
          trust: policy?.trust ?? 'needs_reapproval',
          lastUsed: extractedFrom?.timestamp,
        };

        skills.push({ name: entry.name, ...indexEntry });
      } catch {
        // Skip invalid skills
        continue;
      }
    }

    return skills;
  } catch {
    // Skills directory doesn't exist yet
    return [];
  }
}

/**
 * Get skill names as a simple array.
 *
 * Convenience wrapper around discoverSkills().
 */
export async function getSkillNames(baseDir?: string): Promise<string[]> {
  const skills = await discoverSkills(baseDir);
  return skills.map((s) => s.name).sort();
}

/**
 * Load a skill by name from the skills directory.
 *
 * Returns frontmatter + optional policy + body.
 * Verifies content hash if policy exists — resets trust to 'needs_reapproval' on mismatch.
 *
 * @param skillName - Skill name (directory name under data/skills/)
 * @param baseDir - Base directory (default: data/skills)
 * @returns LoadedSkill or error object
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

    const errors = validateSkillFrontmatter(parsed.frontmatter);
    if (errors.length > 0) {
      return { error: `Validation errors in ${skillName}/SKILL.md: ${errors.join('; ')}` };
    }

    const frontmatter = toSkillFrontmatter(parsed.frontmatter);
    const skillDir = join(dir, skillName);
    let policy = await loadPolicy(skillDir);

    // Content hash verification
    if (policy?.provenance?.contentHash) {
      const currentHash = await computeDirectoryHash(skillDir);
      if (currentHash !== policy.provenance.contentHash) {
        // Reset trust to needs_reapproval
        policy = { ...policy, trust: 'needs_reapproval' };
        await savePolicy(skillDir, policy);

        // Skill content changed since approval — trust reset to needs_reapproval
        // Hash mismatch is logged via the updated policy.json
      }
    }

    return {
      frontmatter,
      policy: policy ?? undefined,
      body: parsed.body,
      path: skillDir,
      skillPath,
    };
  } catch (error) {
    return {
      error: `Failed to load skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
    };
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
  const inputDefs = skill.policy?.inputs ?? [];

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
