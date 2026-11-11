/**
 * The loader's logs page (ADR-016 §4): a filter row of time range, module,
 * level, conversation and text, the newest records first, and the store's
 * unavailable answer with its reason.
 *
 * The list pages through one window, whose end is fixed at the first page.
 * Every page re-reads the window's count, and a page whose count changed says
 * so: records arrived while the reader was scrolling, and the refresh reads
 * the first page again. Above it sits the owner's retention setting, whose own
 * component says when the store runs it (ADR-016 §5).
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
import {
  LOGS_CONVERSATION_MAX_LENGTH,
  LOGS_LEVELS,
  LOGS_TEXT_MAX_LENGTH,
} from '../../../loader/src/logs-query.js';
import type { LogsRecord } from '../../../loader/src/logs-store-adapter.js';
import { LogsSettings } from './LogsSettings';
import { LogsThrottleStatus } from './LogsThrottleStatus';
import type { LogsThrottle } from '../../../loader/src/logs-throttle.js';
import { formatMiB } from './logs-i18n';

const ALL_MODULES = '__all__';
const ALL_LEVELS = '__all__';

/** The day a record belongs to, as the store names a partition: `YYYYMMDD`. */
function recordDay(record: LogsRecord): string {
  return record.time.slice(0, 10).replace(/-/g, '');
}

