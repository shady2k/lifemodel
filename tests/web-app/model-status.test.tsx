// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import i18n from '../../web/app/src/i18n';
import App from '../../web/app/src/App';
import { MODEL_STATUS_ERROR_KEYS, modelErrorKey } from '../../src/web/model-status.js';

let darkPreference = false;
let listeners = new Map<string, (event: MessageEvent<string>) => void>();

class FakeEventSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    listeners.set(type, listener);
  }
  close() {}
}

beforeEach(() => {
  darkPreference = false;
  listeners = new Map();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/instance'))
        return new Response(
          JSON.stringify({ name: 'lifemodel', loaderUrl: 'https://boot-lifemodel.local/' })
        );
      if (url.startsWith('/api/transcript'))
        return new Response(JSON.stringify({ messages: [], cursor: null }));
      throw new Error(`Unexpected request: ${url}`);
    })
  );
  window.matchMedia = (media) => ({
    matches: media.includes('prefers-color-scheme') ? darkPreference : false,
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
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

async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(<App />);
  await waitFor(() => expect(listeners.has('model')).toBe(true));
  return container;
}

function emitModel(data: unknown): void {
  act(() => {
    listeners.get('model')!(new MessageEvent('model', { data: JSON.stringify(data) }));
  });
}

function emitRawModel(data: string): void {
  act(() => {
    listeners.get('model')!(new MessageEvent('model', { data }));
  });
}

describe('the model connection in Сейчас', () => {
  it.each([
    ['en', false, 'No connection to the model since', '— the endpoint is unreachable'],
    ['en', true, 'No connection to the model since', '— the endpoint is unreachable'],
    ['ru', false, 'Нет связи с моделью с', '— эндпоинт недоступен'],
    ['ru', true, 'Нет связи с моделью с', '— эндпоинт недоступен'],
  ])(
    'shows an outage in words for %s in the dark=%s theme without axe violations',
    async (language, dark, lead, tail) => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: language === 'ru' ? 'ru-RU' : 'en-US',
      });
      darkPreference = dark;
      await i18n.changeLanguage(language);
      const container = await renderPanel();
      expect(screen.queryByText(lead, { exact: false })).toBeNull();
      emitModel({
        state: 'down',
        outageSince: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastErrorCode: 'unreachable',
      });
      const line = await screen.findByText(new RegExp(`^${lead} \\d{2}:\\d{2} ${tail}$`));
      expect(line).toBeTruthy();
      expect(line.closest('[data-slot=alert]')).not.toBeNull();
      expect(document.documentElement.classList.contains('dark')).toBe(dark);
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it('shows nothing while the model answers, or before any status arrives', async () => {
    await i18n.changeLanguage('en');
    const container = await renderPanel();
    expect(container.textContent).not.toContain('No connection to the model');
    expect(container.textContent).not.toContain('Model status unavailable');
    emitModel({ state: 'ok', outageSince: null, lastErrorCode: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).not.toContain('No connection to the model');
    emitModel({ state: 'unknown', outageSince: null, lastErrorCode: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.textContent).not.toContain('No connection to the model');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows one quieter line when no status could be read', async () => {
    await i18n.changeLanguage('en');
    const container = await renderPanel();
    emitModel(null);
    const quiet = await screen.findByText('Model status unavailable');
    expect(quiet.closest('[data-slot=badge]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    emitRawModel('not json');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('Model status unavailable')).toBeTruthy();
    emitRawModel('{"state":"broken"}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('Model status unavailable')).toBeTruthy();
    expect(container.textContent).not.toContain('down');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the date of an outage that began on an earlier day', async () => {
    await i18n.changeLanguage('en');
    await renderPanel();
    emitModel({
      state: 'down',
      outageSince: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
      lastErrorCode: 'upstream_503',
    });
    const line = await screen.findByText(/the model is answering with an error$/);
    expect(line.textContent).toMatch(/\d{1,2}[./]\d{1,2}/);
  });

  it('never shows the raw code, an endpoint or an error body', async () => {
    await i18n.changeLanguage('en');
    const container = await renderPanel();
    emitModel({
      state: 'down',
      outageSince: new Date().toISOString(),
      lastErrorCode: 'upstream_402',
      upstreamUrl: 'http://owner-endpoint.example/v1',
      lastErrorBody: 'invalid api key sk-secret',
    });
    const line = await screen.findByText(/^No connection to the model since /);
    expect(line.textContent).toContain('the model refused the request');
    expect(container.textContent).not.toContain('upstream_402');
    expect(container.textContent).not.toContain('owner-endpoint.example');
    expect(container.textContent).not.toContain('sk-secret');
  });

  it('has words for every safe code in both languages', async () => {
    for (const language of ['en', 'ru'] as const) {
      await i18n.changeLanguage(language);
      const codes = [
        ...Object.keys(MODEL_STATUS_ERROR_KEYS),
        'upstream_401',
        'upstream_404',
        'upstream_429',
        'upstream_400',
        'upstream_500',
        'something-new',
      ];
      for (const code of codes) {
        const key = modelErrorKey(code);
        expect(i18n.exists(key, { lng: language }), `${language}:${key}`).toBe(true);
        // The phrase is words, never the raw code (a code may share a word with it).
        expect(String(i18n.t(key, { lng: language }))).not.toBe(code);
        expect(String(i18n.t(key, { lng: language })).length).toBeGreaterThan(3);
      }
      for (const key of ['modelStatusUnavailable', 'modelOutage'])
        expect(i18n.exists(key, { lng: language }), `${language}:${key}`).toBe(true);
    }
    expect(String(i18n.t('modelOutage', { lng: 'ru', time: '14:03', error: 'причина' }))).toBe(
      'Нет связи с моделью с 14:03 — причина'
    );
  });
});
