/**
 * The model gateway's own safe error codes (ADR-013 D4/D6): the whole set of
 * values its `/status` `lastErrorCode` may carry besides an upstream status.
 *
 * This is the source of truth for both status parsers. They live in separate
 * TypeScript projects (`src/` and `loader/src/`), so the web module keeps its
 * own copy beside the phrases it translates, and a test asserts the two lists
 * are equal.
 */
export const GATEWAY_ERROR_CODES = [
  'unreachable',
  'timeout',
  'blocked_destination',
  'not_configured',
  'storage_unavailable',
  'bad_response',
  'unsafe_response',
  'invalid_request',
  'request_too_large',
  'client_disconnected',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/** The one upstream shape the gateway passes through: `upstream_<3 digits>`. */
const UPSTREAM_STATUS = /^upstream_(\d{3})$/;

/** Whether the gateway itself owns this code. */
export function isOwnedGatewayErrorCode(code: string): code is GatewayErrorCode {
  return (GATEWAY_ERROR_CODES as readonly string[]).includes(code);
}

/** Whether this is the one upstream status shape the gateway produces. */
export function isUpstreamErrorCode(code: string): boolean {
  return UPSTREAM_STATUS.test(code);
}
