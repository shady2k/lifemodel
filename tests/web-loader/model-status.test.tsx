// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import '@testing-library/jest-dom/vitest';
import 'jest-axe/extend-expect';
import i18n, { resources } from '../../web/loader/src/i18n';
import App from '../../web/loader/src/App';
import { MODEL_STATUS_ERROR_KEYS, modelErrorKey } from '../../src/web/model-status.js';

let dark = false;
let fetchMock: ReturnType<typeof vi.fn>;

function settingsFetch(modelStatus: () => unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/state')
      return {
        ok: true,
        json: async () => ({
          setupNeeded: false,
          loggedIn: true,
          csrfToken: 'csrf',
          onboarding: { step: 'done', completedAt: 'now' },
          instanceName: 'lifemodel',
          caFingerprint: 'abc123',
        }),
      };
    if (url === '/api/model')
      return {
        ok: true,
        json: async () => ({
          primary: { kind: 'openai', baseUrl: 'https://model.example', model: 'm', keySet: true },
          reserve: null,
        }),
      };
    if (url === '/api/model-status') return modelStatus() as never;
    return { ok: true, json: async () => ({}) };
  });
}

beforeEach(() => {
  dark = false;
  window.matchMedia = (media) => ({
    get matches() {
      return media.includes('prefers-color-scheme') ? dark : false;
    },
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

function stub(modelStatus: () => unknown): void {
  fetchMock = settingsFetch(modelStatus);
  vi.stubGlobal('fetch', fetchMock);
}

describe('the loader settings show the model connection', () => {
  it.each([
    ['en', false, 'No connection to the model since', '— the model is answering with an error'],
    ['en', true, 'No connection to the model since', '— the model is answering with an error'],
    ['ru', false, 'Нет связи с моделью с', '— модель отвечает ошибкой'],
    ['ru', true, 'Нет связи с моделью с', '— модель отвечает ошибкой'],
  ])(
    'shows an outage in words for %s in the dark=%s theme without axe violations',
    async (language, isDark, lead, tail) => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: language === 'ru' ? 'ru-RU' : 'en-US',
      });
      dark = isDark;
      await i18n.changeLanguage(language);
      stub(() => ({
        ok: true,
        json: async () => ({
          state: 'down',
          outageSince: new Date(Date.now() - 3 * 60_000).toISOString(),
          lastErrorCode: 'upstream_500',
          upstreamUrl: 'http://owner-endpoint.example/v1',
        }),
      }));
      const { container } = render(<App />);
      expect(
        await screen.findByRole('heading', { name: language === 'ru' ? 'Настройки' : 'Settings' })
      ).toBeInTheDocument();
      const line = await screen.findByText(new RegExp(`^${lead} \\d{2}:\\d{2} ${tail}$`));
      expect(line.closest('[data-slot=alert]')).not.toBeNull();
      expect(container.textContent).not.toContain('upstream_500');
      expect(container.textContent).not.toContain('owner-endpoint.example');
      expect(document.documentElement.classList.contains('dark')).toBe(isDark);
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it.each([
    ['ok', { state: 'ok', outageSince: null, lastErrorCode: null }],
    ['unknown', { state: 'unknown', outageSince: null, lastErrorCode: null }],
  ])('stays silent while the status is %s', async (_name, body) => {
    await i18n.changeLanguage('en');
    stub(() => ({ ok: true, json: async () => body }));
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/model-status')).toBe(true)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).not.toContain('No connection to the model');
    expect(container.textContent).not.toContain('Model status unavailable');
  });

  it.each([
    ['a failed request', () => ({ ok: false, status: 503, json: async () => ({}) })],
    ['an unavailable status', () => ({ ok: true, json: async () => null })],
    [
      'a body the loader cannot read',
      () => ({ ok: true, json: async () => ({ state: 'broken' }) }),
    ],
  ])('shows the quieter unavailable line for %s', async (_name, response) => {
    await i18n.changeLanguage('en');
    stub(response);
    const { container } = render(<App />);
    expect(await screen.findByText('Model status unavailable')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText('Model status unavailable').closest('[data-slot=badge]')
    ).not.toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the date of an outage that began on an earlier day', async () => {
    await i18n.changeLanguage('en');
    stub(() => ({
      ok: true,
      json: async () => ({
        state: 'down',
        outageSince: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
        lastErrorCode: 'timeout',
      }),
    }));
    render(<App />);
    const line = await screen.findByText(/— the request timed out$/);
    expect(line.textContent).toMatch(/\d{1,2}[./]\d{1,2}/);
  });

  it.each([
    ['en-US', 'en', 'Model saved — waiting for the first request'],
    ['ru-RU', 'ru', 'Модель сохранена — ждём первого запроса'],
  ])(
    'shows the waiting line for unknown after the owner saved a slot (%s)',
    async (locale, language, line) => {
      Object.defineProperty(navigator, 'language', { configurable: true, value: locale });
      await i18n.changeLanguage(language);
      stub(() => ({
        ok: true,
        json: async () => ({ state: 'unknown', outageSince: null, lastErrorCode: null }),
      }));
      const { container } = render(<App />);
      await screen.findByRole('heading', { name: language === 'ru' ? 'Настройки' : 'Settings' });
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url === '/api/model-status')).toBe(true)
      );
      // Nothing is saved in this page session yet: unknown stays silent.
      expect(container.textContent).not.toContain(line);
      const save = screen.getByRole('button', {
        name: language === 'ru' ? 'Проверить и сохранить' : 'Check and save',
      });
      fireEvent.submit(save.closest('form')!);
      expect(await screen.findByText(line)).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it('keeps the outage line after a save when the model really failed', async () => {
    await i18n.changeLanguage('en');
    stub(() => ({
      ok: true,
      json: async () => ({
        state: 'down',
        outageSince: new Date(Date.now() - 60_000).toISOString(),
        lastErrorCode: 'upstream_500',
      }),
    }));
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });
    const save = await screen.findByRole('button', { name: 'Check and save' });
    fireEvent.submit(save.closest('form')!);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/model/primary')).toBe(true)
    );
    expect(await screen.findByText(/— the model is answering with an error$/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Model saved — waiting for the first request');
  });

  it('retains the save across an older ok poll and later historical ok/down/unavailable polls (F6)', async () => {
    await i18n.changeLanguage('en');
    let poll!: () => void;
    const realInterval = window.setInterval;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback, ms, ...args) => {
      if (ms === 10_000) {
        poll = callback as () => void;
        return 123 as ReturnType<typeof window.setInterval>;
      }
      return realInterval(callback, ms, ...args);
    });
    let release!: (value: unknown) => void;
    let next: unknown = new Promise((resolve) => {
      release = resolve;
    });
    let polls = 0;
    stub(() => {
      polls++;
      return next;
    });
    const { container } = render(<App />);
    try {
      await screen.findByRole('heading', { name: 'Settings' });
      await waitFor(() => expect(polls).toBe(1));
      const save = screen.getByRole('button', { name: 'Check and save' });
      fireEvent.submit(save.closest('form')!);
      await waitFor(() => expect(save).not.toBeDisabled());
      // This ok read started before the save. It cannot prove post-save success.
      await act(async () => {
        release({ ok: true, json: async () => ({ state: 'ok' }) });
      });
      const show = async (body: unknown, expected?: string) => {
        const before = polls;
        next = { ok: true, json: async () => body };
        poll();
        await waitFor(() => expect(polls).toBe(before + 1));
        if (expected) expect(await screen.findByText(expected)).toBeInTheDocument();
      };
      const line = 'Model saved — waiting for the first request';
      await show({ state: 'unknown' }, line);
      // Even a post-save ok poll can describe a historical request: the loader
      // projection has no lastSuccessAt. Retain the page-session fact.
      await show({ state: 'ok' });
      await waitFor(() => expect(screen.queryByText(line)).toBeNull());
      await show({ state: 'unknown' }, line);
      await show({
        state: 'down',
        outageSince: new Date().toISOString(),
        lastErrorCode: 'timeout',
      });
      expect(await screen.findByText(/— the request timed out$/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(line);
      await show(null, 'Model status unavailable');
      await show({ state: 'unknown' }, line);
    } finally {
      interval.mockRestore();
    }
  });

  it('has words for every safe code in both languages', () => {
    const codes = [
      ...Object.keys(MODEL_STATUS_ERROR_KEYS),
      'upstream_401',
      'upstream_404',
      'upstream_429',
      'upstream_400',
      'upstream_500',
      'a-new-code',
    ];
    for (const language of ['en', 'ru'] as const)
      for (const code of codes) {
        const key = modelErrorKey(code);
        const phrase =
          resources[language].translation[key as keyof typeof resources.en.translation];
        expect(phrase, `${language}:${key}`).toBeTruthy();
        expect(String(phrase)).not.toBe(code);
      }
    expect(Object.keys(resources.en.translation).sort()).toEqual(
      Object.keys(resources.ru.translation).sort()
    );
  });
});
