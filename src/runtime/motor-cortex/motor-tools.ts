/**
 * Motor Cortex Tools
 *
 * Tool definitions for the Motor Cortex sub-agent LLM.
 * These are NOT cognition tools - they're the tools the motor sub-agent can call.
 */

import type { OpenAIChatTool } from '../../llm/tool-schema.js';
import type { MotorTool, MotorToolResult } from './motor-protocol.js';
import type {
  ContainerHandle,
  ToolExecuteRequest,
  ToolExecuteResponse,
} from '../container/types.js';
import { runShell } from '../shell/shell-runner.js';
import { fuzzyFindUnique, matchesGlobPattern } from '../container/tool-server-utils.js';
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  mkdtemp,
  lstat,
  realpath,
  stat,
} from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * DI callback for web fetch (provided by web-fetch plugin).
 */
export type MotorFetchFn = (
  url: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
) => Promise<{ ok: boolean; status: number; content: string; contentType: string }>;

/**
 * Tool context passed to executors.
 */
export interface ToolContext {
  /** Allowed root directories for read operations */
  allowedRoots: string[];

  /** Allowed root directories for write operations (subset of allowedRoots) */
  writeRoots: string[];

  /** Primary workspace directory (first allowed root) */
  workspace: string;

  /** Container handle for dispatching tools via Docker isolation (optional) */
  containerHandle?: ContainerHandle;

  /** Allowed network domains for this run (from run.domains) */
  allowedDomains?: string[];

  /** DI callback for web fetch (provided by web-fetch plugin) */
  fetchFn?: MotorFetchFn;
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
 * Synthetic tool definitions (injected by motor-loop, NOT part of MotorTool union).
 *
 * ask_user and request_approval are synthetic because:
 * - They're NOT dispatched to container (host-side only)
 * - They're conditionally injected based on run state
 * - They don't live in TOOL_EXECUTORS (special handling in loop)
 */
export const SYNTHETIC_TOOL_DEFINITIONS = {
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
          message: {
            type: 'string',
            description: 'Alias for question.',
          },
        },
        required: ['question'],
      },
    },
  },
  request_approval: {
    type: 'function',
    function: {
      name: 'request_approval',
      description:
        'Request approval before performing a potentially dangerous action (e.g., network requests that send data, destructive operations). Pauses execution until approved.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Description of the action needing approval.',
          },
        },
        required: ['action'],
      },
    },
  },
} satisfies Record<string, OpenAIChatTool>;

/**
 * Tool definitions in OpenAI function calling format.
 */
export const TOOL_DEFINITIONS: Record<MotorTool, OpenAIChatTool> = {
  read: {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read a file. Returns content with line numbers (max 2000 lines). Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path (relative to workspace).',
          },
          offset: {
            type: 'number',
            description: 'Start line (1-based, default 1).',
          },
          limit: {
            type: 'number',
            description: 'Max lines to read (default 2000, max 2000).',
          },
        },
        required: ['path'],
      },
    },
  },

  write: {
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write content to a file. Creates parent directories automatically. ' +
        'Writes to workspace only — use relative paths (e.g. "output.txt", "skills/name/SKILL.md").',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'File path relative to workspace (e.g. "output.txt"). Do NOT use absolute paths like /skills/.',
          },
          content: {
            type: 'string',
            description: 'File content to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },

  list: {
    type: 'function',
    function: {
      name: 'list',
      description:
        'List files and directories. Returns entries with [DIR]/[FILE] markers. Use to discover workspace structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path (relative to workspace, default ".").',
          },
          recursive: {
            type: 'boolean',
            description: 'List files recursively (default false).',
          },
        },
        required: [],
      },
    },
  },

  glob: {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files by glob pattern (e.g., "**/*.ts"). Returns paths sorted by modification time (newest first).',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match files (e.g., "**/*.ts", "*.md").',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (relative to workspace, default ".").',
          },
        },
        required: ['pattern'],
      },
    },
  },

  bash: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run commands (node, npm, npx, python, pip, curl, jq, grep, cat, head, tail, ls, git, etc.). ' +
        'Full async Node.js via "node script.js". Supports pipes (e.g., "curl url | jq .data"). ' +
        'Use for HTTP requests, package management, running scripts, and file processing.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run. Supports node, npm, npx, python, pip, curl, jq, grep, cat, ls, git, etc.',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 60000, max: 120000).',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this command does (for logging).',
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
        'Returns matching lines in "file:line: content" format (max 100 matches, 200 chars per line).',
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
        'Find-and-replace text in a file. First tries exact match (must be unique). ' +
        'Falls back to fuzzy matching (trimmed trailing whitespace, normalized whitespace, flexible indentation) if exact not found. ' +
        'More precise than full file rewrites via write.',
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

  fetch: {
    type: 'function',
    function: {
      name: 'fetch',
      description:
        'Fetch a URL (GET/POST/PUT/DELETE). Returns content (HTML→Markdown for web pages, raw for JSON/text). ' +
        'Domain-restricted. Prefer over shell curl for HTTP requests.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to fetch (must be in allowed domains list).',
          },
          method: {
            type: 'string',
            description: 'HTTP method (default: GET).',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          },
          headers: {
            type: 'object',
            description: 'HTTP headers as key-value pairs.',
          },
          body: {
            type: ['string', 'object'],
            description: 'Request body (for POST/PUT/PATCH). Pass a JSON object or a JSON string.',
          },
        },
        required: ['url'],
      },
    },
  },
};

