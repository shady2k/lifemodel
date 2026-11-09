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

/** One page answer, as `GET /api/logs` sends it (ADR-016 §4). */
function page(
  rows: ReturnType<typeof records>,
  fields: { offset?: number; limit?: number; count?: number; incomplete?: boolean } = {}
) {
  return {
    state: 'ok',
    records: rows,
    offset: fields.offset ?? 0,
    limit: fields.limit ?? rows.length,
    count: fields.count ?? rows.length,
    incomplete: fields.incomplete ?? false,
  };
}

/** Answers each log request through `answers` and returns the requested URLs. */
function stubAnswers(answers: (url: string) => unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const body = url === '/api/logs/modules' ? { state: 'ok', modules: [] } : answers(url);
      return { ok: true, json: async () => body };
    })
  );
  return urls;
}

function stubFetch(answer: unknown): void {
  stubAnswers(() => answer);
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
    stubFetch(page(records(count)));
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
    stubFetch(page(records(1)));
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
          json: async () => (url === '/api/logs/modules' ? { state: 'ok', modules: [] } : page([])),
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

describe('logs page paging', () => {
  it('reads the next page at its offset, expecting the first page count', async () => {
    const urls = stubAnswers((url) =>
      url.includes('offset=2')
        ? page([{ time: '2026-11-08T10:00:02.000Z', message: 'line 2', fields: {} }], {
            offset: 2,
            limit: 2,
            count: 3,
          })
        : page(records(2), { count: 3 })
    );
    render(<Logs />);
    await screen.findByText('line 0');
    fireEvent.click(await screen.findByRole('button', { name: 'Show older records' }));
    await screen.findByText('line 2');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    const logCalls = urls.filter((url) => url.startsWith('/api/logs?'));
    expect(logCalls).toHaveLength(2);
    expect(logCalls[0]).not.toContain('offset=');
    expect(logCalls[1]).toContain('offset=2');
    expect(logCalls[1]).toContain('limit=2');
    expect(logCalls[1]).toContain('expected=3');
    // The window is read to its end: no further page is offered.
    expect(screen.queryByRole('button', { name: 'Show older records' })).toBeNull();
  });

  it('says records arrived while scrolling and refreshes from the first page', async () => {
    const urls = stubAnswers((url) =>
      url.includes('offset=2')
        ? page([{ time: '2026-11-08T10:00:02.000Z', message: 'line 2', fields: {} }], {
            offset: 2,
            limit: 2,
            count: 4,
            incomplete: true,
          })
        : page(records(2), { count: 3 })
    );
    render(<Logs />);
    await screen.findByText('line 0');
    fireEvent.click(await screen.findByRole('button', { name: 'Show older records' }));
    expect(
      await screen.findByText(
        'Incomplete: records arrived while you were scrolling. Refresh from the first page to read the window again.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh from the first page' }));
    await waitFor(() => {
      expect(screen.queryByText(/records arrived while you were scrolling/)).toBeNull();
    });
    const logCalls = urls.filter((url) => url.startsWith('/api/logs?'));
    expect(logCalls.at(-1)).not.toContain('offset=');
    expect(logCalls.at(-1)).not.toContain('expected=');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('states that byte-identical records cannot be told apart', async () => {
    stubFetch(page(records(2)));
    render(<Logs />);
    expect(await screen.findByText(/byte-identical .* cannot be told apart/u)).toBeInTheDocument();
  });
});
