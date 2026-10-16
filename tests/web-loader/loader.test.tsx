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
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ setupNeeded: true, loggedIn: false }) });
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
        json: async () => ({ setupNeeded, loggedIn: false }),
      });
      const { container } = render(<App />);
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      expect(document.documentElement.lang).toBe(language);
      expect(document.documentElement.classList.contains('dark')).toBe(isDark);
      expect(await axe(container)).toHaveNoViolations();
    }
  );
  it('shows the wrong-password error and accepts the right password', async () => {
    await i18n.changeLanguage('en');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ setupNeeded: false, loggedIn: false }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
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
});