/**
 * Maximum grep matches to return.
 */
const MAX_GREP_MATCHES = 100;

/**
 * Maximum characters per grep match line.
 */
const MAX_GREP_LINE_LENGTH = 200;

/**
 * Maximum lines for read tool output.
 */
const MAX_READ_LINES = 2000;

/**
 * Maximum characters for read tool output.
 */
const MAX_READ_CHARS = 50 * 1024; // 50KB

/**
 * Maximum entries for list tool (recursive mode).
 */
const MAX_LIST_ENTRIES = 200;

/**
 * Maximum files for glob tool output.
 */
const MAX_GLOB_RESULTS = 100;

/**
 * Maximum files scanned by glob before early termination.
 */
const MAX_GLOB_SCAN = 5000;

/**
 * Maximum shell timeout in milliseconds.
 */
const MAX_SHELL_TIMEOUT = 120_000;

/**
 * Tools that MUST execute on the host (never dispatched to container).
 * fetch uses a DI callback that only exists on the host side.
 */
const HOST_ONLY_TOOLS = new Set(['fetch']);

/**
 * Recursively list all files in a directory with optional early termination.
 */
async function walkDir(dir: string, basePath = '', maxEntries?: number): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (maxEntries != null && files.length >= maxEntries) break;
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip node_modules and hidden dirs
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const remaining = maxEntries != null ? maxEntries - files.length : undefined;
      files.push(...(await walkDir(join(dir, entry.name), entryPath, remaining)));
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
 * Check if a buffer contains null bytes (binary detection).
 */
