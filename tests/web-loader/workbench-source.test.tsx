// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../web/loader/src/i18n';
import { WorkbenchSourceSettings } from '../../web/loader/src/WorkbenchSourceSettings';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('workbench source settings UI', () => {
  it.each([
    ['en', 'Workbench image source', 'Import failed', 'Last attempt'],
    ['ru', 'Источник образа рабочего окружения', 'Импорт не удался', 'Последняя попытка'],
  ] as const)(
    'shows localized status and last attempt in %s',
    async (language, title, status, last) => {
      await i18n.changeLanguage(language);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          ok: true,
          json: async () =>
            url.endsWith('status')
              ? {
                  state: 'failed',
                  reason: 'unauthorized',
                  lastAttemptAt: 1000,
                  pinnedDigest: 'sha256:abc',
                }
              : {
                  registry: 'https://registry.example',
                  repository: 'team/workbench',
                  username: 'reader',
                  hasPassword: true,
                },
        }))
      );
      render(<WorkbenchSourceSettings csrfToken="csrf" />);
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
      expect(await screen.findByText(new RegExp(status))).toBeInTheDocument();
      expect(screen.getByText(new RegExp(last))).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://registry.example')).toBeInTheDocument();
    }
  );
  it('never shows a secret and omits a blank password on save; explicit clear sends empty', async () => {
    await i18n.changeLanguage('en');
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => ({
      ok: true,
      json: async () =>
        options?.method === 'PUT'
          ? {
              ok: true,
              source: {
                registry: 'https://registry.example',
                repository: 'team/workbench',
                username: 'reader',
                hasPassword: true,
              },
            }
          : url.endsWith('status')
            ? { state: 'ready', lastAttemptAt: 1000 }
            : {
                registry: 'https://registry.example',
                repository: 'team/workbench',
                username: 'reader',
                hasPassword: true,
              },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchSourceSettings csrfToken="csrf" />);
    const password = await screen.findByLabelText('Registry password or token');
    await screen.findByDisplayValue('reader');
    expect(password).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Save source and retry' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true)
    );
    const save = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(JSON.parse(String(save[1]?.body))).not.toHaveProperty('password');
    expect(save[1]?.headers).toMatchObject({ 'x-csrf-token': 'csrf' });
    fireEvent.click(screen.getByLabelText('Clear saved pull credential'));
    fireEvent.click(screen.getByRole('button', { name: 'Save source and retry' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(2)
    );
    const last = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT').at(-1)!;
    expect(JSON.parse(String(last[1]?.body))).toMatchObject({ password: '', username: '' });
  });
  it.each(['pending', 'importing', 'ready', 'failed'])('renders %s state', async (state) => {
    await i18n.changeLanguage('en');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.endsWith('status')
            ? { state, lastAttemptAt: null }
            : {
                registry: 'https://registry.example',
                repository: 'team/workbench',
                hasPassword: false,
              },
      }))
    );
    render(<WorkbenchSourceSettings csrfToken="csrf" />);
    expect(await screen.findByTestId('workbench-status')).toHaveAttribute('data-state', state);
  });
});
