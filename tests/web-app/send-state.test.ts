import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_SENT_AFTER_MS, scheduleNotSent } from '../../web/app/src/send-state';

afterEach(() => vi.useRealTimers());

describe('send-state expiration', () => {
  it('marks a pending message not sent after 24 hours', () => {
    vi.useFakeTimers();
    const markNotSent = vi.fn();
    scheduleNotSent((callback, delay) => setTimeout(callback, delay), markNotSent);
    expect(markNotSent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NOT_SENT_AFTER_MS - 1);
    expect(markNotSent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(markNotSent).toHaveBeenCalledOnce();
  });
});
