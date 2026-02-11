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
import { runSandbox } from '../sandbox/sandbox-runner.js';
import { runShell } from '../shell/shell-runner.js';
import { readFile, writeFile, readdir, mkdir, mkdtemp, lstat, realpath } from 'node:fs/promises';
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
 * DI callback for web search (provided by web-search plugin).
 */
export type MotorSearchFn = (
  query: string,
  limit?: number
) => Promise<{ title: string; url: string; snippet: string }[]>;

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

  /** DI callback for web search (provided by web-search plugin) */
  searchFn?: MotorSearchFn;
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
export const TOOL_DEFINITIONS: Record<MotorTool, OpenAIChatTool> = {
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
            type: 'string',
            description: 'Request body (for POST/PUT/PATCH).',
          },
        },
        required: ['url'],
      },
    },
  },

  search: {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Search the web for information. Returns titles, URLs, and snippets. ' +
        'Use to find documentation, APIs, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query.',
          },
          limit: {
            type: 'number',
            description: 'Number of results (default: 5, max: 10).',
          },
        },
        required: ['query'],
      },
    },
  },
};

/**
 * Maximum grep matches to return.
 */
const MAX_GREP_MATCHES = 50;

/**
 * Tools that MUST execute on the host (never dispatched to container).
 * fetch and search use DI callbacks that only exist on the host side.
 */
const HOST_ONLY_TOOLS = new Set(['fetch', 'search']);

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
        output: 'Missing "code" argument. Provide JavaScript code as a string.',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    return runSandbox(code, 30_000); // 30s timeout for agentic code steps
  },

  filesystem: async (args, ctx): Promise<MotorToolResult> => {
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

    if (!args['action'] || !args['path']) {
      return {
        ok: false,
        output:
          'Missing required arguments. Usage: filesystem({action: "read"|"write"|"list", path: "file/path", content: "..." (for write)})',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const action = args['action'] as 'read' | 'write' | 'list';
    const path = args['path'] as string;
    // Auto-stringify if model passes JSON object as content (common LLM behavior)
    const rawContent = args['content'];
    const content =
      rawContent == null
        ? undefined
        : typeof rawContent === 'string'
          ? rawContent
          : JSON.stringify(rawContent, null, 2);

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
              output: 'Missing "content" argument. Provide the file content as a string.',
              errorCode: 'invalid_args',
              retryable: false,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            };
          }
          const fullPath = await resolveSafePath(ctx.writeRoots, path);
          if (!fullPath) return pathTraversalError(startTime);
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
        }

        case 'list': {
          const fullPath = await resolveSafePath(ctx.allowedRoots, path);
          if (!fullPath) return pathTraversalError(startTime);
          let entries;
          try {
            entries = await readdir(fullPath, { withFileTypes: true });
          } catch (e: unknown) {
            if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
              return {
                ok: true,
                output:
                  '(directory does not exist yet — use filesystem write to create files here)',
                retryable: false,
                provenance: 'internal',
                durationMs: Date.now() - startTime,
              };
            }
            throw e;
          }
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
          output: `Domain ${hostname} not allowed. Allowed domains: ${allowed.join(', ')}. Call ask_user to request access.`,
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
    const headers = args['headers'] as Record<string, string> | undefined;
    const body = args['body'] as string | undefined;

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

  search: async (args, ctx): Promise<MotorToolResult> => {
    const query = args['query'] as string;
    if (!query) {
      return {
        ok: false,
        output: 'Missing "query" argument. Provide a search query.',
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    // Check search function is available
    if (!ctx.searchFn) {
      return {
        ok: false,
        output: 'Search not configured (web-search plugin not available)',
        errorCode: 'tool_not_available',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }

    // Call search function
    const limit = Math.min(10, (args['limit'] as number | undefined) ?? 5);

    try {
      const results = await ctx.searchFn(query, limit);

      // Format results as numbered list
      const formatted = results
        .map((r, i) => `${String(i + 1)}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
        .join('\n\n');

      return {
        ok: true,
        output: formatted || 'No results found',
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
