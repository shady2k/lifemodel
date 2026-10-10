/**
 * Time, behind one interface (lifemodel-q4x.2.1).
 *
 * A test that has to wait for a backoff would be slow and flaky, so the loader
 * never calls setTimeout directly: the supervisor and the login take this.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The system clock. Its timer is UNREF'd: a pending backoff must never keep
 * the container's main process alive after a shutdown was asked for.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
};

/** A clock a test drives: sleeping is instant and recorded, time is its own. */
export interface TestClock extends Clock {
  sleeps: number[];
  advance(ms: number): void;
}

export function createTestClock(startMs = 1_700_000_000_000): TestClock {
  let current = startMs;
  const clock: TestClock = {
    sleeps: [],
    now: () => current,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
  return clock;
}
