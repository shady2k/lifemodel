/** Time-limited, machine-local model debugging. Off unless the owner opts in. */
export interface ModelCaptureSetting {
  until: string | null;
  session?: string;
}
/** HTTP writes carry a duration; only the server chooses the expiry timestamp. */
export interface ModelCaptureRequest {
  durationMs: number | null;
  session?: string;
}
export const MAX_CAPTURE_DURATION_MS = 24 * 60 * 60 * 1000;
export const CAPTURE_SETTING_PATH = 'lifemodel/data/model/capture';
export class CaptureSettingError extends Error {
  constructor() {
    super('capture_setting_invalid');
  }
}
/** Validate a server response without relying on the browser's clock. */
export function validateCaptureSettingResponse(input: unknown): ModelCaptureSetting {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new CaptureSettingError();
  const value = input as Record<string, unknown>;
  const until = value['until'];
  const session = value['session'];
  if (
    Object.keys(value).some((key) => key !== 'until' && key !== 'session') ||
    (until !== null && typeof until !== 'string') ||
    (session !== undefined &&
      (typeof session !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(session)))
  )
    throw new CaptureSettingError();
  if (until === null) {
    if (session !== undefined) throw new CaptureSettingError();
    return { until: null };
  }
  const expiry = Date.parse(until);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== until)
    throw new CaptureSettingError();
  return {
    until,
    ...(session === undefined ? {} : { session }),
  };
}
/** Validate stored values; writes additionally require a future expiry within 24 hours. */
export function validateCaptureSetting(
  input: unknown,
  now = Date.now(),
  forWrite = false
): ModelCaptureSetting {
  const value = validateCaptureSettingResponse(input);
  if (value.until !== null) {
    const expiry = Date.parse(value.until);
    if (expiry > now + MAX_CAPTURE_DURATION_MS || (forWrite && expiry <= now))
      throw new CaptureSettingError();
  }
  return value;
}
/** Bound the requested duration and derive the stored setting from server time. */
export function captureSettingFromRequest(input: unknown, now = Date.now()): ModelCaptureSetting {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new CaptureSettingError();
  const value = input as Record<string, unknown>;
  const duration = value['durationMs'];
  const session = value['session'];
  if (Object.keys(value).some((key) => key !== 'durationMs' && key !== 'session'))
    throw new CaptureSettingError();
  if (duration === null) {
    if (session !== undefined) throw new CaptureSettingError();
    return { until: null };
  }
  if (
    typeof duration !== 'number' ||
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > MAX_CAPTURE_DURATION_MS
  )
    throw new CaptureSettingError();
  return validateCaptureSetting(
    {
      until: new Date(now + duration).toISOString(),
      ...(session === undefined ? {} : { session }),
    },
    now,
    true
  );
}
/** Check expiry at use time, including while a cached setting awaits refresh. */
export function isCaptureEnabled(
  value: ModelCaptureSetting,
  session?: string,
  now = Date.now()
): boolean {
  return (
    value.until !== null &&
    Date.parse(value.until) > now &&
    (value.session === undefined || value.session === session)
  );
}
/** An expired setting is always exposed as off, without a store write. */
export function activeCaptureSetting(
  value: ModelCaptureSetting,
  now = Date.now()
): ModelCaptureSetting {
  return value.until !== null && Date.parse(value.until) > now ? { ...value } : { until: null };
}
