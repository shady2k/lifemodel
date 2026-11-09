// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../web/loader/src/i18n';
import '../../web/loader/src/logs-i18n';
import { Logs } from '../../web/loader/src/Logs';

function records(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(Date.UTC(2026, 10, 8, 10, 0, index)).toISOString(),
    message: `line ${String(index)}`,
    fields: { module: 'core', level: 'info' },
  }));
}

function stubFetch(answer: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url === '/api/logs/modules' ? { state: 'ok', modules: [] } : answer;
      return { ok: true, json: async () => body };
    })
  );
}

beforeEach(async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia = ((media: string) => ({
    get matches() {
      return false;
    },
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('logs page record count', () => {
  it.each([
    ['en', 1, '1 record'],
    ['en', 2, '2 records'],
    ['en', 5, '5 records'],
    ['en', 21, '21 records'],
    ['ru', 1, '1 запись'],
    ['ru', 2, '2 записи'],
    ['ru', 5, '5 записей'],
    ['ru', 21, '21 запись'],
  ] as const)('counts in %s above %i records', async (language, count, expected) => {
    await i18n.changeLanguage(language);
    stubFetch({ state: 'ok', records: records(count) });
    const { container } = render(<Logs />);
    const list = await screen.findByRole('list');
    expect(list.previousElementSibling?.textContent).toBe(expected);
    expect(container.textContent).not.toContain('{{');
  });

  it.each([
    ['en', 'The log store did not answer. Reason: the request timed out.'],
    ['ru', 'Хранилище логов не ответило. Причина: истекло время ожидания.'],
  ] as const)('fills the unavailable reason in %s', async (language, expected) => {
    await i18n.changeLanguage(language);
    stubFetch({ state: 'unavailable', reason: 'timeout' });
    const { container } = render(<Logs />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(container.textContent).not.toContain('{{');
  });
});

describe('logs page filter row', () => {
  it.each([
    ['en', ['Level', 'Conversation', 'Text']],
    ['ru', ['Уровень', 'Беседа', 'Текст']],
  ] as const)('offers level, conversation and text in %s', async (language, labels) => {
    await i18n.changeLanguage(language);
    stubFetch({ state: 'ok', records: records(1) });
    render(<Logs />);
    await screen.findByRole('list');
    for (const label of labels) expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('sends the chosen level, conversation and text with the search', async () => {
    await i18n.changeLanguage('en');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          json: async () =>
            url === '/api/logs/modules' ? { state: 'ok', modules: [] } : { state: 'ok', records: [] },
        };
      })
    );
    const { container } = render(<Logs />);
    await screen.findByText('No records in this range.');
    fireEvent.click(container.querySelector('#logs-level')!);
    fireEvent.click(await screen.findByRole('option', { name: 'error' }));
    fireEvent.change(container.querySelector('#logs-conversation')!, {
      target: { value: 'conv_1' },
    });
    fireEvent.change(container.querySelector('#logs-text')!, { target: { value: 'needle' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => {
      expect(calls.filter((url) => url.startsWith('/api/logs?'))).toHaveLength(2);
    });
    const last = calls.filter((url) => url.startsWith('/api/logs?')).at(-1) ?? '';
    expect(last).toContain('level=error');
    expect(last).toContain('conversation_id=conv_1');
    expect(last).toContain('text=needle');
  });
});
