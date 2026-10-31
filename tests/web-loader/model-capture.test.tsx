// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import i18n from '../../web/loader/src/i18n';
import { ModelCaptureSettings } from '../../web/loader/src/ModelCaptureSettings';

beforeEach(async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('model capture settings control', () => {
  it.each([
    [
      'en',
      'Until disabled',
      'Capture is off.',
      'Capture duration',
      'Start capture',
      'Stop capture',
      'Chat/session ID (optional)',
      'Capture is on with no end until you disable it. It stores personal conversation text on this machine.',
    ],
    [
      'ru',
      'До отключения',
      'Запись выключена.',
      'Длительность записи',
      'Начать запись',
      'Остановить запись',
      'ID чата/сессии (необязательно)',
      'Запись включена без ограничения срока, пока вы её не отключите. Личный текст переписки хранится на этой машине.',
    ],
  ])(
    'chooses until disabled, warns, reloads and disables it (%s)',
    async (language, choice, off, durationLabel, start, stop, sessionLabel, warning) => {
      await i18n.changeLanguage(language);
      let setting: Record<string, unknown> = { until: null };
      const writes: unknown[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            writes.push(body);
            setting =
              body.mode === 'until-disabled'
                ? { until: 'until-disabled', session: body.session }
                : { until: null };
          }
          return { ok: true, json: async () => setting };
        })
      );
      const first = render(<ModelCaptureSettings csrfToken="csrf" />);
      await screen.findByText(off);
      fireEvent.click(screen.getByLabelText(durationLabel));
      fireEvent.click(await screen.findByRole('option', { name: choice, exact: true }));
      fireEvent.change(screen.getByLabelText(sessionLabel), { target: { value: 'chat-1' } });
      fireEvent.click(screen.getByRole('button', { name: start }));
      expect(await screen.findByText(warning)).toBeInTheDocument();
      expect(writes).toEqual([{ mode: 'until-disabled', session: 'chat-1' }]);
      first.unmount();
      const reloaded = render(<ModelCaptureSettings csrfToken="csrf" />);
      expect(await screen.findByText(warning)).toBeInTheDocument();
      expect(screen.getByLabelText(durationLabel)).toHaveTextContent(choice);
      expect(screen.getByLabelText(sessionLabel)).toHaveValue('chat-1');
      expect(await axe(reloaded.container)).toHaveNoViolations();
      fireEvent.click(screen.getByRole('button', { name: stop }));
      expect(await screen.findByText(off)).toBeInTheDocument();
      expect(writes[1]).toEqual({ durationMs: null });
    }
  );
  it('warns about local conversation text, starts a timed session-filtered capture and stops it', async () => {
    const writes: { body: Record<string, unknown>; csrf: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          writes.push({ body, csrf: (init.headers as Record<string, string>)['x-csrf-token'] });
          const setting =
            body.durationMs === null
              ? { until: null }
              : {
                  until: new Date(Date.now() + Number(body.durationMs)).toISOString(),
                  ...(body.session ? { session: body.session } : {}),
                };
          return { ok: true, json: async () => setting };
        }
        return { ok: true, json: async () => ({ until: null }) };
      })
    );
    const { container } = render(<ModelCaptureSettings csrfToken="csrf-canary" />);
    expect(await screen.findByText('Capture is off.')).toBeInTheDocument();
    expect(screen.getByText(/personal conversation text on this machine/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Capture duration/)).toHaveTextContent('10 minutes');
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.change(screen.getByLabelText('Chat/session ID (optional)'), {
      target: { value: 'chat-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      body: { durationMs: 600_000, session: 'chat-1' },
      csrf: 'csrf-canary',
    });
    expect(await screen.findByText('Only session: chat-1')).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop capture' });
    await waitFor(() => expect(stop).not.toBeDisabled());
    fireEvent.click(stop);
    await waitFor(() => expect(writes[1]?.body).toEqual({ durationMs: null }));
    expect(await screen.findByText('Capture is off.')).toBeInTheDocument();
  });
  it('sends the 24-hour duration unchanged with a slow browser clock and accepts server expiry', async () => {
    const serverNow = Date.now();
    const expiry = new Date(serverNow + 86_400_000).toISOString();
    vi.spyOn(Date, 'now').mockReturnValue(serverNow - 120_000);
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          writes.push(JSON.parse(String(init.body)));
          return { ok: true, json: async () => ({ until: expiry }) };
        }
        return { ok: true, json: async () => ({ until: null }) };
      })
    );
    render(<ModelCaptureSettings csrfToken="csrf" />);
    await screen.findByText('Capture is off.');
    fireEvent.click(screen.getByLabelText(/Capture duration/));
    fireEvent.click(await screen.findByRole('option', { name: '24 hours', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
    await waitFor(() => expect(writes).toEqual([{ durationMs: 86_400_000 }]));
    expect(
      await screen.findByText(`Capture is on until ${new Date(expiry).toLocaleString()}.`)
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('shows expired capture as off and does not allow saving when loading fails', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ until: new Date(Date.now() - 1).toISOString() }),
    });
    vi.stubGlobal('fetch', fetch);
    const first = render(<ModelCaptureSettings csrfToken="csrf" />);
    expect(await screen.findByText('Capture is off.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop capture' })).toBeDisabled();
    first.unmount();
    fetch.mockResolvedValue({ ok: false });
    render(<ModelCaptureSettings csrfToken="csrf" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Capture settings are unavailable');
    expect(screen.getByRole('button', { name: 'Start capture' })).toBeDisabled();
  });
  it('offers three timed modes and until disabled, and reports a failed save without claiming capture is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'PUT' ? { ok: false } : { ok: true, json: async () => ({ until: null }) }
      )
    );
    render(<ModelCaptureSettings csrfToken="csrf" />);
    await screen.findByText('Capture is off.');
    fireEvent.click(screen.getByLabelText(/Capture duration/));
    for (const name of ['10 minutes', '1 hour', '24 hours', 'Until disabled'])
      expect(await screen.findByRole('option', { name, exact: true })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.click(screen.getByRole('option', { name: '24 hours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Capture settings could not be saved'
    );
    expect(screen.getByText('Capture is off.')).toBeInTheDocument();
  });
});
