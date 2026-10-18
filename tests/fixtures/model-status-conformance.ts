import type { ModelStatusEvent } from '../../src/web/contract.js';

/**
 * One conformance table for the two parsers that project the gateway's
 * `/status` body for a browser: the web module's (`src/web/model-status.ts`)
 * and the loader's (`loader/src/model-status.ts`). Both must produce exactly
 * the `expected` value for every case (ADR-013 D6: safe fields only, and an
 * unusable body is "unavailable", never an outage).
 *
 * The cases are the adversarial shapes a malformed or hostile producer can
 * send: an unsafe string in a safe-looking field, a prototype name, an
 * unknown state, a `down` without the moment it began, and extra fields.
 */
export interface ModelStatusConformanceCase {
  name: string;
  body: unknown;
  expected: ModelStatusEvent | null;
}

/** The fixed value a parser gives a code it does not recognize. */
export const UNSAFE_ERROR_CODE = 'unknown_error';

const OUTAGE = '2026-10-16T11:03:00.000Z';
const SECRET = 'https://endpoint.example/v1?key=sk-secret';

/** The gateway's own codes, as the loader's source of truth lists them. */
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

export const MODEL_STATUS_CONFORMANCE_CASES: readonly ModelStatusConformanceCase[] = [
  {
    name: 'down with a valid outage start keeps its safe fields only',
    body: {
      state: 'down',
      outageSince: OUTAGE,
      lastAttemptAt: '2026-10-16T11:05:00.000Z',
      lastSuccessAt: null,
      lastErrorCode: 'unreachable',
      primary: { lastErrorCode: 'unreachable', lastErrorAt: '2026-10-16T11:05:00.000Z' },
      reserve: { lastErrorCode: null, lastErrorAt: null },
      upstreamUrl: 'http://owner-endpoint.example/v1',
      lastErrorBody: 'invalid api key sk-secret',
    },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'unreachable' },
  },
  {
    name: 'down without an outage start is unavailable',
    body: { state: 'down', lastErrorCode: 'timeout' },
    expected: null,
  },
  {
    name: 'down with an unparseable outage start is unavailable',
    body: { state: 'down', outageSince: 'yesterday', lastErrorCode: 'timeout' },
    expected: null,
  },
  {
    name: 'down with a non-date outage start is unavailable',
    body: { state: 'down', outageSince: SECRET, lastErrorCode: 'timeout' },
    expected: null,
  },
  {
    name: 'down with a numeric outage start is unavailable',
    body: { state: 'down', outageSince: 1_770_000_000_000, lastErrorCode: 'timeout' },
    expected: null,
  },
  {
    name: 'ok drops an unparseable outage start',
    body: { state: 'ok', outageSince: SECRET, lastErrorCode: null },
    expected: { state: 'ok', outageSince: null, lastErrorCode: null },
  },
  {
    name: 'ok drops a valid outage start too',
    body: { state: 'ok', outageSince: OUTAGE, lastErrorCode: null },
    expected: { state: 'ok', outageSince: null, lastErrorCode: null },
  },
  {
    name: 'unknown without any optional field is readable',
    body: { state: 'unknown' },
    expected: { state: 'unknown', outageSince: null, lastErrorCode: null },
  },
  {
    name: 'unknown drops an outage start',
    body: { state: 'unknown', outageSince: OUTAGE, lastErrorCode: 'timeout' },
    expected: { state: 'unknown', outageSince: null, lastErrorCode: 'timeout' },
  },
  {
    name: 'an unknown state is unavailable',
    body: { state: 'broken', outageSince: OUTAGE },
    expected: null,
  },
  {
    name: 'a prototype name as the state is unavailable',
    body: { state: '__proto__', outageSince: OUTAGE },
    expected: null,
  },
  {
    name: 'a missing state is unavailable',
    body: { outageSince: OUTAGE },
    expected: null,
  },
  {
    name: 'a body that is not an object is unavailable',
    body: 'down',
    expected: null,
  },
  {
    name: 'an array body is unavailable',
    body: [OUTAGE],
    expected: null,
  },
  {
    name: 'a secret in the error-code field never leaves the parser',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: SECRET },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: UNSAFE_ERROR_CODE },
  },
  {
    name: 'a prototype name as the error code becomes the fixed unknown code',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'constructor' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: UNSAFE_ERROR_CODE },
  },
  {
    name: '__proto__ as the error code becomes the fixed unknown code',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: '__proto__' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: UNSAFE_ERROR_CODE },
  },
  {
    name: 'toString as the error code becomes the fixed unknown code',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'toString' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: UNSAFE_ERROR_CODE },
  },
  {
    name: 'a code that only resembles an upstream status becomes the fixed unknown code',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'upstream_50' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: UNSAFE_ERROR_CODE },
  },
  {
    name: 'a long upstream-looking code becomes the fixed unknown code',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'upstream_5030' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: UNSAFE_ERROR_CODE },
  },
  {
    name: 'an upstream status keeps its shape',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'upstream_503' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'upstream_503' },
  },
  {
    name: 'an owned gateway code is kept',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'invalid_request' },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: 'invalid_request' },
  },
  {
    name: 'a non-string error code is unavailable',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: 7 },
    expected: null,
  },
  {
    name: 'a null error code stays null',
    body: { state: 'down', outageSince: OUTAGE, lastErrorCode: null },
    expected: { state: 'down', outageSince: OUTAGE, lastErrorCode: null },
  },
];
