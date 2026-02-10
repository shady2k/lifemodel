/**
 * Shell command allowlist - strict command validation.
 *
 * Only commands on this list can be executed.
 * This is a security boundary - never allow arbitrary commands.
 */

import { tokenize } from './shell-tokenizer.js';

/**
 * Default allowlist of safe commands.
 *
 * These commands are safe to run in a controlled environment.
 * Intentionally excluded: node, npx, python, etc. (use code tool instead)
 */
export const DEFAULT_ALLOWLIST = new Set([
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

/**
 * Network-capable commands (for provenance tagging).
 *
 * Commands that can make network requests should be tagged
 * with provenance='web' to indicate the data came from outside.
 */
export const NETWORK_COMMANDS = new Set(['curl', 'wget', 'git']);

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
 * Validate a single command against the allowlist.
 *
 * @param command - Command name (without arguments)
 * @param allowlist - Set of allowed commands (defaults to DEFAULT_ALLOWLIST)
 * @returns Validation result
 */
export function validateCommand(
  command: string,
  allowlist: Set<string> = DEFAULT_ALLOWLIST
): ValidationResult {
  // Strip leading path (e.g., /usr/bin/cat -> cat)
  const baseCommand = command.split('/').pop() ?? command;

  if (!allowlist.has(baseCommand)) {
    return {
      valid: false,
      reason: `Command not allowed: ${baseCommand}`,
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
 * Each command in the pipeline must be on the allowlist.
 * Uses quote-aware tokenizer so that `|` inside quotes is not treated as a pipe.
 *
 * @param pipeline - Full command string with optional pipes
 * @param allowlist - Set of allowed commands (defaults to DEFAULT_ALLOWLIST)
 * @returns Validation result
 */
export function validatePipeline(
  pipeline: string,
  allowlist: Set<string> = DEFAULT_ALLOWLIST
): ValidationResult {
  const { segments } = tokenize(pipeline);

  if (segments.length === 0) {
    return { valid: false, reason: 'Malformed command (unterminated quote)' };
  }

  // Validate each segment's first token against allowlist
  const commandNames: string[] = [];
  for (const tokens of segments) {
    const commandName = tokens[0];

    if (!commandName) {
      return { valid: false, reason: 'Empty command in pipeline' };
    }

    const result = validateCommand(commandName, allowlist);
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
 * Create a custom allowlist from an array of commands.
 *
 * @param commands - Array of command names
 * @returns Set of commands
 */
export function createAllowlist(commands: string[]): Set<string> {
  return new Set(commands);
}
