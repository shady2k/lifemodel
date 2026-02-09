/**
 * Motor Cortex Tools
 *
 * Tool definitions for the Motor Cortex sub-agent LLM.
 * These are NOT cognition tools - they're the tools the motor sub-agent can call.
 */

import type { OpenAIChatTool } from '../../llm/tool-schema.js';
import type { MotorTool, MotorToolResult } from './motor-protocol.js';
import { runSandbox } from '../sandbox/sandbox-runner.js';
import { runShell } from '../shell/shell-runner.js';
import { readFile, writeFile, readdir, mkdir, mkdtemp, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tool context passed to executors.
 */
export interface ToolContext {
  /** Allowed root directories for file operations */
  allowedRoots: string[];

  /** Primary workspace directory (first allowed root) */
  workspace: string;
}

/**
 * Tool executor function type.
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<MotorToolResult>;

/**
 * Resolve a path within allowed roots, preventing traversal and symlink attacks.
 *
 * Checks that:
 * 1. The resolved path stays within at least one allowed root
 * 2. The real path (after resolving symlinks) also stays within an allowed root
 *
 * Returns null if the path escapes all allowed roots.
 */
export async function resolveSafePath(
  allowedRoots: string[],
  relativePath: string
): Promise<string | null> {
  // Canonicalize allowed roots (resolve symlinks like /var -> /private/var on macOS)
  const realRoots: string[] = [];
  for (const root of allowedRoots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      realRoots.push(root); // Root doesn't exist yet, use as-is
    }
  }

  for (let i = 0; i < allowedRoots.length; i++) {
    const root = allowedRoots[i];
    const realRoot = realRoots[i];
    if (!root || !realRoot) continue;
    const resolved = resolve(root, relativePath);
    const rel = relative(root, resolved);
    // Reject if relative path escapes root (starts with ..) or is absolute
    if (rel.startsWith('..') || isAbsolute(rel)) {
      // Also try with the real root path
      const resolvedReal = resolve(realRoot, relativePath);
      const relReal = relative(realRoot, resolvedReal);
      if (relReal.startsWith('..') || isAbsolute(relReal)) {
        continue;
      }
    }

    // Check symlink safety: resolve symlinks and verify real path is still inside a root
    try {
      let checkPath = resolved;
      try {
        await lstat(resolved);
      } catch {
        // File doesn't exist yet — check parent directory instead
        checkPath = dirname(resolved);
        try {
          await lstat(checkPath);
        } catch {
          // Parent doesn't exist either — will be created by the caller
          return resolved;
        }
      }

      const real = await realpath(checkPath);
      // Verify real path is inside at least one allowed root (using real roots)
      for (const r of realRoots) {
        const rr = relative(r, real);
        if (!rr.startsWith('..') && !isAbsolute(rr)) {
          return resolved;
        }
      }
      // Symlink resolved outside all roots — reject
      return null;
    } catch {
      // If realpath fails, the path doesn't exist yet — safe to use
      return resolved;
    }
  }
  return null;
}

/**
 * Build a permission_denied result for path traversal attempts.
 */
function pathTraversalError(startTime: number): MotorToolResult {
  return {
    ok: false,
    output: 'Path traversal denied: path must stay within allowed directories',
    errorCode: 'permission_denied',
    retryable: false,
    provenance: 'internal',
    durationMs: Date.now() - startTime,
  };
}

/**
 * Tool definitions in OpenAI function calling format.
 */
