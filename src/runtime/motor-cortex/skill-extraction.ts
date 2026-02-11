/**
 * Skill Extraction
 *
 * Extracts skills from Motor Cortex workspace to data/skills/.
 *
 * After Motor Cortex creates a skill in its workspace, this module:
 * - Validates skill frontmatter and structure
 * - Performs atomic copy to data/skills/
 * - Forces trust to "pending_review" for user approval
 * - Rebuilds the skills index
 *
 * ## Security
 *
 * - Symlinks are rejected throughout the skill tree
 * - Size limits enforced (1MB per file, 10MB total)
 * - Name must match directory name
 * - Atomic copy prevents race conditions
 */

import { readdir, readFile, stat, lstat, cp, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../types/logger.js';
import type { MotorTool } from './motor-protocol.js';
import type { SkillInput, SkillPolicy } from '../skills/skill-types.js';
import {
  computeDirectoryHash,
  parseSkillFile,
  validateSkillFrontmatter,
  savePolicy,
  rebuildSkillIndex,
} from '../skills/skill-loader.js';

/**
 * Size limits for skill extraction.
 */
const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file
const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB total

/**
 * Recursively check for symlinks in a directory tree.
 *
 * @param dirPath - Absolute path to check
 * @throws Error if symlink found
 */
async function rejectSymlinks(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    // Use lstat to detect symlinks
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Symlink detected: ${entry.name}`);
    }

    if (entry.isDirectory()) {
      // Skip dot directories
      if (entry.name.startsWith('.')) continue;
      // Recursively check
      await rejectSymlinks(fullPath);
    }
  }
}

/**
 * Compute total size of all files in a directory.
 *
 * @param dirPath - Absolute path to directory
 * @returns Total size in bytes
 */
async function computeTotalSize(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isFile()) {
      // Skip dotfiles
      if (entry.name.startsWith('.')) continue;
      const stats = await stat(fullPath);
      total += stats.size;
    } else if (entry.isDirectory()) {
      // Skip dot directories
      if (entry.name.startsWith('.')) continue;
      total += await computeTotalSize(fullPath);
    }
  }

  return total;
}

/**
 * Check if a file exceeds the size limit.
 *
 * @param dirPath - Absolute path to directory
 * @throws Error if any file exceeds MAX_FILE_SIZE
 */
async function checkFileSizeLimit(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isFile()) {
      // Skip dotfiles
      if (entry.name.startsWith('.')) continue;
      const stats = await stat(fullPath);
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File exceeds size limit (${String(MAX_FILE_SIZE)} bytes): ${entry.name}`);
      }
    } else if (entry.isDirectory()) {
      // Skip dot directories
      if (entry.name.startsWith('.')) continue;
      await checkFileSizeLimit(fullPath);
    }
  }
}

/**
 * Extract skills from Motor Cortex workspace to data/skills/.
 *
 * This function is called after a successful Motor Cortex run to harvest
 * any skills that were created during execution.
 *
 * @param workspace - Absolute path to Motor Cortex workspace
 * @param skillsDir - Absolute path to data/skills/
 * @param runId - Run identifier for temp file naming
 * @param logger - Logger instance
 * @returns Object with created/updated skill name arrays
 */
