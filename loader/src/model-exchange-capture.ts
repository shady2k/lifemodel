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
  /** Pre-serialized database payload; non-enumerable so it never nests in the evidence. */
  serialized?: string;
}
export interface CaptureContext {
  setting: ModelCaptureSetting;
  /** Global credentials, including all slot keys and database passwords, regardless of length. */
  secrets: readonly string[];
  /** Precomputed variants of secrets; replaces secrets when present. Refresh with the inventory. */
  preparedSecrets?: readonly string[];
  /** Redact these headers by name, without treating their values as global credentials. */
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
/** Prepare global credential variants once per inventory refresh, not once per model call. */
export function prepareCaptureSecrets(secrets: readonly string[]): readonly string[] {
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
/** Literal alternatives cannot backtrack through credential-controlled regex syntax. */
function secretPattern(secrets: readonly string[]): RegExp | undefined {
  if (!secrets.length) return undefined;
  return new RegExp(
    secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g'
  );
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
/** Longest retained suffix that could be the start of a cut credential, in linear time. */
function partialSecretSuffix(value: string, secret: string): number {
  if (secret.length < 2) return 0;
  const fallback = new Uint32Array(secret.length);
  let matched = 0;
  for (let index = 1; index < secret.length; index++) {
    while (matched > 0 && secret[index] !== secret[matched]) matched = fallback[matched - 1] ?? 0;
    if (secret[index] === secret[matched]) matched++;
    fallback[index] = matched;
  }
  matched = 0;
  // A full credential is handled by scrub; only a proper prefix is uncertain.
  const start = Math.max(0, value.length - secret.length + 1);
  for (let index = start; index < value.length; index++) {
    while (matched > 0 && value[index] !== secret[matched]) matched = fallback[matched - 1] ?? 0;
    if (value[index] === secret[matched]) matched++;
  }
  return matched;
}
/** Only declared credential material is scrubbed globally; custom header maps are always redacted. */
export function createExchangeCapture(options: {
  context(input: CaptureInput): CaptureContext | undefined;
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
  const finalizers: (() => void)[] = [];
  let finalizing = false;
  // One bounded row per event-loop turn, even if all active attempts finish together.
  function finalize(work: () => void): void {
    finalizers.push(work);
    if (finalizing) return;
    finalizing = true;
    const next = () => {
      finalizers.shift()?.();
      if (finalizers.length) setImmediate(next);
      else finalizing = false;
    };
    setImmediate(next);
  }
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
        const context = options.context(input);
        if (
          closed ||
          !context?.setting.until ||
          !(Date.parse(context.setting.until) > now()) ||
          (context.setting.session !== undefined && context.setting.session !== input.sessionId) ||
          active >= (options.active ?? CAPTURE_LIMITS.active) ||
          queue.length >= (options.queue ?? CAPTURE_LIMITS.queue)
        )
          return undefined;
        const expiresAt = context.setting.until;
        const started = now();
        const secretNames = new Set([
          ...privateHeaders,
          ...[...context.secretHeaders, ...(attempted?.secretHeaders ?? [])].map((name) =>
            name.toLowerCase()
          ),
        ]);
        const inboundSecrets = Object.entries(input.inbound.headers).flatMap(([name, value]) => {
          // Custom routing/session headers are private by name, not global credentials.
          if (!privateHeaders.includes(name.toLowerCase()) || value === undefined) return [];
          const values = Array.isArray(value) ? value : [value];
          return values.flatMap((item) => [item, item.replace(/^Bearer\s+/i, '')]);
        });
        const secrets = [
          ...new Set([
            ...(context.preparedSecrets ?? prepareCaptureSecrets(context.secrets)),
            ...prepareCaptureSecrets([...(attempted?.secrets ?? []), ...inboundSecrets]),
          ]),
        ].sort((a, b) => b.length - a.length);
        // Compile once, deferred to finalization. Reuse for every field and the whole-row guard.
        let pattern: RegExp | undefined;
        const text = (value: string) =>
          pattern ? value.replace(pattern, (secret) => marker(secret)) : value;
        const responseText = () => {
          let raw = Buffer.concat(responseChunks).toString('utf8');
          if (originalBytes > storedBytes) {
            // Never keep a partial credential at the retained prefix boundary.
            let remove = 0;
            for (const secret of secrets)
              remove = Math.max(remove, partialSecretSuffix(raw, secret));
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
        const responseChunks: Buffer[] = [];
        // Retain lookahead so a secret crossing the cap cannot leave a raw prefix.
        const retainBytes =
          bodyBytes +
          secrets.reduce((maximum, secret) => Math.max(maximum, Buffer.byteLength(secret)), 0);
        let storedBytes = 0;
        let originalBytes = 0;
        let status: number | null = null;
        let responseHeaders: IncomingHttpHeaders = {};
        let firstByteMs: number | null = null;
        let finished = false;
        active++;
        return {
          response(code: number, values: IncomingHttpHeaders) {
            if (finished) return;
            try {
              status = code;
              // Keep raw headers only in this bounded active collector, never the queue.
              responseHeaders = Object.fromEntries(
                Object.entries(values).map(([name, value]) => [
                  name,
                  Array.isArray(value) ? [...value] : value,
                ])
              );
              firstByteMs = now() - started;
            } catch {
              /* capture only */
            }
          },
          chunk(value: Buffer) {
            if (finished) return;
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
            const durationMs = now() - started;
            // Finalization owns its active slot until every raw reference is released.
            // Neither response scrubbing nor serialization runs on the model-call stack.
            finalize(() => {
              try {
                if (
                  closed ||
                  Date.parse(context.setting.until ?? '') <= now() ||
                  queue.length >= (options.queue ?? CAPTURE_LIMITS.queue)
                )
                  return;
                pattern = secretPattern(secrets);
                const row: CaptureRow = {
                  callId: text(input.callId),
                  attempt: input.attempt,
                  slot: input.slot,
                  expiresAt,
                  taskId: input.taskId === null ? null : text(input.taskId),
                  sessionId: input.sessionId === null ? null : text(input.sessionId),
                  exchange: {
                    inbound: request(input.inbound),
                    upstream: request(input.upstream),
                    response: { status, headers: headers(responseHeaders), body: responseText() },
                    timing: {
                      startedAt: new Date(started).toISOString(),
                      firstByteMs,
                      durationMs,
                    },
                    ...(error ? { error: text(error) } : {}),
                  },
                };
                // The writer queue receives redacted rows only. Drop marker collisions too.
                const serialized = JSON.stringify(row.exchange);
                if (pattern) {
                  pattern.lastIndex = 0;
                  if (
                    pattern.test(
                      [
                        row.callId,
                        row.attempt,
                        row.slot,
                        row.taskId,
                        row.sessionId,
                        row.expiresAt,
                        serialized,
                      ].join('\0')
                    )
                  )
                    return;
                }
                Object.defineProperty(row, 'serialized', { value: serialized });
                queue.push(row);
                setImmediate(() => {
                  void drain().catch(() => undefined);
                });
              } catch {
                /* capture only */
              } finally {
                responseChunks.length = 0;
                responseHeaders = {};
                active--;
              }
            });
          },
        };
      } catch {
        return undefined;
      }
    },
  };
}
export type ExchangeCapture = ReturnType<typeof createExchangeCapture>;
