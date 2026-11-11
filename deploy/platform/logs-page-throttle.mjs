// A positive exact collector pair is evidence even when other pairs are unknown.
function windowTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time % 6000 === 0 ? time : null;
}

export function findDiscardedWindow(answer, task) {
  if (answer?.state !== 'ok' || !Array.isArray(answer.throttle?.windows)) return null;
  const namespace = task?.namespace ?? 'lifemodel-motor';
  if (typeof task?.pod !== 'string' || typeof namespace !== 'string') return null;
  return answer.throttle.windows.find((window) => {
    if (window?.namespace !== namespace || window?.pod !== task.pod) return false;
    const start = windowTime(window.start);
    const end = windowTime(window.end);
    return start !== null && end !== null && end - start === 6000
      && Number.isSafeInteger(window.discarded) && window.discarded > 0;
  }) ?? null;
}

/** The caller holds the API time range fixed across these bounded reads. */
export async function waitForThrottle(read, task, {
  boundMs = 180000,
  pauseMs = 2000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(boundMs) || boundMs < 0 || !Number.isFinite(pauseMs) || pauseMs <= 0)
    throw new Error('invalid throttle polling bound');
  const deadline = now() + boundMs;
  let reason = 'no_exact_positive_window';
  for (;;) {
    try {
      const answer = await read(Math.max(0, deadline - now()));
      if (now() > deadline) return { window: null, reason: 'poll_deadline_exceeded' };
      const window = findDiscardedWindow(answer, task);
      if (window) return { window, reason: null };
      reason = answer?.state === 'ok' ? 'no_exact_positive_window' : 'logs_unavailable';
    } catch {
      reason = 'logs_unavailable';
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { window: null, reason };
    await sleep(Math.min(pauseMs, remaining));
  }
}

/** Exact text rendered by LogsThrottleStatus for a positive paired window. */
export function throttleRowText(window, locale) {
  const count = window.discarded;
  const identity = `${window.namespace || '?'}/${window.pod || '?'}`;
  const bounds = `${new Date(window.start).toLocaleString(locale)} – ${new Date(window.end).toLocaleString(locale)}`;
  let discarded;
  if (locale.split('-')[0] === 'ru') {
    const plural = new Intl.PluralRules(locale).select(count);
    const noun = plural === 'one' ? 'событие' : plural === 'few' ? 'события' : plural === 'many' ? 'событий' : 'события';
    discarded = `${count} ${noun} отброшено`;
  } else discarded = `${count} ${count === 1 ? 'event' : 'events'} discarded`;
  return `${identity} · ${bounds} · ${discarded}`;
}
