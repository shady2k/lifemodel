/**
 * Tool Server — runs inside the Docker container.
 *
 * Long-lived process that:
 * 1. Reads length-prefixed JSON requests from stdin
 * 2. Dispatches to tool executors (code, shell, filesystem, grep, patch)
 * 3. Writes length-prefixed JSON responses to stdout
 * 4. Holds credentials in memory (delivered via special request type)
 * 5. Self-exits after 5 minutes of inactivity (watchdog)
 *
 * IMPORTANT: All console output goes to stderr. Only framed JSON on stdout.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  validatePipeline,
  matchesGlob,
  resolveCredentialPlaceholders as resolveCredentialPlaceholdersUtil,
  findUniqueSubstring,
} from './tool-server-utils.js';

const execFileAsync = promisify(execFile);

// ─── Logging helper (stderr only, stdout reserved for IPC) ─────────

function logToStderr(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(' ') + '\n');
}

// ─── Types (inline to avoid import issues in container) ──────────

interface ToolExecuteRequest {
  type: 'execute';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

interface CredentialDeliverRequest {
  type: 'credential';
  name: string;
  value: string;
}

interface ShutdownRequest {
  type: 'shutdown';
}

interface MotorToolResult {
  ok: boolean;
  output: string;
  errorCode?: string;
  retryable: boolean;
  provenance: 'user' | 'web' | 'internal';
  durationMs: number;
  cost?: number;
}

type ToolServerRequest = ToolExecuteRequest | CredentialDeliverRequest | ShutdownRequest;

// ─── Constants ───────────────────────────────────────────────────

const WORKSPACE = '/workspace';
const SKILLS_DIR = '/skills';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RESULT_SIZE = 32 * 1024; // 32KB
const MAX_GREP_MATCHES = 50;
const MAX_SHELL_OUTPUT = 10 * 1024; // 10KB
const MAX_READ_OUTPUT = 1024 * 1024; // 1MB cap for file reads (well under 10MB frame limit)

// ─── Credential Store (in-memory) ────────────────────────────────

const credentials = new Map<string, string>();

// ─── Length-Prefixed Framing ─────────────────────────────────────

function writeFrame(message: unknown): void {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  const write = (chunk: Buffer) => {
    try {
      process.stdout.write(chunk);
    } catch {
      // Ignore write errors (e.g., broken pipe)
    }
  };
  write(header);
  write(payload);
}

let inputBuffer = Buffer.alloc(0);

function processInputBuffer(): void {
  while (inputBuffer.length >= 4) {
    const payloadLength = inputBuffer.readUInt32BE(0);

    if (payloadLength > 10 * 1024 * 1024) {
      writeFrame({ type: 'error', message: `Frame too large: ${String(payloadLength)}` });
      inputBuffer = inputBuffer.subarray(4 + payloadLength);
      continue;
    }

    if (inputBuffer.length < 4 + payloadLength) {
      break;
    }

    const json = inputBuffer.subarray(4, 4 + payloadLength).toString('utf-8');
    inputBuffer = inputBuffer.subarray(4 + payloadLength);

    try {
      const request = JSON.parse(json) as ToolServerRequest;
      const requestId = 'id' in request ? request.id : undefined;
      handleRequest(request).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        writeFrame({ type: 'error', id: requestId, message: msg });
      });
    } catch {
      writeFrame({ type: 'error', message: `Invalid JSON: ${json.slice(0, 100)}` });
    }
  }
}

// ─── Watchdog Timer ──────────────────────────────────────────────

let watchdog: ReturnType<typeof setTimeout> | null = null;

function resetWatchdog(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    logToStderr('Tool-server idle timeout, exiting');
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

// ─── Request Handler ─────────────────────────────────────────────

async function handleRequest(request: ToolServerRequest): Promise<void> {
  resetWatchdog();

  switch (request.type) {
    case 'execute': {
      const result = await executeTool(request);
      writeFrame({ type: 'result', id: request.id, result });
      break;
    }

    case 'credential': {
      credentials.set(request.name, request.value);
      writeFrame({ type: 'credential_ack', name: request.name });
      break;
    }

    case 'shutdown': {
      logToStderr('Shutdown requested');
      process.exit(0);
    }
  }
}

// ─── Tool Execution ──────────────────────────────────────────────

async function executeTool(request: ToolExecuteRequest): Promise<MotorToolResult> {
  const startTime = Date.now();

  switch (request.tool) {
    case 'code':
      return executeCode(request.args, request.timeoutMs);
    case 'shell':
      return executeShell(request.args, request.timeoutMs);
    case 'filesystem':
      return executeFilesystem(request.args);
    case 'grep':
      return executeGrep(request.args);
    case 'patch':
      return executePatch(request.args);
    case 'ask_user':
      return executeAskUser(request.args);
    default:
      return {
        ok: false,
        output: `Unknown tool: ${request.tool}`,
        errorCode: 'invalid_args',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
  }
}

// ─── Code Execution ──────────────────────────────────────────────

async function executeCode(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<MotorToolResult> {
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

  const startTime = Date.now();
  const workerPath = join(dirname(new URL(import.meta.url).pathname), 'sandbox-worker.js');

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, // Use absolute path to node binary
      [workerPath, '--eval', code],
      {
        timeout: timeoutMs,
        env: {}, // Empty environment
        maxBuffer: MAX_RESULT_SIZE * 2,
      }
    );

    // Worker protocol: JSON result on stdout
    try {
      const result = JSON.parse(stdout) as {
        ok: boolean;
        output: string;
        error: string;
        durationMs: number;
      };
      if (result.ok) {
        return {
          ok: true,
          output: result.output,
          retryable: false,
          provenance: 'internal',
          durationMs: result.durationMs,
        };
      } else {
        return {
          ok: false,
          output: result.output || result.error,
          errorCode: 'execution_error',
          retryable: false,
          provenance: 'internal',
          durationMs: result.durationMs,
        };
      }
    } catch {
      // Fallback: treat stdout as raw output
      return {
        ok: true,
        output: stdout || stderr || '(no output)',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }
  } catch (error) {
    const err = error as { killed?: boolean; message?: string };
    if (err.killed) {
      return {
        ok: false,
        output: '',
        errorCode: 'timeout',
        retryable: true,
        provenance: 'internal',
        durationMs: timeoutMs,
      };
    }
    return {
      ok: false,
      output: err.message ?? String(error),
      errorCode: 'execution_error',
      retryable: true,
      provenance: 'internal',
      durationMs: Date.now() - startTime,
    };
  }
}

// ─── Shell Execution ─────────────────────────────────────────────

async function executeShell(
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<MotorToolResult> {
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

  const startTime = Date.now();
  const timeout = (args['timeout'] as number | undefined) ?? timeoutMs;

  // Validate ALL commands in pipeline + reject dangerous metacharacters
  const validation = validatePipeline(command);
  if (!validation.ok) {
    return {
      ok: false,
      output: validation.error ?? 'Command validation failed',
      errorCode: 'permission_denied',
      retryable: false,
      provenance: 'internal',
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd: WORKSPACE,
      timeout,
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin' },
      maxBuffer: MAX_SHELL_OUTPUT * 2,
    });

    let output = stdout;
    if (output.length > MAX_SHELL_OUTPUT) {
      output = output.slice(0, MAX_SHELL_OUTPUT) + '\n[... truncated]';
    }

    // Detect network commands that returned empty output (likely DNS/iptables block)
    if (validation.hasNetwork && !output && !stderr) {
      return {
        ok: false,
        output:
          'Network request returned empty response. The target domain may not be in the allowed domains list. Use ask_user to request access to additional domains.',
        errorCode: 'execution_error',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }

    return {
      ok: true,
      output: output || stderr || '(no output)',
      retryable: false,
      provenance: validation.hasNetwork ? 'web' : 'internal',
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as { killed?: boolean; stderr?: string; message?: string };
    if (err.killed) {
      return {
        ok: false,
        output: 'Command timed out.',
        errorCode: 'timeout',
        retryable: true,
        provenance: 'internal',
        durationMs: timeout,
      };
    }

    const errorOutput = err.stderr ?? err.message ?? String(error);

    // Add hint for network errors
    const networkHint =
      validation.hasNetwork && /resolve|refused|reset|unreachable|Network/i.test(errorOutput)
        ? '\nNote: The domain may not be in the allowed list. Use ask_user to request access to additional domains.'
        : '';

    return {
      ok: false,
      output: errorOutput + networkHint,
      errorCode: 'execution_error',
      retryable: false,
      provenance: 'internal',
      durationMs: Date.now() - startTime,
    };
  }
}

// ─── Filesystem Operations ───────────────────────────────────────

const ALLOWED_ROOTS = [WORKSPACE, SKILLS_DIR];

async function resolveSafePath(relativePath: string): Promise<string | null> {
  for (const root of ALLOWED_ROOTS) {
    const resolved = resolve(root, relativePath);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;

    try {
      let checkPath = resolved;
      try {
        await lstat(resolved);
      } catch {
        checkPath = dirname(resolved);
        try {
          await lstat(checkPath);
        } catch {
          return resolved;
        }
      }

      const real = await realpath(checkPath);
      for (const r of ALLOWED_ROOTS) {
        try {
          const realRoot = await realpath(r);
          const rr = relative(realRoot, real);
          if (!rr.startsWith('..') && !isAbsolute(rr)) return resolved;
        } catch {
          // Root doesn't exist
        }
      }
      return null;
    } catch {
      return resolved;
    }
  }
  return null;
}

function pathError(startTime: number): MotorToolResult {
  return {
    ok: false,
    output: 'Path traversal denied: path must stay within allowed directories',
    errorCode: 'permission_denied',
    retryable: false,
    provenance: 'internal',
    durationMs: Date.now() - startTime,
  };
}

async function executeFilesystem(args: Record<string, unknown>): Promise<MotorToolResult> {
  // Auto-fix common LLM arg mistakes: filesystem({read: "path"}) → {action: "read", path: "path"}
  if (!args['action'] && !args['path']) {
    for (const action of ['read', 'write', 'list']) {
      if (typeof args[action] === 'string') {
        args['action'] = action;
        args['path'] = args[action];
        break;
      }
    }
  }

  const action = args['action'] as string;
  const path = args['path'] as string;
  // Auto-stringify if model passes JSON object as content (common LLM behavior)
  const rawContent = args['content'];
  const content =
    rawContent == null
      ? undefined
      : typeof rawContent === 'string'
        ? rawContent
        : JSON.stringify(rawContent, null, 2);

  if (!action || !path) {
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

  const startTime = Date.now();

  // Resolve credential placeholders in content
  const resolvedContent =
    content != null ? resolveCredentialPlaceholdersUtil(content, credentials) : undefined;

  try {
    switch (action) {
      case 'read': {
        const fullPath = await resolveSafePath(path);
        if (!fullPath) return pathError(startTime);
        let data = await readFile(fullPath, 'utf-8');
        if (data.length > MAX_READ_OUTPUT) {
          data = data.slice(0, MAX_READ_OUTPUT) + '\n[... truncated at 1MB]';
        }
        return {
          ok: true,
          output: data,
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      case 'write': {
        if (resolvedContent == null) {
          return {
            ok: false,
            output: 'Missing "content" argument. Provide the file content as a string.',
            errorCode: 'invalid_args',
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          };
        }
        const fullPath = await resolveSafePath(path);
        if (!fullPath) return pathError(startTime);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, resolvedContent, 'utf-8');
        return {
          ok: true,
          output: `Wrote ${String(resolvedContent.length)} bytes to ${path}`,
          retryable: false,
          provenance: 'internal',
          durationMs: Date.now() - startTime,
        };
      }

      case 'list': {
        const fullPath = await resolveSafePath(path);
        if (!fullPath) return pathError(startTime);
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
}

// ─── Grep ────────────────────────────────────────────────────────

async function walkDir(dir: string, basePath = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...(await walkDir(join(dir, entry.name), entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function executeGrep(args: Record<string, unknown>): Promise<MotorToolResult> {
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
    const fullPath = await resolveSafePath(searchPath);
    if (!fullPath) return pathError(startTime);

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
        // Skip unreadable files
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
}

// ─── Patch ───────────────────────────────────────────────────────

async function executePatch(args: Record<string, unknown>): Promise<MotorToolResult> {
  const path = args['path'] as string | undefined;
  const oldText = args['old_text'] as string | undefined;
  const newText = args['new_text'] as string | undefined;

  if (!path || !oldText || !newText) {
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
    const fullPath = await resolveSafePath(path);
    if (!fullPath) return pathError(startTime);

    const content = await readFile(fullPath, 'utf-8');

    const findResult = findUniqueSubstring(content, oldText);

    if (!findResult.ok) {
      const errorCode = findResult.error === 'not_found' ? 'not_found' : 'invalid_args';
      const output =
        findResult.error === 'not_found'
          ? 'old_text not found in file'
          : findResult.error === 'ambiguous'
            ? 'old_text found 2+ times (must be exactly 1)'
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

    const patched =
      content.slice(0, findResult.index) +
      newText +
      content.slice(findResult.index + oldText.length);
    await writeFile(fullPath, patched, 'utf-8');

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
}

// ─── Ask User (pass-through) ─────────────────────────────────────

function executeAskUser(args: Record<string, unknown>): MotorToolResult {
  const question = args['question'] as string;
  if (!question) {
    return {
      ok: false,
      output: '',
      errorCode: 'invalid_args',
      retryable: false,
      provenance: 'internal',
      durationMs: 0,
    };
  }
  return {
    ok: true,
    output: `ASK_USER: ${question}`,
    retryable: false,
    provenance: 'internal',
    durationMs: 0,
  };
}

// ─── Main ────────────────────────────────────────────────────────

logToStderr('Tool-server starting');
resetWatchdog();

process.stdin.on('data', (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processInputBuffer();
});

process.stdin.on('end', () => {
  logToStderr('Stdin closed, exiting');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logToStderr('SIGTERM received, exiting');
  process.exit(0);
});

logToStderr('Tool-server ready');
