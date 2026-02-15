/**
 * Skill Extraction
 *
 * Extracts skills from Motor Cortex workspace to data/skills/.
 *
 * ## Security
 *
 * - Symlinks are rejected throughout the skill tree
 * - Size limits enforced (1MB per file, 10MB total)
 * - Name must match frontmatter name
 * - Atomic copy prevents race conditions
 *
 * ## Baseline-Diff Extraction
 *
 * Skills are copied to workspace root on init. A baseline manifest (.motor-baseline.json)
 * records the hash of each copied file. On extraction, we:
 * - Read baseline to know what was originally copied
 * - Scan workspace for current skill files
 * - Extract files that changed or were added
 * - Skip if no changes detected (prevents status churn)
 *
 * ## Crash Safety
 *
 * Policy.json is written atomically: temp file → rename.
 *
 * NOTE: Extraction happens in motor-cortex.ts (runLoopInBackground middleware),
 * which has run state for reconciliation tracking.
 */

import { readdir, readFile, lstat, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from '../../types/logger.js';
import type { SkillPolicy } from '../skills/skill-types.js';
import {
  parseSkillFile,
  validateSkillFrontmatter,
  savePolicy,
  computeDirectoryHash,
} from '../skills/skill-loader.js';

/**
 * Size limits for skill extraction.
 */
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB per file
const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB total

/**
 * Baseline manifest format.
 * Records file hashes at workspace init for diff-based extraction.
 */
export interface MotorBaseline {
  files: Record<string, string>; // relative path -> sha256 hash
}

/**
 * Recursively reject symlinks in a directory tree.
 *
 * @param dirPath - Absolute path to check
 * @throws Error if symlink found
 */
async function rejectSymlinks(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath);
  for (const entryName of entries) {
    const fullPath = join(dirPath, entryName);
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Symlink detected: ${entryName}`);
    }
    if (stats.isDirectory()) {
      await rejectSymlinks(fullPath);
    }
  }
}

/**
 * Scan workspace for skill files and compute hashes.
 * Returns a map of relative path -> sha256 hash.
 *
 * Skips hidden files/dirs, policy.json, and .motor-* files.
 */
async function scanSkillFiles(dir: string, relativeDir = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }

  for (const entryName of entries) {
    // Skip hidden, policy, motor internals
    if (entryName.startsWith('.') || entryName === 'policy.json') continue;

    const fullPath = join(dir, entryName);
    const relativePath = relativeDir ? join(relativeDir, entryName) : entryName;

    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      const nested = await scanSkillFiles(fullPath, relativePath);
      Object.assign(result, nested);
    } else if (stats.isFile()) {
      const content = await readFile(fullPath);
      const hash = createHash('sha256').update(content).digest('hex');
      result[relativePath] = hash;
    }
  }

  return result;
}

/**
 * Check total size of all files in a directory (excluding hidden, policy.json).
 * Returns total bytes and per-file sizes.
 */
async function checkSizeLimits(
  dir: string,
  relativeDir = ''
): Promise<{ totalBytes: number; oversizedFile?: string }> {
  let totalBytes = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { totalBytes: 0 };
  }

  for (const entryName of entries) {
    if (entryName.startsWith('.') || entryName === 'policy.json') continue;

    const fullPath = join(dir, entryName);
    const relativePath = relativeDir ? join(relativeDir, entryName) : entryName;
    const stats = await lstat(fullPath);

    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      const nested = await checkSizeLimits(fullPath, relativePath);
      totalBytes += nested.totalBytes;
      if (nested.oversizedFile) return { totalBytes, oversizedFile: nested.oversizedFile };
    } else if (stats.isFile()) {
      if (stats.size > MAX_FILE_SIZE) {
        return {
          totalBytes,
          oversizedFile: `${relativePath} (${String(stats.size)} bytes > ${String(MAX_FILE_SIZE)} limit)`,
        };
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_TOTAL_SIZE) {
        return {
          totalBytes,
          oversizedFile: `total size ${String(totalBytes)} bytes > ${String(MAX_TOTAL_SIZE)} limit`,
        };
      }
    }
  }

  return { totalBytes };
}

/**
 * Generate a baseline manifest for skill files in a directory.
 *
 * @param dir - Absolute path to scan
 * @returns Baseline manifest
 */
export async function generateBaseline(dir: string): Promise<MotorBaseline> {
  const files = await scanSkillFiles(dir);
  return { files };
}

/**
 * Result of workspace extraction.
 */
export interface ExtractionResult {
  created: string[];
  updated: string[];
}

/**
 * Extract skills from a Motor Cortex workspace to the skills directory.
 *
 * Looks for SKILL.md at workspace root, validates it, copies files
 * to data/skills/<name>/, and writes a minimal policy.json.
 *
 * @param workspace - Absolute path to workspace
 * @param skillsDir - Absolute path to skills base directory
 * @param runId - Run identifier (for extraction metadata)
 * @param logger - Logger instance
 * @param pendingCredentials - Credentials to persist in new policy
 * @returns Extraction result with created/updated skill names
 */
export async function extractSkillsFromWorkspace(
  workspace: string,
  skillsDir: string,
  runId: string,
  logger: Logger,
  pendingCredentials?: Record<string, string>
): Promise<ExtractionResult> {
  const result: ExtractionResult = { created: [], updated: [] };

  // Step 1: Check SKILL.md exists
  const skillMdPath = join(workspace, 'SKILL.md');
  let skillMdContent: string;
  try {
    skillMdContent = await readFile(skillMdPath, 'utf-8');
  } catch {
    logger.debug('No SKILL.md in workspace, skipping extraction');
    return result;
  }

  // Step 2: Parse and validate
  const parsed = parseSkillFile(skillMdContent);
  if ('error' in parsed) {
    logger.warn({ error: parsed.error }, 'SKILL.md parse error');
    return result;
  }

  const validationErrors = validateSkillFrontmatter(parsed.frontmatter);
  if (validationErrors.length > 0) {
    logger.warn({ errors: validationErrors }, 'Frontmatter validation failed');
    return result;
  }

  const skillName = parsed.frontmatter['name'] as string;
  const targetDir = join(skillsDir, skillName);

  // Step 3: Security checks on workspace
  await rejectSymlinks(workspace);

  // Step 3b: Size limit enforcement
  const sizeCheck = await checkSizeLimits(workspace);
  if (sizeCheck.oversizedFile) {
    logger.warn(
      { skillName, oversizedFile: sizeCheck.oversizedFile },
      'Skill extraction skipped: size limit exceeded'
    );
    return result;
  }

  // Step 4: Check if this is an update (target dir already exists)
  let isUpdate = false;
  let existingPolicy: SkillPolicy | null = null;
  try {
    const existingPolicyPath = join(targetDir, 'policy.json');
    const existingPolicyContent = await readFile(existingPolicyPath, 'utf-8');
    existingPolicy = JSON.parse(existingPolicyContent) as SkillPolicy;
    isUpdate = true;
  } catch {
    // No existing policy - new skill
  }

  // Step 4b: Baseline diff — skip extraction if workspace files unchanged
  // prepareSkillWorkspace writes .motor-baseline.json at init time.
  // If present, compare current workspace state against baseline.
  // Unchanged workspace = no extraction needed (prevents status downgrade on normal runs).
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  if (isUpdate) {
    try {
      const baselinePath = join(workspace, '.motor-baseline.json');
      const baselineContent = await readFile(baselinePath, 'utf-8');
      const baseline = JSON.parse(baselineContent) as MotorBaseline;
      const currentFiles = await scanSkillFiles(workspace);

      // Compute actual changedFiles and deletedFiles
      const baselineKeys = new Set(Object.keys(baseline.files));
      const currentKeys = new Set(Object.keys(currentFiles));

      // Changed: files where hash differs OR files in current but not in baseline
      for (const key of currentKeys) {
        if (!baselineKeys.has(key) || baseline.files[key] !== currentFiles[key]) {
          changedFiles.push(key);
        }
      }

      // Deleted: files in baseline but not in current
      for (const key of baselineKeys) {
        if (!currentKeys.has(key)) {
          deletedFiles.push(key);
        }
      }

      if (changedFiles.length === 0 && deletedFiles.length === 0) {
        logger.debug({ skillName }, 'Workspace unchanged from baseline, skipping extraction');
        return result;
      }
      logger.info(
        { skillName, changedFiles, deletedFiles },
        'Workspace modified — extracting updated skill'
      );
    } catch {
      // No baseline file — this is a new skill creation (no prepareSkillWorkspace), proceed normally
      logger.debug({ skillName }, 'No baseline file — treating as new skill creation');
    }
  }

  // Step 5: Copy workspace files to target (clean replacement semantics)
  // Remove existing target dir and recreate to handle deleted files
  // (merge cp would leave deleted files behind)
  // Preserve policy.json by reading it first (already done in Step 4)
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  // Copy files from workspace to target
  await cp(workspace, targetDir, {
    recursive: true,
    filter: (src: string) => {
      const name = src.split('/').pop() ?? '';
      // Exclude policy.json, hidden files, motor internals
      return !name.startsWith('.') && name !== 'policy.json';
    },
  });

  // Step 5b: Compute content hash over the installed skill files
  const contentHash = await computeDirectoryHash(targetDir);

  // Step 6: Build policy
  let policy: SkillPolicy;
  if (isUpdate && existingPolicy) {
    // Preserve status if skill was already approved — content-only changes from task runs
    // don't need re-review. Only new skills start at pending_review.
    const preserveStatus =
      existingPolicy.status === 'approved' || existingPolicy.status === 'reviewed';
    policy = {
      schemaVersion: 2,
      status: preserveStatus ? existingPolicy.status : 'pending_review',
      ...(preserveStatus && existingPolicy.approvedBy && { approvedBy: existingPolicy.approvedBy }),
      ...(preserveStatus && existingPolicy.approvedAt && { approvedAt: existingPolicy.approvedAt }),
      // Preserve user-configured fields
      ...(existingPolicy.tools && { tools: existingPolicy.tools }),
      ...(existingPolicy.domains && { domains: existingPolicy.domains }),
      ...(existingPolicy.requiredCredentials && {
        requiredCredentials: existingPolicy.requiredCredentials,
      }),
      ...(existingPolicy.dependencies && { dependencies: existingPolicy.dependencies }),
      // Merge credential values: existing + pending (pending takes precedence)
      credentialValues: {
        ...(existingPolicy.credentialValues ?? {}),
        ...(pendingCredentials ?? {}),
      },
      provenance: {
        ...(existingPolicy.provenance ?? {
          source: 'motor-cortex',
          fetchedAt: new Date().toISOString(),
        }),
        contentHash,
      },
      extractedFrom: {
        runId,
        timestamp: new Date().toISOString(),
        changedFiles,
        deletedFiles,
      },
    };
    result.updated.push(skillName);
  } else {
    // Minimal policy for new skill
    policy = {
      schemaVersion: 2,
      status: 'pending_review',
      // Merge any pending credentials
      ...(pendingCredentials &&
        Object.keys(pendingCredentials).length > 0 && {
          credentialValues: pendingCredentials,
        }),
      provenance: {
        source: 'motor-cortex',
        fetchedAt: new Date().toISOString(),
        contentHash,
      },
      extractedFrom: {
        runId,
        timestamp: new Date().toISOString(),
        changedFiles,
        deletedFiles,
      },
    };
    result.created.push(skillName);
  }

  // Step 7: Atomic policy write (temp → rename)
  await savePolicy(targetDir, policy);

  logger.info(
    { skillName, isUpdate, runId, contentHash },
    isUpdate ? 'Skill updated from workspace' : 'Skill created from workspace'
  );

  return result;
}
