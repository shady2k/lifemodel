// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
      expect(await screen.findByRole('heading', { name: language === 'ru' ? 'Настройки' : 'Settings' })).toBeInTheDocument();
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
    ['a body the loader cannot read', () => ({ ok: true, json: async () => ({ state: 'broken' }) })],
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
        const phrase = resources[language].translation[key as keyof typeof resources.en.translation];
        expect(phrase, `${language}:${key}`).toBeTruthy();
        expect(String(phrase)).not.toBe(code);
      }
    expect(Object.keys(resources.en.translation).sort()).toEqual(
      Object.keys(resources.ru.translation).sort()
    );
  });
});
