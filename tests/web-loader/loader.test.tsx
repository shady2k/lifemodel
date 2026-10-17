// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import '@testing-library/jest-dom/vitest';
import 'jest-axe/extend-expect';
import i18n from '../../web/loader/src/i18n';
import App from '../../web/loader/src/App';
let dark = false;
let listeners: Array<(event: MediaQueryListEvent) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dark = false;
  listeners = [];
  window.matchMedia = (media) => ({
    get matches() {
      return media.includes('prefers-color-scheme') ? dark : false;
    },
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_t, l) => listeners.push(l as (e: MediaQueryListEvent) => void),
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      setupNeeded: true,
      loggedIn: false,
      onboarding: { step: 'password', completedAt: null },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});
describe('loader UI', () => {
  it.each([
    ['en', false, 'Set your password', true],
    ['en', true, 'Set your password', true],
    ['ru', false, 'Создайте пароль', true],
    ['ru', true, 'Создайте пароль', true],
    ['en', false, 'Welcome back', false],
    ['en', true, 'Welcome back', false],
    ['ru', false, 'С возвращением', false],
    ['ru', true, 'С возвращением', false],
  ] as const)(
    'renders %s in theme dark=%s and has no axe violations',
    async (language, isDark, title, setupNeeded) => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: language === 'ru' ? 'ru-RU' : 'en-US',
      });
      dark = isDark;
      await i18n.changeLanguage(language);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          setupNeeded,
          loggedIn: false,
          onboarding: { step: 'password', completedAt: null },
        }),
      });
      const { container } = render(<App />);
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      expect(document.documentElement.lang).toBe(language);
      expect(document.documentElement.classList.contains('dark')).toBe(isDark);
      expect(await axe(container)).toHaveNoViolations();
    }
  );
  it.each([
    ['en-US', 'Use at least 12 characters.', 'Show password'],
    ['ru-RU', 'Используйте не менее 12 символов.', 'Показать пароль'],
  ] as const)('shows password safety guidance in locale %s', async (locale, guidance, show) => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: locale });
    const { container } = render(<App />);
    expect(await screen.findByText(guidance)).toBeTruthy();
    const input = screen.getByLabelText(locale.startsWith('ru') ? 'Пароль' : 'Password');
    expect(input).toHaveAttribute('minLength', '12');
    fireEvent.click(screen.getByRole('button', { name: show }));
    expect(input).toHaveAttribute('type', 'text');
  });
  it('defaults unknown browser languages to English', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'de-DE' });
    await i18n.changeLanguage('en');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Set your password' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });
  it('shows a translated recovery message when state loading fails', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'ru-RU' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<App />);
    expect(
      await screen.findByText('Не удалось завершить настройку. Попробуйте ещё раз.')
    ).toBeTruthy();
  });
  it('shows the wrong-password error and accepts the right password', async () => {
    await i18n.changeLanguage('en');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ setupNeeded: false, loggedIn: false }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render(<App />);
    const field = await screen.findByLabelText('Password');
    fireEvent.change(field, { target: { value: 'wrong' } });
    fireEvent.submit(field.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'That password did not match. Try again.'
    );
    fireEvent.change(field, { target: { value: 'correct' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/login');
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toContain('correct');
  });
  it('follows system theme changes live', async () => {
    await i18n.changeLanguage('en');
    render(<App />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    dark = true;
    act(() =>
      listeners.forEach((listener) => listener(new Event('change') as MediaQueryListEvent))
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
  it.each(['welcome', 'model', 'device', 'done'] as const)(
    'renders wizard step %s in English and Russian in both themes without axe violations',
    async (step) => {
      for (const language of ['en', 'ru'] as const)
        for (const isDark of [false, true]) {
          cleanup();
          dark = isDark;
          Object.defineProperty(navigator, 'language', {
            configurable: true,
            value: language === 'ru' ? 'ru-RU' : 'en-US',
          });
          await i18n.changeLanguage(language);
          const loggedIn = step !== 'welcome';
          fetchMock.mockImplementation(async (url: string) =>
            url === '/api/state'
              ? {
                  ok: true,
                  json: async () => ({
                    setupNeeded: step === 'welcome',
                    loggedIn,
                    csrfToken: 'csrf',
                    onboarding: {
                      step,
                      completedAt: step === 'done' ? '2026-10-17T00:00:00.000Z' : null,
                    },
                    instanceName: 'lifemodel',
                    caFingerprint: 'abc123',
                  }),
                }
              : url === '/api/model'
                ? {
                    ok: true,
                    json: async () => ({
                      primary: {
                        kind: 'openai',
                        baseUrl: 'https://model.example',
                        model: 'model',
                        keySet: true,
                      },
                      reserve: null,
                    }),
                  }
                : { ok: true, json: async () => ({}) }
          );
          const { container } = render(<App />);
          await screen.findByRole('heading');
          expect(await axe(container)).toHaveNoViolations();
          if (step === 'device') expect(screen.getByText(/SHA-256/)).toBeTruthy();
        }
    }
  );
  it('keeps the model step and shows the safe check error when endpoint check fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/state'
        ? {
            ok: true,
            json: async () => ({
              setupNeeded: false,
              loggedIn: true,
              csrfToken: 'csrf',
              onboarding: { step: 'model', completedAt: null },
            }),
          }
        : url === '/api/model'
          ? { ok: true, json: async () => ({ primary: null, reserve: null }) }
          : { ok: false, json: async () => ({ error: 'auth_failed' }) }
    );
    render(<App />);
    await screen.findByRole('heading', { name: 'Connect model access' });
    fireEvent.change(await screen.findByLabelText('Base URL', { selector: '#url' }), {
      target: { value: 'https://example.com' },
    });
    fireEvent.change(screen.getByLabelText('Model name', { selector: '#model' }), {
      target: { value: 'unit' },
    });
    fireEvent.submit(screen.getByLabelText('Model name', { selector: '#model' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/auth_failed/);
    expect(screen.getByRole('heading', { name: 'Connect model access' })).toBeInTheDocument();
  });
  it.each([
    ['en-US', 'Get started', 'Set your password'],
    ['ru-RU', 'Начать', 'Создайте пароль'],
  ] as const)('welcome progresses to password in %s', async (locale, begin, passwordTitle) => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: locale });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        setupNeeded: true,
        loggedIn: false,
        onboarding: { step: 'welcome', completedAt: null },
      }),
    });
    render(<App />);
    expect(await screen.findByRole('heading')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: begin }));
    expect(screen.getByRole('heading', { name: passwordTitle })).toBeInTheDocument();
  });
  it.each([
    ['en-US', 'Reserve model (optional)', 'auth_failed'],
    ['ru-RU', 'Резервная модель (необязательно)', 'auth_failed'],
  ] as const)('reserve check failure stays on model step (%s)', async (locale, summary) => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: locale });
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/state'
        ? {
            ok: true,
            json: async () => ({
              setupNeeded: false,
              loggedIn: true,
              csrfToken: 'csrf',
              onboarding: { step: 'model', completedAt: null },
            }),
          }
        : url === '/api/model'
          ? {
              ok: true,
              json: async () => ({
                primary: {
                  kind: 'openai',
                  baseUrl: 'https://primary.example',
                  model: 'p',
                  keySet: true,
                },
                reserve: null,
              }),
            }
          : { ok: false, json: async () => ({ error: 'auth_failed' }) }
    );
    render(<App />);
    expect(await screen.findByRole('heading')).toBeInTheDocument();
    fireEvent.click(screen.getByText(summary));
    fireEvent.change(
      screen.getByLabelText(locale.startsWith('ru') ? 'Базовый URL' : 'Base URL', {
        selector: '#reserve-url',
      }),
      { target: { value: 'https://reserve.example' } }
    );
    fireEvent.change(
      screen.getByLabelText(locale.startsWith('ru') ? 'Название модели' : 'Model name', {
        selector: '#reserve-model',
      }),
      { target: { value: 'reserve' } }
    );
    fireEvent.submit(
      screen
        .getByLabelText(locale.startsWith('ru') ? 'Название модели' : 'Model name', {
          selector: '#reserve-model',
        })
        .closest('form')!
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/auth_failed/);
    expect(screen.getByRole('heading')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) => url === '/api/model/reserve' && options?.method === 'PUT'
      )
    ).toBe(true);
  });
  it('resumes the device step from server state after reload and done uses the app handoff URL', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/state'
        ? {
            ok: true,
            json: async () => ({
              setupNeeded: false,
              loggedIn: true,
              onboarding: { step: 'device', completedAt: null },
              instanceName: 'lifemodel',
              caFingerprint: 'fingerprint',
            }),
          }
        : url === '/api/model'
          ? { ok: true, json: async () => ({ primary: null, reserve: null }) }
          : { ok: true, json: async () => ({}) }
    );
    const { unmount } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Set up this device' })).toBeInTheDocument();
    unmount();
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/state'
        ? {
            ok: true,
            json: async () => ({
              setupNeeded: false,
              loggedIn: true,
              onboarding: { step: 'done', completedAt: 'now' },
              instanceName: 'lifemodel',
            }),
          }
        : url === '/api/model'
          ? { ok: true, json: async () => ({ primary: null, reserve: null }) }
          : { ok: true, json: async () => ({}) }
    );
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Open the chat' })).toHaveAttribute(
      'href',
      'https://boot-lifemodel.local/login?next=https%3A%2F%2Flifemodel.local%2F'
    );
  });
});
