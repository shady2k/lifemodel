/**
 * The owner's retention setting (ADR-016 §5): the two numbers, the largest byte
 * bound this volume can ever reach, and whether the store is already running
 * the change.
 *
 * The form speaks MiB because the numbers in the ADR are MiB and GiB; the API
 * takes bytes. The page says `pending` with its reason until the loader has
 * proved the store runs the new values, and refuses a bound the evictor would
 * remove a day before it could ever be reached - with both numbers.
 */
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import { Button } from '@kit/components/ui/button';
import { Card, CardContent } from '@kit/components/ui/card';
import { Input } from '@kit/components/ui/input';
import { Label } from '@kit/components/ui/label';
import { formatMiB } from './logs-i18n';

const MIB = 1024 * 1024;

/** How often the page asks again while a change is pending, and how many times. */
export const LOGS_SETTINGS_POLL_MS = 2_000;
export const LOGS_SETTINGS_POLL_ATTEMPTS = 15;

export interface LogsRetentionLimits {
  readonly volumeBytes: number;
  readonly evictorThresholdBytes: number;
  readonly largestMaxBytes: number;
}

/** What `GET /api/logs/settings` answers. */
export interface LogsSettingsAnswer {
  state: 'ok';
  days: number;
  maxBytes: number;
  desiredRevision: string | null;
  appliedRevision: string | null;
  appliedAt: string | null;
  applied: boolean;
  pending: string | null;
  limits: LogsRetentionLimits | null;
  fitsVolume: boolean | null;
}

/** A refused bound, as the loader answers it: the asked value and the largest one. */
export interface LogsSettingsRefusal {
  state: 'refused';
  reason: 'above_volume';
  maxBytes: number;
  largestMaxBytes: number;
  volumeBytes: number;
  evictorThresholdBytes: number;
}

interface InvalidAnswer {
  state: 'invalid';
  field: string;
}

interface UnavailableAnswer {
  state: 'unavailable';
  reason: string;
}

/** The one line the form shows about the change, or null while it is applied. */
function pendingText(
  t: (key: string, options?: Record<string, unknown>) => string,
  why: string
): string {
  return t('logsRetentionPending', {
    reason: t(`logsRetentionPending_${why}`, { defaultValue: why }),
  });
}

