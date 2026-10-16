// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../../web/app/src/i18n';
import { Conversation } from '../../web/app/src/Conversation';
import type { TranscriptMessage, TranscriptPage, WebTransport } from '../../web/app/src/transport';

class SendingTransport implements WebTransport {
  sent: Array<{ id: string; text: string; replyTo?: string }> = [];
  outcomes: Array<() => Promise<'accepted' | 'conflict' | 'stale'>> = [];
  callbacks: Array<(message: TranscriptMessage) => void> = [];
  async readTranscript(): Promise<TranscriptPage> {
    return { messages: [], cursor: '0' };
  }
  subscribe(_after: string, onMessage: (message: TranscriptMessage) => void) {
    this.callbacks.push(onMessage);
    return () => undefined;
  }
  async sendMessage(input: { id: string; text: string; replyTo?: string }) {
    this.sent.push(input);
    const outcome = this.outcomes.shift();
    return outcome ? outcome() : 'accepted';
  }
  deliver(message: TranscriptMessage) {
    for (const callback of this.callbacks) callback(message);
  }
}

const persisted = (
  sequence: string,
  text: string,
  clientId: string,
  replyTo?: TranscriptMessage['replyTo']
): TranscriptMessage => ({
  sequence,
  role: 'user',
  text,
  clientId,
  createdAt: '2026-10-15T12:30:00.000Z',
  ...(replyTo ? { replyTo } : {}),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('conversation composer and replies', () => {
  it('retries a network failure with the same id and renders one optimistic bubble', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(() => Promise.reject(new Error('offline')));
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    const composer = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(composer, 'hello{enter}');
    await waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent[0]?.id).toBe(transport.sent[1]?.id);
    expect(screen.getAllByText('hello')).toHaveLength(1);
    act(() => transport.deliver(persisted('1', 'hello', transport.sent[0]!.id)));
    await waitFor(() => expect(screen.getAllByText('hello')).toHaveLength(1));
  });

  it('reuses the client id after two lost responses on manual retry', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(
      () => Promise.reject(new Error('offline')),
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve('accepted')
    );
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'uncertain{enter}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry sending message' })).toBeTruthy()
    );
    const firstId = transport.sent[0]?.id;
    await user.click(screen.getByRole('button', { name: 'Retry sending message' }));
    await waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(transport.sent[1]?.id).toBe(firstId);
    expect(transport.sent[2]?.id).toBe(firstId);
  });

  it('marks stale messages not sent and retry mints a new id', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(
      () => Promise.resolve('stale'),
      () => Promise.resolve('accepted')
    );
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    const composer = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(composer, 'old message{enter}');
    await waitFor(() => expect(screen.getByText('Not sent — retry')).toBeTruthy());
    const firstId = transport.sent[0]?.id;
    await user.click(screen.getByRole('button', { name: 'Retry sending message' }));
    await waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent[1]?.id).not.toBe(firstId);
    const replacementId = transport.sent[1]!.id;
    act(() => transport.deliver(persisted('1', 'old message', replacementId)));
    await waitFor(() => expect(screen.getAllByText('old message')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Retry sending message' })).toBeNull();
  });

  it('mints a fresh identity after an explicit conflict response', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(
      () => Promise.resolve('conflict'),
      () => Promise.resolve('accepted')
    );
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'conflict{enter}');
    await user.click(await screen.findByRole('button', { name: 'Retry sending message' }));
    await waitFor(() => expect(transport.sent).toHaveLength(2));
    act(() => transport.deliver(persisted('1', 'conflict', transport.sent[1]!.id)));
    await waitFor(() => expect(screen.getAllByText('conflict')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Retry sending message' })).toBeNull();
  });

  it('mints a fresh identity after an expired retry and retires its old control', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(
      () => Promise.reject(new Error('offline')),
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve('accepted')
    );
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<Conversation transport={transport} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), {
      target: { value: 'expired' },
    });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Message' }).closest('form')!);
    await screen.findByRole('button', { name: 'Retry sending message' });
    const id = transport.sent[0]?.id;
    now += 24 * 60 * 60 * 1000;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry sending message' }));
    await waitFor(() => expect(transport.sent).toHaveLength(3));
    expect(transport.sent[2]?.id).not.toBe(id);
    act(() => transport.deliver(persisted('1', 'expired', transport.sent[2]!.id)));
    await waitFor(() => expect(screen.getAllByText('expired')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Retry sending message' })).toBeNull();
  });

  it('keyboard users can tab to and activate reply, send, and retry controls', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(() => Promise.resolve('stale'));
    render(
      <Conversation
        transport={{
          ...transport,
          readTranscript: async () => ({ messages: [persisted('1', 'old', 'fixed')], cursor: '1' }),
          subscribe: transport.subscribe.bind(transport),
          sendMessage: transport.sendMessage.bind(transport),
        }}
      />
    );
    const user = userEvent.setup();
    await screen.findByText('old');
    await user.tab(); // transcript region
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reply to old' }));
    await user.keyboard('{enter}');
    await user.tab(); // cancel reply
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'keyboard');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send message' }));
    await user.keyboard('{enter}');
    const retry = await screen.findByRole('button', { name: 'Retry sending message' });
    for (let index = 0; index < 5 && document.activeElement !== retry; index += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(retry);
    await user.keyboard('{enter}');
    await waitFor(() => expect(transport.sent).toHaveLength(2));
  });

  it('sends a reply binding and shows the quoted text in both binding and sent bubble', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    const target: TranscriptMessage = {
      sequence: '7',
      role: 'assistant',
      text: 'Earlier answer',
      createdAt: '2026-10-15T12:00:00Z',
    };
    const populated: WebTransport = {
      sendMessage: transport.sendMessage.bind(transport),
      readTranscript: async () => ({ messages: [target], cursor: '7' }),
      subscribe: transport.subscribe.bind(transport),
    };
    render(<Conversation transport={populated} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reply to Earlier answer' }));
    expect(screen.getAllByText('Earlier answer').length).toBeGreaterThan(0);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'follow up{enter}');
    await waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0]?.replyTo).toBe('7');
    act(() =>
      transport.deliver(
        persisted('8', 'follow up', transport.sent[0]!.id, {
          sequence: '7',
          role: 'assistant',
          excerpt: 'Earlier answer',
        })
      )
    );
    await waitFor(() => expect(screen.getAllByText('Earlier answer').length).toBeGreaterThan(1));
  });

  it('uses Shift+Enter for a newline, keeps the draft, and clears it on Enter send', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    const composer = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(composer, 'first{shift>}{enter}{/shift}second');
    expect((composer as HTMLTextAreaElement).value).toBe('first\nsecond');
    await user.keyboard('{enter}');
    await waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(transport.sent[0]?.text).toBe('first\nsecond');
    expect((composer as HTMLTextAreaElement).value).toBe('');
  });
});