const TOOL_DEFINITIONS: Record<MotorTool, OpenAIChatTool> = {
  code: {
    type: 'function',
    function: {
      name: 'code',
      description:
        'Execute JavaScript code in a sandboxed environment. ' +
        'Use for calculations, data processing, and simple algorithms. ' +
        'Returns the result of the last expression.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute. Can use Math, JSON, Date, console.log.',
          },
        },
        required: ['code'],
      },
    },
  },

  filesystem: {
    type: 'function',
    function: {
      name: 'filesystem',
      description:
        'Read, write, or list files in the workspace directory or skill directory (data/skills/). ' +
        'Use for managing data files, artifacts, and creating SKILL.md files.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'list'],
            description: 'Action to perform',
          },
          path: {
            type: 'string',
            description:
              'File path (relative to workspace). For skill files, use paths like "skills/<name>/SKILL.md".',
          },
          content: {
            type: 'string',
            description: 'File content (for write action).',
          },
        },
        required: ['action', 'path'],
      },
    },
  },

  ask_user: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a question. Pauses execution until they respond. ' +
        'Use when you need clarification, approval, or additional information.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'Question to ask the user. Be clear and specific.',
          },
        },
        required: ['question'],
      },
    },
  },

  shell: {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run allowlisted shell commands (curl, jq, grep, cat, ls, etc.). ' +
        'Supports pipes (e.g., "curl url | jq .data"). ' +
        'Use for fetching URLs, processing text, and file inspection.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run. Only allowlisted commands: curl, jq, grep, cat, head, tail, ls, etc.',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 60000).',
          },
        },
        required: ['command'],
      },
    },
  },

  grep: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search for patterns across workspace files. ' +
        'Returns matching lines in "file:line: content" format (max 50 matches).',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for.',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (relative to workspace). Default: workspace root.',
          },
          glob: {
            type: 'string',
            description: 'File glob pattern to filter (e.g., "*.ts", "*.md"). Default: all files.',
          },
        },
        required: ['pattern'],
      },
    },
  },

  patch: {
    type: 'function',
    function: {
      name: 'patch',
      description:
        'Find-and-replace text in a file. Matches must be exact and unique (exactly 1 occurrence). ' +
        'More precise than full file rewrites via filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path (relative to workspace).',
          },
          old_text: {
            type: 'string',
            description: 'Exact text to find (must appear exactly once in the file).',
          },
          new_text: {
            type: 'string',
            description: 'Text to replace it with.',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
};

/**
 * Maximum grep matches to return.
 */
const MAX_GREP_MATCHES = 50;

/**
 * Recursively list all files in a directory.
 */
async function walkDir(dir: string, basePath = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip node_modules and hidden dirs
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...(await walkDir(join(dir, entry.name), entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Check if a filename matches a simple glob pattern (e.g., "*.ts").
 */
function matchesGlob(filename: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern;
}

/**
 * Tool executors.
 */
const TOOL_EXECUTORS: Record<MotorTool, ToolExecutor> = {
  code: async (args, _ctx): Promise<MotorToolResult> => {
    const code = args['code'] as string;
    if (!code) {
      return {
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    return runSandbox(code, 30_000); // 30s timeout for agentic code steps
  },

  filesystem: async (args, ctx): Promise<MotorToolResult> => {
    if (!args['action'] || !args['path']) {
      return {
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const action = args['action'] as 'read' | 'write' | 'list';
    const path = args['path'] as string;
    const content = args['content'] as string | undefined;

    const startTime = Date.now();

    try {
      switch (action) {
        case 'read': {
          const fullPath = await resolveSafePath(ctx.allowedRoots, path);
          if (!fullPath) return pathTraversalError(startTime);
          const data = await readFile(fullPath, 'utf-8');
          return {
            ok: true,
            output: data,
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
        }

        case 'write': {
          if (content == null) {
            return {
              ok: false,
              output: '',
              errorCode: 'invalid_args',
              retryable: false,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            };
          }
          const fullPath = await resolveSafePath(ctx.allowedRoots, path);
          if (!fullPath) return pathTraversalError(startTime);
          // Ensure parent directory exists
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content, 'utf-8');
          return {
            ok: true,
            output: `Wrote ${String(content.length)} bytes to ${path}`,
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
        }

        case 'list': {
          const fullPath = await resolveSafePath(ctx.allowedRoots, path);
          if (!fullPath) return pathTraversalError(startTime);
          const entries = await readdir(fullPath, { withFileTypes: true });
          const listing = entries
            .map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
            .join('\n');
          return {
            ok: true,
            output: listing || '(empty directory)',
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
        }

        default:
          return {
            ok: false,
            output: '',
            errorCode: 'invalid_args',
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
      }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
        errorCode: 'not_found',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }
  },

  // Not async — returns a plain value. The loop handles the pause logic.
  ask_user: (args, _ctx): Promise<MotorToolResult> => {
    const question = args['question'] as string;
    if (!question) {
      return Promise.resolve({
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      });
    }

    // This is handled specially in the loop - we return the question
    // and the loop will pause and emit a signal
    return Promise.resolve({
      ok: true,
      output: `ASK_USER: ${question}`,
      retryable: false,
      provenance: 'internal',
      durationMs: 0,
    });
  },

  shell: async (args, ctx): Promise<MotorToolResult> => {
    const command = args['command'] as string;
    if (!command) {
      return {
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const timeout = args['timeout'] as number | undefined;
    return runShell(command, { ...(timeout != null && { timeout }), cwd: ctx.workspace });
  },

  grep: async (args, ctx): Promise<MotorToolResult> => {
    const pattern = args['pattern'] as string;
    if (!pattern) {
      return {
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const searchPath = (args['path'] as string | undefined) ?? '.';
    const globPattern = args['glob'] as string | undefined;
    const startTime = Date.now();

    try {
      const fullPath = await resolveSafePath(ctx.allowedRoots, searchPath);
      if (!fullPath) return pathTraversalError(startTime);

      const regex = new RegExp(pattern, 'g');
      const files = await walkDir(fullPath);
      const matches: string[] = [];

      for (const file of files) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (globPattern && !matchesGlob(file, globPattern)) continue;

        try {
          const content = await readFile(join(fullPath, file), 'utf-8');
          const lines = content.split('\n');
          for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            if (matches.length >= MAX_GREP_MATCHES) break;
            regex.lastIndex = 0;
            const line = lines[lineNum] ?? '';
            if (regex.test(line)) {
              matches.push(`${file}:${String(lineNum + 1)}: ${line}`);
            }
          }
        } catch {
          // Skip unreadable files (binary, permissions, etc.)
        }
      }

      const output =
        matches.length > 0
          ? matches.join('\n') +
            (matches.length >= MAX_GREP_MATCHES
              ? `\n\n[... capped at ${String(MAX_GREP_MATCHES)} matches]`
              : '')
          : 'No matches found';

      return {
        ok: true,
        output,
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
        errorCode: 'execution_error',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }
  },

  patch: async (args, ctx): Promise<MotorToolResult> => {
    const path = args['path'] as string | undefined;
    const oldText = args['old_text'] as string | undefined;
    const newText = args['new_text'] as string | undefined;

    if (!path || oldText == null || newText == null) {
      return {
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const fullPath = await resolveSafePath(ctx.allowedRoots, path);
      if (!fullPath) return pathTraversalError(startTime);

      const content = await readFile(fullPath, 'utf-8');

      // Count occurrences
      let count = 0;
      let idx = -1;
      let searchStart = 0;
      while ((idx = content.indexOf(oldText, searchStart)) !== -1) {
        count++;
        searchStart = idx + 1;
        if (count > 1) break; // No need to count further
      }

      if (count === 0) {
        return {
          ok: false,
          output: 'old_text not found in file',
          errorCode: 'not_found',
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      if (count > 1) {
        return {
          ok: false,
          output: `old_text found ${String(count)}+ times (must be exactly 1). Provide more context to make the match unique.`,
          errorCode: 'invalid_args',
          retryable: true,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      // Single match — apply patch
      const firstIdx = content.indexOf(oldText);
      const patched =
        content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length);
      await writeFile(fullPath, patched, 'utf-8');

      // Build summary
      const linesRemoved = oldText.split('\n').length;
      const linesAdded = newText.split('\n').length;

      return {
        ok: true,
        output: `Patched ${path}: -${String(linesRemoved)} lines, +${String(linesAdded)} lines`,
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
        errorCode: 'not_found',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * Get tool definitions for granted tools.
 *
 * @param granted - Tools granted to the sub-agent
 * @returns OpenAI tool definitions
 */
export function getToolDefinitions(granted: MotorTool[]): OpenAIChatTool[] {
  return granted.map((tool) => TOOL_DEFINITIONS[tool]);
}

/**
 * Execute a tool.
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @param ctx - Tool context
 * @returns Tool result
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<MotorToolResult> {
  if (!(name in TOOL_EXECUTORS)) {
    return {
      ok: false,
      output: '',
      errorCode: 'invalid_args',
      retryable: false,
      provenance: 'internal',
      durationMs: 0,
    };
  }

  const executor = TOOL_EXECUTORS[name as MotorTool];
  return executor(args, ctx);
}

/**
 * Create a workspace directory for a run.
 */
export async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'motor-cortex-workspace-'));
}