export async function extractSkillsFromWorkspace(
  workspace: string,
  skillsDir: string,
  runId: string,
  logger: Logger
): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];

  const workspaceSkillsDir = join(workspace, 'skills');

  // If no skills/ directory in workspace, return empty results
  try {
    await stat(workspaceSkillsDir);
  } catch {
    logger.debug({ workspaceSkillsDir }, 'No skills directory in workspace');
    return { created: [], updated: [] };
  }

  // Read all subdirectories in workspace/skills/
  const entries = await readdir(workspaceSkillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillName = entry.name;
    const sourceDir = join(workspaceSkillsDir, skillName);
    const skillMdPath = join(sourceDir, 'SKILL.md');

    try {
      // Step a: SKILL.md check
      let skillMdContent: string;
      try {
        skillMdContent = await readFile(skillMdPath, 'utf-8');
      } catch {
        logger.warn({ skillName }, 'SKILL.md missing, skipping');
        continue;
      }

      // Step b: Parse via parseSkillFile()
      const parsed = parseSkillFile(skillMdContent);
      if ('error' in parsed) {
        logger.warn({ skillName, error: parsed.error }, 'SKILL.md parse error, skipping');
        continue;
      }

      // Step c: Name validation - must match directory name
      const validationErrors = validateSkillFrontmatter(parsed.frontmatter);
      if (validationErrors.length > 0) {
        logger.warn(
          { skillName, errors: validationErrors },
          'Frontmatter validation failed, skipping'
        );
        continue;
      }

      const nameFromFrontmatter = parsed.frontmatter['name'] as string;
      if (nameFromFrontmatter !== skillName) {
        logger.warn(
          { skillName, nameFromFrontmatter },
          'Name mismatch (frontmatter vs directory), skipping'
        );
        continue;
      }

      // Step d: Recursive symlink check
      try {
        await rejectSymlinks(sourceDir);
      } catch (error) {
        logger.warn({ skillName, error }, 'Symlink detected, skipping');
        continue;
      }

      // Step e: Size check
      try {
        await checkFileSizeLimit(sourceDir);
        const totalSize = await computeTotalSize(sourceDir);
        if (totalSize > MAX_TOTAL_SIZE) {
          logger.warn({ skillName, totalSize }, 'Total size exceeds limit, skipping');
          continue;
        }
      } catch (error) {
        logger.warn({ skillName, error }, 'Size check failed, skipping');
        continue;
      }

      // Step f: Determine create vs update
      const targetDir = join(skillsDir, skillName);
      const isUpdate = await stat(targetDir)
        .then(() => true)
        .catch(() => false);

      // Step f2: Read existing policy for merge (update only)
      let existingPolicy: Record<string, unknown> | null = null;
      if (isUpdate) {
        try {
          const existing = await readFile(join(targetDir, 'policy.json'), 'utf-8');
          const parsed = JSON.parse(existing) as Record<string, unknown>;
          if (typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Validate that provenance has correct structure before using
            // Destructure to exclude provenance from spread, avoiding type errors
            const { provenance, ...restOfParsed } = parsed;
            const hasValidProvenance =
              provenance &&
              typeof provenance === 'object' &&
              'source' in provenance &&
              typeof provenance.source === 'string' &&
              'fetchedAt' in provenance &&
              typeof provenance.fetchedAt === 'string';
            // Type assertion to satisfy TypeScript - provenance is either valid Motor type or undefined
            existingPolicy = {
              ...restOfParsed,
              // Ensure provenance is valid or undefined
              provenance: hasValidProvenance
                ? (provenance as SkillPolicy['provenance'])
                : undefined,
            };
          }
        } catch {
          // No valid existing policy
        }
      }

      // Step g: Atomic copy
      const tempDir = join(skillsDir, `.tmp-${skillName}-${runId}`);
      const backupDir = join(skillsDir, `.old-${skillName}-${String(Date.now())}`);

      try {
        // Copy to temp dir
        await cp(sourceDir, tempDir, { recursive: true });

        // Validate the copy
        const copiedSkillMd = await readFile(join(tempDir, 'SKILL.md'), 'utf-8');
        const copiedParsed = parseSkillFile(copiedSkillMd);
        if ('error' in copiedParsed) {
          throw new Error(`Invalid SKILL.md in copy: ${copiedParsed.error}`);
        }

        // If target exists, rename to backup
        if (isUpdate) {
          await rename(targetDir, backupDir);
        }

        // Rename temp → target
        await rename(tempDir, targetDir);

        // Remove backup on success
        if (isUpdate) {
          await rm(backupDir, { recursive: true, force: true });
        }
      } catch (error) {
        // Clean up temp dir if something went wrong
        try {
          await unlink(tempDir);
        } catch {
          // Ignore
        }
        throw error;
      }

      // Step h: Force policy
      const policyPath = join(targetDir, 'policy.json');
      let motorPolicy: Record<string, unknown> | null = null;

      // Read Motor-written policy.json if present and valid
      try {
        const policyContent = await readFile(policyPath, 'utf-8');
        motorPolicy = JSON.parse(policyContent) as Record<string, unknown>;

        // Basic validation
        if (typeof motorPolicy !== 'object') {
          motorPolicy = null;
        }
      } catch {
        // No valid policy from Motor
      }

      // Compute content hash
      const contentHash = await computeDirectoryHash(targetDir);

      // Extract provenance from Motor policy if valid
      const motorProvenance = motorPolicy?.['provenance'] as Record<string, unknown> | undefined;
      const hasValidProvenance =
        motorProvenance &&
        typeof motorProvenance['source'] === 'string' &&
        typeof motorProvenance['fetchedAt'] === 'string';

      // Prepare policy fields from Motor policy
      const motorAllowedTools = motorPolicy?.['allowedTools'] as string[] | undefined;
      const motorAllowedDomains = motorPolicy?.['allowedDomains'] as string[] | undefined;
      const motorRequiredCredentials = motorPolicy?.['requiredCredentials'] as string[] | undefined;
      const motorInputs = motorPolicy?.['inputs'] as SkillInput[] | undefined;

      // On updates where Motor didn't write a policy, preserve existing permissions
      const fallbackTools = existingPolicy?.['allowedTools'] as string[] | undefined;
      const fallbackDomains = existingPolicy?.['allowedDomains'] as string[] | undefined;
      const fallbackCredentials = existingPolicy?.['requiredCredentials'] as string[] | undefined;
      const fallbackInputs = existingPolicy?.['inputs'] as SkillInput[] | undefined;
      const fallbackProvenance = existingPolicy?.['provenance'] as
        | Record<string, unknown>
        | undefined;

      // Build effective provenance: Motor > existing > none
      let effectiveProvenance: SkillPolicy['provenance'] = undefined;
      if (hasValidProvenance) {
        effectiveProvenance = {
          source: motorProvenance['source'] as string,
          fetchedAt: motorProvenance['fetchedAt'] as string,
          contentHash,
        };
      } else if (
        fallbackProvenance &&
        typeof fallbackProvenance['source'] === 'string' &&
        typeof fallbackProvenance['fetchedAt'] === 'string'
      ) {
        effectiveProvenance = {
          source: fallbackProvenance['source'],
          fetchedAt: fallbackProvenance['fetchedAt'],
          contentHash,
        };
      }

      // Generate new policy with pending_review trust
      const newPolicy = {
        schemaVersion: 1,
        trust: 'pending_review' as const,
        allowedTools: (motorAllowedTools ?? fallbackTools ?? []) as MotorTool[],
        allowedDomains: motorAllowedDomains ?? fallbackDomains,
        requiredCredentials: motorRequiredCredentials ?? fallbackCredentials,
        inputs: motorInputs ?? fallbackInputs,
        ...(effectiveProvenance && { provenance: effectiveProvenance }),
        extractedFrom: {
          runId,
          timestamp: new Date().toISOString(),
        },
      };

      // Save policy via savePolicy
      await savePolicy(targetDir, newPolicy);

      // Track result
      if (isUpdate) {
        updated.push(skillName);
      } else {
        created.push(skillName);
      }

      logger.info({ skillName, isUpdate }, 'Skill extracted successfully');
    } catch (error) {
      logger.warn({ skillName, error }, 'Skill extraction failed, skipping');
    }
  }

  // Step 3: Rebuild skill index
  try {
    await rebuildSkillIndex(skillsDir);
  } catch (error) {
    logger.warn({ error, skillsDir }, 'Failed to rebuild skill index');
  }

  return { created, updated };
}
