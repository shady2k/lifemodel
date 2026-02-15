/**
 * Skill Review Service
 *
 * Deterministic fact collection from policy and instruction content.
 * Content references are advisory extraction hints, not authoritative policy.
 * The sandbox (Docker + iptables) is the real security boundary;
 * this layer provides visibility for informed user consent.
 */

import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LoadedSkill, SkillPolicy } from './skill-types.js';

/** Shell special variables that should never be treated as credentials */
const SHELL_SPECIALS = new Set([
  '$1',
  '$2',
  '$3',
  '$4',
  '$5',
  '$6',
  '$7',
  '$8',
  '$9',
  '$?',
  '$!',
  '$-',
  '$#',
  '$@',
  '$*',
  '$$',
  '$0',
]);

/** Well-known non-credential environment variables (denylist) */
const NON_CREDENTIAL_VARS = new Set([
  'NODE_ENV',
  'HOME',
  'PATH',
  'PWD',
  'SHELL',
  'USER',
  'LANG',
  'TERM',
  'CI',
  'PORT',
  'HOST',
  'DEBUG',
  'LOG_LEVEL',
  'TZ',
]);

/** Placeholder domains that should be filtered out from references */
const PLACEHOLDER_DOMAINS = new Set([
  'localhost',
  '127.0.0.1',
  'example.com',
  'example.org',
  'example.net',
  'your-server.com',
  'yourdomain.com',
]);

/**
 * Extract credential references (env var names) from skill body text.
 *
 * Patterns detected:
 * - process.env.VAR_NAME (JS/TS)
 * - os.environ["VAR_NAME"] / os.environ.get("VAR_NAME") / os.environ['VAR_NAME'] (Python)
 * - ${VAR_NAME} and $VAR_NAME inside fenced shell blocks
 * - VAULT_VAR_NAME anywhere (our convention)
 *
 * Excludes:
 * - Shell specials ($1-$9, $?, $!, etc.)
 * - Well-known non-credential vars (NODE_ENV, HOME, etc.)
 *
 * @param text - Skill file content (SKILL.md body, scripts, references)
 * @returns Sorted, deduped array of env var names
 */
export function extractCredentialReferences(text: string): string[] {
  const found = new Set<string>();

  // process.env.VAR_NAME (JS/TS dot notation)
  const processEnvMatches = text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g);
  for (const match of processEnvMatches) {
    const name = match[1];
    if (name && !NON_CREDENTIAL_VARS.has(name)) {
      found.add(name);
    }
  }

  // process.env["VAR_NAME"] / process.env['VAR_NAME'] (JS/TS bracket notation)
  const processEnvBracketMatches = text.matchAll(
    /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g
  );
  for (const match of processEnvBracketMatches) {
    const name = match[1];
    if (name && !NON_CREDENTIAL_VARS.has(name)) {
      found.add(name);
    }
  }

  // os.environ["VAR_NAME"] / os.environ.get("VAR_NAME") / os.environ['VAR_NAME'] (Python)
  const osEnvironMatches = text.matchAll(
    /os\.environ(?:\.get)?\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)?/g
  );
  for (const match of osEnvironMatches) {
    const name = match[1];
    if (name && !NON_CREDENTIAL_VARS.has(name)) {
      found.add(name);
    }
  }

  // os.environ["VAR_NAME"] with bracket notation
  const osEnvironBracketMatches = text.matchAll(
    /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g
  );
  for (const match of osEnvironBracketMatches) {
    const name = match[1];
    if (name && !NON_CREDENTIAL_VARS.has(name)) {
      found.add(name);
    }
  }

  // ${VAR_NAME} and $VAR_NAME inside fenced shell blocks
  const shellBlockMatches = text.matchAll(/```(?:bash|sh|zsh|shell)\n([\s\S]*?)```/gi);
  for (const blockMatch of shellBlockMatches) {
    const blockContent = blockMatch[1];
    if (!blockContent) continue;
    // ${VAR_NAME}
    const braceMatches = blockContent.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
    for (const match of braceMatches) {
      const name = match[1];
      if (name && !NON_CREDENTIAL_VARS.has(name)) {
        found.add(name);
      }
    }
    // $VAR_NAME (not followed by alphanumeric or underscore, to avoid matching $VARx)
    const plainMatches = blockContent.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g);
    for (const match of plainMatches) {
      const varRef = match[0];
      const name = match[1];
      if (!name) continue;
      // Skip shell specials
      if (SHELL_SPECIALS.has(varRef)) continue;
      if (!NON_CREDENTIAL_VARS.has(name)) {
        found.add(name);
      }
    }
  }

  // VAULT_VAR_NAME anywhere (our convention)
  const vaultMatches = text.matchAll(/\b(VAULT_[A-Za-z0-9_]+)\b/g);
  for (const match of vaultMatches) {
    const name = match[1];
    if (name) {
      found.add(name);
    }
  }

  return Array.from(found).sort();
}

/**
 * Extract domain references (URLs) from skill body text.
 *
 * Uses URL parsing for robust hostname extraction. Only HTTPS/HTTP URLs are detected.
 *
 * Filtered out:
 * - localhost, 127.0.0.1
 * - example.com, example.org, example.net
 * - your-server.com, yourdomain.com
 *
 * @param text - Skill file content (SKILL.md body, scripts, references)
 * @returns Sorted, deduped array of lowercase domain names
 */
