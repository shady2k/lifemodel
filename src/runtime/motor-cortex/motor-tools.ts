/**
 * Motor Cortex Tools
 *
 * Tool definitions for the Motor Cortex sub-agent LLM.
 * These are NOT cognition tools - they're the tools the motor sub-agent can call.
 */

import type { OpenAIChatTool } from '../../llm/tool-schema.js';
import type { MotorTool, MotorToolResult } from './motor-protocol.js';
import { runSandbox } from '../sandbox/sandbox-runner.js';
import { readFile, writeFile, readdir, mkdtemp } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tool context passed to executors.
 */
export interface ToolContext {
  /** Workspace directory for file operations */
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
 * Resolve a path within the workspace, preventing traversal attacks.
 *
 * Uses join + prefix check to ensure the resolved path stays inside workspace.
 * Returns null if the path escapes the workspace boundary.
 */
function resolveSafePath(workspace: string, relativePath: string): string | null {
  const resolved = resolve(workspace, relativePath);
  const rel = relative(workspace, resolved);
  // Reject if relative path escapes workspace (starts with ..) or is absolute
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

/**
 * Build a permission_denied result for path traversal attempts.
 */
function pathTraversalError(startTime: number): MotorToolResult {
  return {
    ok: false,
    output: 'Path traversal denied: path must stay within workspace',
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
        'Read, write, or list files in the workspace directory. ' +
        'Use for managing data files and artifacts.',
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
            description: 'File path (relative to workspace). For list, can be a directory path.',
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
};

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
          const fullPath = resolveSafePath(ctx.workspace, path);
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
          const fullPath = resolveSafePath(ctx.workspace, path);
          if (!fullPath) return pathTraversalError(startTime);
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
          const fullPath = resolveSafePath(ctx.workspace, path);
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
