/**
 * Pure utility functions for tool-server security and validation.
 *
 * These functions are extracted from tool-server.ts to enable unit testing.
 * They use inline types (no imports from outside container/) to avoid
 * Docker container import resolution issues.
 */

// ─── Shell Validation Constants ────────────────────────────────

/**
 * Allowlisted commands (same as host shell-allowlist.ts).
 * These are safe to run inside the container with minimal privileges.
 */
export const SHELL_ALLOWLIST = new Set([
  // Core utilities
  'echo',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'tee',
  'xargs',
  'tr',
  'diff',
  'touch',
  'chmod',

  // File operations
  'ls',
  'pwd',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'find',
  'date',

  // Archive
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',

  // Version control
  'git',

  // Network (for provenance tagging)
  'curl',
  'wget',
  'jq',

  // System info
  'uname',
  'whoami',
  'id',
]);

export const NETWORK_COMMANDS = new Set(['curl', 'wget', 'git']);

/**
 * Shell control operators that enable command chaining.
 * These MUST be rejected to prevent injection attacks.
 */
export const CONTROL_OPERATORS_RE = /\|\||&&/;

/**
 * Injection-capable shell metacharacters.
 *
 * Blocked:
 * - `;`  — command chaining (bypasses pipeline allowlist validation)
 * - `` ` `` — command substitution
 * - `$(` — command substitution
 *
 * Allowed (safe in sandboxed container with command allowlist):
 * - `>`, `<` — file redirections (container has read-only rootfs, writable workspace only)
 * - `&` — background/stderr redirect `2>&1` (pid-limited container)
 * - `\` — escape sequences in grep patterns etc.
 * - `(`, `)` — grouping (harmless without `;` or `$()`)
 * - `!` — history expansion (non-interactive shell, no effect)
 * - `$` alone — variable reference (`$?`, `$HOME`) is safe
 */
export const DANGEROUS_METACHAR_RE = /[;`]|\$\(/;

// ─── Types ───────────────────────────────────────────────────────

export interface PipelineValidationResult {
  ok: boolean;
  error?: string;
  hasNetwork: boolean;
}

export interface PatchFindResult {
  ok: true;
  index: number;
  count: number;
}

export interface PatchFindError {
  ok: false;
  error: 'not_found' | 'ambiguous' | 'invalid_args';
}

export type FindUniqueSubstringResult = PatchFindResult | PatchFindError;

// ─── Shell Pipeline Validation ───────────────────────────────────

/**
 * Split a shell command on unquoted pipe characters.
 *
 * Walks the string tracking quote state (' and "), only splitting on
 * bare unquoted |. This handles patterns like `grep -E 'api|doc'` where
 * the pipe inside quotes should NOT be treated as a command separator.
 *
 * @param command - Shell command that may contain pipes
 * @returns Array of command segments split on unquoted pipes
 *
 * @example
 * splitOnUnquotedPipe("echo hello") // ["echo hello"]
 * splitOnUnquotedPipe("grep -E 'api|doc' file") // ["grep -E 'api|doc' file"]
 * splitOnUnquotedPipe("curl url | grep pattern") // ["curl url ", " grep pattern"]
 * splitOnUnquotedPipe(`grep "a|b" | head`) // [`grep "a|b" `, " head`]
 */
export function splitOnUnquotedPipe(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const ch of command) {
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    switch (ch) {
      case '\\':
        escapeNext = true;
        current += ch;
        break;
      case "'":
        if (!inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        }
        current += ch;
        break;
      case '"':
        if (!inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        }
        current += ch;
        break;
      case '|':
        if (!inSingleQuote && !inDoubleQuote) {
          // Unquoted pipe - split here
          segments.push(current.trim());
          current = '';
        } else {
          // Quoted pipe - part of the current segment
          current += ch;
        }
        break;
      default:
        current += ch;
        break;
    }
  }

  // Always add the last segment (even if empty — lets validatePipeline detect trailing pipes)
  segments.push(current.trim());

  return segments;
}

// ─── Shell Pipeline Validation ───────────────────────────────────

/**
 * Validate all commands in a pipeline against the allowlist.
 * Splits on single `|` and checks each segment's first token.
 *
 * Rejects: control operators (||, &&), dangerous metacharacters,
 * and any pipeline segment without a valid command.
 *
 * @param command - The shell command to validate (may include pipes)
 * @returns Validation result with error details if invalid
 *
 * @example
 * validatePipeline("echo hello | grep pattern")
 * // { ok: true, hasNetwork: false }
 *
 * validatePipeline("curl https://example.com | jq .")
 * // { ok: true, hasNetwork: true }
 *
 * validatePipeline("mkdir dir && cd dir")
 * // { ok: true, hasNetwork: false }
 */
