import { useTranslation } from 'react-i18next';
import type { LogsThrottle } from '../../../loader/src/logs-throttle.js';

/** Exact loss belongs to one pod and one pair, never an unreconciled total. */
export function LogsThrottleStatus({ value }: { value: LogsThrottle }) {
  const { t, i18n } = useTranslation();
  return (
    <section aria-label={t('logsThrottleTitle')} className="space-y-2 text-sm">
      <h2 className="font-medium">{t('logsThrottleTitle')}</h2>
      <p className="text-xs text-muted-foreground">{t('logsThrottleHelp')}</p>
      {value.state === 'unknown' && <p role="status">{t('logsThrottleUnknown')}</p>}
      {value.windows.map((window, index) => (
        <p key={`${window.pod}-${String(index)}`}>
          <span className="font-mono">{window.pod}</span>
          {' · '}
          {window.start !== null && window.end !== null && (
            <>
              {new Date(window.start).toLocaleString(i18n.language)} –{' '}
              {new Date(window.end).toLocaleString(i18n.language)}
              {' · '}
            </>
          )}
          {window.discarded === null
            ? t('logsThrottleUnknown')
            : window.discarded === 0
              ? t('logsThrottleNoLoss')
              : t('logsThrottleDiscarded', { count: window.discarded })}
        </p>
      ))}
    </section>
  );
}
