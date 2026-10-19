import { describe, expect, it, vi } from 'vitest';
import { httpTransport } from '../../web/app/src/transport.js';
import { waitUntil } from '../helpers/browser-event-source.js';
import { SESSION, exactlyOnce, insertRow, openPage } from '../helpers/web-live-page.js';

describe('a reply reaches an open page through the real web server', () => {
  it('shows a reply committed after the first stream was refused with too many streams', async () => {
    const page = await openPage('web-live-refused');
    try {
      // Four leases of a web module that restarted; nothing releases them.
      const held: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const lease = await page.transcript.acquireStreamLease(SESSION, Date.now() + 60_000);
        if (!lease) throw new Error('the test could not hold a lease');
        held.push(lease);
      }
      page.subscribe('0');
      await waitUntil(
        () => page.browser.sources().some((source) => source.lastStatus === 429),
        'the first stream to be refused'
      );
      await insertRow(page.stores, page.recipientId, 'channel:web:refused', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed while the stream was refused'
      );
      for (const lease of held) await page.transcript.releaseStreamLease(SESSION, lease);
      await insertRow(
        page.stores,
        page.recipientId,
        'channel:web:live',
        'assistant',
        'второй ответ'
      );
      await waitUntil(
        () => page.received.some((message) => message.text === 'второй ответ'),
        'a live reply after the stream recovered'
      );
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('shows a reply committed after the stream ended at its max age', async () => {
    const page = await openPage('web-live-max-age', { streamMaxAgeMs: 1_500 });
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:max-age', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await insertRow(page.stores, page.recipientId, 'channel:web:max-age', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed after the stream ended'
      );
      expect(page.browser.sources().length).toBeGreaterThan(1);
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('shows the reply committed while the web module was restarted', async () => {
    const page = await openPage('web-live-restart');
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:restart', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      await page.restart();
      await insertRow(page.stores, page.recipientId, 'channel:web:restart', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed while the module was down'
      );
      expect(page.browser.sources().length).toBeGreaterThan(1);
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("shows the reply after a loader rollout refused the page's reconnect", async () => {
    const onSessionExpired = vi.fn();
    const unsubscribe = httpTransport.onSessionExpired(onSessionExpired);
    const page = await openPage('web-live-forward-auth', { forwardAuth: true });
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:auth', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      // The loader pod is replaced: the open stream drops, and the ingress
      // answers the page's reconnect with its own 5xx while no loader answers.
      const proxy = page.proxy;
      if (!proxy) throw new Error('the page has no proxy');
      proxy.refuse = true;
      proxy.dropConnections();
      await waitUntil(
        () => page.browser.sources().some((source) => source.lastStatus === 503),
        "the page's reconnect to be refused by ForwardAuth"
      );
      // A module or a loader that is down is not an ended session: no login.
      expect(onSessionExpired).not.toHaveBeenCalled();
      await insertRow(page.stores, page.recipientId, 'channel:web:auth', 'assistant', 'ответ');
      // The page recovers when the new loader pod answers: no reload, no action.
      proxy.refuse = false;
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply committed while the rollout refused the stream',
        30_000
      );
      exactlyOnce(page.received);
    } finally {
      unsubscribe();
      await page.close();
    }
  }, 90_000);

  it('keeps an idle page current across many stream ends', async () => {
    const page = await openPage('web-live-idle', { streamMaxAgeMs: 700 });
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:idle', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      // The page sits open with nothing to show while its stream keeps ending.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await insertRow(page.stores, page.recipientId, 'channel:web:idle', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the reply after hours of a page being open'
      );
      expect(page.browser.sources().length).toBeGreaterThan(2);
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('keeps the stream open for a reply slower than a minute', async () => {
    const page = await openPage('web-live-slow-reply');
    try {
      const first = await page.transcript.readTranscript({ limit: 50 });
      page.subscribe(first.cursor);
      await insertRow(page.stores, page.recipientId, 'inbound:slow', 'user', 'вопрос');
      await waitUntil(
        () => page.received.some((message) => message.text === 'вопрос'),
        'the first live row'
      );
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      await insertRow(page.stores, page.recipientId, 'channel:web:slow', 'assistant', 'ответ');
      await waitUntil(
        () => page.received.some((message) => message.text === 'ответ'),
        'the slow reply'
      );
      exactlyOnce(page.received);
    } finally {
      await page.close();
    }
  }, 180_000);
});