export function LogsSettings() {
  const { t, i18n } = useTranslation();
  const [csrf, setCsrf] = useState('');
  const [status, setStatus] = useState<LogsSettingsAnswer | null>(null);
  const [days, setDays] = useState('');
  const [sizeMib, setSizeMib] = useState('');
  const [refusal, setRefusal] = useState<LogsSettingsRefusal | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const read = useCallback(async () => {
    const response = await fetch('/api/logs/settings', { cache: 'no-store' });
    if (!response.ok) throw new Error('unavailable');
    return (await response.json()) as LogsSettingsAnswer | UnavailableAnswer;
  }, []);

  const apply = useCallback((answer: LogsSettingsAnswer) => {
    setStatus(answer);
    setDays(String(answer.days));
    setSizeMib(String(Math.round(answer.maxBytes / MIB)));
    setRefusal(null);
    setInvalidField(null);
    setUnavailable(null);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const state = (await fetch('/api/state', { cache: 'no-store' }).then(async (response) =>
          response.ok ? ((await response.json()) as { csrfToken?: string }) : {}
        )) as { csrfToken?: string };
        if (!active) return;
        setCsrf(state.csrfToken ?? '');
        const answer = await read();
        if (!active) return;
        if (answer.state === 'ok') apply(answer);
        else setUnavailable(answer.reason);
      } catch {
        if (active) setUnavailable('unavailable');
      }
    })();
    return () => {
      active = false;
    };
  }, [apply, read]);

  /** One more look at the same question while a change is still on its way. */
  const refresh = useCallback(async () => {
    setAttempts((current) => current + 1);
    try {
      const answer = await read();
      if (answer.state !== 'ok') {
        setUnavailable(answer.reason);
        setPolling(false);
        return;
      }
      setStatus(answer);
      if (answer.applied) setPolling(false);
    } catch {
      setUnavailable('unavailable');
      setPolling(false);
    }
  }, [read]);

  useEffect(() => {
    if (!polling) return;
    if (attempts >= LOGS_SETTINGS_POLL_ATTEMPTS) {
      setPolling(false);
      return;
    }
    const timer = setTimeout(() => {
      void refresh();
    }, LOGS_SETTINGS_POLL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [attempts, polling, refresh]);

  async function save(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    setInvalidField(null);
    setUnavailable(null);
    try {
      const response = await fetch('/api/logs/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          days: Number(days),
          maxBytes: Math.round(Number(sizeMib) * MIB),
        }),
      });
      const answer = (await response.json().catch(() => null)) as
        | LogsSettingsAnswer
        | LogsSettingsRefusal
        | InvalidAnswer
        | UnavailableAnswer
        | null;
      if (answer === null) {
        setUnavailable('unavailable');
        return;
      }
      if (answer.state === 'ok') {
        apply(answer);
        setAttempts(0);
        setPolling(!answer.applied);
        return;
      }
      if (answer.state === 'refused') {
        setRefusal(answer);
        return;
      }
      if (answer.state === 'invalid') {
        setInvalidField(answer.field);
        return;
      }
      setUnavailable(answer.reason);
    } catch {
      setUnavailable('unavailable');
    } finally {
      setBusy(false);
    }
  }

  const language = i18n.language;
  const largest = status?.limits?.largestMaxBytes ?? null;
  return (
    <Card id="logs-settings">
      <CardContent className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-semibold" id="logs-retention-title">
          {t('logsRetentionTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('logsRetentionDescription')}</p>

        {unavailable !== null && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {t('logsRetentionUnavailable', {
                reason: t(`logs_reason_${unavailable}`, {
                  defaultValue: t('logs_reason_unreachable'),
                }),
              })}
            </AlertDescription>
          </Alert>
        )}

        {status !== null && status.fitsVolume === false && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {t('logsRetentionDoesNotFit', {
                asked: formatMiB(status.maxBytes, language),
                largest: largest === null ? '' : formatMiB(largest, language),
              })}
            </AlertDescription>
          </Alert>
        )}

        {status !== null && (
          <p role="status" className="text-sm">
            {status.applied
              ? status.appliedAt === null
                ? t('logsRetentionAppliedNow', {
                    days: status.days,
                    size: formatMiB(status.maxBytes, language),
                  })
                : t('logsRetentionApplied', {
                    time: new Date(status.appliedAt).toLocaleString(language),
                    days: status.days,
                    size: formatMiB(status.maxBytes, language),
                  })
              : pendingText(t, status.pending ?? 'mismatch')}
          </p>
        )}

        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void save(event)}>
          <div className="space-y-2">
            <Label htmlFor="logs-retention-days">{t('logsRetentionDays')}</Label>
            <Input
              id="logs-retention-days"
              type="number"
              min={1}
              step={1}
              value={days}
              disabled={status === null || busy}
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="logs-retention-size">{t('logsRetentionSize')}</Label>
            <Input
              id="logs-retention-size"
              type="number"
              min={1}
              step={1}
              value={sizeMib}
              disabled={status === null || busy}
              onChange={(event) => {
                setSizeMib(event.target.value);
              }}
            />
            {largest !== null && (
              <p className="text-xs text-muted-foreground">
                {t('logsRetentionLargest', { size: formatMiB(largest, language) })}
              </p>
            )}
          </div>
          {invalidField !== null && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {t('logsRetentionInvalid', { field: invalidField })}
            </p>
          )}
          {refusal !== null && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {t('logsRetentionRefused', {
                asked: formatMiB(refusal.maxBytes, language),
                largest: formatMiB(refusal.largestMaxBytes, language),
              })}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={status === null || busy}>
              {busy ? t('logsRetentionSaving') : t('logsRetentionSave')}
            </Button>
          </div>
        </form>
        <p className="text-xs text-muted-foreground">{t('logsRetentionVolumeNote')}</p>
      </CardContent>
    </Card>
  );
}