/** A removed day as a local date, so the notice reads like the list beside it. */
function noticeDate(day: string, language: string): string {
  const year = day.slice(0, 4);
  const month = day.slice(4, 6);
  const date = day.slice(6, 8);
  return new Date(`${year}-${month}-${date}T00:00:00Z`).toLocaleDateString(language, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
}

/** An eviction notice and the records it belongs above. */
type LogsEntry =
  | { kind: 'record'; record: LogsRecord }
  | { kind: 'notice'; notice: EvictionNotice };

/**
 * Records newest first, each eviction notice above the first record whose day
 * is on or before the removed day — the place in the list where those logs
 * would have been. A day older than every record shown puts its notice after
 * the list. A record an evictor notice already shows is not repeated.
 */
export function entriesWithNotices(
  records: readonly LogsRecord[],
  notices: readonly EvictionNotice[]
): LogsEntry[] {
  const before = new Map<number, EvictionNotice[]>();
  const shown = new Set<string>();
  for (const notice of notices) {
    if (notice.day === null) continue;
    const day = notice.day;
    shown.add(`${notice.time}|${notice.message}`);
    let index = records.findIndex((record) => recordDay(record) <= day);
    if (index < 0) index = records.length;
    before.set(index, [...(before.get(index) ?? []), notice]);
  }
  const entries: LogsEntry[] = [];
  records.forEach((record, index) => {
    for (const notice of before.get(index) ?? []) entries.push({ kind: 'notice', notice });
    if (!shown.has(`${record.time}|${record.message}`)) entries.push({ kind: 'record', record });
  });
  for (const notice of before.get(records.length) ?? []) entries.push({ kind: 'notice', notice });
  return entries;
}

interface Unavailable {
  state: 'unavailable';
  reason: string;
  status?: number;
}

/** One evictor line, shown as a notice rather than as an ordinary record. */
interface EvictionNotice {
  time: string;
  day: string | null;
  freedBytes: number | null;
  reason: string | null;
  message: string;
}

/** The freshness, store alarm and eviction notices the first page carries. */
interface PageStatus {
  collection: {
    state: 'live' | 'stopped' | 'unknown';
    stoppedForMs: number | null;
  };
  storeReadOnly: boolean | null;
  evictor: { lastSuccessAt: string | null; stale: boolean | null };
  evictions: EvictionNotice[];
}

interface PageAnswer {
  state: 'ok';
  records: LogsRecord[];
  offset: number;
  limit: number;
  count: number;
  incomplete: boolean;
  status?: PageStatus;
  throttle?: LogsThrottle;
}

/** One request's place in the window; a first page names none of it. */
interface PagePlace {
  offset: number | null;
  limit: number | null;
  expected: number | null;
}

interface PageFilter {
  from: number;
  to: number;
  module: string;
  level: string;
  conversation: string;
  text: string;
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

/** The label the page shows for a refused filter, or null for a page bound. */
function labelKeyOf(field: string): string | null {
  if (field === 'from') return 'logsTimeFrom';
  if (field === 'to') return 'logsTimeTo';
  if (field === 'module') return 'logsModule';
  if (field === 'level') return 'logsLevel';
  if (field === 'conversation_id') return 'logsConversation';
  if (field === 'text') return 'logsText';
  return null;
}

export function Logs() {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState(() => initialRange().from);
  const [to, setTo] = useState(() => initialRange().to);
  const [moduleName, setModuleName] = useState('');
  const [level, setLevel] = useState('');
  const [conversation, setConversation] = useState('');
  const [text, setText] = useState('');
  const [modules, setModules] = useState<string[]>([]);
  const [records, setRecords] = useState<LogsRecord[] | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The filter the shown records belong to, so a later page reuses it. */
  const [applied, setApplied] = useState<PageFilter | null>(null);
  /** The window's record count as the first page read it. */
  const [windowCount, setWindowCount] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pageLimit, setPageLimit] = useState<number | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  /** The window's freshness, store alarm and eviction notices. */
  const [status, setStatus] = useState<PageStatus | null>(null);
  const [throttle, setThrottle] = useState<LogsThrottle | null>(null);

  const load = useCallback(async (filter: PageFilter, place: PagePlace, append: boolean) => {
    setBusy(true);
    setInvalid(null);
    try {
      const params = new URLSearchParams({
        from: String(filter.from),
        to: String(filter.to),
      });
      if (filter.module !== '') params.set('module', filter.module);
      if (filter.level !== '') params.set('level', filter.level);
      if (filter.conversation !== '') params.set('conversation_id', filter.conversation);
      if (filter.text !== '') params.set('text', filter.text);
      if (place.offset !== null) params.set('offset', String(place.offset));
      if (place.limit !== null) params.set('limit', String(place.limit));
      if (place.expected !== null) params.set('expected', String(place.expected));
      // The status belongs to the window, not to one page: the first page asks
      // for it and a later page keeps the answer it was given.
      if (!append) params.set('status', '1');
      const response = await fetch(`/api/logs?${params.toString()}`);
      if (response.status === 400) {
        const value = (await response.json().catch(() => null)) as {
          field?: string;
        } | null;
        setInvalid(value?.field ?? 'filter');
        setRecords(null);
        setUnavailable(null);
        return;
      }
      const value = (await response.json()) as PageAnswer | Unavailable;
      if (value.state === 'unavailable') {
        setUnavailable(value);
        setRecords(null);
        return;
      }
      setUnavailable(null);
      setRecords((current) =>
        append && current !== null ? [...current, ...value.records] : value.records
      );
      if (value.status !== undefined) setStatus(value.status);
      if (!append) setThrottle(value.throttle ?? { state: 'unknown', windows: [] });
      setWindowCount(value.count);
      setNextOffset(value.offset + value.limit);
      setPageLimit(value.limit);
      setIncomplete((current) => (append ? current || value.incomplete : value.incomplete));
    } catch {
      setUnavailable({ state: 'unavailable', reason: 'unreachable' });
      setRecords(null);
    } finally {
      setBusy(false);
    }
  }, []);

  /** The first page: a new window, whose end stays fixed for its pages. */
  const first = useCallback(
    async (filter: PageFilter) => {
      setApplied(filter);
      setIncomplete(false);
      await load(filter, { offset: null, limit: null, expected: null }, false);
    },
    [load]
  );

  /** The page after the last record shown, expecting the first page's count. */
  const more = useCallback(async () => {
    if (applied === null || nextOffset === null || pageLimit === null) return;
    await load(applied, { offset: nextOffset, limit: pageLimit, expected: windowCount }, true);
  }, [applied, load, nextOffset, pageLimit, windowCount]);

  /** The refresh a page marked incomplete offers: the window from its start. */
  const refresh = useCallback(async () => {
    if (applied === null) return;
    await first(applied);
  }, [applied, first]);

  const loadModules = useCallback(async () => {
    try {
      const response = await fetch('/api/logs/modules');
      if (!response.ok) return;
      const value = (await response.json()) as {
        state: string;
        modules?: string[];
      };
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
    void first({
      from: new Date(range.from).getTime(),
      to: new Date(range.to).getTime(),
      module: '',
      level: '',
      conversation: '',
      text: '',
    });
  }, [first, loadModules]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', preference.matches);
    apply();
    preference.addEventListener('change', apply);
    return () => {
      preference.removeEventListener('change', apply);
    };
  }, []);

  function invalidText(field: string): string {
    if (field === 'range') return t('logsInvalidRange');
    const key = labelKeyOf(field);
    if (key === null) return t('logsInvalidParameter', { parameter: field });
    return t('logsInvalidFilter', { field: t(key) });
  }

  /** The one freshness line above the results, or null while nothing is wrong. */
  const collectionLine: string | null =
    status === null || status.collection.state === 'live'
      ? null
      : status.collection.state === 'unknown'
        ? t('logsCollectionUnknown')
        : t('logsCollectionStopped', {
            count: Math.max(1, Math.round((status.collection.stoppedForMs ?? 0) / 60_000)),
          });

  /**
   * The eviction notices and the records as one list. A window whose records an
   * eviction displaced entirely still has notices to draw, so the list is drawn
   * from the entries rather than the records.
   */
  const entries: LogsEntry[] =
    records === null ? [] : entriesWithNotices(records, status?.evictions ?? []);

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      setInvalid('range');
      return;
    }
    void first({
      from: fromMs,
      to: toMs,
      module: moduleName,
      level,
      conversation,
      text,
    });
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

        <LogsSettings />

        <Card>
          <CardContent className="p-4 sm:p-6">
            <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={submit}>
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
              <div className="space-y-2">
                <Label htmlFor="logs-level">{t('logsLevel')}</Label>
                <Select
                  value={level === '' ? ALL_LEVELS : level}
                  onValueChange={(value) => {
                    setLevel(value === ALL_LEVELS ? '' : value);
                  }}
                >
                  <SelectTrigger id="logs-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_LEVELS}>{t('logsAllLevels')}</SelectItem>
                    {LOGS_LEVELS.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="logs-conversation">{t('logsConversation')}</Label>
                <Input
                  id="logs-conversation"
                  value={conversation}
                  maxLength={LOGS_CONVERSATION_MAX_LENGTH}
                  placeholder={t('logsConversationPlaceholder')}
                  onChange={(event) => {
                    setConversation(event.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="logs-text">{t('logsText')}</Label>
                <Input
                  id="logs-text"
                  value={text}
                  maxLength={LOGS_TEXT_MAX_LENGTH}
                  placeholder={t('logsTextPlaceholder')}
                  onChange={(event) => {
                    setText(event.target.value);
                  }}
                />
              </div>
              <div className="flex items-end sm:col-span-2 lg:col-span-3">
                <Button className="w-full sm:w-auto" disabled={busy}>
                  {busy ? t('logsSearching') : t('logsSearch')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {invalid !== null && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{invalidText(invalid)}</AlertDescription>
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

        {incomplete && (
          <Alert role="status">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{t('logsIncomplete')}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void refresh();
                }}
              >
                {t('logsRefresh')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <p className="text-xs text-muted-foreground">{t('logsHelp')}</p>

        {collectionLine !== null && (
          <Alert role="status">
            <AlertDescription>{collectionLine}</AlertDescription>
          </Alert>
        )}

        {status?.storeReadOnly === true && (
          <Alert variant="destructive" role="status">
            <AlertDescription>{t('logsStoreReadOnly')}</AlertDescription>
          </Alert>
        )}

        {status?.evictor.stale === true && (
          <Alert variant="destructive" role="status">
            <AlertDescription>{t('logsEvictorStale')}</AlertDescription>
          </Alert>
        )}

        {records !== null && throttle !== null && <LogsThrottleStatus value={throttle} />}

        <section aria-live="polite" aria-busy={busy}>
          {records !== null && records.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('logsNoRecords')}</p>
          )}
          {entries.length > 0 && (
            <>
              {records !== null && records.length > 0 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  {t('logsRecordCount', { count: records.length })}
                </p>
              )}
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {entries.map((entry, position) => {
                  if (entry.kind === 'notice') {
                    const notice = entry.notice;
                    return (
                      <li
                        key={`notice-${notice.time}-${String(position)}`}
                        className="bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
                      >
                        <div role="note">
                          {t('logsEvictionNotice', {
                            date: noticeDate(notice.day ?? '', i18n.language),
                            time: new Date(notice.time).toLocaleString(i18n.language),
                            size:
                              notice.freedBytes === null
                                ? ''
                                : formatMiB(notice.freedBytes, i18n.language),
                          })}
                        </div>
                      </li>
                    );
                  }
                  const record = entry.record;
                  const recordLevel = fieldOf(record, 'level');
                  return (
                    <li key={`${record.time}-${String(position)}`} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <time dateTime={record.time}>
                          {new Date(record.time).toLocaleString(i18n.language)}
                        </time>
                        <Badge variant="secondary">{fieldOf(record, 'module') ?? '—'}</Badge>
                        {recordLevel !== undefined && (
                          <Badge variant="outline" className={levelClass(recordLevel)}>
                            {recordLevel}
                          </Badge>
                        )}
                        {fieldOf(record, 'untrusted') === 'true' && (
                          // The variant's 20% dark tint leaves this label at
                          // 3.02:1; 5% keeps it at 4.87:1 (WCAG AA).
                          <Badge variant="destructive" className="dark:bg-destructive/5">
                            {t('logsUntrusted')}
                          </Badge>
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
              {nextOffset !== null && windowCount !== null && nextOffset < windowCount && (
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void more();
                    }}
                  >
                    {t('logsMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
