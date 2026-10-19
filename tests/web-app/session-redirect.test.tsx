// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../../web/app/src/i18n';
import { Conversation } from '../../web/app/src/Conversation';
import * as session from '../../web/app/src/session';
import type {
  MessageInput,
  SendResult,
  TranscriptPage,
  WebTransport,
} from '../../web/app/src/transport';

const DRAFT_KEY = 'lifemodel.web.draft';

/** A transport whose reads can be made to prove the session has ended. */
class SessionTransport implements WebTransport {
  private listeners = new Set<() => void>();

  async readTranscript(): Promise<TranscriptPage> {
    return { messages: [], cursor: '0' };
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async sendMessage(_input: MessageInput): Promise<SendResult> {
    return 'accepted';
  }

  onSessionExpired(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  expire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("the page and the owner's ended session", () => {
  it('keeps the unsent draft and leaves the page', async () => {
    const leave = vi.spyOn(session, 'leaveForLogin').mockImplementation(() => undefined);
    await i18n.changeLanguage('en');
    const transport = new SessionTransport();
    render(<Conversation transport={transport} />);
    const composer = await screen.findByPlaceholderText('Write a message…');
    await userEvent.type(composer, 'черновик');
    transport.expire();
    // The loader takes the reloaded page to its login and back to this address;
    // the draft is waiting for the owner when it returns.
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBe('черновик');
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('puts the saved draft back when the page returns', async () => {
    window.sessionStorage.setItem(DRAFT_KEY, 'черновик');
    await i18n.changeLanguage('en');
    render(<Conversation transport={new SessionTransport()} />);
    const composer = (await screen.findByPlaceholderText(
      'Write a message…'
    )) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(composer.value).toBe('черновик');
    });
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('brings nothing back for a draft the owner already sent', async () => {
    const leave = vi.spyOn(session, 'leaveForLogin').mockImplementation(() => undefined);
    await i18n.changeLanguage('en');
    const transport = new SessionTransport();
    render(<Conversation transport={transport} />);
    const composer = await screen.findByPlaceholderText('Write a message…');
    await userEvent.type(composer, 'отправлено{Enter}');
    transport.expire();
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing when the browser refuses storage', () => {
    // jsdom's Storage is a proxy, so its methods are replaced as a whole.
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const denied = () => {
      throw new Error('storage is disabled');
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: denied, setItem: denied, removeItem: denied },
    });
    try {
      expect(() => {
        session.saveDraft('черновик');
      }).not.toThrow();
      expect(session.takeDraft()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
