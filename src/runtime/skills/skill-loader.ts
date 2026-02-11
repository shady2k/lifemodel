/**
 * Skill Loader
 *
 * Parses SKILL.md files (Agent Skills standard), manages policy.json sidecars,
 * and maintains the central skills index for fast discovery.
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
 *   "allowedTools": ["shell", "code"],
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
  SkillIndex,
  SkillIndexEntry,
  DiscoveredSkill,
  LoadedSkill,
} from './skill-types.js';

/**
 * Default skills base directory.
 */
const DEFAULT_SKILLS_DIR = 'data/skills';

/**
 * Schema version for index.json.
 */
const INDEX_SCHEMA_VERSION = 1;

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

    // Validate trust
    if (
      raw['trust'] !== 'unknown' &&
      raw['trust'] !== 'pending_review' &&
      raw['trust'] !== 'approved'
    ) {
      return null;
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
 * Load the central skills index.
 *
 * @param baseDir - Skills base directory (default: data/skills)
 * @returns SkillIndex (empty if missing/corrupt)
 */
export async function loadSkillIndex(baseDir?: string): Promise<SkillIndex> {
  const dir = resolve(baseDir ?? DEFAULT_SKILLS_DIR);
  const indexPath = join(dir, 'index.json');

  try {
    const content = await readFile(indexPath, 'utf-8');
    const index = JSON.parse(content) as SkillIndex;

    // Validate schema
    if (typeof index.schemaVersion !== 'number' || typeof index.skills !== 'object') {
      return { schemaVersion: INDEX_SCHEMA_VERSION, skills: {} };
    }

    return index;
  } catch {
    // Missing or corrupt — return empty index
    return { schemaVersion: INDEX_SCHEMA_VERSION, skills: {} };
  }
}

/**
 * Save the central skills index (atomic write).
 *
 * @param baseDir - Skills base directory
 * @param index - Index to save
 */
export async function saveSkillIndex(baseDir: string, index: SkillIndex): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  const storage = new JSONStorage({ basePath: baseDir, createBackup: false });
  await storage.save('index', index);
}

/**
 * Update a single entry in the skills index.
 *
 * @param baseDir - Skills base directory
 * @param name - Skill name
 * @param entry - Index entry to upsert
 */
export async function updateSkillIndex(
  baseDir: string,
  name: string,
  entry: SkillIndexEntry
): Promise<void> {
  const index = await loadSkillIndex(baseDir);
  index.skills[name] = entry;
  await saveSkillIndex(baseDir, index);
}

/**
 * Remove a skill from the index.
 *
 * @param baseDir - Skills base directory
 * @param name - Skill name to remove
 */
export async function removeFromSkillIndex(baseDir: string, name: string): Promise<void> {
  const index = await loadSkillIndex(baseDir);
  const { [name]: _, ...remaining } = index.skills;
  index.skills = remaining;
  await saveSkillIndex(baseDir, index);
}

/**
 * Rebuild the skills index from directory scan.
 *
 * Called when index.json is missing or needs refresh.
 *
 * @param baseDir - Skills base directory
 */
export async function rebuildSkillIndex(baseDir: string): Promise<void> {
  const dir = resolve(baseDir);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const index: SkillIndex = { schemaVersion: INDEX_SCHEMA_VERSION, skills: {} };

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(dir, entry.name);
      const skillMdPath = join(skillDir, 'SKILL.md');

      try {
        // Check for SKILL.md
        await stat(skillMdPath);

        // Load frontmatter for description
        const content = await readFile(skillMdPath, 'utf-8');
        const parsed = parseSkillFile(content);

        if ('error' in parsed) continue;

        const frontmatter = toSkillFrontmatter(parsed.frontmatter);

        // Check for policy
        const policy = await loadPolicy(skillDir);

        index.skills[entry.name] = {
          description: frontmatter.description,
          trust: policy?.trust ?? 'unknown',
          hasPolicy: policy !== null,
        };
      } catch {
        // Skip invalid entries
      }
    }

    await saveSkillIndex(dir, index);
  } catch {
    // Base directory doesn't exist — save empty index
    await saveSkillIndex(dir, { schemaVersion: INDEX_SCHEMA_VERSION, skills: {} });
  }
}

/**
 * Discover all available skills.
 *
 * Fast path: reads from index.json.
 * Fallback: directory scan and rebuild index if missing.
 *
 * Returns entries with name attached (preserves the Record key).
 *
 * @param baseDir - Base directory (default: data/skills)
 * @returns Array of discovered skills with names
 */
export async function discoverSkills(baseDir?: string): Promise<DiscoveredSkill[]> {
  const dir = resolve(baseDir ?? DEFAULT_SKILLS_DIR);

  try {
    // Try loading from index first (fast path)
    let index = await loadSkillIndex(dir);

    // If index is empty, try rebuilding from directory scan
    if (Object.keys(index.skills).length === 0) {
      await rebuildSkillIndex(dir);
      index = await loadSkillIndex(dir);
    }

    return Object.entries(index.skills).map(([name, entry]) => ({ name, ...entry }));
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
  const index = await loadSkillIndex(resolve(baseDir ?? DEFAULT_SKILLS_DIR));

  // If index is empty, try rebuild
  if (Object.keys(index.skills).length === 0) {
    await rebuildSkillIndex(resolve(baseDir ?? DEFAULT_SKILLS_DIR));
    const rebuilt = await loadSkillIndex(resolve(baseDir ?? DEFAULT_SKILLS_DIR));
    return Object.keys(rebuilt.skills).sort();
  }

  return Object.keys(index.skills).sort();
}

/**
 * Load a skill by name from the skills directory.
 *
 * Returns frontmatter + optional policy + body.
 * Verifies content hash if policy exists — resets trust to 'unknown' on mismatch.
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
        // Reset trust to unknown
        policy = { ...policy, trust: 'unknown' };
        await savePolicy(skillDir, policy);

        // Skill content changed since approval — trust reset to unknown
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
