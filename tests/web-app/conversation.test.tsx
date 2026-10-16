// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import i18n from '../../web/app/src/i18n';
import { Conversation } from '../../web/app/src/Conversation';
import userEvent from '@testing-library/user-event';
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
  sent: Array<{ id: string; text: string; replyTo?: string }> = [];
  stateEventsHaveId: boolean[] = [];
  subscriptions: Array<{
    after: string;
    message: (row: TranscriptMessage) => void;
    state: (row: CreatureStateEvent) => void;
  }> = [];
  onRead?: (before?: string) => void;
  constructor(private readonly rows: TranscriptMessage[]) {}

  async sendMessage(input: { id: string; text: string; replyTo?: string }): Promise<'accepted'> {
    this.sent.push(input);
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

  it('does not show read for a pending message until its matching durable owner row arrives', async () => {
    await i18n.changeLanguage('en');
    const transport = new FakeTransport([row('1', 'assistant', 'answer')]);
    transport.sendMessage = async (input) => {
      transport.sent.push(input);
      if (transport.sent.length <= 2) throw new Error('lost response');
      return 'accepted';
    };
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'waiting{enter}');
    await waitFor(() => expect(screen.getByText('Not sent — retry')).toBeTruthy());
    expect(screen.queryByTestId('read-receipt')).toBeNull();
    act(() => transport.emit(row('2', 'assistant', 'another answer')));
    expect(screen.queryByTestId('read-receipt')).toBeNull();
    act(() => transport.emit(row('3', 'user', 'someone else', 'other-id')));
    await waitFor(() => expect(screen.getByTestId('read-receipt')).toBeTruthy());
    expect(screen.getByText('someone else')).toBeTruthy();
    expect(transport.sent).toHaveLength(2);
    act(() => transport.emit(row('4', 'user', 'durable waiting', transport.sent[0]?.id)));
    expect(transport.sent[0]?.id).toBe(transport.sent[1]?.id);
    await waitFor(() => expect(screen.getByText('durable waiting')).toBeTruthy());
    expect(screen.queryByText('waiting')).toBeNull();
  });

  it('reconciles the optimistic bubble to the durable timestamp and quote', async () => {
    await i18n.changeLanguage('en');
    const transport = new FakeTransport([row('1', 'assistant', 'first answer')]);
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reply to first answer' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'follow-up{enter}');
    await waitFor(() => expect(screen.getByText('follow-up')).toBeTruthy());
    const id = transport.messageEventIds.at(-1) ?? 'pending';
    act(() =>
      transport.emit({
        ...row('2', 'user', 'durable follow-up', id),
        createdAt: '2020-01-02T03:04:00.000Z',
        replyTo: { sequence: '1', role: 'assistant', excerpt: 'first answer' },
      })
    );
    await waitFor(() => expect(screen.getByText('durable follow-up')).toBeTruthy());
    const bubble = screen.getByText('durable follow-up').closest('div');
    expect(bubble?.parentElement?.querySelector('time')?.dateTime).toBe('2020-01-02T03:04:00.000Z');
    expect(screen.getAllByText('first answer').length).toBeGreaterThanOrEqual(2);
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
    act(() => transport.emit(row('10001', 'assistant', 'live after page')));
    expect(screen.getByText('live after page')).toBeTruthy();
    expect(transport.reads).toEqual([undefined, '9951']);
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

  it.each(['en', 'ru'])(
    'has no axe violations with a populated transcript in %s',
    async (language) => {
      await i18n.changeLanguage(language);
      document.documentElement.classList.toggle('dark', language === 'ru');
      const { container } = render(
        <Conversation
          transport={
            new FakeTransport([
              row('1', 'assistant', 'A populated transcript'),
              row('2', 'user', 'owner response', 'owner'),
            ])
          }
        />
      );
      await screen.findByText('A populated transcript');
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it('keeps focus through live rows and state updates and announces repeated assistant messages', async () => {
    await i18n.changeLanguage('en');
    const transport = new FakeTransport([row('1', 'assistant', 'first')]);
    render(<Conversation transport={transport} />);
    await screen.findByText('first');
    const replyButton = screen.getByRole('button', { name: 'Reply to first' });
    replyButton.focus();
    act(() => transport.emit(row('2', 'assistant', 'second')));
    expect(document.activeElement).toBe(replyButton);
    expect(screen.getByTestId('live-announcement').textContent).toBe('New message from lifemodel.');
    act(() => transport.emit(row('3', 'assistant', 'third')));
    await screen.findByText('third');
    expect(document.activeElement).toBe(replyButton);
    expect(screen.getByTestId('live-announcement').textContent).toBe('New message from lifemodel.');
  });

  it('hides stale thinking after the freshness window passes without another event', async () => {
    await i18n.changeLanguage('en');
    const start = Date.now();
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const transport = new FakeTransport([]);
    render(<Conversation transport={transport} />);
    await waitFor(() => expect(transport.subscriptions).toHaveLength(1));
    act(() =>
      transport.emitState({
        state: 'thinking',
        epoch: 'old',
        publishedAt: new Date(start).toISOString(),
      })
    );
    expect(screen.getByText('•••')).toBeTruthy();
    now += 15_001;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(screen.queryByText('•••')).toBeNull();
  });

  it('filters unsafe markdown URL schemes and preserves relative, mailto and HTTPS links', async () => {
    await i18n.changeLanguage('en');
    const markdown =
      '[js](javascript:alert%281%29) [encoded](java\nscript:alert(1)) [data](data:text/html,evil) [relative](/local) [mail](mailto:a@example.com) [safe](https://example.com)\n\n```js\n<img src=x onerror=alert(1)>\n```';
    const transport = new FakeTransport([row('1', 'assistant', markdown)]);
    const { container } = render(<Conversation transport={transport} />);
    await screen.findByText('js');
    expect(container.querySelector('a[href^="javascript:"],a[href^="data:"]')).toBeNull();
    expect(container.querySelector('a[href="/local"]')).toBeNull();
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(
      container.querySelector('a[href="https://example.com"][rel="noopener noreferrer"]')
    ).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-slot=\"code-block\"]')).toBeTruthy());
    expect(container.querySelector('[onerror]')).toBeNull();
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
