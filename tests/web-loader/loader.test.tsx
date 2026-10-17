// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import '@testing-library/jest-dom/vitest';
import 'jest-axe/extend-expect';
import i18n, { resources } from '../../web/loader/src/i18n';
import App from '../../web/loader/src/App';
let dark = false;
let listeners: Array<(event: MediaQueryListEvent) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dark = false;
  listeners = [];
  HTMLElement.prototype.scrollIntoView = vi.fn();
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

  it('keeps English and Russian translation keys complete and exact device guidance localized', () => {
    expect(Object.keys(resources.en.translation).sort()).toEqual(
      Object.keys(resources.ru.translation).sort()
    );
    expect(resources.en.translation.deviceTitle).toBe('Set up this device');
    expect(resources.ru.translation.deviceTitle).toBe('Настройте это устройство');
    expect(resources.en.translation.macosSteps).toContain('Always Trust');
    expect(resources.ru.translation.macosSteps).toContain('Всегда доверять');
  });
  it('allows switching the wizard language to Russian', async () => {
    await i18n.changeLanguage('en');
    render(<App />);
    await screen.findByRole('heading', { name: 'Set your password' });
    fireEvent.click(screen.getByRole('button', { name: 'Русский' }));
    expect(await screen.findByRole('heading', { name: 'Создайте пароль' })).toBeInTheDocument();
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
  it('uses the kit provider Select controls and supports choosing both providers', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/state'
        ? {
            ok: true,
            json: async () => ({
              setupNeeded: false,
              loggedIn: true,
              onboarding: { step: 'model', completedAt: null },
            }),
          }
        : { ok: true, json: async () => ({ primary: null, reserve: null }) }
    );
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Connect model access' });
    expect(container.querySelector('[data-slot=select-trigger]')).toBeInTheDocument();
    expect(container.querySelector('#kind')).not.toBeInstanceOf(HTMLSelectElement);
    expect(container.querySelector('#kind')).toHaveAttribute('role', 'combobox');
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByRole('option', { name: 'Ollama' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Ollama' }));
    expect(screen.getByRole('combobox').textContent).toContain('Ollama');
    fireEvent.click(screen.getByRole('button', { name: 'Reserve model (optional)' }));
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(2);
    expect(combos[1]).not.toBeInstanceOf(HTMLSelectElement);
    fireEvent.click(combos[1]!);
    expect(await screen.findByRole('option', { name: 'OpenAI compatible' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI compatible' }));
    expect(combos[1]?.textContent).toContain('OpenAI compatible');
  });
  it.each([
    ['en-US', 'Reserve model (optional)', 'The model rejected the credentials.'],
    ['ru-RU', 'Резервная модель (необязательно)', 'Модель отклонила учётные данные.'],
  ] as const)(
    'does not prefill either stored API key and shows exact reserve errors (%s)',
    async (locale, summary, explanation) => {
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
                    model: 'primary',
                    keySet: true,
                  },
                  reserve: {
                    kind: 'ollama',
                    baseUrl: 'https://reserve.example',
                    model: 'reserve',
                    keySet: true,
                  },
                }),
              }
            : { ok: false, json: async () => ({ error: 'auth_failed' }) }
      );
      const { container } = render(<App />);
      await screen.findByRole('heading', {
        name: locale.startsWith('ru') ? 'Подключите модель' : 'Connect model access',
      });
      await waitFor(() => {
        expect(
          screen.getByLabelText(locale.startsWith('ru') ? 'Ключ API' : 'API key', {
            selector: '#key',
          })
        ).toHaveValue('');
        expect(
          screen.getByLabelText(locale.startsWith('ru') ? 'Ключ API' : 'API key', {
            selector: '#key',
          })
        ).toHaveAttribute(
          'placeholder',
          locale.startsWith('ru')
            ? 'Ключ задан; оставьте поле пустым, чтобы сохранить его.'
            : 'Key is set; leave blank to keep it.'
        );
      });
      fireEvent.click(screen.getByRole('button', { name: summary }));
      await waitFor(() => {
        expect(container.querySelector('#reserve-key')).toHaveValue('');
        expect(container.querySelector('#reserve-key')).toHaveAttribute(
          'placeholder',
          locale.startsWith('ru')
            ? 'Ключ задан; оставьте поле пустым, чтобы сохранить его.'
            : 'Key is set; leave blank to keep it.'
        );
      });
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
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(explanation);
      expect(alert.textContent).not.toContain('auth_failed');
      expect(
        screen.getByRole('heading', {
          name: locale.startsWith('ru') ? 'Подключите модель' : 'Connect model access',
        })
      ).toBeInTheDocument();
    }
  );
  it('logs in to the server-authorized next handoff after onboarding is done', async () => {
    const next = 'https://lifemodel.local/private';
    window.history.replaceState({}, '', `/login?next=${encodeURIComponent(next)}`);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: `?next=${encodeURIComponent(next)}`, assign },
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ setupNeeded: false, loggedIn: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          redirectTo: 'https://lifemodel.local/_auth/handoff?code=opaque&next=%2Fprivate',
        }),
      });
    render(<App />);
    const field = await screen.findByLabelText('Password');
    fireEvent.change(field, { target: { value: 'correct' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://lifemodel.local/_auth/handoff?code=opaque&next=%2Fprivate'
      )
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      password: 'correct',
      next,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
          if (step === 'model') {
            expect(
              screen.getByText(
                language === 'ru'
                  ? 'Укажите обязательную основную модель. Здесь также можно настроить необязательную резервную модель.'
                  : 'Set the required primary model. You can also configure an optional reserve model here.'
              )
            ).toBeInTheDocument();
            await waitFor(() =>
              expect(
                screen.getByLabelText(language === 'ru' ? 'Ключ API' : 'API key', {
                  selector: '#key',
                })
              ).toHaveValue('')
            );
            fireEvent.click(
              screen.getByRole('button', {
                name:
                  language === 'ru'
                    ? 'Резервная модель (необязательно)'
                    : 'Reserve model (optional)',
              })
            );
            await waitFor(() => expect(container.querySelector('#reserve-key')).toHaveValue(''));
          }
          if (step === 'device') expect(screen.getByText(/SHA-256/)).toBeTruthy();
          if (step === 'done') {
            expect(fetchMock.mock.calls.some(([url]) => url === '/api/model')).toBe(false);
            expect(container.textContent).not.toContain(
              language === 'ru' ? 'Защищённое хранилище' : 'Secure storage'
            );
          }
        }
    }
  );
  it.each([
    ['en-US', 'Secure storage is unavailable.'],
    ['ru-RU', 'Защищённое хранилище недоступно.'],
  ] as const)(
    'shows a localized model-load error without leaving the model step (%s)',
    async (locale, explanation) => {
      Object.defineProperty(navigator, 'language', { configurable: true, value: locale });
      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/state'
          ? {
              ok: true,
              json: async () => ({
                setupNeeded: false,
                loggedIn: true,
                onboarding: { step: 'model', completedAt: null },
              }),
            }
          : { ok: false, json: async () => ({ error: 'storage_unavailable' }) }
      );
      render(<App />);
      const title = locale.startsWith('ru') ? 'Подключите модель' : 'Connect model access';
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent(explanation);
      expect(screen.getByRole('alert')).not.toHaveTextContent('storage_unavailable');
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model rejected the credentials.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('auth_failed');
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      locale.startsWith('ru')
        ? 'Модель отклонила учётные данные.'
        : 'The model rejected the credentials.'
    );
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
