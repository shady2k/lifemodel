/**
 * Skill Review Service
 *
 * Provides deterministic security reviews for skill approval.
 * No heuristics, no regex patterns — just observed facts from the actual run
 * and file inventory. The sandbox (Docker + iptables) is the real security boundary;
 * this layer provides visibility for informed user consent.
 */

import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LoadedSkill, SkillPolicy } from './skill-types.js';

/**
 * File inventory entry for skill review.
 */
export interface SkillFileInventory {
  path: string;
  sizeBytes: number;
  hash: string;
}

/**
 * Comprehensive skill review for approval flow.
 */
export interface SkillReview {
  /** Skill name */
  name: string;

  /** Description from frontmatter */
  description: string;

  /** Trust level interpretation */
  trust: string;

  /** Domains allowed by policy (runtime permissions) */
  policyDomains: string[];

  /** Credentials declared in policy */
  policyCredentials: string[];

  /** Observed evidence from creation/update run */
  evidence: {
    fetchedDomains: string[];
    savedCredentials: string[];
    toolsUsed: string[];
    bashUsed: boolean;
  } | null;

  /** File inventory (deterministic) */
  files: SkillFileInventory[];

  /** Provenance (where the skill came from) */
  provenance: SkillPolicy['provenance'];

  /** Extraction metadata */
  extractedFrom: SkillPolicy['extractedFrom'];
}

/**
 * Scan skill directory for file inventory.
 *
 * Similar to scanSkillFiles in skill-extraction.ts but returns
 * size and hash for security review display.
 */
async function scanSkillFileInventory(skillPath: string): Promise<SkillFileInventory[]> {
  const files: SkillFileInventory[] = [];
  const allowlist = ['SKILL.md', 'references/**', 'scripts/**'];
  const denylist = ['node_modules/**', '.cache/**', '.local/**', '*.log', '.git/**', 'policy.json'];

  async function scanDirectory(currentPath: string, relativePath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const entryRelative = join(relativePath, entry.name);

      // Skip dotfiles/directories
      if (entry.name.startsWith('.')) continue;

      // Skip symlinks (security)
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await scanDirectory(entryPath, entryRelative);
      } else if (entry.isFile()) {
        // Check denylist patterns
        const isDenied = denylist.some((pattern) => {
          const regex = new RegExp(
            '^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$'
          );
          return regex.test(entryRelative);
        });
        if (isDenied) continue;

        // Check allowlist patterns
        const isAllowed = allowlist.some((pattern) => {
          const regex = new RegExp(
            '^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$'
          );
          return regex.test(entryRelative);
        });

        if (isAllowed) {
          const content = await readFile(entryPath);
          const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
          files.push({
            path: entryRelative,
            sizeBytes: content.length,
            hash,
          });
        }
      }
    }
  }

  await scanDirectory(skillPath, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Generate a deterministic skill review for approval flow.
 *
 * Collects facts from the skill's policy (runtime permissions), evidence
 * from the creation run (what actually happened), and file inventory.
 * No heuristics or content scanning — just observed data.
 *
 * @param loaded - The loaded skill to review
 * @returns Deterministic review for Cognition to present
 */
export async function reviewSkill(loaded: LoadedSkill): Promise<SkillReview> {
  const policy = loaded.policy;

  // Scan file inventory
  const files = await scanSkillFileInventory(loaded.path);

  // Interpret trust level
  let trust: string;
  if (!policy) {
    trust = 'no_policy - skill has no security policy';
  } else {
    switch (policy.trust) {
      case 'approved':
        trust = 'approved - user has approved these permissions';
        break;
      case 'pending_review':
        trust = 'pending_review - extracted from Motor Cortex, needs approval';
        break;
      case 'needs_reapproval':
        trust = 'needs_reapproval - content changed since last approval';
        break;
      default:
        trust = `unknown (${(policy as { trust: string }).trust})`;
    }
  }

  return {
    name: loaded.frontmatter.name,
    description: loaded.frontmatter.description,
    trust,
    policyDomains: policy?.allowedDomains ?? [],
    policyCredentials: policy?.requiredCredentials ?? [],
    evidence: policy?.runEvidence ?? null,
    files,
    provenance: policy?.provenance ?? undefined,
    extractedFrom: policy?.extractedFrom ?? undefined,
  };
}