export function validatePipeline(command: string): PipelineValidationResult {
  // Reject injection-capable metacharacters
  if (DANGEROUS_METACHAR_RE.test(command)) {
    return { ok: false, error: 'Command contains disallowed metacharacters', hasNetwork: false };
  }

  // Split on control operators (&&, ||), then on unquoted pipes within each chain.
  // Split order matters: && and || first (they contain |), then remaining | via quote-aware split.
  const chains = command.split(/\s*(?:&&|\|\|)\s*/);
  const segments: string[] = [];
  for (const chain of chains) {
    for (const seg of splitOnUnquotedPipe(chain)) {
      segments.push(seg.trim());
    }
  }

  // Reject empty segments (e.g., "echo |  | grep" or trailing pipe)
  if (segments.some((s) => !s)) {
    return { ok: false, error: 'Empty pipeline segment', hasNetwork: false };
  }

  let hasNetwork = false;

  for (const segment of segments) {
    const cmd = segment.split(/\s+/)[0]?.replace(/^.*\//, '') ?? '';
    if (!SHELL_ALLOWLIST.has(cmd)) {
      return {
        ok: false,
        error: `Command not allowed: ${cmd}. Allowed: ${[...SHELL_ALLOWLIST].join(', ')}`,
        hasNetwork: false,
      };
    }
    if (NETWORK_COMMANDS.has(cmd)) hasNetwork = true;
  }

  return { ok: true, hasNetwork };
}

// ─── Glob Matching ───────────────────────────────────────────────

/**
 * Check if a filename matches a glob pattern.
 *
 * Supports:
 * - Exact match: "data.json" matches "data.json"
 * - Extension patterns: "*.ts" matches "file.ts", "dir/file.ts"
 *
 * @param filename - The filename to check (may include path)
 * @param pattern - The glob pattern (*.ts, *.json, etc.)
 * @returns true if the filename matches the pattern
 *
 * @example
 * matchesGlob("file.ts", "*.ts")      // true
 * matchesGlob("file.txt", "*.ts")     // false
 * matchesGlob("dir/file.ts", "*.ts")  // true
 * matchesGlob("data.json", "data.json") // true (exact match)
 */
export function matchesGlob(filename: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return filename.endsWith(pattern.slice(1));
  return filename === pattern;
}

// ─── Credential Placeholder Resolution ───────────────────────────

/**
 * Regular expression for credential placeholders in content.
 * Matches: <credential:name> where name is alphanumeric + underscore
 */
export const CREDENTIAL_PLACEHOLDER = /<credential:([a-zA-Z0-9_]+)>/g;

/**
 * Resolve credential placeholders in text.
 *
 * Replaces occurrences of `<credential:name>` with the actual credential value.
 * If a credential is not found, the placeholder is left as-is.
 *
 * @param text - The text containing credential placeholders
 * @param credentials - Map of credential names to values
 * @returns Text with placeholders replaced (or left as-is if missing)
 *
 * @example
 * const creds = new Map([['api_key', 'secret123']]);
 * resolveCredentialPlaceholders("key=<credential:api_key>", creds)
 * // "key=secret123"
 *
 * resolveCredentialPlaceholders("key=<credential:missing>", creds)
 * // "key=<credential:missing>"
 */
export function resolveCredentialPlaceholders(
  text: string,
  credentials: Map<string, string>
): string {
  return text.replace(CREDENTIAL_PLACEHOLDER, (_match, name: string) => {
    const value = credentials.get(name);
    return value ?? `<credential:${name}>`;
  });
}

// ─── Patch Find Unique Substring ──────────────────────────────────

/**
 * Find the unique index of oldText within content.
 *
 * Ensures that oldText appears exactly once in content before patching.
 * This prevents ambiguous edits when the same text appears multiple times.
 *
 * @param content - The full content to search within
 * @param oldText - The text to find
 * @returns Result with index if found exactly once, error otherwise
 *
 * @example
 * findUniqueSubstring("hello world", "world")
 * // { ok: true, index: 6, count: 1 }
 *
 * findUniqueSubstring("hello world hello", "hello")
 * // { ok: false, error: 'ambiguous' }
 *
 * findUniqueSubstring("hello world", "goodbye")
 * // { ok: false, error: 'not_found' }
 */
export function findUniqueSubstring(content: string, oldText: string): FindUniqueSubstringResult {
  if (!oldText) {
    return { ok: false, error: 'invalid_args' };
  }

  let count = 0;
  let searchStart = 0;
  let idx = -1;
  let firstIdx = -1;

  while ((idx = content.indexOf(oldText, searchStart)) !== -1) {
    count++;
    if (count === 1) firstIdx = idx;
    searchStart = idx + 1;
    if (count > 1) break;
  }

  if (count === 0) {
    return { ok: false, error: 'not_found' };
  }

  if (count > 1) {
    return { ok: false, error: 'ambiguous' };
  }

  return { ok: true, index: firstIdx, count: 1 };
}