export function extractDomainReferences(text: string): string[] {
  const found = new Set<string>();

  // Match URL tokens (scheme required)
  const urlMatches = text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gi);
  for (const match of urlMatches) {
    const urlStr = match[0];
    try {
      const url = new URL(urlStr);
      let hostname = url.hostname.toLowerCase();
      // Strip trailing dot if present
      if (hostname.endsWith('.')) {
        hostname = hostname.slice(0, -1);
      }
      // Filter out placeholders
      if (!PLACEHOLDER_DOMAINS.has(hostname)) {
        found.add(hostname);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return Array.from(found).sort();
}

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

  /** Status level interpretation */
  status: string;

  /** Domains allowed by policy (runtime permissions) */
  policyDomains: string[];

  /** Credentials declared in policy */
  policyCredentials: string[];

  /** Tools allowed by policy */
  policyTools: string[];

  /** Env var names referenced in skill files (observed, not authoritative) */
  referencedCredentials: string[];

  /** Domain names referenced via URLs in skill files (observed, not authoritative) */
  referencedDomains: string[];

  /** VAULT_ prefixed env var names for user setup (derived from all credentials) */
  vaultEnvVars: string[];

  /** File inventory (deterministic) */
  files: SkillFileInventory[];

  /** Provenance (where the skill came from) */
  provenance: SkillPolicy['provenance'];

  /** Extraction metadata */
  extractedFrom: SkillPolicy['extractedFrom'];
}

/** Result of scanning skill directory: inventory + text content for extraction */
interface ScanResult {
  files: SkillFileInventory[];
  /** Concatenated text content of all allowlisted files (for credential/domain extraction) */
  allText: string;
}

/** Convert a simple glob pattern to a regex string, escaping dots */
function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*');
  return new RegExp('^' + regexStr + '$');
}

/**
 * Scan skill directory for file inventory and text content.
 *
 * Similar to scanSkillFiles in skill-extraction.ts but returns
 * size and hash for security review display, plus concatenated
 * text content for credential/domain extraction.
 */
async function scanSkillFileInventory(skillPath: string): Promise<ScanResult> {
  const files: SkillFileInventory[] = [];
  const textChunks: string[] = [];

  const allowlist = ['SKILL.md', 'references/**', 'scripts/**'];
  const denylist = ['node_modules/**', '.cache/**', '.local/**', '*.log', '.git/**', 'policy.json'];

  // Pre-compile glob regexes
  const allowlistRegexes = allowlist.map(globToRegex);
  const denylistRegexes = denylist.map(globToRegex);

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
        if (denylistRegexes.some((r) => r.test(entryRelative))) continue;

        // Check allowlist patterns
        if (allowlistRegexes.some((r) => r.test(entryRelative))) {
          const content = await readFile(entryPath);
          const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
          files.push({
            path: entryRelative,
            sizeBytes: content.length,
            hash,
          });
          // Collect text for extraction (skip binary files by checking for null bytes)
          const text = content.toString('utf-8');
          if (!text.includes('\0')) {
            textChunks.push(text);
          }
        }
      }
    }
  }

  await scanDirectory(skillPath, '');
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    allText: textChunks.join('\n'),
  };
}

/**
 * Generate a deterministic skill review for approval flow.
 *
 * Collects facts from the skill's policy (runtime permissions), file inventory,
 * and content references (observed env vars and URLs in instructions).
 *
 * @param loaded - The loaded skill to review
 * @returns Deterministic review for Cognition to present
 */
export async function reviewSkill(loaded: LoadedSkill): Promise<SkillReview> {
  const policy = loaded.policy;

  // Scan file inventory and collect text content
  const scan = await scanSkillFileInventory(loaded.path);
  const files = scan.files;

  // Extract content references from all allowlisted files (SKILL.md + scripts/ + references/)
  const referencedCredentials = extractCredentialReferences(scan.allText);
  const referencedDomains = extractDomainReferences(scan.allText);

  // Interpret status level
  let status: string;
  if (!policy) {
    status = 'no_policy - skill has no security policy';
  } else {
    switch (policy.status) {
      case 'pending_review':
        status = 'pending_review - freshly created by Motor Cortex, never reviewed';
        break;
      case 'reviewing':
        status = 'reviewing - deterministic review done, Motor deep review in progress';
        break;
      case 'reviewed':
        status = 'reviewed - security review done, waiting for user approval';
        break;
      case 'needs_reapproval':
        status = 'needs_reapproval - content changed since last approval';
        break;
      case 'approved':
        status = 'approved - user has approved these permissions';
        break;
      default:
        status = `unknown (${(policy as { status: string }).status})`;
    }
  }

  // Compute VAULT_ env var names from union of all credentials
  const allCredentials = new Set([
    ...(policy?.requiredCredentials ?? []),
    ...referencedCredentials,
  ]);
  const vaultEnvVars = Array.from(allCredentials)
    .map((name) => (name.startsWith('VAULT_') ? name : `VAULT_${name}`))
    .sort();

  return {
    name: loaded.frontmatter.name,
    description: loaded.frontmatter.description,
    status,
    policyDomains: policy?.domains ?? [],
    policyCredentials: policy?.requiredCredentials ?? [],
    policyTools: policy?.tools ?? [],
    referencedCredentials,
    referencedDomains,
    vaultEnvVars,
    files,
    provenance: policy?.provenance ?? undefined,
    extractedFrom: policy?.extractedFrom ?? undefined,
  };
}
