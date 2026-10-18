import type { ModelStatusEvent } from '../../src/web/contract.js';
import type { ModelStatusSource } from '../../src/web/model-status.js';

/**
 * A model status source that never answers and never fetches: for tests whose
 * subject is another route, so the stream carries no model events.
 */
export function silentModelStatus(): ModelStatusSource {
  return {
    start: () => undefined,
    stop: () => undefined,
    read: () => null,
    settled: () => false,
  };
}

export interface StubModelStatus extends ModelStatusSource {
  /** Replaces the status a new reader would see, as the poller would. */
  set(value: ModelStatusEvent | null): void;
  /** How many readers have attached since the source was created. */
  starts(): number;
}

/** A model status source the test drives directly, without a gateway. */
export function stubModelStatus(initial: ModelStatusEvent | null = null): StubModelStatus {
  let value = initial;
  let answered = initial !== null;
  let starts = 0;
  return {
    start: () => {
      starts += 1;
    },
    stop: () => undefined,
    read: () => value,
    settled: () => answered,
    set: (next) => {
      value = next;
      answered = true;
    },
    starts: () => starts,
  };
}
