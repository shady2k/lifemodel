// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { within } from '@testing-library/react';
import i18n, { languageFor } from '../../web/app/src/i18n';
import 'jest-axe/extend-expect';
import App from '../../web/app/src/App';
import { Conversation } from '../../web/app/src/Conversation';
import type { WebTransport } from '../../web/app/src/transport';

let darkPreference = false;
let mobilePreference = false;
let listeners: Array<(event: MediaQueryListEvent) => void> = [];

beforeEach(() => {
  darkPreference = false;
  mobilePreference = false;
  listeners = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: async () => ({ name: 'lifemodel', loaderUrl: 'http://boot-lifemodel.local/' }),
    })
  );
  window.matchMedia = (media) => ({
    get matches() {
      return media.includes('prefers-color-scheme')
        ? darkPreference
        : media.includes('max-width: 1023px')
          ? window.innerWidth <= 1023
          : media.includes('max-width: 767px')
            ? window.innerWidth <= 767
            : mobilePreference;
    },
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: (_type, listener) =>
      listeners.push(listener as (event: MediaQueryListEvent) => void),
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('web app shell', () => {
  it.each([
    ['en', false, 'Conversation', 'System', 'Now'],
    ['en', true, 'Conversation', 'System', 'Now'],
    ['ru', false, 'Разговор', 'Система', 'Сейчас'],
    ['ru', true, 'Разговор', 'Система', 'Сейчас'],
  ])(
    'renders %s navigation in the %s theme without accessibility violations',
    async (language, dark, conversation, system, now) => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: language === 'ru' ? 'ru-RU' : 'en-US',
      });
      darkPreference = dark;
      await i18n.changeLanguage(language);
      const { container } = render(<App />);
      expect(screen.getByRole('link', { name: conversation })).toBeTruthy();
      expect(screen.getByText(system)).toBeTruthy();
      expect(screen.getByRole('heading', { name: now })).toBeTruthy();
      expect(screen.getAllByText('lifemodel').length).toBeGreaterThan(0);
      await waitFor(() =>
        expect(
          screen
            .getAllByRole('link')
            .some((link) => link.getAttribute('href') === 'http://boot-lifemodel.local/')
        ).toBe(true)
      );
      expect(document.documentElement.lang).toBe(language);
      expect(document.documentElement.classList.contains('dark')).toBe(dark);
      expect(
        container.querySelector('main') || container.querySelector('[data-slot=\"sidebar-inset\"]')
      ).toBeTruthy();
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it.each([
    ['fr-FR', 'en'],
    ['de-DE', 'en'],
    ['xx-ZZ', 'en'],
    ['ru-RU', 'ru'],
    ['ru', 'ru'],
  ])('maps browser locale %s to %s and formats dates by locale', (locale, expected) => {
    expect(languageFor(locale)).toBe(expected);
    const formatted = new Intl.DateTimeFormat(expected, { dateStyle: 'medium' }).format(
      new Date('2026-02-03T12:00:00Z')
    );
    expect(formatted).toBe(expected === 'ru' ? '3 февр. 2026 г.' : 'Feb 3, 2026');
  });

  it('shows the Now opener below the aside breakpoint at 390, 768, and 900 px, and the aside at 1024 px', () => {
    for (const width of [390, 768, 900, 1024]) {
      cleanup();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      const { container } = render(<App />);
      if (width < 1024) expect(screen.getByRole('button', { name: 'Open Now' })).toBeTruthy();
      else expect(screen.queryByRole('button', { name: 'Open Now' })).toBeNull();
      expect(container.querySelector('aside')).toBeTruthy();
    }
  });

  it('exposes only the routed Loader destination in desktop and mobile System navigation', async () => {
    await i18n.changeLanguage('en');
    render(<App />);
    const desktop = document.querySelector('[data-slot="sidebar"]')!;
    await waitFor(() =>
      expect(within(desktop).getByRole('link', { name: 'Loader' }).getAttribute('href')).toBe(
        'http://boot-lifemodel.local/'
      )
    );
    expect(within(desktop).queryByRole('link', { name: 'Keys' })).toBeNull();
    expect(within(desktop).queryByRole('link', { name: 'Code' })).toBeNull();
    cleanup();
    mobilePreference = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<App />);
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const sheet = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(sheet).getByRole('link', { name: 'Loader' }).getAttribute('href')).toBe(
      'http://boot-lifemodel.local/'
    );
    expect(within(sheet).queryByRole('link', { name: 'Keys' })).toBeNull();
    expect(within(sheet).queryByRole('link', { name: 'Code' })).toBeNull();
  });

  it('translates mobile navigation and sheet close labels in Russian', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'ru-RU' });
    await i18n.changeLanguage('ru');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть навигацию' }));
    expect(screen.getByRole('dialog', { name: 'Навигация' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Загрузчик' }).getAttribute('href')).toBe(
      'http://boot-lifemodel.local/'
    );
    cleanup();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть Сейчас' }));
    expect(screen.getByRole('dialog', { name: 'Сейчас' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Закрыть' })).toBeTruthy();
  });

  it('clears header and Now presence when state becomes unavailable', async () => {
    await i18n.changeLanguage('en');
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    class FakeEventSource {
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        listeners.set(type, listener);
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/instance'))
          return new Response(
            JSON.stringify({ name: 'lifemodel', loaderUrl: 'https://boot.local/' })
          );
        if (url.startsWith('/api/transcript'))
          return new Response(JSON.stringify({ messages: [], cursor: null }));
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    render(<App />);
    await waitFor(() => expect(listeners.has('state')).toBe(true));
    act(() =>
      listeners.get('state')!(
        new MessageEvent('state', {
          data: JSON.stringify({
            state: 'thinking',
            epoch: '55',
            publishedAt: new Date().toISOString(),
          }),
        })
      )
    );
    expect(await screen.findAllByText('thinking…')).toHaveLength(2);
    act(() => listeners.get('state')!(new MessageEvent('state', { data: 'null' })));
    await waitFor(() => expect(screen.getAllByText('no connection since --:--')).toHaveLength(2));
  });

  it('follows system colour-scheme changes live', () => {
    render(<App />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    darkPreference = true;
    act(() => {
      for (const listener of listeners) listener(new Event('change') as MediaQueryListEvent);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    darkPreference = false;
    act(() => {
      for (const listener of listeners) listener(new Event('change') as MediaQueryListEvent);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('opens and closes both mobile sheets with keyboard activation', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    mobilePreference = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<App />);
    const navigation = await screen.findByRole('button', { name: 'Open navigation' });
    navigation.focus();
    await user.keyboard('{enter}');
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    await user.keyboard('{escape}');
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    const now = screen.getByRole('button', { name: 'Open Now' });
    now.focus();
    await user.keyboard('{enter}');
    expect(screen.getByRole('dialog', { name: 'Now' })).toBeTruthy();
    await user.keyboard('{escape}');
    expect(screen.queryByRole('dialog', { name: 'Now' })).toBeNull();
  });

  it('puts navigation and the Сейчас panel behind buttons on a narrow screen', async () => {
    mobilePreference = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Conversation' })).toBeTruthy();
    cleanup();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Now' }));
    const panel = screen.getByRole('dialog', { name: 'Now' });
    expect(within(panel).getByText('no connection since --:--')).toBeTruthy();
  });
});

describe('transcript rendering contract', () => {
  it.each([
    [[], 'No messages yet'],
    [
      [
        {
          sequence: '1',
          role: 'assistant' as const,
          text: 'A first answer',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      'A first answer',
    ],
  ])('renders transcript rows: %j', async (messages, expected) => {
    await i18n.changeLanguage('en');
    const transport: WebTransport = {
      sendMessage: vi.fn().mockResolvedValue('accepted'),
      readTranscript: vi.fn().mockResolvedValue({ messages, cursor: messages.length ? '1' : null }),
      subscribe: vi.fn().mockReturnValue(() => undefined),
      onSessionExpired: vi.fn().mockReturnValue(() => undefined),
    };
    render(<Conversation transport={transport} />);
    if (messages.length) expect(await screen.findByText(expected)).toBeTruthy();
    else expect(await screen.findByText('No messages yet')).toBeTruthy();
  });
});
