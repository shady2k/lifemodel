import { describe, expect, it } from 'vitest';
import { waitUntil } from '../helpers/browser-event-source.js';
import { exactlyOnce, insertRow, openPage } from '../helpers/web-live-page.js';

function inOrder(sequences: string[]): string[] {
  return [...sequences].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
  );
}

describe('a page catches up from the transcript it has', () => {
  it('shows every row committed after an empty first read, in order', async () => {
    const page = await openPage('web-live-empty-catch-up');
    try {
      // The owner opens the page on an empty conversation: the first read
      // returns no rows and no cursor.
      const first = await page.transcript.readTranscript({ limit: 50 });
      expect(first.rows).toEqual([]);
      expect(first.cursor).toBeNull();
      // A question and two answers are committed while the page has no stream.
      await insertRow(page.stores, page.recipientId, 'inbound:first', 'user', 'вопрос');
      await insertRow(page.stores, page.recipientId, 'channel:web:first', 'assistant', 'ответ');
      await insertRow(page.stores, page.recipientId, 'channel:web:second', 'assistant', 'второй');
      page.subscribe(first.cursor);
      // The stream opens only after the catch-up read has delivered everything it read.
      await waitUntil(
        () => page.browser.sources().some((source) => source.lastStatus === 200),
        'the page stream to open'
      );
      expect(page.received.map((message) => message.text)).toEqual(['вопрос', 'ответ', 'второй']);
      expect(page.received.map((message) => message.sequence)).toEqual(
        inOrder(page.received.map((message) => message.sequence))
      );
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);
});
