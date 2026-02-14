/**
 * Shell Tokenizer — quote-aware command parsing.
 *
 * Shared between shell-allowlist (validation) and shell-runner (execution)
 * to ensure identical parsing rules.  Handles double/single quotes, escaped
 * quotes inside double-quoted strings, and unquoted pipe operators.
 */

export interface TokenizeResult {
  /** Parsed segments split by unquoted `|`. Each segment is an array of tokens. */
  segments: string[][];
  /** Whether the command contains at least one unquoted pipe. */
  hasPipe: boolean;
}

/**
 * Injection-capable metacharacters.
 *
 * Only truly dangerous patterns are blocked:
 * - `` ` `` — command substitution
 * - `$(` — command substitution
 *
 * Safe (allowed in sandboxed container with command allowlist):
 * - `;` — command chaining: each command still validated against allowlist independently
 * - `>`, `<` — redirections
 * - `&` — background/stderr redirect `2>&1`
 * - `\` — escape sequences
 * - `(`, `)` — grouping (harmless without `$()`)
 * - `!` — history expansion (non-interactive shell, no effect)
 * - `$` alone — variable reference is safe
 *
 * Semicolon is safe because the Docker sandbox enforces per-command allowlisting.
 * Even with `; rm -rf /`, the `rm` command would be blocked by the allowlist.
 * This unblocks legitimate shell constructs like `for f in a b; do echo $f; done`.
 */
const DANGEROUS_RE = /[`]|\$\(/;

/**
 * Check if a command string contains injection-capable metacharacters.
 *
 * Uses a simple regex — quote context doesn't matter because the blocked
 * patterns (backtick, `$(`) are dangerous even inside double quotes.
 * Single-quoted regions are safe but the patterns are rare enough in
 * legitimate single-quoted content that false positives are acceptable.
 */
export function hasDangerousMetachars(command: string): boolean {
  return DANGEROUS_RE.test(command);
}

/**
 * Tokenize a shell command string.
 *
 * - `"..."` and `'...'` are stripped, content kept as a single token.
 * - Inside double quotes, `\` only escapes `$`, `` ` ``, `"`, `\`, and newline (POSIX).
 *   All other `\X` sequences preserve the backslash.
 * - Outside quotes, `\` escapes the next character (any char becomes literal).
 * - Unquoted `|` splits into pipeline segments.
 * - Empty quoted strings (`""`, `''`) produce an empty-string token.
 * - Unterminated quotes return `{ segments: [], hasPipe: false }`.
 */
export function tokenize(command: string): TokenizeResult {
  const segments: string[][] = [[]];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let inToken = false; // Track whether we're building a token (for empty quoted args)

  let activeSeg: string[] = segments[0] ?? [];

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        // POSIX: inside double quotes, \ only escapes $, `, ", \, and newline
        const next = i + 1 < command.length ? command.charAt(i + 1) : '';
        if (next && '$`"\\'.includes(next)) {
          // Skip the backslash, next char will be added literally
          escaped = true;
        } else if (next === '\n') {
          // Line continuation: skip both backslash and newline
          i++;
        } else {
          // Preserve the backslash literally (e.g., \n, \t, C:\path)
          current += ch;
        }
      } else if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    // Outside quotes
    switch (ch) {
      case '\\': {
        // Outside quotes: backslash escapes the next character
        if (i + 1 < command.length) {
          current += command.charAt(i + 1);
          inToken = true;
          i++; // skip next char
        } else {
          // Trailing backslash — treat as literal
          current += ch;
          inToken = true;
        }
        break;
      }
      case '"':
        inDouble = true;
        inToken = true; // Opening a quote always starts a token
        break;
      case "'":
        inSingle = true;
        inToken = true;
        break;
      case '|': {
        // Check for || (logical OR)
        if (i + 1 < command.length && command.charAt(i + 1) === '|') {
          i++; // skip second |
        }
        // Flush current token and start new segment
        if (current || inToken) {
          activeSeg.push(current);
          current = '';
          inToken = false;
        }
        activeSeg = [];
        segments.push(activeSeg);
        break;
      }
      case '&': {
        // Check for && (logical AND) — treat as segment separator like |
        if (i + 1 < command.length && command.charAt(i + 1) === '&') {
          i++; // skip second &
          if (current || inToken) {
            activeSeg.push(current);
            current = '';
            inToken = false;
          }
          activeSeg = [];
          segments.push(activeSeg);
        } else {
          // Single & (background) — treat as part of token
          current += ch;
          inToken = true;
        }
        break;
      }
      case ' ':
      case '\t': {
        if (current || inToken) {
          activeSeg.push(current);
          current = '';
          inToken = false;
        }
        break;
      }
      default:
        current += ch;
        inToken = true;
    }
  }

  // Unterminated quote
  if (inDouble || inSingle) {
    return { segments: [], hasPipe: false };
  }

  // Flush remaining token
  if (current || inToken) {
    activeSeg.push(current);
  }

  return {
    segments,
    hasPipe: segments.length > 1,
  };
}
