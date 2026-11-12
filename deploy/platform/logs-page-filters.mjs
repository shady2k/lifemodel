// The window a page form holds, read the way the API reads it (WALK-LOGS-PAGE).
//
// The logs page's time fields are `datetime-local`: the browser reads them in
// the walk machine's local time to the minute. The walk compares the page's
// records with the API's answer for the same window, so it reads the two form
// values back and sends exactly their milliseconds; its own earlier range is
// not the window the page holds.

/** A `datetime-local` value as the API's milliseconds, or NaN when unreadable. */
export function inputMillis(value) {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Both ends of the window the page's form holds. */
export function formWindow(from, to) {
  return { from: inputMillis(from), to: inputMillis(to) };
}
