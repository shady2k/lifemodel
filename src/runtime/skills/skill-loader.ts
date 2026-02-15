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
 * ## Policy Sidecar (policy.json) - Schema v2
 * ```json
 * {
 *   "schemaVersion": 2,
 *   "status": "approved",
 *   "tools": ["ALL"],
 *   "domains": ["api.weather.com"],
 *   "requiredCredentials": ["api_key"]
 * }
 * ```
 */

import matter from 'gray-matter';
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
  SkillInput,
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
 * Uses gray-matter for YAML frontmatter parsing — handles all YAML features
 * including block sequences, nested objects, and multi-line strings.
 */
export function parseSkillFile(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | { error: string } {
  try {
    const result = matter(content);
    if (typeof result.data !== 'object' || Array.isArray(result.data)) {
      return { error: 'SKILL.md frontmatter must be a YAML mapping (key-value pairs)' };
    }
    return {
      frontmatter: result.data as Record<string, unknown>,
      body: result.content.trim(),
    };
  } catch (err) {
    return {
      error: `Failed to parse SKILL.md frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
    inputs: Array.isArray(raw['inputs']) ? parseSkillInputs(raw['inputs']) : undefined,
  };
}

/**
 * Parse and validate skill inputs from frontmatter.
 *
 * Validates each entry and applies defaults:
 * - `name` must be non-empty string (skip if not)
 * - `type` must be 'string' | 'number' | 'boolean' (default: 'string')
 * - `description` must be string (default: empty string)
 * - `required` must be boolean (default: true)
 * - `default` is optional, passed through if present
 * - Skip entries with duplicate `name`s
 *
 * @param raw - Raw inputs array from frontmatter
 * @returns Validated SkillInput array
 */
export function parseSkillInputs(raw: unknown[]): SkillInput[] {
  const result: SkillInput[] = [];
  const seenNames = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;

    const e = entry as Record<string, unknown>;

    // name is required and must be non-empty string
    if (typeof e['name'] !== 'string' || e['name'].trim() === '') continue;
    const name = e['name'];

    // Skip duplicate names
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    // type validation with default
    let type: 'string' | 'number' | 'boolean' = 'string';
    if (e['type'] === 'string' || e['type'] === 'number' || e['type'] === 'boolean') {
      type = e['type'];
    }

    // description with default
    const description = typeof e['description'] === 'string' ? e['description'] : '';

    // required with default
    const required = typeof e['required'] === 'boolean' ? e['required'] : true;

    // default is optional, pass through if present
    const hasDefault = 'default' in e;
    const defaultVal = hasDefault ? e['default'] : undefined;

    const input: SkillInput = { name, type, description, required };
    if (hasDefault) {
      input.default = defaultVal as string | number | boolean;
    }

    result.push(input);
  }

  return result;
}

/**
 * Valid npm/pip package name pattern.
 * Supports scoped packages (@org/pkg) and plain packages.
 */
const PACKAGE_NAME_REGEX = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

/**
 * Exact version pin pattern (digits and dots only, e.g. "1.0.0", "2.3").
 * Rejects ranges (^, ~, >=, *), URLs, git refs, and local paths.
 */
const EXACT_VERSION_REGEX = /^\d+(\.\d+)*$/;

/**
 * Known dependency ecosystems.
 */
const KNOWN_ECOSYSTEMS = new Set(['npm', 'pip']);

/**
 * Validate the `dependencies` field of a skill policy.
 *
 * Rules:
 * - Only `npm` and `pip` ecosystems allowed
 * - Package names must be valid (scoped @org/pkg or plain)
 * - Versions must be exact pins (no ^, ~, *, >=, URLs, git refs)
 *
 * @returns Array of validation errors (empty = valid)
 */
export function validateDependencies(dependencies: Record<string, unknown>): string[] {
  const errors: string[] = [];

  for (const [ecosystem, value] of Object.entries(dependencies)) {
    if (!KNOWN_ECOSYSTEMS.has(ecosystem)) {
      errors.push(`Unknown dependency ecosystem: "${ecosystem}" (allowed: npm, pip)`);
      continue;
    }

    if (typeof value !== 'object' || value === null || !('packages' in value)) {
      errors.push(`"${ecosystem}" must have a "packages" array`);
      continue;
    }

    const eco = value as { packages: unknown };
    if (!Array.isArray(eco.packages)) {
      errors.push(`"${ecosystem}.packages" must be an array`);
      continue;
    }

    for (const pkg of eco.packages) {
      if (typeof pkg !== 'object' || pkg === null) {
        errors.push(`${ecosystem}: package entry must be an object`);
        continue;
      }
      const p = pkg as Record<string, unknown>;

      // Validate name
      if (typeof p['name'] !== 'string') {
        errors.push(`${ecosystem}: package missing "name"`);
      } else if (!PACKAGE_NAME_REGEX.test(p['name'])) {
        errors.push(
          `${ecosystem}: invalid package name "${p['name']}" (must match ${String(PACKAGE_NAME_REGEX)})`
        );
      }

      // Validate version — exact pin only
      if (typeof p['version'] !== 'string') {
        const pkgName = typeof p['name'] === 'string' ? p['name'] : '?';
        errors.push(`${ecosystem}: package "${pkgName}" missing "version"`);
      } else if (!EXACT_VERSION_REGEX.test(p['version'])) {
        errors.push(
          `${ecosystem}: package "${String(p['name'])}" version "${p['version']}" must be an exact pin (e.g. "1.0.0"). Ranges (^, ~, *, >=), URLs, and git refs are not allowed.`
        );
      }
    }
  }

  return errors;
}

/**
 * Load policy.json from a skill directory.
 *
 * Validates schemaVersion 2 and the new 'status' field.
 * Logs a warning for v1 policies (no migration - clean break).
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

    // Schema v1 is no longer supported - log migration warning
    if (raw['schemaVersion'] === 1) {
      // eslint-disable-next-line no-console -- one-time migration warning, no logger available
      console.warn(
        `[skill-loader] Policy v1 is deprecated. ` +
          `Delete policy.json for skill "${skillDir}" to regenerate, ` +
          `or manually update to schemaVersion 2 with 'status' (not 'trust') and 'domains' (not 'allowedDomains').`
      );
      return null;
    }

    // Schema v2 validation
    if (raw['schemaVersion'] !== 2) {
      return null;
    }

    // Validate status
    if (
      raw['status'] !== 'pending_review' &&
      raw['status'] !== 'reviewing' &&
      raw['status'] !== 'reviewed' &&
      raw['status'] !== 'needs_reapproval' &&
      raw['status'] !== 'approved'
    ) {
      return null;
    }

    return raw as unknown as SkillPolicy;
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
          status: policy?.status ?? 'needs_reapproval',
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
 * Verifies content hash if policy exists — resets status to 'needs_reapproval' on mismatch.
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

  // Path traversal guard: resolved path must stay within skills dir
  const skillDir = resolve(dir, skillName);
  if (!skillDir.startsWith(dir + '/') && skillDir !== dir) {
    return { error: `Invalid skill name: "${skillName}"` };
  }

  const skillPath = join(skillDir, 'SKILL.md');

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
    let policy = await loadPolicy(skillDir);

    // Content hash verification
    if (policy?.provenance?.contentHash) {
      const currentHash = await computeDirectoryHash(skillDir);
      if (currentHash !== policy.provenance.contentHash) {
        // Reset status to needs_reapproval (from approved, reviewed, or reviewing)
        if (policy.status !== 'pending_review' && policy.status !== 'needs_reapproval') {
          policy = { ...policy, status: 'needs_reapproval' };
          await savePolicy(skillDir, policy);
        }
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
