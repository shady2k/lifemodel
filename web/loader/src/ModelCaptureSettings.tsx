import { useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@kit/components/ui/button';
import { Input } from '@kit/components/ui/input';
import { Label } from '@kit/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kit/components/ui/select';
import {
  CAPTURE_UNTIL_DISABLED,
  isCaptureEnabled,
  validateCaptureSettingResponse,
  type ModelCaptureRequest,
  type ModelCaptureSetting,
} from '../../../loader/src/model-capture-setting.js';

/** Opt-in debug capture, separate from credentials and model connection checks. */
export function ModelCaptureSettings({ csrfToken }: { csrfToken: string }) {
  const { t } = useTranslation();
  const [setting, setSetting] = useState<ModelCaptureSetting>({ until: null });
  const [duration, setDuration] = useState('600000');
  const [session, setSession] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    void fetch('/api/model-capture', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const value = validateCaptureSettingResponse(await response.json());
        if (active) {
          setSetting(value);
          setSession(value.session ?? '');
          if (value.until === CAPTURE_UNTIL_DISABLED) setDuration(CAPTURE_UNTIL_DISABLED);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setError('captureLoadFailed');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setNow(Date.now());
    const remaining = setting.until === null ? 0 : Date.parse(setting.until) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
    }, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [setting.until]);
  async function save(off = false) {
    setBusy(true);
    setError('');
    const value: ModelCaptureRequest = off
      ? { durationMs: null }
      : {
          ...(duration === CAPTURE_UNTIL_DISABLED
            ? { mode: CAPTURE_UNTIL_DISABLED }
            : { durationMs: Number(duration) }),
          ...(session.trim() ? { session: session.trim() } : {}),
        };
    try {
      const response = await fetch('/api/model-capture', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error('unavailable');
      setSetting(validateCaptureSettingResponse(await response.json()));
      setNow(Date.now());
    } catch {
      setError('captureSaveFailed');
    } finally {
      setBusy(false);
    }
  }
  const enabled = isCaptureEnabled(setting, setting.session, now);
  return (
    <section className="space-y-3" aria-labelledby="model-capture-title">
      <h3 className="text-base font-semibold" id="model-capture-title">
        {t('captureTitle')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('captureWarning')}</p>
      {loaded && (
        <p role="status" className="text-sm">
          {enabled
            ? setting.until === CAPTURE_UNTIL_DISABLED
              ? t('captureNoEnd')
              : t('captureUntil', { time: new Date(setting.until ?? '').toLocaleString() })
            : t('captureOff')}
        </p>
      )}
      {loaded && enabled && setting.session && (
        <p className="text-sm">{t('captureScope', { session: setting.session })}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="capture-duration">{t('captureDuration')}</Label>
          <Select value={duration} onValueChange={setDuration}>
            <SelectTrigger id="capture-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="600000">{t('capture10Minutes')}</SelectItem>
              <SelectItem value="3600000">{t('capture1Hour')}</SelectItem>
              <SelectItem value="86400000">{t('capture24Hours')}</SelectItem>
              <SelectItem value={CAPTURE_UNTIL_DISABLED}>{t('captureUntilDisabled')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="capture-session">{t('captureSession')}</Label>
          <Input
            id="capture-session"
            value={session}
            maxLength={128}
            pattern={'[A-Za-z0-9._:\\-]+'}
            onChange={(event) => {
              setSession(event.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">{t('captureSessionHint')}</p>
        </div>
        <Button disabled={!loaded || busy} type="submit">
          {t('captureStart')}
        </Button>
        <Button
          className="ml-2"
          variant="outline"
          disabled={!loaded || busy || !enabled}
          type="button"
          onClick={() => {
            void save(true);
          }}
        >
          {t('captureStop')}
        </Button>
      </form>
    </section>
  );
}
