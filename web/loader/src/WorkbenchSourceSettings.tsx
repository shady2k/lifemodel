import { useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@kit/components/ui/button';
import { Input } from '@kit/components/ui/input';
import { Label } from '@kit/components/ui/label';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import type { WorkbenchImportStatus } from '../../../loader/src/workbench-status.js';

interface PublicSource {
  registry: string;
  repository: string;
  username?: string;
  hasPassword: boolean;
}
/** Private pull credentials are write-only; this form only receives their presence. */
export function WorkbenchSourceSettings({ csrfToken }: { csrfToken: string }) {
  const { t, i18n } = useTranslation();
  const [source, setSource] = useState<PublicSource | null>(null);
  const [registry, setRegistry] = useState('');
  const [repository, setRepository] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearCredential, setClearCredential] = useState(false);
  const [status, setStatus] = useState<WorkbenchImportStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    async function loadSource(): Promise<void> {
      try {
        const response = await fetch('/api/workbench-source');
        if (!response.ok) throw new Error('unavailable');
        const value = (await response.json()) as PublicSource;
        if (typeof value.registry !== 'string' || typeof value.repository !== 'string')
          throw new Error('invalid');
        if (!active) return;
        setSource(value);
        setRegistry(value.registry);
        setRepository(value.repository);
        setUsername(value.username ?? '');
      } catch {
        if (active) setNotice('workbenchLoadFailed');
      } finally {
        if (active) setLoaded(true);
      }
    }
    async function loadStatus(): Promise<void> {
      try {
        const response = await fetch('/api/workbench-status');
        if (!response.ok) throw new Error('unavailable');
        const value = (await response.json()) as WorkbenchImportStatus;
        if (!['pending', 'importing', 'ready', 'failed'].includes(value.state))
          throw new Error('invalid');
        if (active) setStatus(value);
      } catch {
        if (active) setStatus(null);
      }
    }
    void loadSource();
    void loadStatus();
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  async function save(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/workbench-source', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          registry,
          repository,
          username: clearCredential ? '' : username,
          ...(clearCredential ? { password: '' } : password !== '' ? { password } : {}),
        }),
      });
      if (!response.ok) {
        setNotice(response.status === 400 ? 'workbenchInvalid' : 'workbenchSaveFailed');
        return;
      }
      const value = (await response.json()) as { source: PublicSource };
      setSource(value.source);
      setUsername(value.source.username ?? '');
      setPassword('');
      setClearCredential(false);
      setNotice('workbenchSaved');
      // An immediate refresh keeps a stale "ready" line from masking the new attempt.
      const current = await fetch('/api/workbench-status');
      if (current.ok) setStatus((await current.json()) as WorkbenchImportStatus);
    } catch {
      setNotice('workbenchSaveFailed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 space-y-4" aria-labelledby="workbench-source-title">
      <h3 id="workbench-source-title" className="text-base font-semibold">
        {t('workbenchSource')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('workbenchHint')}</p>
      <div role="status" aria-live="polite" className="space-y-1 text-sm">
        {status ? (
          <>
            <p data-testid="workbench-status" data-state={status.state}>
              {t(`workbench_${status.state}`)}
            </p>
            {status.reason && (
              <p>
                {t('workbenchReason', {
                  reason: t(`workbench_reason_${status.reason}`, {
                    defaultValue: t('workbench_reason_unavailable'),
                  }),
                })}
              </p>
            )}
            {status.detail && (
              <p data-testid="workbench-failure-detail">
                {t('workbenchFailureStep', {
                  step: t(`workbench_step_${status.detail.step}`),
                  side: t(`workbench_side_${status.detail.side}`),
                })}
                {status.detail.status !== undefined && ` · HTTP ${String(status.detail.status)}`}
                {status.detail.sourceOrigin &&
                  status.detail.sourceRepository &&
                  ` · ${status.detail.sourceOrigin}/${status.detail.sourceRepository}`}
                {status.detail.errorName && ` · ${status.detail.errorName}`}
                {status.detail.errorCode && ` · ${status.detail.errorCode}`}
                {status.detail.digest && ` · ${status.detail.digest}`}
              </p>
            )}
            <p>
              {status.lastAttemptAt === null
                ? t('workbenchNoAttempt')
                : t('workbenchLastAttempt', {
                    time: new Date(status.lastAttemptAt).toLocaleString(i18n.language),
                  })}
            </p>
          </>
        ) : (
          <p>{t('workbenchStatusUnavailable')}</p>
        )}
      </div>
      {notice && (
        <Alert role="status" variant={notice === 'workbenchSaved' ? 'default' : 'destructive'}>
          <AlertDescription>{t(notice)}</AlertDescription>
        </Alert>
      )}
      {loaded && source && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            void save(event);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="workbench-registry">{t('workbenchRegistry')}</Label>
            <Input
              id="workbench-registry"
              type="url"
              required
              value={registry}
              onChange={(event) => {
                setRegistry(event.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workbench-repository">{t('workbenchRepository')}</Label>
            <Input
              id="workbench-repository"
              required
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workbench-username">{t('workbenchUsername')}</Label>
            <Input
              id="workbench-username"
              autoComplete="off"
              disabled={clearCredential}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workbench-password">{t('workbenchPassword')}</Label>
            <Input
              id="workbench-password"
              type="password"
              autoComplete="new-password"
              disabled={clearCredential}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            {source.hasPassword && (
              <p className="text-xs text-muted-foreground">{t('workbenchPasswordSet')}</p>
            )}
          </div>
          {source.hasPassword && (
            <div className="flex items-center gap-2">
              <input
                id="workbench-clear"
                type="checkbox"
                checked={clearCredential}
                onChange={(event) => {
                  setClearCredential(event.target.checked);
                }}
              />
              <Label htmlFor="workbench-clear">{t('workbenchClearCredential')}</Label>
            </div>
          )}
          <Button disabled={busy}>{busy ? t('loading') : t('workbenchSave')}</Button>
        </form>
      )}
    </section>
  );
}
