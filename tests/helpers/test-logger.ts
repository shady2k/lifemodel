/**
 * The logger a test instance gets (lifemodel-ctc.2.1 harnesses).
 *
 * A real pino, but WITHOUT any transport. A pino transport runs its target in
 * a WORKER THREAD, and a worker thread cannot be fenced or awaited: the
 * pino-pretty file target kept writing the instance's log file after the test
 * had silenced the logger, so the teardown's rmdir raced it (ENOTEMPTY on the
 * log directory; review round 6). A transport-free logger has no worker
 * thread, creates no log file and has nothing to flush - there is no shared
 * logs directory between instances either. Its lines still reach stdout, which
 * vitest captures, and `recordingLogger` keeps the in-memory copy the
 * assertions read.
 */
import pino from 'pino';

import type { Logger } from '../../src/types/logger.js';

/** Create the logger of one test instance (see the file comment). */
export function createTestLogger(level: pino.Level = 'warn'): Logger {
  return pino({ level }) as unknown as Logger;
}

/** One log call a test can inspect. */
export interface RecordedLog {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}

/**
 * Wrap a logger so every call is kept in `calls` (in-memory, synchronous) and
 * still reaches `base`. The level of `base` filters what is WRITTEN, never
 * what is recorded, exactly like pino: a test can assert on a line that the
 * instance's own level would drop.
 */
export function recordingLogger(base: Logger, calls: RecordedLog[]): Logger {
  const record =
    (level: string) =>
    (obj: Record<string, unknown> | string, msg?: string): void => {
      if (typeof obj === 'string') {
        calls.push({ level, obj: {}, msg: obj });
      } else {
        calls.push({ level, obj, msg: msg ?? '' });
      }
      // The real logger keeps its own signature (obj first, or a bare message).
      if (typeof obj === 'string') {
        (base[level as 'info'] as (m: string) => void)(obj);
      } else {
        (base[level as 'info'] as (o: object, m?: string) => void)(obj, msg);
      }
    };
  const wrapper = {
    child: (bindings: Record<string, unknown>) => recordingLogger(base.child(bindings), calls),
    info: record('info'),
    debug: record('debug'),
    warn: record('warn'),
    error: record('error'),
    trace: record('trace'),
    fatal: record('fatal'),
  } as unknown as Logger;
  // The level reaches the REAL logger: silencing an instance at teardown must
  // stop what it writes, not a property on this wrapper.
  Object.defineProperty(wrapper, 'level', {
    get: () => (base as unknown as { level?: string }).level,
    set: (value: string) => {
      (base as unknown as { level?: string }).level = value;
    },
    enumerable: true,
    configurable: true,
  });
  return wrapper;
}
