/**
 * The loader's logs page (ADR-016 §4): one time range and one module, the
 * newest records first, and the store's unavailable answer with its reason.
 * Level, conversation and paging are stage 2 and are deliberately absent.
 */
import { Fragment, useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import { Badge } from '@kit/components/ui/badge';
import { Button } from '@kit/components/ui/button';
import { Card, CardContent } from '@kit/components/ui/card';
import { Input } from '@kit/components/ui/input';
import { Label } from '@kit/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kit/components/ui/select';
import type { LogsRecord } from '../../../loader/src/logs-store-adapter.js';

const ALL_MODULES = '__all__';

interface Unavailable {
  state: 'unavailable';
  reason: string;
  status?: number;
}

interface RecordsAnswer {
  state: 'ok';
  records: LogsRecord[];
}

function localInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initialRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: localInputValue(new Date(now.getTime() - 60 * 60 * 1000)),
    to: localInputValue(now),
  };
}

function fieldOf(record: LogsRecord, name: string): string | undefined {
  return record.fields[name];
}

function levelClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'border-destructive text-destructive';
  if (level === 'warn' || level === 'warning') return 'border-warning text-warning';
  return 'text-muted-foreground';
}

export function Logs() {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState(() => initialRange().from);
  const [to, setTo] = useState(() => initialRange().to);
  const [moduleName, setModuleName] = useState('');
  const [modules, setModules] = useState<string[]>([]);
  const [records, setRecords] = useState<LogsRecord[] | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [rangeInvalid, setRangeInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (fromMs: number, toMs: number, module: string) => {
    setBusy(true);
    setRangeInvalid(false);
    try {
      const params = new URLSearchParams({ from: String(fromMs), to: String(toMs) });
      if (module !== '') params.set('module', module);
      const response = await fetch(`/api/logs?${params.toString()}`);
      if (response.status === 400) {
        setRangeInvalid(true);
        setRecords(null);
        setUnavailable(null);
        return;
      }
      const value = (await response.json()) as RecordsAnswer | Unavailable;
      if (value.state === 'unavailable') {
        setUnavailable(value);
        setRecords(null);
        return;
      }
      setUnavailable(null);
      setRecords(value.records);
    } catch {
      setUnavailable({ state: 'unavailable', reason: 'unreachable' });
      setRecords(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const loadModules = useCallback(async () => {
    try {
      const response = await fetch('/api/logs/modules');
      if (!response.ok) return;
      const value = (await response.json()) as { state: string; modules?: string[] };
      if (value.state === 'ok' && Array.isArray(value.modules)) setModules(value.modules);
    } catch {
      // The record answer carries the unavailable reason.
    }
  }, []);

  useEffect(() => {
    const range = initialRange();
    setFrom(range.from);
    setTo(range.to);
    void loadModules();
    void load(new Date(range.from).getTime(), new Date(range.to).getTime(), '');
  }, [load, loadModules]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', preference.matches);
    apply();
    preference.addEventListener('change', apply);
    return () => {
      preference.removeEventListener('change', apply);
    };
  }, []);

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      setRangeInvalid(true);
      return;
    }
    void load(fromMs, toMs, moduleName);
  }

  return (
    <main className="min-h-svh bg-background px-5 py-10 text-foreground">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t('logsTitle')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('logsDescription')}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" asChild>
              <a href="/">{t('logsSettings')}</a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('en')}
              onClick={() => {
                void i18n.changeLanguage('en');
              }}
            >
              EN
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('ru')}
              onClick={() => {
                void i18n.changeLanguage('ru');
              }}
            >
              RU
            </Button>
          </div>
        </header>

        <Card>
          <CardContent className="p-4 sm:p-6">
            <form
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]"
              onSubmit={submit}
            >
              <div className="space-y-2">
                <Label htmlFor="logs-from">{t('logsTimeFrom')}</Label>
                <Input
                  id="logs-from"
                  type="datetime-local"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="logs-to">{t('logsTimeTo')}</Label>
                <Input
                  id="logs-to"
                  type="datetime-local"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="logs-module">{t('logsModule')}</Label>
                <Select
                  value={moduleName === '' ? ALL_MODULES : moduleName}
                  onValueChange={(value) => {
                    setModuleName(value === ALL_MODULES ? '' : value);
                  }}
                >
                  <SelectTrigger id="logs-module">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_MODULES}>{t('logsAllModules')}</SelectItem>
                    {modules.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button className="w-full" disabled={busy}>
                  {busy ? t('logsSearching') : t('logsSearch')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {rangeInvalid && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t('logsInvalidRange')}</AlertDescription>
          </Alert>
        )}

        {unavailable !== null && (
          <Alert variant="destructive" role="status">
            <AlertDescription>
              {t('logsUnavailable', {
                reason: t(`logs_reason_${unavailable.reason}`, {
                  defaultValue: t('logs_reason_unreachable'),
                }),
              })}
            </AlertDescription>
          </Alert>
        )}

        <section aria-live="polite" aria-busy={busy}>
          {records !== null && records.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('logsNoRecords')}</p>
          )}
          {records !== null && records.length > 0 && (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('logsRecordCount', { count: records.length })}
              </p>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {records.map((record, index) => {
                  const level = fieldOf(record, 'level');
                  return (
                    <li key={`${record.time}-${String(index)}`} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <time dateTime={record.time}>
                          {new Date(record.time).toLocaleString(i18n.language)}
                        </time>
                        <Badge variant="secondary">{fieldOf(record, 'module') ?? '—'}</Badge>
                        {level !== undefined && (
                          <Badge variant="outline" className={levelClass(level)}>
                            {level}
                          </Badge>
                        )}
                        {fieldOf(record, 'untrusted') === 'true' && (
                          <Badge variant="destructive">{t('logsUntrusted')}</Badge>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words font-mono text-sm">
                        {record.message}
                      </p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          {t('logsFields')}
                        </summary>
                        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                          {Object.entries(record.fields)
                            .sort(([left], [right]) => left.localeCompare(right))
                            .map(([key, value]) => (
                              <Fragment key={key}>
                                <dt className="text-muted-foreground">{key}</dt>
                                <dd className="break-all">{value}</dd>
                              </Fragment>
                            ))}
                        </dl>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
