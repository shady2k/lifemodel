/**
 * Static code safety checks for sandbox execution.
 *
 * Best-effort regex-based validation - NOT a security boundary.
 * The real isolation comes from process forking and environment stripping.
 */

/**
 * Guard result from code validation.
 */
export interface GuardResult {
  safe: boolean;
  reason?: string;
}

/**
 * Dangerous patterns that should never appear in user code.
 *
 * These are best-effort checks - actual security comes from
 * process isolation and environment stripping.
 */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  // Dynamic imports
  /import\s*\(/,
  /require\s*\(/,

  // Process access
  /\bprocess\b/,

  // Child process execution
  /child_process/,

  // File system access
  /\bfs\b/,
  /fs\./,

  // Eval and Function (we use Function ourselves internally)
  /\beval\s*\(/,

  // Module access
  /\b__dirname\b/,
  /\b__filename\b/,
];

/**
 * Allowed safe patterns (whitelist approach).
 *
 * We check for these to reduce false positives - code that only
 * uses safe patterns is likely safe.
 */
const SAFE_PATTERNS: readonly RegExp[] = [
  // Math operations
  /\bMath\./,

  // JSON operations
  /\bJSON\./,

  // Date operations
  /\bDate\b/,

  // Console logging
  /console\.log/,

  // Array methods
  /\.(map|filter|reduce|forEach|find|some|every|sort|reverse|slice|splice)\(/,

  // String methods
  /\.(toUpperCase|toLowerCase|trim|split|join|substring|includes|startsWith|endsWith)\(/,

  // Object operations
  /Object\.(keys|values|entries|assign|fromEntries)\(/,
];

/**
 * Validate code for sandbox execution.
 *
 * This is a best-effort check - actual isolation comes from
 * the child process and stripped environment.
 *
 * @param code - JavaScript code to validate
 * @returns Guard result indicating if code is safe
 */
export function guardCode(code: string): GuardResult {
  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      const match = code.match(pattern);
      return {
        safe: false,
        reason: `Dangerous pattern detected: ${match?.[0] ?? 'unknown'}`,
      };
    }
  }

  // Check if code has any safe patterns (reduces false positives)
  const hasSafePatterns = SAFE_PATTERNS.some((pattern) => pattern.test(code));

  // Empty code is not safe
  if (!code.trim()) {
    return { safe: false, reason: 'Code is empty' };
  }

  // If we have safe patterns and no dangerous ones, likely safe
  if (hasSafePatterns) {
    return { safe: true };
  }

  // If we don't recognize any patterns, still allow it (best-effort)
  // The real security is from process isolation
  return { safe: true };
}

/**
 * Check if a string looks like valid JavaScript code.
 *
 * This is a very basic syntax check - just ensures the code
 * isn't obviously malformed.
 */
export function isValidJavaScript(code: string): boolean {
  // Check for balanced brackets and braces
  const openBraces = (code.match(/\{/g) ?? []).length;
  const closeBraces = (code.match(/\}/g) ?? []).length;
  const openBrackets = (code.match(/\(/g) ?? []).length;
  const closeBrackets = (code.match(/\)/g) ?? []).length;

  return openBraces === closeBraces && openBrackets === closeBrackets;
}
