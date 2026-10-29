/** Opt-in, bounded, fail-open exchange capture. No raw text enters the writer queue. */
import type { IncomingHttpHeaders } from 'node:http';
import type { ModelSlotName } from './model.js';
import type { ModelCaptureSetting } from './model-capture-setting.js';

export const CAPTURE_LIMITS = { bodyBytes: 1024 * 1024, queue: 8, active: 16 } as const;
export interface CaptureRow {
  callId: string;
  attempt: number;
  slot: ModelSlotName;
  taskId: string | null;
  sessionId: string | null;
  exchange: Record<string, unknown>;
  expiresAt: string;
}
export interface CaptureContext {
  setting: ModelCaptureSetting;
  /** All slots, not merely the attempted one, and the database password. */
  secrets: readonly string[];
  secretHeaders: readonly string[];
}
export interface CaptureInput {
  callId: string;
  attempt: number;
  slot: ModelSlotName;
  taskId: string | null;
  sessionId: string | null;
  inbound: { method: string; path: string; headers: IncomingHttpHeaders; body: string };
  upstream: { method: string; url: string; headers: Record<string, string>; body: string };
}
const privateHeaders = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
];
const marker = (value: string) => `[redacted len=${String(Buffer.byteLength(value))}]`;
function variants(secrets: readonly string[]): string[] {
  return [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [
          secret,
          JSON.stringify(secret).slice(1, -1),
          encodeURIComponent(secret),
        ])
    ),
  ].sort((a, b) => b.length - a.length);
}
function scrub(value: string, secrets: readonly string[]): string {
  for (const secret of secrets) value = value.split(secret).join(marker(secret));
  return value;
}
function bounded(value: string, bytes: number, originalBytes = Buffer.byteLength(value)): string {
  if (Buffer.byteLength(value) <= bytes && originalBytes <= bytes) return value;
  return (
    Buffer.from(value)
      .subarray(0, bytes)
      .toString('utf8')
      .replace(/\uFFFD+$/, '') + `\n[truncated original_bytes=${String(originalBytes)}]`
  );
}
/** Deliberately treats ALL custom slot headers as secret: the slot format has no secret flag. */
export function createExchangeCapture(options: {
  context(): CaptureContext | undefined;
  write(row: CaptureRow): Promise<void>;
  now?: () => number;
  bodyBytes?: number;
  queue?: number;
  active?: number;
}) {
  const now = options.now ?? Date.now;
  const bodyBytes = options.bodyBytes ?? CAPTURE_LIMITS.bodyBytes;
  const queue: CaptureRow[] = [];
  let running = false;
  let active = 0;
  let closed = false;
  async function drain(): Promise<void> {
    if (running || closed) return;
    running = true;
    try {
      while (queue.length && !closed) {
        const row = queue.shift();
        if (row) {
          try {
            await options.write(row);
          } catch {
            /* drop, never retry raw evidence */
          }
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    close() {
      closed = true;
      queue.length = 0;
    },
    begin(
      input: CaptureInput,
      attempted?: { secrets: readonly string[]; secretHeaders: readonly string[] }
    ) {
      // This entire optional facility is contained: even a broken context or writer cannot escape.
      try {
        const context = options.context();
        if (
          closed ||
          !context ||
          !context.setting.until ||
          !(Date.parse(context.setting.until) > now()) ||
          (context.setting.session !== undefined && context.setting.session !== input.sessionId) ||
          active >= (options.active ?? CAPTURE_LIMITS.active) ||
          queue.length >= (options.queue ?? CAPTURE_LIMITS.queue)
        )
          return undefined;
        const started = now();
        const secretNames = new Set([
          ...privateHeaders,
          ...[...context.secretHeaders, ...(attempted?.secretHeaders ?? [])].map((name) =>
            name.toLowerCase()
          ),
        ]);
        const inboundSecrets = Object.entries(input.inbound.headers).flatMap(([name, value]) => {
          if (!secretNames.has(name.toLowerCase()) || value === undefined) return [];
          const values = Array.isArray(value) ? value : [value];
          return values.flatMap((item) => [item, item.replace(/^Bearer\s+/i, '')]);
        });
        const originals = [
          ...context.secrets,
          ...(attempted?.secrets ?? []),
          ...inboundSecrets,
        ].filter(Boolean);
        const secrets = variants(originals);
        const text = (value: string) => scrub(value, secrets);
        const responseText = () => {
          let raw = Buffer.concat(responseChunks).toString('utf8');
          if (originalBytes > storedBytes) {
            // Never keep a partial credential at the retained prefix boundary.
            let remove = 0;
            for (const secret of secrets)
              for (let length = 1; length < secret.length && length <= raw.length; length++)
                if (raw.endsWith(secret.slice(0, length))) remove = Math.max(remove, length);
            if (remove) raw = raw.slice(0, -remove);
          }
          return bounded(text(raw), bodyBytes, originalBytes);
        };
        const headers = (values: IncomingHttpHeaders | Record<string, string>) =>
          Object.fromEntries(
            Object.entries(values).map(([name, value]) => {
              const joined = Array.isArray(value) ? value.join('\n') : (value ?? '');
              return [
                text(name),
                secretNames.has(name.toLowerCase()) ? marker(joined) : text(joined),
              ];
            })
          );
        const request = (value: CaptureInput['inbound'] | CaptureInput['upstream']) => ({
          ...Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== 'headers' && key !== 'body')
              .map(([key, value]) => [key, text(String(value))])
          ),
          headers: headers(value.headers),
          body: bounded(text(value.body), bodyBytes, Buffer.byteLength(value.body)),
        });
        const inbound = request(input.inbound);
        const upstream = request(input.upstream);
        const responseChunks: Buffer[] = [];
        // Retain lookahead so a secret crossing the cap cannot leave a raw prefix.
        const retainBytes =
          bodyBytes + Math.max(0, ...secrets.map((secret) => Buffer.byteLength(secret)));
        let storedBytes = 0;
        let originalBytes = 0;
        let status: number | null = null;
        let responseHeaders: Record<string, string> = {};
        let firstByteMs: number | null = null;
        let finished = false;
        active++;
        return {
          response(code: number, values: IncomingHttpHeaders) {
            try {
              status = code;
              responseHeaders = headers(values);
              firstByteMs = now() - started;
            } catch {
              /* capture only */
            }
          },
          chunk(value: Buffer) {
            try {
              originalBytes += value.length;
              if (storedBytes < retainBytes) {
                const part = Buffer.from(value.subarray(0, retainBytes - storedBytes));
                responseChunks.push(part);
                storedBytes += part.length;
              }
            } catch {
              /* capture only */
            }
          },
          finish(error?: string) {
            if (finished) return;
            finished = true;
            active--;
            try {
              if (
                closed ||
                Date.parse(context.setting.until ?? '') <= now() ||
                queue.length >= (options.queue ?? CAPTURE_LIMITS.queue)
              )
                return;
              // Metadata is also untrusted stored text, and must pass the same scrubber.
              const row: CaptureRow = {
                callId: text(input.callId),
                attempt: input.attempt,
                slot: input.slot,
                expiresAt: context.setting.until!,
                taskId: input.taskId === null ? null : text(input.taskId),
                sessionId: input.sessionId === null ? null : text(input.sessionId),
                exchange: {
                  inbound,
                  upstream,
                  response: { status, headers: responseHeaders, body: responseText() },
                  timing: {
                    startedAt: new Date(started).toISOString(),
                    firstByteMs,
                    durationMs: now() - started,
                  },
                  ...(error ? { error: text(error) } : {}),
                },
              };
              // A conservative last guard covers escaped forms and redaction-marker collisions.
              // Drop rather than persist any row in which a configured value still occurs.
              const serialized = JSON.stringify(row);
              if (secrets.some((secret) => serialized.includes(secret))) return;
              queue.push(row);
              // Never start a writer on the caller's stack; thrown/rejected writes stay contained.
              setImmediate(() => {
                void drain().catch(() => undefined);
              });
            } catch {
              /* capture only */
            }
          },
        };
      } catch {
        return undefined;
      }
    },
  };
}
export type ExchangeCapture = ReturnType<typeof createExchangeCapture>;
