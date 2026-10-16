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
  });

  it('mints a fresh id after an explicit conflict response', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(
      () => Promise.resolve('conflict'),
      () => Promise.resolve('accepted')
    );
    render(<Conversation transport={transport} />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'conflict{enter}');
    await screen.findByRole('button', { name: 'Retry sending message' });
    const prior = transport.sent[0]?.id;
    await user.click(screen.getByRole('button', { name: 'Retry sending message' }));
    await waitFor(() => expect(transport.sent).toHaveLength(2));
    expect(transport.sent[1]?.id).not.toBe(prior);
  });

  it('mints a new identity after the pending message reaches its 24-hour expiry', async () => {
    await i18n.changeLanguage('en');
    const transport = new SendingTransport();
    transport.outcomes.push(
      () => Promise.reject(new Error('offline')),
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve('accepted')
    );
    const originalNow = Date.now;
    let now = originalNow();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<Conversation transport={transport} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'expired' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'expired' },
    });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Message' }).closest('form')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Retry sending message' })).toBeTruthy();
    const id = transport.sent[0]?.id;
    now += 24 * 60 * 60 * 1000;
    fireEvent.click(screen.getByRole('button', { name: 'Retry sending message' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(transport.sent[2]?.id).not.toBe(id);
  });

  it('keyboard users can activate reply, send, and retry controls', async () => {
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
    await screen.findByText('old');
    const reply = screen.getByRole('button', { name: 'Reply to old' });
    reply.focus();
    expect(document.activeElement).toBe(reply);
    fireEvent.keyDown(reply, { key: 'Enter' });
    fireEvent.click(reply);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    composer.focus();
    await userEvent.setup().type(composer, 'keyboard');
    const send = screen.getByRole('button', { name: 'Send message' });
    send.focus();
    expect(document.activeElement).toBe(send);
    fireEvent.keyDown(send, { key: 'Enter' });
    fireEvent.click(send);
    await screen.findByRole('button', { name: 'Retry sending message' });
    const retry = screen.getByRole('button', { name: 'Retry sending message' });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.keyDown(retry, { key: 'Enter' });
    fireEvent.click(retry);
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