function isBinaryBuffer(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Tool executors.
 */
const TOOL_EXECUTORS: Record<MotorTool, ToolExecutor> = {
  read: async (args, ctx): Promise<MotorToolResult> => {
    const path = args['path'] as string;
    if (!path) {
      return {
        ok: false,
        output: 'Missing required parameter: "path". Usage: read({path: "file.txt"}).',
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

      // Binary detection: read first 512 bytes as buffer
      const fileHandle = await readFile(fullPath);
      if (isBinaryBuffer(fileHandle)) {
        return {
          ok: true,
          output: `Binary file (${String(fileHandle.length)} bytes). Use bash to inspect.`,
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      const data = fileHandle.toString('utf-8');
      const allLines = data.split('\n');
      const totalLines = allLines.length;

      // Clamp offset/limit
      const rawOffset = args['offset'] as number | undefined;
      const rawLimit = args['limit'] as number | undefined;
      const offset = Math.max(1, Math.min(totalLines, Math.floor(rawOffset ?? 1)));
      const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(rawLimit ?? MAX_READ_LINES)));

      // Apply offset (1-based) and limit
      const sliced = allLines.slice(offset - 1, offset - 1 + limit);

      // Format with line numbers
      const lineNumWidth = String(offset - 1 + sliced.length).length;
      let output = sliced
        .map((line, i) => {
          const lineNum = String(offset + i).padStart(lineNumWidth, ' ');
          return `${lineNum}| ${line}`;
        })
        .join('\n');

      // Apply 50KB character cap
      if (output.length > MAX_READ_CHARS) {
        output = output.slice(0, MAX_READ_CHARS);
        // Find last complete line
        const lastNewline = output.lastIndexOf('\n');
        if (lastNewline > 0) output = output.slice(0, lastNewline);
      }

      // Truncation notice
      const endLine = offset - 1 + sliced.length;
      if (endLine < totalLines) {
        output += `\n[... truncated: ${String(totalLines)} total lines. Use offset=${String(endLine + 1)} to continue.]`;
      }

      return {
        ok: true,
        output,
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return {
          ok: false,
          output: `File not found: ${path}`,
          errorCode: 'not_found',
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }
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

  write: async (args, ctx): Promise<MotorToolResult> => {
    const path = args['path'] as string;
    // Auto-stringify if model passes JSON object as content
    const rawContent = args['content'];
    const content =
      rawContent == null
        ? undefined
        : typeof rawContent === 'string'
          ? rawContent
          : JSON.stringify(rawContent, null, 2);

    if (!path) {
      const received = Object.keys(args).join(', ');
      return {
        ok: false,
        output: `Missing "path" argument. Usage: write({path: "file.txt", content: "..."}).${received ? ` You passed: {${received}}. Use "path" instead.` : ''}`,
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }
    if (content == null) {
      return {
        ok: false,
        output: 'Missing "content" argument. Provide the file content as a string.',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const fullPath = await resolveSafePath(ctx.writeRoots, path);
      if (!fullPath) {
        // Give specific guidance when model uses absolute /skills/ path
        const hint = path.startsWith('/skills/')
          ? ` The /skills/ directory is read-only. Use a relative path instead: "${path.replace(/^\/skills\//, 'skills/')}".`
          : ' Use a relative path (e.g. "output.txt", "skills/name/file.md").';
        return {
          ok: false,
          output: `Write denied: "${path}" is outside the workspace.${hint}`,
          errorCode: 'permission_denied',
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }
      // Reject writes to symlinks
      try {
        const stats = await lstat(fullPath);
        if (stats.isSymbolicLink()) {
          return {
            ok: false,
            output: 'Cannot write to symlink',
            errorCode: 'permission_denied',
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
        }
      } catch {
        // File doesn't exist yet - that's fine for writes
      }
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

  list: async (args, ctx): Promise<MotorToolResult> => {
    const path = (args['path'] as string | undefined) ?? '.';
    const recursive = (args['recursive'] as boolean | undefined) ?? false;
    const startTime = Date.now();

    try {
      const fullPath = await resolveSafePath(ctx.allowedRoots, path);
      if (!fullPath) return pathTraversalError(startTime);

      if (recursive) {
        const files = await walkDir(fullPath, '', MAX_LIST_ENTRIES);
        const capped = files.length >= MAX_LIST_ENTRIES;
        const output =
          files.join('\n') +
          (capped ? `\n[... capped at ${String(MAX_LIST_ENTRIES)} entries]` : '');
        return {
          ok: true,
          output: output || '(empty directory)',
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      let entries;
      try {
        entries = await readdir(fullPath, { withFileTypes: true });
      } catch (e: unknown) {
        if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
          return {
            ok: true,
            output: '(directory does not exist)',
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
        }
        throw e;
      }

      // Sort: directories first, then alphabetical
      const sorted = [...entries].sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      const listing = sorted
        .slice(0, MAX_LIST_ENTRIES)
        .map((e) => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
        .join('\n');

      const output = listing || '(empty directory)';
      return {
        ok: true,
        output:
          sorted.length > MAX_LIST_ENTRIES
            ? output + `\n[... capped at ${String(MAX_LIST_ENTRIES)} entries]`
            : output,
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

  glob: async (args, ctx): Promise<MotorToolResult> => {
    const pattern = args['pattern'] as string;
    if (!pattern) {
      return {
        ok: false,
        output: 'Missing "pattern" argument.',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    // Validate pattern: reject path escape attempts
    if (pattern.startsWith('..') || pattern.includes('../')) {
      return {
        ok: false,
        output: 'Pattern must not escape the search directory.',
        errorCode: 'permission_denied',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const path = (args['path'] as string | undefined) ?? '.';
    const startTime = Date.now();

    try {
      const fullPath = await resolveSafePath(ctx.allowedRoots, path);
      if (!fullPath) return pathTraversalError(startTime);

      // Walk directory with early termination
      const allFiles = await walkDir(fullPath, '', MAX_GLOB_SCAN);

      // Filter using glob matching
      const matched: string[] = [];
      for (const file of allFiles) {
        if (matched.length >= MAX_GLOB_RESULTS) break;
        if (matchesGlobPattern(file, pattern)) {
          matched.push(file);
        }
      }

      // Sort by mtime (newest first) — only stat matched files
      const withMtime: { file: string; mtime: number }[] = [];
      for (const file of matched) {
        try {
          const s = await stat(join(fullPath, file));
          withMtime.push({ file, mtime: s.mtimeMs });
        } catch {
          withMtime.push({ file, mtime: 0 });
        }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const output = withMtime.map((f) => f.file).join('\n');
      const capped = matched.length >= MAX_GLOB_RESULTS;

      return {
        ok: true,
        output:
          (output || 'No files matched') +
          (capped ? `\n[... capped at ${String(MAX_GLOB_RESULTS)} files]` : ''),
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

  bash: async (args, ctx): Promise<MotorToolResult> => {
    // Accept common aliases: models often pass {"curl":"..."} or {"cmd":"..."} instead of {"command":"..."}
    const command = (args['command'] ?? args['cmd'] ?? args['curl'] ?? args['run']) as string;
    if (!command) {
      return {
        ok: false,
        output: 'Missing "command" argument. Provide a shell command string.',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const rawTimeout = args['timeout'] as number | undefined;
    const timeout = rawTimeout != null ? Math.min(rawTimeout, MAX_SHELL_TIMEOUT) : undefined;
    return runShell(command, { ...(timeout != null && { timeout }), cwd: ctx.workspace });
  },

  grep: async (args, ctx): Promise<MotorToolResult> => {
    const pattern = args['pattern'] as string;
    if (!pattern) {
      const received = Object.keys(args).join(', ');
      return {
        ok: false,
        output: `Missing "pattern" argument. Usage: grep({pattern: "regex", path: "dir"}).${received ? ` You passed: {${received}}.` : ''}`,
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
            let line = lines[lineNum] ?? '';
            if (regex.test(line)) {
              // Per-line truncation
              const truncated = line.length > MAX_GREP_LINE_LENGTH;
              if (truncated) line = line.slice(0, MAX_GREP_LINE_LENGTH) + '[line truncated]';
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
      const received = Object.keys(args).join(', ');
      const missing = [!path && '"path"', !oldText && '"old_text"', !newText && '"new_text"']
        .filter(Boolean)
        .join(', ');
      return {
        ok: false,
        output: `Missing required arguments: ${missing}. Usage: patch({path: "file.txt", old_text: "find this", new_text: "replace with"}).${received ? ` You passed: {${received}}.` : ''}`,
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

      // Try exact match first, then fuzzy
      const findResult = fuzzyFindUnique(content, oldText);

      if (!findResult.ok) {
        const errorCode = findResult.error === 'not_found' ? 'not_found' : 'invalid_args';
        const output =
          findResult.error === 'not_found'
            ? 'old_text not found in file (tried exact + fuzzy matching)'
            : findResult.error === 'ambiguous'
              ? 'old_text found 2+ times (must be exactly 1). Provide more context to make the match unique.'
              : 'old_text cannot be empty';
        return {
          ok: false,
          output,
          errorCode,
          retryable: findResult.error === 'ambiguous',
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      // Apply patch at the found position
      // For fuzzy matches, we need to find the actual text in the content at that position
      // The index points to where the match starts in the original content
      // We need to determine how long the matched segment is in the original content
      // For exact strategy, it's oldText.length. For fuzzy, we need the original span.
      // Since fuzzyFindUnique returns the index in the normalized content mapped back,
      // we use the oldText length for replacement (the strategies normalize for matching but
      // the index maps back to original positions)
      const matchEnd = findResult.index + oldText.length;
      const patched = content.slice(0, findResult.index) + newText + content.slice(matchEnd);
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

  fetch: async (args, ctx): Promise<MotorToolResult> => {
    const url = args['url'] as string;
    if (!url) {
      return {
        ok: false,
        output: 'Missing "url" argument. Provide a URL to fetch.',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    // Check domain is allowed
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const allowed = ctx.allowedDomains ?? [];

      if (!allowed.includes(hostname) && !allowed.some((d) => hostname.endsWith(`.${d}`))) {
        return {
          ok: false,
          output: `BLOCKED: Domain ${hostname} is not in the allowed list. You MUST call ask_user now to request access to this domain. Do not try alternative URLs or workarounds. Allowed domains: ${allowed.join(', ')}.`,
          errorCode: 'permission_denied',
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }
    } catch {
      return {
        ok: false,
        output: 'Invalid URL format',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }

    // Check fetch function is available
    if (!ctx.fetchFn) {
      return {
        ok: false,
        output: 'Fetch not configured (web-fetch plugin not available)',
        errorCode: 'tool_not_available',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }

    // Call fetch function
    const method = (args['method'] as string | undefined) ?? 'GET';
    // Weak models sometimes pass headers as a JSON string instead of an object
    const rawHeaders = args['headers'];
    let headers: Record<string, string> | undefined;
    if (typeof rawHeaders === 'string') {
      try {
        headers = JSON.parse(rawHeaders) as Record<string, string>;
      } catch {
        // Malformed JSON string — ignore headers
      }
    } else if (rawHeaders && typeof rawHeaders === 'object') {
      headers = rawHeaders as Record<string, string>;
    }
    // Weak models sometimes pass body as an object instead of a JSON string
    const rawBody = args['body'];
    const body =
      rawBody == null ? undefined : typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);

    try {
      const result = await ctx.fetchFn(url, {
        method,
        ...(headers && { headers }),
        ...(body && { body }),
      });

      // Truncate response to 10KB
      const maxLength = 10 * 1024;
      const truncated =
        result.content.length > maxLength
          ? result.content.slice(0, maxLength) +
            `\n\n[... response truncated to ${String(maxLength)} bytes]`
          : result.content;

      return {
        ok: result.ok,
        output: truncated,
        retryable: false,
        provenance: 'web',
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
        errorCode: 'execution_error',
        retryable: true,
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
 * Default timeout for tool execution requests (30s).
 */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Execute a tool.
 *
 * When a containerHandle is present in the context, the tool is dispatched
 * to the Docker container via IPC. Otherwise, it executes directly in-process.
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
  // Compat shim: route legacy 'filesystem' tool calls to read/write/list.
  // Handles in-flight resumed runs with pending filesystem tool calls in their message history.
  if (name === 'filesystem') {
    // Auto-fix common LLM arg mistakes: filesystem({read: "path"}) → {action: "read", path: "path"}
    if (!args['action'] && !args['path']) {
      for (const action of ['read', 'write', 'list'] as const) {
        if (typeof args[action] === 'string') {
          args['action'] = action;
          args['path'] = args[action];
          break;
        }
      }
    }
    const action = args['action'] as string | undefined;
    if (action === 'write') return TOOL_EXECUTORS.write(args, ctx);
    if (action === 'list') return TOOL_EXECUTORS.list(args, ctx);
    return TOOL_EXECUTORS.read(args, ctx); // Default to read
  }

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

  // Container dispatch path: serialize and send to container
  // EXCEPTION: fetch and search are HOST_ONLY (use DI callbacks that don't exist in container)
  if (ctx.containerHandle && !HOST_ONLY_TOOLS.has(name)) {
    const request: ToolExecuteRequest = {
      type: 'execute',
      id: crypto.randomUUID(),
      tool: name,
      args,
      timeoutMs: (args['timeout'] as number | undefined) ?? DEFAULT_TOOL_TIMEOUT_MS,
    };

    try {
      const response: ToolExecuteResponse = await ctx.containerHandle.execute(request);
      return response.result;
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
        errorCode: 'execution_error',
        retryable: true,
        provenance: 'internal',
        durationMs: 0,
      };
    }
  }

  // Direct execution path (no container)
  const executor = TOOL_EXECUTORS[name as MotorTool];
  return executor(args, ctx);
}

/**
 * Create a workspace directory for a run.
 */
export async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'motor-cortex-workspace-'));
}
