// @vitest-environment jsdom
/**
 * The retention setting on the logs page (ADR-016 §5, check L08): the two
 * numbers, the largest bound the volume can reach, a refusal with both
 * numbers, and a change that says it is pending until the store runs it.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../web/loader/src/i18n';
import '../../web/loader/src/logs-i18n';
import {
  LOGS_SETTINGS_POLL_MS,
  LogsSettings,
  type LogsSettingsAnswer,
} from '../../web/loader/src/LogsSettings';

const VOLUME = 3 * 1024 * 1024 * 1024;
const LARGEST = 1_610_612_736;

function status(over: Partial<LogsSettingsAnswer> = {}): LogsSettingsAnswer {
  return {
    state: 'ok',
    days: 14,
    maxBytes: 1_610_612_736,
    desiredRevision: '2-abcdef012345',
    appliedRevision: null,
    appliedAt: null,
    applied: true,
    pending: null,
    limits: { volumeBytes: VOLUME, evictorThresholdBytes: 1_610_612_736, largestMaxBytes: LARGEST },
    fitsVolume: true,
    ...over,
  };
}

interface Stub {
  puts: string[];
  gets: string[];
  /** Answer one request; the first entry of `answers` answers each call in turn. */
  answers: Record<'state' | 'settings', unknown[]>;
}

function stubFetch(stub: Stub): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/state') return { ok: true, json: async () => ({ csrfToken: 'token' }) };
      if (url !== '/api/logs/settings') throw new Error(`unexpected ${url}`);
      if (init?.method === 'PUT') {
        stub.puts.push(String(init.body));
        const next = stub.answers.settings.shift() ?? status();
        return { ok: true, json: async () => next };
      }
      stub.gets.push(url);
      const next = stub.answers.settings.shift() ?? status();
      return { ok: true, json: async () => next };
    })
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the retention card', () => {
  it('shows the current setting and the largest bound the volume can reach', async () => {
    const stub = { puts: [], gets: [], answers: { state: [], settings: [status()] } };
    stubFetch(stub);
    render(<LogsSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText('Days kept')).toHaveValue(14);
    });
    expect(screen.getByLabelText('Size limit (MiB)')).toHaveValue(1536);
    expect(screen.getByText('The largest bound this volume can reach is 1,536 MiB.')).toBeInTheDocument();
    expect(screen.getByText(/Applied: the store runs 14 days with a 1,536 MiB limit\./)).toBeInTheDocument();
    // Raising the volume is an installation step, and the page says so.
    expect(screen.getByText(/Raising the volume is an installation step/)).toBeInTheDocument();
  });

  it('saves the two numbers and says the change is pending, then applied', async () => {
    const stub = {
      puts: [],
      gets: [],
      answers: {
        state: [],
        settings: [
          status(),
          // the PUT's answer: the store is still being replaced
          status({ days: 7, maxBytes: 1_073_741_824, applied: false, pending: 'mismatch' }),
          // the poll's answer: proved
          status({ days: 7, maxBytes: 1_073_741_824, applied: true }),
        ],
      },
    };
    stubFetch(stub);
    render(<LogsSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText('Days kept')).toHaveValue(14);
    });
    fireEvent.change(screen.getByLabelText('Days kept'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Size limit (MiB)'), { target: { value: '1024' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save retention' }).closest('form')!);
    await waitFor(() => {
      expect(stub.puts).toEqual([JSON.stringify({ days: 7, maxBytes: 1_073_741_824 })]);
    });
    expect(
      await screen.findByText('Waiting for the store to run the new values: it still answers the previous values')
    ).toBeInTheDocument();
    // One poll, two seconds later, proves it.
    await new Promise((resolve) => setTimeout(resolve, LOGS_SETTINGS_POLL_MS + 300));
    expect(
      await screen.findByText('Applied: the store runs 7 days with a 1,024 MiB limit.')
    ).toBeInTheDocument();
  });

  it('refuses a bound above the largest one with both numbers', async () => {
    const stub = {
      puts: [],
      gets: [],
      answers: {
        state: [],
        settings: [
          status(),
          {
            state: 'refused',
            reason: 'above_volume',
            maxBytes: 2 * 1024 * 1024 * 1024,
            largestMaxBytes: LARGEST,
            volumeBytes: VOLUME,
            evictorThresholdBytes: 1_610_612_736,
          },
        ],
      },
    };
    stubFetch(stub);
    render(<LogsSettings />);
    await waitFor(() => {
      expect(screen.getByLabelText('Size limit (MiB)')).toHaveValue(1536);
    });
    fireEvent.change(screen.getByLabelText('Size limit (MiB)'), { target: { value: '2048' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save retention' }).closest('form')!);
    expect(
      await screen.findByText(/Refused: 2,048 MiB is above 1,536 MiB, the largest bound this volume can reach\./)
    ).toBeInTheDocument();
    expect(stub.puts).toEqual([JSON.stringify({ days: 14, maxBytes: 2 * 1024 * 1024 * 1024 })]);
  });

  it('says a saved bound no longer fits this volume', async () => {
    const stub = {
      puts: [],
      gets: [],
      answers: {
        state: [],
        settings: [
          status({
            maxBytes: 2 * 1024 * 1024 * 1024,
            fitsVolume: false,
          }),
        ],
      },
    };
    stubFetch(stub);
    render(<LogsSettings />);
    expect(
      await screen.findByText(
        'retention does not fit this volume: the saved bound 2,048 MiB is above 1,536 MiB'
      )
    ).toBeInTheDocument();
  });

  it('says the change is pending with the reason, or that the setting could not be read', async () => {
    const stub = {
      puts: [],
      gets: [],
      answers: {
        state: [],
        settings: [
          status({ applied: false, pending: 'forbidden' }),
        ],
      },
    };
    stubFetch(stub);
    const first = render(<LogsSettings />);
    expect(
      await screen.findByText(
        'Waiting for the store to run the new values: the loader may not write its settings'
      )
    ).toBeInTheDocument();
    first.unmount();
    stub.answers.settings = [{ state: 'unavailable', reason: 'unreachable' }];
    render(<LogsSettings />);
    expect(
      await screen.findByText('The retention setting could not be read. Reason: the store could not be reached.')
    ).toBeInTheDocument();
  });
});
