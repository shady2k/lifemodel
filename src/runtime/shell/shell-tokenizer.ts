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
 * Metacharacters dangerous in ALL contexts (including double quotes).
 * Double quotes do NOT neutralize $-expansion or backticks in sh.
 * Note: `\` inside double quotes is safe — it can only escape specific chars,
 * and the shell still treats the result as part of the quoted string.
 */
const ALWAYS_DANGEROUS = /[;`$()><!\n]/;

/**
 * Metacharacters dangerous only when unquoted.
 * `&` is a job control operator only outside quotes — safe inside both
 * single and double quotes (e.g., URLs with query params).
 * `\` outside quotes enables escape sequences; inside double quotes it's
 * constrained to specific chars and can't break out of the quoted string.
 */
const UNQUOTED_DANGEROUS = /[&\\]/;

/**
 * Check if a command string contains shell metacharacters that could enable
 * injection when passed to `exec` (sh -c).
 *
 * - Single-quoted regions: fully safe (shell treats them literally).
 * - Double-quoted regions: `&` and `\` are safe, but `$` and `` ` `` remain dangerous.
 * - Unquoted regions: both sets are dangerous.
 */
export function hasDangerousMetachars(command: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (const ch of command) {
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ALWAYS_DANGEROUS.test(ch)) {
        return true;
      }
      // & is safe inside double quotes — skip UNQUOTED_DANGEROUS check
      continue;
    }

    // Outside quotes
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ALWAYS_DANGEROUS.test(ch) || UNQUOTED_DANGEROUS.test(ch)) {
      return true;
    }
  }
  return false;
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
