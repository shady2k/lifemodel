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
  it.each(['en', 'ru'])('uses full foreground contrast for the explanation in %s', async (language) => {
    await i18n.changeLanguage(language);
    render(<LogsThrottleStatus value={{ state: 'unknown', windows: [] }} />);
    expect(screen.getByText(i18n.t('logsThrottleHelp'))).toHaveClass('text-foreground');
    expect(screen.getByText(i18n.t('logsThrottleHelp'))).not.toHaveClass('text-muted-foreground');
  });

  it.each(['en', 'ru'])('renders unknown, no loss and exact loss in %s', async (language) => {
    await i18n.changeLanguage(language);
    const { container } = render(
      <LogsThrottleStatus
        value={{
          state: 'ok',
          windows: [
            {
              namespace: 'lifemodel-motor',
              pod: 'unknown-pod',
              start: null,
              end: null,
              discarded: null,
            },
            {
              namespace: 'lifemodel-motor',
              pod: 'under-limit',
              start: '2026-11-11T12:00:00Z',
              end: '2026-11-11T12:00:06Z',
              discarded: 0,
            },
            {
              namespace: 'lifemodel-motor',
              pod: 'flood',
              start: '2026-11-11T12:00:00Z',
              end: '2026-11-11T12:00:06Z',
              discarded: 240,
            },
          ],
        }}
      />
    );
    expect(screen.getByText('lifemodel-motor/unknown-pod').parentElement).toHaveTextContent(
      i18n.t('logsThrottleUnknown')
    );
    expect(screen.getByText('lifemodel-motor/under-limit').parentElement).toHaveTextContent(
      i18n.t('logsThrottleNoLoss')
    );
    expect(screen.getByText('lifemodel-motor/flood').parentElement).toHaveTextContent(
      i18n.t('logsThrottleDiscarded', { count: 240 })
    );
    expect(container.textContent).not.toContain('{{');
  });
  it.each(['en', 'ru'])('orders namespaces, pods and times oldest first, including unknown gaps in %s', async (language) => {
    await i18n.changeLanguage(language);
    const window = (namespace: string, pod: string, start: string | null, end: string | null, discarded: number | null) => ({ namespace, pod, start, end, discarded });
    const windows = [
      window('b', 'a', '2026-11-11T23:00:00Z', '2026-11-11T23:00:06Z', 1),
      window('a', 'b', '2026-11-11T23:00:00Z', '2026-11-11T23:00:06Z', 2),
      window('a', 'a', '2026-11-11T23:01:00Z', '2026-11-11T23:01:06Z', 3),
      window('a', 'a', null, null, null),
      window('a', 'a', '2026-11-11T23:00:12Z', '2026-11-11T23:00:18Z', 4),
      window('a', 'a', '2026-11-11T23:00:06Z', '2026-11-11T23:00:12Z', null),
      window('a', 'a', '2026-11-11T23:00:00Z', '2026-11-11T23:00:06Z', 5),
    ];
    const original = [...windows];
    const { container, rerender } = render(<LogsThrottleStatus value={{ state: 'unknown', windows }} />);
    const rows = () => [...container.querySelectorAll('p')].filter((row) => row.querySelector('.font-mono'));
    const expected = [windows[6], windows[5], windows[4], windows[2], windows[3], windows[1], windows[0]];
    for (const [index, entry] of expected.entries()) {
      expect(rows()[index]).toHaveTextContent(`${entry!.namespace}/${entry!.pod}`);
      if (entry!.start !== null) expect(rows()[index]).toHaveTextContent(new Date(entry!.start!).toLocaleString(i18n.language));
      expect(rows()[index]).toHaveTextContent(entry!.discarded === null ? i18n.t('logsThrottleUnknown') : i18n.t('logsThrottleDiscarded', { count: entry!.discarded! }));
    }
    const first = rows().map((row) => row.textContent);
    rerender(<LogsThrottleStatus value={{ state: 'unknown', windows: [...windows].reverse() }} />);
    expect(rows().map((row) => row.textContent)).toEqual(first);
    expect(windows).toEqual(original);
  });

  it('does not turn missing records into no loss', async () => {
    await i18n.changeLanguage('en');
    render(<LogsThrottleStatus value={{ state: 'unknown', windows: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('discarded count unknown');
    expect(screen.queryByText('no events discarded')).not.toBeInTheDocument();
  });
});
