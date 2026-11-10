/** The window a page form holds, read as the API reads it (WALK-LOGS-PAGE). */
import { describe, expect, it } from 'vitest';
import { formWindow, inputMillis } from '../../deploy/platform/logs-page-filters.mjs';

describe('the window the logs page form holds', () => {
  it('reads a datetime-local value in the browser\'s local time, down to the minute', () => {
    const value = '2026-11-10T10:05';
    expect(inputMillis(value)).toBe(new Date(2026, 10, 10, 10, 5).getTime());
  });

  it('gives the API both ends of the form window, not a window the walk kept', () => {
    const from = '2026-11-10T09:00';
    const to = '2026-11-10T10:00';
    expect(formWindow(from, to)).toEqual({
      from: new Date(2026, 10, 10, 9, 0).getTime(),
      to: new Date(2026, 10, 10, 10, 0).getTime(),
    });
  });

  it('marks an empty or unreadable form value as no window', () => {
    expect(inputMillis('')).toBeNaN();
    expect(inputMillis(undefined)).toBeNaN();
    expect(formWindow('', 'not a time')).toEqual({ from: NaN, to: NaN });
  });
});
