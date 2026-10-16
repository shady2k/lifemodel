// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import i18n from '../../web/app/src/i18n';
import { Conversation } from '../../web/app/src/Conversation';
import { mergeTranscript } from '../../web/app/src/transport';
import type {
  CreatureStateEvent,
  TranscriptMessage,
  TranscriptPage,
  WebTransport,
} from '../../web/app/src/transport';

class FakeTransport implements WebTransport {
  reads: Array<string | undefined> = [];
  messageEventIds: string[] = [];
  stateEventsHaveId: boolean[] = [];
  subscriptions: Array<{
    after: string;
    message: (row: TranscriptMessage) => void;
    state: (row: CreatureStateEvent) => void;
  }> = [];
  onRead?: (before?: string) => void;
  constructor(private readonly rows: TranscriptMessage[]) {}

  async sendMessage(): Promise<'accepted'> {
    return 'accepted';
  }

  async readTranscript(before?: string): Promise<TranscriptPage> {
    this.reads.push(before);
    this.onRead?.(before);
    const eligible =
      before === undefined
        ? this.rows
        : this.rows.filter((row) => BigInt(row.sequence) < BigInt(before));
    const messages = eligible.slice(-50).reverse();
    return { messages, cursor: messages[0]?.sequence ?? '0' };
  }

  subscribe(
    after: string,
    message: (row: TranscriptMessage) => void,
    state: (row: CreatureStateEvent) => void
  ) {
    this.subscriptions.push({ after, message, state });
    return () => undefined;
  }

  emit(message: TranscriptMessage) {
    this.messageEventIds.push(message.sequence);
    for (const sub of this.subscriptions) sub.message(message);
  }
  emitState(state: CreatureStateEvent) {
    this.stateEventsHaveId.push(false);
    for (const sub of this.subscriptions) sub.state(state);
  }
}

const row = (
  sequence: string,
  role: 'user' | 'assistant',
  text = `row ${sequence}`,
  clientId?: string
): TranscriptMessage => ({
  sequence,
  role,
  text,
  ...(clientId ? { clientId } : {}),
  createdAt: '2026-10-15T12:30:00.000Z',
});

afterEach(() => {
  cleanup();
});

describe('conversation transcript', () => {
  it('matches a persisted owner row to its optimistic bubble by client id', () => {
    const optimistic = row('1', 'user', 'sending', 'stable-client-id');
    const persisted = row('2', 'user', 'persisted', 'stable-client-id');
    expect(mergeTranscript([optimistic], persisted)).toEqual([persisted]);
  });
  it('renders out-of-order and duplicate SSE rows once and without a reload', async () => {
    await i18n.changeLanguage('en');
    const transport = new FakeTransport([row('1', 'assistant', 'first')]);
    render(<Conversation transport={transport} />);
    await screen.findByText('first');
    expect(transport.subscriptions[0]?.after).toBe('1');
    act(() => {
      transport.emit(row('3', 'assistant', 'third'));
      transport.emit(row('2', 'assistant', 'second'));
      transport.emit({ ...row('2', 'assistant', 'second'), sequence: '2' });
    });
    await screen.findByText('third');
    expect(screen.getAllByText('second')).toHaveLength(1);
    const content = screen.getByTestId('transcript-scroller').textContent ?? '';
    expect(content.indexOf('second')).toBeLessThan(content.indexOf('third'));
    expect(transport.reads).toHaveLength(1);
    expect(transport.messageEventIds).toEqual(['3', '2', '2']);
  });

  it('shows the receipt only after the owner row is in the transcript', async () => {
    await i18n.changeLanguage('en');
    const transport = new FakeTransport([]);
    render(<Conversation transport={transport} />);
    await waitFor(() => expect(transport.subscriptions).toHaveLength(1));
    expect(screen.queryByTestId('read-receipt')).toBeNull();
    act(() => transport.emit(row('1', 'user', 'owner text', 'owner-uuid')));
    await screen.findByTestId('read-receipt');
    expect(screen.getByTestId('read-receipt').textContent).toMatch(/^Read /);
  });

  it('reads only the latest page of a long history and loads an earlier page without losing position', async () => {
    await i18n.changeLanguage('en');
    const rows = Array.from({ length: 10_000 }, (_, index) => row(String(index + 1), 'assistant'));
    const transport = new FakeTransport(rows);
    render(<Conversation transport={transport} />);
    await screen.findByText('row 10000');
    expect(transport.reads).toEqual([undefined]);
    const scroller = screen.getByTestId('transcript-scroller');
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 2000,
      writable: true,
    });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0, writable: true });
    transport.onRead = (before) => {
      if (before)
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2500 });
    };
    fireEvent.scroll(scroller);
    await waitFor(() => expect(transport.reads).toHaveLength(2));
    await screen.findByText('row 9950');
    expect(transport.reads[1]).toBe('9951');
    expect((scroller as HTMLDivElement).scrollTop).toBe(500);
  });

  it('announces fresh thinking state and renders the owner and lifemodel in distinct bubbles', async () => {
    await i18n.changeLanguage('en');
    const transport = new FakeTransport([
      row('1', 'user', 'hello', 'owner-id'),
      row('2', 'assistant', 'welcome'),
    ]);
    render(<Conversation transport={transport} />);
    await screen.findByText('welcome');
    expect(screen.getByText('hello').closest('[class*=bg-accent]')).toBeTruthy();
    expect(screen.getByText('welcome').closest('[class*=bg-secondary]')).toBeTruthy();
    act(() => {
      transport.emitState({
        state: 'thinking',
        epoch: 'epoch-1',
        publishedAt: new Date().toISOString(),
      });
    });
    expect(await screen.findByLabelText('thinking…')).toBeTruthy();
    expect(screen.getByText('•••')).toBeTruthy();
    expect(transport.stateEventsHaveId).toEqual([false]);
  });

  it('renders the XSS fixtures inert and allows only safe links', async () => {
    await i18n.changeLanguage('en');
    const fixture = readFileSync('tests/web-app/fixtures/xss-markdown.md', 'utf8');
    const transport = new FakeTransport([row('1', 'assistant', fixture)]);
    const { container } = render(<Conversation transport={transport} />);
    await screen.findByText('good link');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror], [onclick]')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"], a[href^="data:"]')).toBeNull();
    expect(
      container.querySelector(
        'a[href="https://example.com"][target="_blank"][rel="noopener noreferrer"]'
      )
    ).toBeTruthy();
  });
});
