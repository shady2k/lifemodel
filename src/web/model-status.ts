/**
 * The model gateway's health as the owner's screens show it (ADR-013 D6).
 *
 * Every string a browser may hold is produced here: the safe fields of the
 * gateway's `/status` body, the phrase for a safe error code, and the local
 * time of an outage. No URL, key or upstream body has a path through this
 * module, and an unusable body is "unavailable", never an outage.
 */
import type { ModelStatusEvent } from './contract.js';

/** How often the web module asks the gateway for its status (ADR-013 D6: ≤ 10 s). */
export const MODEL_STATUS_POLL_MS = 5_000;
/** How long one status fetch may take before it is "unavailable". */
export const MODEL_STATUS_TIMEOUT_MS = 2_000;
/** The narrow seam the web server sees; the poller is its only real implementation. */
export interface ModelStatusSource {
  /** A client started reading; the poll runs while at least one reader is attached. */
  start(): void;
  /** A client stopped reading; the last reader stops the poll. */
  stop(): void;
  /** The last answered status, or `null` while none could be read. */
  read(): ModelStatusEvent | null;
  /** Whether a fetch has answered at all (successfully or not). */
  settled(): boolean;
}

/** The line shown when no status could be read. */
export const MODEL_STATUS_UNAVAILABLE_KEY = 'modelStatusUnavailable';
/** The line shown for an outage, with {{time}} and {{error}} (ADR-013 D6). */
export const MODEL_STATUS_OUTAGE_KEY = 'modelOutage';
/** The phrase for a safe code this build does not know. */
export const MODEL_STATUS_UNKNOWN_ERROR_KEY = 'modelErrorUnknown';

/**
 * The gateway's safe codes in words (see `loader/src/model-error-codes.ts` and
 * `loader/src/model-gateway-app.ts`). A code has one phrase per language,
 * never the raw code. This map is also the web module's list of the codes the
 * gateway owns; a test keeps it equal to the loader's list.
 */
export const MODEL_STATUS_ERROR_KEYS: Record<string, string> = {
  unreachable: 'modelErrorUnreachable',
  timeout: 'modelErrorTimeout',
  blocked_destination: 'modelErrorBlocked',
  not_configured: 'modelErrorNotConfigured',
  storage_unavailable: 'modelErrorStorage',
  bad_response: 'modelErrorBadResponse',
  unsafe_response: 'modelErrorUnsafeResponse',
  invalid_request: 'modelErrorInvalidRequest',
  request_too_large: 'modelErrorTooLarge',
  client_disconnected: 'modelErrorDisconnected',
};

/** The fixed value every code the gateway does not own becomes. */
export const MODEL_STATUS_UNSAFE_ERROR_CODE = 'unknown_error';

/** The one upstream shape the gateway passes through: `upstream_<3 digits>`. */
const UPSTREAM_STATUS = /^upstream_(\d{3})$/;
/** An ISO 8601 instant with its offset, the only timestamp shape accepted. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether the gateway itself owns this code (the map's own keys, never a prototype's). */
function isOwnedErrorCode(code: string): boolean {
  return Object.hasOwn(MODEL_STATUS_ERROR_KEYS, code);
}

/**
 * A code a browser may hold: one the gateway owns, or an upstream status. Any
 * other string — a URL, a secret, a prototype name — becomes one fixed value.
 */
export function safeModelErrorCode(code: string): string {
  if (isOwnedErrorCode(code) || UPSTREAM_STATUS.test(code)) return code;
  return MODEL_STATUS_UNSAFE_ERROR_CODE;
}

/** The outage's start as the gateway wrote it, or `null` for anything else. */
function safeInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** The i18n key for a safe gateway error code; unknown codes get one phrase. */
export function modelErrorKey(code: string | null): string {
  if (code === null) return MODEL_STATUS_UNKNOWN_ERROR_KEY;
  const known = isOwnedErrorCode(code) ? MODEL_STATUS_ERROR_KEYS[code] : undefined;
  if (known !== undefined) return known;
  const upstream = /^upstream_(\d{3})$/.exec(code);
  if (upstream === null) return MODEL_STATUS_UNKNOWN_ERROR_KEY;
  const status = Number(upstream[1]);
  if (!Number.isInteger(status)) return MODEL_STATUS_UNKNOWN_ERROR_KEY;
  if (status === 401 || status === 403) return 'modelErrorUpstreamKey';
  if (status === 404) return 'modelErrorUpstreamModel';
  if (status === 429) return 'modelErrorUpstreamRateLimit';
  if (status >= 500) return 'modelErrorUpstreamServer';
  if (status >= 400) return 'modelErrorUpstreamRefused';
  return MODEL_STATUS_UNKNOWN_ERROR_KEY;
}

/**
 * Reads exactly the safe fields of a `/status` body. Anything else — another
 * state, a `down` without the start of the outage, a body that is not an
 * object — is unusable and becomes `null`, which the screens read as
 * "status unavailable".
 */
export function parseModelStatus(value: unknown): ModelStatusEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const state = body['state'];
  if (state !== 'unknown' && state !== 'ok' && state !== 'down') return null;
  const outageSince = body['outageSince'];
  const lastErrorCode = body['lastErrorCode'];
  if (outageSince !== undefined && outageSince !== null && typeof outageSince !== 'string')
    return null;
  if (lastErrorCode !== undefined && lastErrorCode !== null && typeof lastErrorCode !== 'string')
    return null;
  // Only `down` carries the moment the outage began: another state drops it,
  // and a `down` without a usable instant is not an outage at all.
  const since = state === 'down' ? safeInstant(outageSince) : null;
  if (state === 'down' && since === null) return null;
  return {
    state,
    outageSince: since,
    lastErrorCode:
      typeof lastErrorCode === 'string' ? safeModelErrorCode(lastErrorCode) : null,
  };
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export type ModelStatusView =
  | { kind: 'hidden' }
  | { kind: 'unavailable' }
  | { kind: 'outage'; time: string; errorKey: string };

/**
 * What the owner's screen shows: nothing while the model answers, one
 * unavailable line when no status could be read, and the outage line only for
 * `state: down` with the moment it began (ADR-013 D6).
 */
export function modelStatusView(
  value: ModelStatusEvent | null,
  language: string,
  now: number
): ModelStatusView {
  if (value === null) return { kind: 'unavailable' };
  if (value.state !== 'down') return { kind: 'hidden' };
  if (!isInstant(value.outageSince)) return { kind: 'unavailable' };
  return {
    kind: 'outage',
    time: formatOutageTime(value.outageSince, language, now),
    errorKey: modelErrorKey(value.lastErrorCode),
  };
}

/** The outage's local time, with the date when it began on an earlier day. */
export function formatOutageTime(outageSince: string, language: string, now: number): string {
  const at = new Date(outageSince);
  const current = new Date(now);
  const sameDay =
    at.getFullYear() === current.getFullYear() &&
    at.getMonth() === current.getMonth() &&
    at.getDate() === current.getDate();
  return new Intl.DateTimeFormat(
    language,
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
  ).format(at);
}
