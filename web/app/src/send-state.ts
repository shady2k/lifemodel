export const NOT_SENT_AFTER_MS = 24 * 60 * 60 * 1000;

export type SendState = 'sending' | 'failed';

export function scheduleNotSent(
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>,
  markNotSent: () => void
): ReturnType<typeof setTimeout> {
  return schedule(markNotSent, NOT_SENT_AFTER_MS);
}
