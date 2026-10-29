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
  it('loads, edits and clears effort beside each model and sends it on save', async () => {
    await i18n.changeLanguage('en');
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    const slots = {
      primary: {
        kind: 'openai',
        baseUrl: 'https://primary.example/v1',
        model: 'primary',
        keySet: false,
        reasoningEffort: 'none',
      },
      reserve: {
        kind: 'openai',
        baseUrl: 'https://reserve.example/v1',
        model: 'reserve',
        keySet: false,
        reasoningEffort: 'high',
      },
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push({ url, body });
        const name = url.endsWith('primary') ? 'primary' : 'reserve';
        slots[name].reasoningEffort = body.reasoningEffort;
        return { ok: true, json: async () => ({ ok: true, slot: slots[name] }) };
      }
      return {
        ok: true,
        json: async () =>
          url === '/api/state'
            ? {
                setupNeeded: false,
                loggedIn: true,
                csrfToken: 'csrf',
                onboarding: { step: 'model', completedAt: null },
              }
            : url === '/api/model'
              ? slots
              : {},
      };
    });
    render(<App />);
    const primary = await screen.findByLabelText('Reasoning effort', {
      selector: '#reasoning-effort',
    });
    await waitFor(() => expect(primary).toHaveTextContent('none'));
    fireEvent.click(primary);
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high']) {
      expect(await screen.findByRole('option', { name: effort, exact: true })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('option', { name: 'minimal', exact: true }));
    fireEvent.submit(primary.closest('form')!);
    await waitFor(() => expect(writes[0]?.body.reasoningEffort).toBe('minimal'));
    await waitFor(() =>
      expect(primary.closest('form')!.querySelector('button:not([type=button])')).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reserve model (optional)' }));
    const reserve = await screen.findByLabelText('Reasoning effort', {
      selector: '#reserve-reasoning-effort',
    });
    expect(reserve).toHaveTextContent('high');
    fireEvent.click(reserve);
    fireEvent.click(await screen.findByRole('option', { name: 'Default (blank)' }));
    fireEvent.submit(reserve.closest('form')!);
    await waitFor(() =>
      expect(writes[1]).toMatchObject({ url: '/api/model/reserve', body: { reasoningEffort: '' } })
    );
  });
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
    fireEvent.click(container.querySelector('#kind')!);
    expect(await screen.findByRole('option', { name: 'Ollama' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Ollama' }));
    expect(container.querySelector('#kind')?.textContent).toContain('Ollama');
    fireEvent.click(screen.getByRole('button', { name: 'Reserve model (optional)' }));
    const combos = container.querySelectorAll('#kind, #reserve-kind');
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
                    key: 'SECRET-API-KEY',
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
          await screen.findByRole('heading', {
            name:
              step === 'done'
                ? language === 'ru'
                  ? 'Настройки'
                  : 'Settings'
                : step === 'welcome'
                  ? language === 'ru'
                    ? 'Добро пожаловать в lifemodel'
                    : 'Welcome to lifemodel'
                  : step === 'model'
                    ? language === 'ru'
                      ? 'Подключите модель'
                      : 'Connect model access'
                    : language === 'ru'
                      ? 'Настройте это устройство'
                      : 'Set up this device',
          });
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
            expect(fetchMock.mock.calls.some(([url]) => url === '/api/model')).toBe(true);
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
  it('renders completed settings and keeps a failed model edit unsaved', async () => {
    const stored = {
      kind: 'openai',
      baseUrl: 'https://saved.example',
      model: 'saved-model',
      keySet: true,
    };
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/model-capture') return { ok: true, json: async () => ({ until: null }) };
      if (url === '/api/state')
        return {
          ok: true,
          json: async () => ({
            setupNeeded: false,
            loggedIn: true,
            csrfToken: 'csrf',
            onboarding: { step: 'done', completedAt: 'now' },
            instanceName: 'lifemodel',
            caFingerprint: 'fingerprint',
          }),
        };
      if (url === '/api/model')
        return {
          ok: true,
          json: async () => ({ primary: { ...stored, key: 'SECRET-API-KEY' }, reserve: null }),
        };
      if (url === '/api/model/primary' && options?.method === 'PUT')
        return { ok: false, status: 502, json: async () => ({ error: 'auth_failed' }) };
      return { ok: true, json: async () => ({}) };
    });
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Base URL', { selector: '#url' })).toHaveValue(
      stored.baseUrl
    );
    expect(screen.getByLabelText('API key', { selector: '#key' })).toHaveValue('');
    expect(screen.getByText('fingerprint')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the chat', selector: 'a' })).toHaveAttribute(
      'href',
      'https://boot-lifemodel.local/login?next=https%3A%2F%2Flifemodel.local%2F'
    );
    fireEvent.change(screen.getByLabelText('Base URL', { selector: '#url' }), {
      target: { value: 'https://changed.example' },
    });
    fireEvent.submit(screen.getByLabelText('Base URL', { selector: '#url' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model rejected the credentials.'
    );
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/model-capture') return { ok: true, json: async () => ({ until: null }) };
      if (url === '/api/state')
        return {
          ok: true,
          json: async () => ({
            setupNeeded: false,
            loggedIn: true,
            csrfToken: 'csrf',
            onboarding: { step: 'done', completedAt: 'now' },
          }),
        };
      if (url === '/api/model')
        return { ok: false, json: async () => ({ error: 'storage_unavailable' }) };
      if (url === '/api/password') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new secure password' },
    });
    fireEvent.submit(screen.getByLabelText('New password').closest('form')!);
    expect(
      await screen.findByText('Password changed. Other sessions have been logged out.')
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Secure storage is unavailable.');
    expect(
      screen.getByText('Password changed. Other sessions have been logged out.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL', { selector: '#url' })).toHaveValue(
      'https://changed.example'
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) => url === '/api/model/primary' && options?.method === 'PUT'
      )
    ).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('changes the password through the settings form and reports a wrong current password', async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/state')
        return {
          ok: true,
          json: async () => ({
            setupNeeded: false,
            loggedIn: true,
            csrfToken: 'csrf',
            onboarding: { step: 'done', completedAt: 'now' },
          }),
        };
      if (url === '/api/model')
        return { ok: true, json: async () => ({ primary: null, reserve: null }) };
      if (url === '/api/password')
        return String(options?.body).includes('wrong')
          ? { ok: false, status: 401 }
          : { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a new secure password' },
    });
    fireEvent.submit(screen.getByLabelText('New password').closest('form')!);
    // The settings page also carries the quiet model-status live region.
    expect(await screen.findByText('The current password is incorrect.')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) => url === '/api/password' && options?.method === 'POST'
      )
    ).toBe(true);
  });

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
  it('clears every reserve candidate field, including the key, after removal', async () => {
    let removed = false;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/state')
        return {
          ok: true,
          json: async () => ({
            setupNeeded: false,
            loggedIn: true,
            csrfToken: 'csrf',
            onboarding: { step: 'done', completedAt: 'now' },
          }),
        };
      if (url === '/api/model')
        return {
          ok: true,
          json: async () => ({
            primary: null,
            reserve: removed
              ? null
              : { kind: 'openai', baseUrl: 'https://saved.example', model: 'saved', keySet: true },
          }),
        };
      if (url === '/api/model/reserve' && options?.method === 'DELETE') {
        removed = true;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Reserve model (optional)' }));
    fireEvent.change(screen.getByLabelText('Base URL', { selector: '#reserve-url' }), {
      target: { value: 'https://typed.example' },
    });
    fireEvent.change(screen.getByLabelText('Model name', { selector: '#reserve-model' }), {
      target: { value: 'typed-model' },
    });
    fireEvent.change(screen.getByLabelText('API key', { selector: '#reserve-key' }), {
      target: { value: 'candidate-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove reserve model' }));
    await waitFor(() =>
      expect(screen.getByLabelText('API key', { selector: '#reserve-key' })).toHaveValue('')
    );
    expect(screen.getByLabelText('Base URL', { selector: '#reserve-url' })).toHaveValue('');
    expect(screen.getByLabelText('Model name', { selector: '#reserve-model' })).toHaveValue('');
  });

  it.each([
    ['en-US', 'Additional headers', 'Saved headers'],
    ['ru-RU', 'Дополнительные заголовки', 'Сохранённые заголовки'],
  ] as const)(
    'shows the additional headers section in %s, masked and axe clean',
    async (locale, section, stored) => {
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
                    headerNames: ['x-opencode-session'],
                  },
                  reserve: null,
                }),
              }
            : { ok: true, json: async () => ({}) }
      );
      const { container } = render(<App />);
      const toggle = await screen.findByRole('button', { name: section });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const list = screen.getByRole('list', { name: stored });
      expect(list.textContent).toContain('x-opencode-session');
      expect(list.textContent).toContain('\u2022\u2022\u2022\u2022\u2022\u2022');
      expect(list.textContent).not.toContain('{session}');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const hint = screen.getByText(/\{session\}/);
      expect(hint.textContent).toContain('{session}');
      expect(
        screen.getByRole('button', {
          name: locale.startsWith('ru') ? 'Добавить заголовок' : 'Add header',
        })
      ).toBeTruthy();
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it('sends the rows typed, keeps stored headers when untouched and clears them on removal', async () => {
    const puts: string[] = [];
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/state')
        return {
          ok: true,
          json: async () => ({
            setupNeeded: false,
            loggedIn: true,
            csrfToken: 'csrf',
            onboarding: { step: 'done', completedAt: 'now' },
          }),
        };
      if (url === '/api/model')
        return {
          ok: true,
          json: async () => ({
            primary: {
              kind: 'openai',
              baseUrl: 'https://primary.example',
              model: 'p',
              keySet: true,
              headerNames: ['x-opencode-session'],
            },
            reserve: null,
          }),
        };
      if (url === '/api/model/primary' && options?.method === 'PUT') {
        puts.push(String(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });
    const submit = () =>
      fireEvent.submit(
        screen.getByLabelText('Model name', { selector: '#model' }).closest('form')!
      );
    // Untouched: no header list is sent, so the stored one is kept.
    await act(async () => {
      submit();
    });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(JSON.parse(puts[0]!)).toEqual({
      kind: 'openai',
      baseUrl: 'https://primary.example',
      model: 'p',
      reasoningEffort: '',
    });
    // A row typed by the owner is sent as is, `{session}` included.
    fireEvent.click(screen.getByRole('button', { name: 'Additional headers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header name 1'), {
      target: { value: 'x-opencode-session' },
    });
    fireEvent.change(screen.getByLabelText('Header value 1'), {
      target: { value: '{session}' },
    });
    await act(async () => {
      submit();
    });
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(JSON.parse(puts[1]!).headers).toEqual([
      { name: 'x-opencode-session', value: '{session}' },
    ]);
    // The stored headers can be cleared explicitly, and only explicitly.
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved headers' }));
    await act(async () => {
      submit();
    });
    await waitFor(() => expect(puts).toHaveLength(3));
    expect(JSON.parse(puts[2]!).headers).toEqual([]);
    // A row can be added and removed again.
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    expect(screen.getByLabelText('Header name 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove header 1' }));
    expect(screen.queryByLabelText('Header name 1')).toBeNull();
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
    expect(
      await screen.findByRole('link', { name: 'Open the chat', selector: 'a' })
    ).toHaveAttribute(
      'href',
      'https://boot-lifemodel.local/login?next=https%3A%2F%2Flifemodel.local%2F'
    );
  });
});
