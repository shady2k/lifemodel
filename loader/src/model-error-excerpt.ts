/** Only upstream JSON error fields may become diagnostics. Never retain a body or header. */
import type { IncomingMessage } from 'node:http';

export const MODEL_ERROR_BODY_LIMIT = 16_384;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function modelErrorExcerpt(body: string, secrets: readonly string[] = []): string {
  try {
    const error = object(object(JSON.parse(body))['error']);
    const parts: string[] = [];
    for (const field of ['message', 'type', 'code']) {
      const value = error[field];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      let safe = String(value);
      // An error field can itself echo a credential. Drop credential-bearing
      // fields, and redact the exact credentials known to this connection.
      if (/\b(?:authorization|bearer|token|api[_ -]?key|password|cookie)\b/i.test(safe)) continue;
      for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
      let line = '';
      for (const character of safe) line += character.charCodeAt(0) < 32 ? ' ' : character;
      parts.push(line);
      if (field === 'message' && safe) break;
    }
    return Buffer.from(parts.join('; '))
      .subarray(0, 300)
      .toString('utf8')
      .replace(/\uFFFD+$/, '');
  } catch {
    return '';
  }
}

/** Oversized/non-JSON errors yield no excerpt, rather than an unsafe raw prefix. */
export async function readModelErrorExcerpt(
  response: IncomingMessage,
  secrets: readonly string[]
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += chunk.length;
    if (size > MODEL_ERROR_BODY_LIMIT) return '';
    chunks.push(chunk);
  }
  return modelErrorExcerpt(Buffer.concat(chunks).toString('utf8'), secrets);
}
