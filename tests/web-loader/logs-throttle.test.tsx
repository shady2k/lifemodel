// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../web/loader/src/i18n';
import '../../web/loader/src/logs-i18n';
import { LogsThrottleStatus } from '../../web/loader/src/LogsThrottleStatus';

afterEach(cleanup);

describe('per-pod discarded windows', () => {
  it.each(['en', 'ru'])('renders unknown, no loss and exact loss in %s', async (language) => {
    await i18n.changeLanguage(language);
    const { container } = render(
      <LogsThrottleStatus
        value={{
          state: 'ok',
          windows: [
            { pod: 'unknown-pod', start: null, end: null, discarded: null },
            {
              pod: 'under-limit',
              start: '2026-11-11T12:00:00Z',
              end: '2026-11-11T12:00:06Z',
              discarded: 0,
            },
            {
              pod: 'flood',
              start: '2026-11-11T12:00:00Z',
              end: '2026-11-11T12:00:06Z',
              discarded: 240,
            },
          ],
        }}
      />
    );
    expect(screen.getByText('unknown-pod').parentElement).toHaveTextContent(
      i18n.t('logsThrottleUnknown')
    );
    expect(screen.getByText('under-limit').parentElement).toHaveTextContent(
      i18n.t('logsThrottleNoLoss')
    );
    expect(screen.getByText('flood').parentElement).toHaveTextContent(
      i18n.t('logsThrottleDiscarded', { count: 240 })
    );
    expect(container.textContent).not.toContain('{{');
  });
  it('does not turn missing records into no loss', async () => {
    await i18n.changeLanguage('en');
    render(<LogsThrottleStatus value={{ state: 'unknown', windows: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('discarded count unknown');
    expect(screen.queryByText('no events discarded')).not.toBeInTheDocument();
  });
});
