/**
 * Skill Workspace Helper
 *
 * Prepares workspaces for skill execution by:
 * - Creating a fresh workspace directory
 * - Copying skill files (excluding policy.json)
 * - Generating baseline manifest for extraction
 *
 * This is called by core.act before starting a Motor Cortex run.
 * The workspace is passed to startRun() as workspacePath.
 */

import { mkdir, cp, readdir, lstat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { generateBaseline } from '../motor-cortex/skill-extraction.js';
import type { MotorBaseline } from '../motor-cortex/skill-extraction.js';
import type { Logger } from '../../types/logger.js';

/**
 * Result of preparing a skill workspace.
 */
export interface PreparedWorkspace {
  /** Absolute path to the prepared workspace */
  workspacePath: string;

  /** Baseline manifest for extraction (records initial state) */
  baseline: MotorBaseline;
}

/**
 * Files to exclude when copying skill to workspace.
 * policy.json is host-side only and never copied to the container.
 */
const EXCLUDE_FILES = new Set(['policy.json', '.DS_Store', '.git', '.gitignore']);

/**
 * Prepare a workspace for skill execution.
 *
 * This is called by core.act before starting a Motor Cortex run.
 * The workspace is passed to startRun() as workspacePath.
 *
 * Steps:
 * 1. Creates a fresh workspace directory under baseDir
 * 2. Copies all skill files (excluding policy.json)
 * 3. Generates baseline manifest for later extraction
 *
 * @param skillDir - Absolute path to the skill directory
 * @param baseDir - Base directory for workspaces (default: data/motor-workspaces)
 * @param runId - Run ID for unique workspace naming
 * @param logger - Logger for diagnostics
 * @returns Prepared workspace info
 */
export async function prepareSkillWorkspace(
  skillDir: string,
  baseDir: string,
  runId: string,
  logger: Logger
): Promise<PreparedWorkspace> {
  const skillName = basename(skillDir);
  const workspacePath = join(baseDir, `skill-${skillName}-${runId}`);

  // Create workspace directory
  await mkdir(workspacePath, { recursive: true });
  logger.debug({ skillDir, workspacePath }, 'Created workspace for skill');

  // Copy skill files (excluding policy.json)
  await copySkillFiles(skillDir, workspacePath, logger);

  // Generate baseline manifest for extraction and write to workspace
  const baseline = await generateBaseline(workspacePath);
  await writeFile(join(workspacePath, '.motor-baseline.json'), JSON.stringify(baseline), 'utf-8');
  logger.debug(
    { workspacePath, fileCount: Object.keys(baseline.files).length },
    'Generated baseline'
  );

  return { workspacePath, baseline };
}

/**
 * Recursively copy skill files to workspace, excluding policy.json.
 *
 * @param srcDir - Source skill directory
 * @param destDir - Destination workspace directory
 * @param logger - Logger for diagnostics
 */
async function copySkillFiles(srcDir: string, destDir: string, logger: Logger): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip excluded files
    if (EXCLUDE_FILES.has(entry.name)) {
      continue;
    }

    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);

    // Reject symlinks (security)
    const stats = await lstat(srcPath);
    if (stats.isSymbolicLink()) {
      logger.warn({ path: srcPath }, 'Skipping symlink in skill copy');
      continue;
    }

    if (entry.isDirectory()) {
      // Skip hidden directories
      if (entry.name.startsWith('.')) {
        continue;
      }
      // Recursively copy directory
      await mkdir(destPath, { recursive: true });
      await copySkillFiles(srcPath, destPath, logger);
    } else if (entry.isFile()) {
      // Copy file
      await cp(srcPath, destPath);
    }
  }
}
