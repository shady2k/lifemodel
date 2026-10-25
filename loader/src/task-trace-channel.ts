/** Disposable task traces. Never shares the terminal client's socket or retry queue. */
import { readFile } from 'node:fs/promises';
import { TaskJsonClient, type TaskEndpoint } from './task-launcher-http.js';
import type { TaskHarnessEvent } from './task-harness.js';
type Span = Extract<TaskHarnessEvent, { type: 'trace' }>['span'];

/** Redact assignments even inside quoted tool output or nested JSON serialization. */
function scrubTraceAssignments(input: string): string {
  // Start at the key, not an optional run of backslashes before its quote.
  // Retrying that greedy prefix at every offset makes plain backslash runs quadratic.
  const assignment = /\b(api[_-]?key|password|secret|token|authorization)(?:\\*["'])?\s*[=:]\s*/gi;
  const quoted = /(\\*)(["'])/y;
  const unquoted = /[^\s,;"'}]+/y;
  // Scan each consumed value once. Quotes inside Digest parameters are content
  // unless they close the surrounding shell/serialized header delimiter.
  function endOfValue(start: number, quote?: string, depth = 0, header = false): number {
    let slashes = 0;
    for (let i = start; i < input.length; i++) {
      const char = input[i];
      if (header && (char === '\r' || char === '\n')) return i;
      if (
        quote &&
        char === quote &&
        slashes >= depth &&
        (slashes - depth) % (2 * (depth + 1)) === 0
      )
        return i - slashes;
      slashes = char === '\\' ? slashes + 1 : 0;
    }
    return input.length;
  }
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(input)) !== null) {
    const start = assignment.lastIndex;
    if (start < cursor) continue;
    const header = match[1]?.toLowerCase() === 'authorization';
    quoted.lastIndex = start;
    const opening = quoted.exec(input);
    let end = start;
    if (opening) {
      end = endOfValue(start + opening[0].length, opening[2], opening[1]?.length, header);
      output += input.slice(cursor, start) + opening[0] + '[REDACTED]';
    } else if (header) {
      // A whole curl -H 'Authorization: ...' header has its delimiter BEFORE
      // the key. Without a delimiter the HTTP value ends only at CR/LF or EOF,
      // never at a space/comma/quote belonging to an unknown scheme's value.
      const before = input[match.index - 1];
      let depth = 0;
      if (before === '"' || before === "'") {
        for (let i = match.index - 2; i >= cursor && input[i] === '\\'; i--) depth++;
      }
      end = endOfValue(start, before === '"' || before === "'" ? before : undefined, depth, true);
      output += input.slice(cursor, start) + '[REDACTED]';
    } else {
      unquoted.lastIndex = start;
      end = start + (unquoted.exec(input)?.[0].length ?? 0);
      output += input.slice(cursor, start) + '[REDACTED]';
    }
    cursor = end;
    assignment.lastIndex = Math.max(end, start + 1);
  }
  return output + input.slice(cursor);
}

export function createTaskTraceChannel(options: {
  endpoint: TaskEndpoint;
  env: NodeJS.ProcessEnv;
  identity: { taskId: string; attemptId: string; launchId: string };
  traceId: string;
  timeoutMs?: number;
}) {
  const client = new TaskJsonClient(options.endpoint, options.timeoutMs ?? 1500, 0);
  const queue: Span[] = [];
  const secrets = new Set<string>();
  let active = false;
  let stopped = false;
  let finishing = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let count = 0;
  let dropped = 0;
  async function scrub(span: Span) {
    // Reread rotating projected tokens before each frame. Never send unsanitized
    // observations if any known token file cannot be read.
    for (const [key, path] of Object.entries(options.env)) {
      if (!key.endsWith('_TOKEN_FILE') || !path) continue;
      const token = (
        await readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(500) })
      ).trim();
      if (token) secrets.add(token);
      // Rotation cannot turn a bounded run into an unbounded credential cache.
      while (secrets.size > 32) {
        const oldest = secrets.values().next().value;
        if (oldest) secrets.delete(oldest);
        else break;
      }
    }
    const clean = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let text = value;
        for (const token of secrets) {
          text = text.split(token).join('[REDACTED]');
          // The adapter bounds output tails and final text before transport.
          // Hide credential fragments cut at either text boundary as well.
          for (let n = Math.min(token.length - 1, text.length); n >= 8; n--) {
            if (text.startsWith(token.slice(-n))) text = '[REDACTED]' + text.slice(n);
            if (text.endsWith(token.slice(0, n))) text = text.slice(0, -n) + '[REDACTED]';
          }
        }
        return scrubTraceAssignments(text)
          .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
          .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
          .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
          .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
      }
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [String(clean(k)), clean(v)])
        );
      return value;
    };
    return clean(span) as Span;
  }

  async function drain() {
    if (active || stopped) return;
    active = true;
    try {
      while (queue.length && !stopped) {
        const span = queue.shift();
        if (!span) break;
        try {
          const cleaned = await scrub(span);
          await client.call('/task/trace', {
            ...options.identity,
            span: { ...cleaned, traceId: options.traceId },
          });
        } catch {
          dropped++;
        }
      }
    } finally {
      active = false;
      if (finishing) {
        clearTimeout(closeTimer);
        client.close();
      }
    }
  }
  return {
    enqueue(span: Span): void {
      try {
        if (
          stopped ||
          finishing ||
          ++count > 2048 ||
          queue.length >= 128 ||
          Buffer.byteLength(JSON.stringify(span)) > 30000
        ) {
          dropped++;
          return;
        }
        // Detach from mutable harness objects before async scrubbing/HTTP.
        queue.push(JSON.parse(JSON.stringify(span)) as Span);
        void drain();
      } catch {
        dropped++;
      }
    },
    get droppedCount() {
      return dropped;
    },
    close(): void {
      finishing = true;
      // Terminal report is already settled. Allow queued observations to finish
      // independently, but never retain the process/socket beyond one second.
      if (!active && !queue.length) {
        client.close();
        return;
      }
      closeTimer = setTimeout(() => {
        stopped = true;
        dropped += queue.length;
        queue.length = 0;
        client.close();
      }, 1000);
      closeTimer.unref();
    },
  };
}
