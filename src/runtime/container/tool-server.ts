/**
 * Tool Server — runs inside the Docker container.
 *
 * Long-lived process that:
 * 1. Reads length-prefixed JSON requests from stdin
 * 2. Dispatches to tool executors (bash, read, write, list, glob, grep, patch)
 * 3. Writes length-prefixed JSON responses to stdout
 * 4. Holds credentials in memory (delivered via special request type)
 * 5. Self-exits after 5 minutes of inactivity (watchdog)
 *
 * IMPORTANT: All console output goes to stderr. Only framed JSON on stdout.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, lstat, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  validatePipeline,
  matchesGlob,
  matchesGlobPattern,
  fuzzyFindUnique,
  resolveCredentialPlaceholders,
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
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_LENGTH = 200;
const MAX_SHELL_OUTPUT = 10 * 1024; // 10KB
const MAX_SHELL_TIMEOUT = 120_000;
const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 50 * 1024; // 50KB
const MAX_LIST_ENTRIES = 200;
const MAX_GLOB_RESULTS = 100;
const MAX_GLOB_SCAN = 5000;

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
    case 'bash':
      return executeBash(request.args, request.timeoutMs);
    case 'read':
      return executeRead(request.args);
    case 'write':
      return executeWrite(request.args);
    case 'list':
      return executeList(request.args);
    case 'glob':
      return executeGlob(request.args);
    case 'grep':
      return executeGrep(request.args);
    case 'patch':
      return executePatch(request.args);

    // Compat shim: route legacy 'filesystem' tool calls to read/write/list.
    // Handles resumed runs with pending filesystem tool calls in their message history.
    case 'filesystem': {
      const args = request.args;
      // Auto-fix common LLM arg mistakes
      if (!args['action'] && !args['path']) {
        for (const action of ['read', 'write', 'list']) {
          if (typeof args[action] === 'string') {
            args['action'] = action;
            args['path'] = args[action];
            break;
          }
        }
      }
      const action = args['action'] as string | undefined;
      if (action === 'write') return executeWrite(args);
      if (action === 'list') return executeList(args);
      return executeRead(args); // Default to read
    }

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

// ─── Shell Environment ──────────────────────────────────────────

/**
 * Build a sanitized environment for shell subprocesses.
 *
 * Inherits container ENV vars (NPM_CONFIG_CACHE, PIP_*, PYTHONUSERBASE, PATH, HOME)
 * so that `npm install` and `pip install` work on the read-only root filesystem.
 * Credentials are excluded — they are injected via <credential:X> placeholder
 * resolution, not leaked into the shell environment.
 */
function buildShellEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Inherit safe container environment variables
  const INHERITED_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'TERM',
    // npm
    'NPM_CONFIG_CACHE',
    // pip / Python
    'PIP_USER',
    'PYTHONUSERBASE',
    'PIP_CACHE_DIR',
    'PIP_BREAK_SYSTEM_PACKAGES',
    // Node.js
    'NODE_VERSION',
    'NODE_PATH',
  ];

  for (const key of INHERITED_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Fallback PATH if not set
  if (!env['PATH']) {
    env['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  }

  // Inject credentials as env vars so scripts can use process.env.NAME or $NAME.
  // This is the runtime-only path — credentials never touch disk.
  for (const [name, value] of credentials) {
    env[name] = value;
  }

  return env;
}

// ─── Bash Execution ─────────────────────────────────────────────

async function executeBash(
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
  const rawTimeout = (args['timeout'] as number | undefined) ?? timeoutMs;
  const timeout = Math.min(rawTimeout, MAX_SHELL_TIMEOUT);

  // Log description to stderr if provided
  const description = args['description'] as string | undefined;
  if (description) {
    logToStderr(`[${description}]`);
  }

  // Resolve <credential:NAME> placeholders in the command string.
  // File content keeps placeholders (no disk leakage); resolution happens here at execution time.
  const resolved = resolveCredentialPlaceholders(command, credentials);

  // Validate ALL commands in pipeline + reject dangerous metacharacters
  const validation = validatePipeline(resolved);
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
    const { stdout, stderr } = await execFileAsync('sh', ['-c', resolved], {
      cwd: WORKSPACE,
      timeout,
      env: buildShellEnv(),
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

// ─── Path Safety ─────────────────────────────────────────────────

const ALLOWED_ROOTS = [WORKSPACE, SKILLS_DIR];
const WRITE_ROOTS = [WORKSPACE];

async function resolveSafePath(relativePath: string, roots?: string[]): Promise<string | null> {
  const allowedRoots = roots ?? ALLOWED_ROOTS;
  for (const root of allowedRoots) {
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
      for (const r of allowedRoots) {
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

// ─── Read ─────────────────────────────────────────────────────────

function isBinaryBuffer(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function executeRead(args: Record<string, unknown>): Promise<MotorToolResult> {
  // Accept common aliases for 'path' (weak models often use intuitive names)
  const path = (args['path'] ?? args['file'] ?? args['filename'] ?? args['filepath']) as string;
  if (!path) {
    const received = Object.keys(args).join(', ');
    return {
      ok: false,
      output: `Missing "path" argument. Usage: read({path: "file.txt"}).${received ? ` You passed: {${received}}. Use "path" instead.` : ''}`,
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

    // Binary detection
    const fileBuffer = await readFile(fullPath);
    if (isBinaryBuffer(fileBuffer)) {
      return {
        ok: true,
        output: `Binary file (${String(fileBuffer.length)} bytes). Use shell to inspect.`,
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }

    const data = fileBuffer.toString('utf-8');
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

    // Apply character cap
    if (output.length > MAX_READ_CHARS) {
      output = output.slice(0, MAX_READ_CHARS);
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
}

// ─── Write ────────────────────────────────────────────────────────

async function executeWrite(args: Record<string, unknown>): Promise<MotorToolResult> {
  // Accept common aliases for 'path' (weak models often use intuitive names)
  const path = (args['path'] ?? args['file'] ?? args['filename'] ?? args['filepath']) as string;
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

  // Do NOT resolve credential placeholders in file content.
  // Credentials must stay as <credential:X> placeholders on disk to prevent key leakage.
  // They are resolved at execution time in executeBash() via resolveCredentialPlaceholders()
  // and also injected as env vars via buildShellEnv().
  const resolvedContent = content;

  try {
    const fullPath = await resolveSafePath(path, WRITE_ROOTS);
    if (!fullPath) {
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
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, resolvedContent, 'utf-8');
    return {
      ok: true,
      output: `Wrote ${String(resolvedContent.length)} bytes to ${path}`,
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

// ─── List ─────────────────────────────────────────────────────────

async function executeList(args: Record<string, unknown>): Promise<MotorToolResult> {
  // Accept 'directory' as alias for 'path' (weak models often use intuitive names)
  const path =
    (args['path'] as string | undefined) ?? (args['directory'] as string | undefined) ?? '.';
  const recursive = (args['recursive'] as boolean | undefined) ?? false;
  const startTime = Date.now();

  try {
    const fullPath = await resolveSafePath(path);
    if (!fullPath) return pathError(startTime);

    if (recursive) {
      const files = await walkDir(fullPath, '', MAX_LIST_ENTRIES);
      const capped = files.length >= MAX_LIST_ENTRIES;
      const output =
        files.join('\n') + (capped ? `\n[... capped at ${String(MAX_LIST_ENTRIES)} entries]` : '');
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
}

// ─── Glob ─────────────────────────────────────────────────────────

async function executeGlob(args: Record<string, unknown>): Promise<MotorToolResult> {
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
    const fullPath = await resolveSafePath(path);
    if (!fullPath) return pathError(startTime);

    const allFiles = await walkDir(fullPath, '', MAX_GLOB_SCAN);

    const matched: string[] = [];
    for (const file of allFiles) {
      if (matched.length >= MAX_GLOB_RESULTS) break;
      if (matchesGlobPattern(file, pattern)) {
        matched.push(file);
      }
    }

    // Sort by mtime (newest first)
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
}

// ─── Grep ────────────────────────────────────────────────────────

async function walkDir(dir: string, basePath = '', maxEntries?: number): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (maxEntries != null && files.length >= maxEntries) break;
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const remaining = maxEntries != null ? maxEntries - files.length : undefined;
      files.push(...(await walkDir(join(dir, entry.name), entryPath, remaining)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function executeGrep(args: Record<string, unknown>): Promise<MotorToolResult> {
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
          let line = lines[lineNum] ?? '';
          if (regex.test(line)) {
            // Per-line truncation
            const truncated = line.length > MAX_GREP_LINE_LENGTH;
            if (truncated) line = line.slice(0, MAX_GREP_LINE_LENGTH) + '[line truncated]';
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
  // Accept common aliases (weak models often use camelCase or intuitive names)
  const path = (args['path'] ?? args['file'] ?? args['filename'] ?? args['filepath']) as
    | string
    | undefined;
  const oldText = (args['old_text'] ??
    args['oldText'] ??
    args['search'] ??
    args['match'] ??
    args['text']) as string | undefined;
  const newText = (args['new_text'] ??
    args['newText'] ??
    args['replace'] ??
    args['replacement']) as string | undefined;

  if (!path || !oldText || !newText) {
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
    // Patch mutates files — resolve against writable roots only
    const fullPath = await resolveSafePath(path, WRITE_ROOTS);
    if (!fullPath) {
      const hint = path.startsWith('/skills/')
        ? ` The /skills/ directory is read-only. Use a relative path instead: "${path.replace(/^\/skills\//, 'skills/')}".`
        : ' Use a relative path (e.g. "output.txt", "skills/name/file.md").';
      return {
        ok: false,
        output: `Cannot patch: path is outside the writable workspace.${hint}`,
        errorCode: 'permission_denied',
        retryable: false,
        provenance: 'internal',
        durationMs: Date.now() - startTime,
      };
    }

    const content = await readFile(fullPath, 'utf-8');

    // Try exact match first, then fuzzy
    const findResult = fuzzyFindUnique(content, oldText);

    if (!findResult.ok) {
      const errorCode = findResult.error === 'not_found' ? 'not_found' : 'invalid_args';
      const output =
        findResult.error === 'not_found'
          ? 'old_text not found in file (tried exact + fuzzy matching)'
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

    const matchEnd = findResult.index + oldText.length;
    const patched = content.slice(0, findResult.index) + newText + content.slice(matchEnd);
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

// ─── Main ────────────────────────────────────────────────────────

logToStderr('Tool-server starting');
logToStderr(
  `  env: HOME=${process.env['HOME'] ?? '(unset)'} PATH=${(process.env['PATH'] ?? '(unset)').slice(0, 80)} NPM_CONFIG_CACHE=${process.env['NPM_CONFIG_CACHE'] ?? '(unset)'} PIP_USER=${process.env['PIP_USER'] ?? '(unset)'} PYTHONUSERBASE=${process.env['PYTHONUSERBASE'] ?? '(unset)'}`
);
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
