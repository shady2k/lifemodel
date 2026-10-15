// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '../../web/app/src/i18n';
import { CreaturePresence } from '../../web/app/src/components/CreaturePresence';

afterEach(cleanup);

describe('creature presence', () => {
  it('shows fresh thinking with its icon and polite announcement in English', async () => {
    await i18n.changeLanguage('en');
    render(
      <CreaturePresence value={{ state: 'thinking', publishedAt: new Date().toISOString() }} />
    );
    expect(screen.getByText('thinking…')).toBeTruthy();
    expect(document.querySelector('svg.lucide-loader-circle')).toBeTruthy();
  });

  it('shows fresh awake and asleep states with their icons in Russian', async () => {
    await i18n.changeLanguage('ru');
    const fresh = new Date().toISOString();
    const { rerender } = render(
      <CreaturePresence value={{ state: 'awake', publishedAt: fresh }} />
    );
    expect(screen.getByText('на связи')).toBeTruthy();
    expect(document.querySelector('svg.lucide-check')).toBeTruthy();
    rerender(<CreaturePresence value={{ state: 'asleep', publishedAt: fresh }} />);
    expect(screen.getByRole('status').textContent).toBe('спит');
    rerender(
      <CreaturePresence
        value={{ state: 'asleep', publishedAt: fresh, asleepUntil: '2026-10-15T20:30:00Z' }}
      />
    );
    expect(screen.getByRole('status').textContent).toMatch(/^спит до /);
    expect(document.querySelector('svg.lucide-moon')).toBeTruthy();
  });

  it('reports no connection when the state is absent or older than 15 seconds', async () => {
    await i18n.changeLanguage('en');
    const { rerender } = render(<CreaturePresence />);
    expect(screen.getByText('no connection since --:--')).toBeTruthy();
    rerender(
      <CreaturePresence
        value={{ state: 'thinking', publishedAt: new Date(Date.now() - 15_001).toISOString() }}
      />
    );
    expect(screen.getByRole('status').textContent).toMatch(/^no connection since /);
    expect(document.querySelector('svg.lucide-wifi-off')).toBeTruthy();
  });
});
