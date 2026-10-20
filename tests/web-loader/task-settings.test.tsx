// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import '@testing-library/jest-dom/vitest';
import 'jest-axe/extend-expect';
import i18n from '../../web/loader/src/i18n';
import App from '../../web/loader/src/App';
import type { SettingsSectionPayload } from '../../loader/src/settings/registry.js';

const concurrencyDeclaration = {
  key: 'tasks.concurrency',
  section: 'tasks',
  label: { en: 'Concurrent tasks', ru: 'Параллельные задачи' },
  description: {
    en: 'How many tasks may run at the same time.',
    ru: 'Сколько задач может выполняться одновременно.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 2,
  min: 1,
  max: 8,
  unit: { en: 'tasks', ru: 'задачи' },
  authority: 'owner',
  apply: 'nextAdmission',
};
const stopGraceDeclaration = {
  key: 'tasks.stopGraceSeconds',
  section: 'tasks',
  label: { en: 'Soft-stop grace', ru: 'Время на завершение' },
  description: { en: 'Seconds a wrapping task keeps.', ru: 'Сколько секунд задача завершается.' },
  control: 'number',
  dataClass: 'publicConfig',
  default: 300,
  min: 0,
  max: 3600,
  unit: { en: 'seconds', ru: 'секунды' },
  authority: 'owner',
  apply: 'immediate',
};

const warningLeadDaysDeclaration = {
  key: 'storage.warningLeadDays',
  section: 'tasks',
  label: { en: 'Deletion warning lead', ru: 'Предупреждение перед удалением' },
  description: {
    en: 'How many days before stored output is deleted the owner is warned first.',
    ru: 'За сколько дней до удаления сохранённых результатов владельца предупреждают заранее.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 7,
  min: 1,
  max: 30,
  unit: { en: 'days', ru: 'дни' },
  authority: 'owner',
  apply: 'immediate',
};

const ceilingDeclaration = {
  key: 'storage.ceilingBytes',
  section: 'tasks',
  label: { en: 'Storage ceiling', ru: 'Потолок хранилища' },
  description: {
    en: 'Fixed at 20 GB (20,000,000,000 bytes) of sealed task output. It cannot be changed.',
    ru: 'Фиксирован: 20 ГБ (20 000 000 000 байт) запечатанных результатов задач. Его нельзя изменить.',
  },
  control: 'number',
  dataClass: 'publicConfig',
  default: 20000000000,
  min: 20000000000,
  max: 20000000000,
  unit: { en: 'bytes', ru: 'байты' },
  format: 'bytes',
  readOnly: true,
  authority: 'owner',
  apply: 'immediate',
};

let fetchMock: ReturnType<typeof vi.fn>;
function sectionPayload(overrides: Partial<SettingsSectionPayload> = {}): SettingsSectionPayload {
  return {
    declarations: [concurrencyDeclaration],
    values: { 'tasks.concurrency': 2 },
    revision: 0,
    problems: [],
    projection: { state: 'unattempted' },
    ...overrides,
  };
}
function mockDonePage(settings: SettingsSectionPayload, puts?: Array<Record<string, unknown>>) {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
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
        json: async () => ({
          primary: { kind: 'openai', baseUrl: 'https://m.example', model: 'm', keySet: true },
          reserve: null,
        }),
      };
    if (url === '/api/model-status') return { ok: true, json: async () => ({}) };
    if (url === '/api/settings' && (options?.method ?? 'GET') === 'GET')
      return { ok: true, json: async () => settings };
    if (url.startsWith('/api/settings/') && options?.method === 'PUT') {
      puts?.push(JSON.parse(String(options.body)) as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true, value: 4, revision: 1 }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia = (media) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const enabledDeclaration = {
  key: 'tasks.enabled',
  section: 'tasks',
  label: { en: 'Enabled', ru: 'Включено' },
  description: { en: 'Whether tasks run.', ru: 'Запускаются ли задачи.' },
  control: 'toggle',
  dataClass: 'publicConfig',
  default: true,
  authority: 'owner',
  apply: 'nextAdmission',
};

describe('loader settings section', () => {
  it('renders the concurrency control from the declaration', async () => {
    await i18n.changeLanguage('en');
    mockDonePage(sectionPayload());
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Platform settings' })).toBeInTheDocument();
    const input = await screen.findByLabelText('Concurrent tasks', { selector: 'input' });
    expect(input).toHaveValue(2);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '8');
    expect(screen.getByText('How many tasks may run at the same time.')).toBeInTheDocument();
    expect(screen.getByText('tasks')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('saves a typed value through the CSRF-protected endpoint and shows the stored value', async () => {
    await i18n.changeLanguage('en');
    const puts: Array<Record<string, unknown>> = [];
    const served = sectionPayload();
    mockDonePage(served, puts);
    render(<App />);
    const input = await screen.findByLabelText('Concurrent tasks', { selector: 'input' });
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/settings/tasks.concurrency')).toBe(
        true
      )
    );
    const put = fetchMock.mock.calls.find(([url]) => url === '/api/settings/tasks.concurrency')!;
    expect(put[1].method).toBe('PUT');
    expect(put[1].headers['x-csrf-token']).toBe('csrf');
    expect(JSON.parse(String(put[1].body))).toEqual({ value: 4 });
  });

  it('renders a second declaration with no UI change', async () => {
    await i18n.changeLanguage('en');
    mockDonePage(
      sectionPayload({
        declarations: [concurrencyDeclaration, stopGraceDeclaration],
        values: { 'tasks.concurrency': 2, 'tasks.stopGraceSeconds': 300 },
      })
    );
    const { container } = render(<App />);
    expect(
      await screen.findByLabelText('Concurrent tasks', { selector: 'input' })
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('Soft-stop grace', { selector: 'input' })).toHaveValue(300);
    expect(container.textContent).not.toContain('tasks.concurrency');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders a second declaration that is a toggle and saves its boolean on click', async () => {
    await i18n.changeLanguage('en');
    const puts: Array<Record<string, unknown>> = [];
    mockDonePage(
      sectionPayload({
        declarations: [concurrencyDeclaration, enabledDeclaration],
        values: { 'tasks.concurrency': 2, 'tasks.enabled': true },
      }),
      puts
    );
    const { container } = render(<App />);
    const form = await screen.findByRole('form', { name: 'Enabled' });
    const toggle = within(form).getByRole('button');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('On');
    expect(screen.getByText('Whether tasks run.')).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(puts).toEqual([{ value: false }]));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows file problems and a failed projection in the section', async () => {
    await i18n.changeLanguage('en');
    mockDonePage(
      sectionPayload({
        problems: [
          {
            code: 'corrupt',
            reason: 'the settings file is not a settings document this loader wrote',
          },
        ],
        projection: { state: 'failed', reason: 'the API refused the write' },
      })
    );
    render(<App />);
    expect(
      await screen.findByText(
        'The settings file had problems; the declared defaults are in use until they are fixed.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('the settings file is not a settings document this loader wrote')
    ).toBeInTheDocument();
    expect(screen.getByText(/could not be published to the instance/)).toBeInTheDocument();
  });

  it('localizes a bounds refusal from the declared limits', async () => {
    await i18n.changeLanguage('en');
    let attempts = 0;
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
      if (url === '/api/model-status') return { ok: true, json: async () => ({}) };
      if (url === '/api/settings') return { ok: true, json: async () => sectionPayload() };
      if (url === '/api/settings/tasks.concurrency' && options?.method === 'PUT')
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: 'invalid_value',
            reasonCode: 'above_maximum',
            reason: 'value 9 is above the declared maximum 8',
            limit: 8,
          }),
        };
      attempts += 1;
      return { ok: true, json: async () => ({}) };
    });
    render(<App />);
    const input = await screen.findByLabelText('Concurrent tasks', { selector: 'input' });
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The largest allowed value is 8.');
    expect(attempts).toBe(0);
  });

  it('renders a number unit localized from the declaration', async () => {
    await i18n.changeLanguage('en');
    mockDonePage(
      sectionPayload({
        declarations: [concurrencyDeclaration, stopGraceDeclaration],
        values: { 'tasks.concurrency': 2, 'tasks.stopGraceSeconds': 300 },
      })
    );
    render(<App />);
    expect(await screen.findByText('tasks')).toBeInTheDocument();
    expect(await screen.findByText('seconds')).toBeInTheDocument();
  });

  it('renders the localized units in Russian', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'ru-RU' });
    await i18n.changeLanguage('ru');
    mockDonePage(
      sectionPayload({
        declarations: [concurrencyDeclaration, stopGraceDeclaration],
        values: { 'tasks.concurrency': 2, 'tasks.stopGraceSeconds': 300 },
      })
    );
    render(<App />);
    expect(await screen.findByText('задачи')).toBeInTheDocument();
    expect(await screen.findByText('секунды')).toBeInTheDocument();
  });

  it('renders a read-only setting as fixed text with no input and a decimal bytes value', async () => {
    await i18n.changeLanguage('en');
    mockDonePage(
      sectionPayload({
        declarations: [ceilingDeclaration],
        values: { 'storage.ceilingBytes': 20000000000 },
      })
    );
    const { container } = render(<App />);
    expect(await screen.findByText('20 GB')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Storage ceiling', { selector: 'input' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the read-only fixed value in Russian the same decimal way', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'ru-RU' });
    await i18n.changeLanguage('ru');
    mockDonePage(
      sectionPayload({
        declarations: [ceilingDeclaration],
        values: { 'storage.ceilingBytes': 20000000000 },
      })
    );
    render(<App />);
    expect(await screen.findByText('Потолок хранилища')).toBeInTheDocument();
    expect(await screen.findByText('20 GB')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Потолок хранилища', { selector: 'input' })
    ).not.toBeInTheDocument();
  });

  it('shows the days unit of the warning lead', async () => {
    await i18n.changeLanguage('en');
    mockDonePage(
      sectionPayload({
        declarations: [warningLeadDaysDeclaration],
        values: { 'storage.warningLeadDays': 7 },
      })
    );
    const { container } = render(<App />);
    const input = await screen.findByLabelText('Deletion warning lead', { selector: 'input' });
    expect(input).toHaveValue(7);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '30');
    expect(screen.getByText('days')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the declaration labels in Russian', async () => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'ru-RU' });
    await i18n.changeLanguage('ru');
    mockDonePage(sectionPayload());
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Настройки платформы' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Задачи' })).toBeInTheDocument();
    expect(screen.getByLabelText('Параллельные задачи', { selector: 'input' })).toHaveValue(2);
  });
});
