/**
 * Stop-deadline helpers.
 *
 * The graceful stop has ONE overall deadline (default 90 s from
 * CoreLoopConfig.shutdownDrainTimeoutMs). Each waiter - channel intake stop,
 * the in-flight tick, the scheduler callback, the COGNITION turn and its
 * sends - is awaited within that deadline; past it the stop continues and
 * whatever is unprocessed is journaled (takePendingSignals()).
 */
import type { Logger } from '../types/logger.js';

export type DeadlineOutcome<T> = { done: true; value: T } | { done: false };

/**
 * Await a promise until the absolute deadline. On expiry resolve not-done,
 * log once, and let the caller continue the stop. A settled promise never
 * waits at all; a rejected one is rethrown (the caller logs it).
 */
export async function awaitWithinDeadline<T>(
  promise: Promise<T> | null | undefined,
  deadlineMs: number,
  logger: Logger,
  what: string
): Promise<DeadlineOutcome<T>> {
  if (!promise) {
    return { done: true, value: undefined as T };
  }
  if (Date.now() >= deadlineMs) {
    logger.warn({ what }, 'Stop deadline already passed, proceeding without waiting');
    return { done: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      promise.then((value) => ({ done: true, value }) as DeadlineOutcome<T>),
      new Promise<DeadlineOutcome<T>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ done: false });
        }, deadlineMs - Date.now());
      }),
    ]);
    if (!outcome.done) {
      logger.warn({ what }, 'Stop deadline reached before this wait finished; the stop continues');
    }
    return outcome;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
