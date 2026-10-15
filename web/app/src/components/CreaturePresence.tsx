import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LoaderCircle, Moon, WifiOff } from 'lucide-react';

type CreatureState = 'thinking' | 'awake' | 'asleep';

export interface CreaturePresenceValue {
  state: CreatureState;
  publishedAt: string;
  asleepUntil?: string;
}

const FRESHNESS_MS = 15_000;

function formatTime(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  );
}

export function CreaturePresence({ value }: { value?: CreaturePresenceValue }) {
  const { t, i18n } = useTranslation();
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const disconnected = !value || Date.now() - new Date(value.publishedAt).getTime() > FRESHNESS_MS;
  const status = disconnected
    ? t('noConnection', {
        time: value ? formatTime(value.publishedAt, i18n.language) : '--:--',
      })
    : value.state === 'thinking'
      ? t('thinking')
      : value.state === 'asleep'
        ? value.asleepUntil
          ? t('asleepUntil', { time: formatTime(value.asleepUntil, i18n.language) })
          : t('asleep')
        : t('awake');
  const Icon = disconnected
    ? WifiOff
    : value.state === 'thinking'
      ? LoaderCircle
      : value.state === 'asleep'
        ? Moon
        : Check;

  return (
    <span
      role="status"
      aria-live="polite"
      className="flex items-center gap-1 text-sm text-muted-foreground"
    >
      <Icon
        aria-hidden="true"
        className={value?.state === 'thinking' && !disconnected ? 'size-4 animate-spin' : 'size-4'}
      />
      <span>{status}</span>
    </span>
  );
}
