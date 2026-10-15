// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { within } from '@testing-library/react';
import i18n from '../../web/app/src/i18n';
import 'jest-axe/extend-expect';
import App from '../../web/app/src/App';

let darkPreference = false;
let mobilePreference = false;
let listeners: Array<(event: MediaQueryListEvent) => void> = [];

beforeEach(() => {
  darkPreference = false;
  mobilePreference = false;
  listeners = [];
  window.matchMedia = (media) => ({
    get matches() {
      return media.includes('prefers-color-scheme') ? darkPreference : mobilePreference;
    },
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: (_type, listener) =>
      listeners.push(listener as (event: MediaQueryListEvent) => void),
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

describe('web app shell', () => {
  it.each([
    ['en', false, 'Conversation', 'System'],
    ['en', true, 'Conversation', 'System'],
    ['ru', false, 'Разговор', 'Система'],
    ['ru', true, 'Разговор', 'Система'],
  ])(
    'renders %s navigation in the %s theme without accessibility violations',
    async (language, dark, conversation, system) => {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: language === 'ru' ? 'ru-RU' : 'en-US',
      });
      darkPreference = dark;
      await i18n.changeLanguage(language);
      const { container } = render(<App />);
      expect(screen.getByRole('link', { name: conversation })).toBeTruthy();
      expect(screen.getByRole('link', { name: system })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Сейчас' })).toBeTruthy();
      expect(screen.getAllByText('lifemodel').length).toBeGreaterThan(0);
      expect(document.documentElement.lang).toBe(language);
      expect(document.documentElement.classList.contains('dark')).toBe(dark);
      expect(await axe(container)).toHaveNoViolations();
    }
  );

  it('follows system colour-scheme changes live', () => {
    render(<App />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    darkPreference = true;
    act(() => {
      for (const listener of listeners) listener(new Event('change') as MediaQueryListEvent);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    darkPreference = false;
    act(() => {
      for (const listener of listeners) listener(new Event('change') as MediaQueryListEvent);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('puts navigation and the Сейчас panel behind buttons on a narrow screen', () => {
    mobilePreference = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog', { name: 'Sidebar' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Conversation' })).toBeTruthy();
    cleanup();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Сейчас' }));
    const panel = screen.getByRole('dialog', { name: 'Сейчас' });
    expect(within(panel).getByText('Awake')).toBeTruthy();
  });
});
