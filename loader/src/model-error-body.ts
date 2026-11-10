/** Drain rejected bodies within the gateway's bounded admission window. */
import type { IncomingMessage } from 'node:http';

export const MODEL_ERROR_BODY_LIMIT = 16_384;
const CODES = new Set([
  'bad_response',
  'unsafe_response',
  'timeout',
  'unreachable',
  'not_configured',
  'storage_unavailable',
  'blocked_destination',
  'invalid_request',
  'request_too_large',
  'client_disconnected',
  'task_unauthorized',
]);
/** Read only gateway-owned codes; an upstream's arbitrary code is still text. */
export function gatewayErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return undefined;
    const value = parsed.error;
    if (!value || typeof value !== 'object' || !('code' in value) || !('type' in value))
      return undefined;
    const code = value.code;
    return value.type === 'gateway_error' &&
      typeof code === 'string' &&
      (CODES.has(code) || /^upstream_[1-5]\d{2}$/.test(code))
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

export async function drainModelErrorBody(
  response: IncomingMessage,
  preserveForCapture: boolean
): Promise<void> {
  let size = 0;
  for await (const chunk of response.iterator({
    destroyOnReturn: !preserveForCapture,
  })) {
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (size > MODEL_ERROR_BODY_LIMIT) return;
  }
}
