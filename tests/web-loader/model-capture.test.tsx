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
});
describe('model capture settings control', () => {
  it('warns about local conversation text, starts a timed session-filtered capture and stops it', async () => {
    const writes: { body: Record<string, unknown>; csrf: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          writes.push({ body, csrf: (init.headers as Record<string, string>)['x-csrf-token'] });
          return { ok: true, json: async () => body };
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
    const before = Date.now();
    fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ body: { session: 'chat-1' }, csrf: 'csrf-canary' });
    const expiry = Date.parse(String(writes[0]?.body.until));
    expect(expiry).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(await screen.findByText('Only session: chat-1')).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop capture' });
    await waitFor(() => expect(stop).not.toBeDisabled());
    fireEvent.click(stop);
    await waitFor(() => expect(writes[1]?.body).toEqual({ until: null }));
    expect(await screen.findByText('Capture is off.')).toBeInTheDocument();
  });
  it('shows expired capture as off and does not allow saving when loading fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({
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
  it('offers at most 24 hours and reports a failed save without claiming capture is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'PUT' ? { ok: false } : { ok: true, json: async () => ({ until: null }) }
      )
    );
    render(<ModelCaptureSettings csrfToken="csrf" />);
    await screen.findByText('Capture is off.');
    fireEvent.click(screen.getByLabelText(/Capture duration/));
    for (const name of ['10 minutes', '1 hour', '24 hours'])
      expect(await screen.findByRole('option', { name, exact: true })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.click(screen.getByRole('option', { name: '24 hours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Capture settings could not be saved'
    );
    expect(screen.getByText('Capture is off.')).toBeInTheDocument();
  });
});
