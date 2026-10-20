import { useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Orbit } from 'lucide-react';
import { Button } from '@kit/components/ui/button';
import { Input } from '@kit/components/ui/input';
import { Card, CardContent } from '@kit/components/ui/card';
import { Label } from '@kit/components/ui/label';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kit/components/ui/select';

import i18n, { languageFor } from './i18n';
import { ModelStatus } from './ModelStatus';
import { parseModelStatus } from '../../../src/web/model-status.js';
import type { ModelStatusEvent } from '../../../src/web/contract.js';
import type {
  SettingDeclaration,
  SettingsSectionPayload,
} from '../../../loader/src/settings/registry.js';
interface Slot {
  kind: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  keySet: boolean;
  /** The stored header names only; a value never comes back from the loader. */
  headerNames?: string[];
}
interface HeaderRow {
  name: string;
  value: string;
}
/** What a stored header value looks like after save: the name, never the value. */
const MASKED_VALUE = '\u2022\u2022\u2022\u2022\u2022\u2022';
interface State {
  setupNeeded: boolean;
  loggedIn: boolean;
  csrfToken?: string;
  onboarding?: { step: string; completedAt: string | null };
  instanceName?: string;
  caFingerprint?: string;
}
const codes = [
  'unreachable',
  'tls',
  'timeout',
  'auth_failed',
  'model_not_found',
  'bad_response',
  'blocked_destination',
  'storage_unavailable',
  'header_shape_invalid',
  'header_name_invalid',
  'header_name_reserved',
  'header_value_invalid',
  'header_duplicate',
  'header_too_many',
];
/**
 * The slot's additional headers: a collapsed section with name/value rows,
 * add and remove. After a save the stored header names are listed with their
 * values masked - the loader never sends a value back (ADR-013, custom
 * headers).
 */
function HeaderFields(props: {
  id: string;
  rows: HeaderRow[];
  open: boolean;
  names: string[];
  onToggle: () => void;
  onChange: (rows: HeaderRow[]) => void;
}) {
  const { t } = useTranslation();
  const update = (index: number, field: keyof HeaderRow, text: string) => {
    props.onChange(
      props.rows.map((row, position) => (position === index ? { ...row, [field]: text } : row))
    );
  };
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" aria-expanded={props.open} onClick={props.onToggle}>
        {t('additionalHeaders')}
      </Button>
      {props.names.length > 0 && (
        <ul
          className="space-y-1 text-xs text-muted-foreground"
          aria-label={t('storedHeaders')}
          id={`${props.id}-stored`}
        >
          {props.names.map((name) => (
            <li key={name}>
              <strong>{name}</strong>: {MASKED_VALUE}
            </li>
          ))}
        </ul>
      )}
      {props.open && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground" id={`${props.id}-hint`}>
            {t('headersHint')}
          </p>
          {props.names.length > 0 && props.rows.length === 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                props.onChange([]);
              }}
            >
              {t('clearHeaders')}
            </Button>
          )}
          {props.rows.map((row, index) => (
            <div className="flex items-end gap-2" key={`${props.id}-row-${String(index)}`}>
              <div className="flex-1 space-y-1">
                <Label htmlFor={`${props.id}-name-${String(index)}`}>
                  {t('headerName', { number: index + 1 })}
                </Label>
                <Input
                  id={`${props.id}-name-${String(index)}`}
                  value={row.name}
                  onChange={(e) => {
                    update(index, 'name', e.target.value);
                  }}
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label htmlFor={`${props.id}-value-${String(index)}`}>
                  {t('headerValue', { number: index + 1 })}
                </Label>
                <Input
                  id={`${props.id}-value-${String(index)}`}
                  value={row.value}
                  onChange={(e) => {
                    update(index, 'value', e.target.value);
                  }}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  props.onChange(props.rows.filter((_, position) => position !== index));
                }}
              >
                {t('removeHeader', { number: index + 1 })}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              props.onChange([...props.rows, { name: '', value: '' }]);
            }}
          >
            {t('addHeader')}
          </Button>
        </div>
      )}
    </div>
  );
}
/**
 * One generated control (ADR-014 D6): the declaration alone decides what is
 * rendered and how a value is checked; the code switches on the control kind,
 * never on a setting's name.
 */
const BYTE_UNITS: readonly { limit: number; suffix: { en: string; ru: string } }[] = [
  { limit: 1e12, suffix: { en: 'TB', ru: 'ТБ' } },
  { limit: 1e9, suffix: { en: 'GB', ru: 'ГБ' } },
  { limit: 1e6, suffix: { en: 'MB', ru: 'МБ' } },
  { limit: 1e3, suffix: { en: 'kB', ru: 'кБ' } },
];

/**
 * A decimal byte count a person can read: 20000000000 renders as '20 GB' in
 * English and '20 ГБ' in Russian, with the language's decimal separator.
 */
export function formatDecimalBytes(value: number, language: 'en' | 'ru'): string {
  for (const unit of BYTE_UNITS) {
    if (value >= unit.limit) {
      const scaled = value / unit.limit;
      const text = Number.isInteger(scaled)
        ? String(scaled)
        : scaled.toLocaleString(language, { maximumFractionDigits: 1 });
      return `${text} ${unit.suffix[language]}`;
    }
  }
  return `${String(value)} ${language === 'ru' ? 'Б' : 'B'}`;
}

/** The fixed text of a read-only setting's value; never an input. */
function fixedSettingText(
  value: boolean | number | string,
  declaration: SettingDeclaration,
  language: 'en' | 'ru',
  labels: { on: string; off: string }
): string {
  if (declaration.control === 'number') {
    if (declaration.format === 'bytes' && typeof value === 'number')
      return formatDecimalBytes(value, language);
    return String(value);
  }
  if (declaration.control === 'select') {
    const option = declaration.options?.find((candidate) => candidate.value === value);
    return option ? option.label[language] : String(value);
  }
  if (declaration.control === 'toggle') return value === true ? labels.on : labels.off;
  return String(value);
}

function SettingControl(props: {
  declaration: SettingDeclaration;
  value: boolean | number | string;
  language: 'en' | 'ru';
  csrfToken: string;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const declaration = props.declaration;
  const [draft, setDraft] = useState(String(props.value));
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const label = declaration.label[props.language];
  const description = declaration.description[props.language];
  async function save(value: boolean | number | string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/settings/${declaration.key}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': props.csrfToken },
        body: JSON.stringify({ value }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          reasonCode?: string;
          limit?: number;
        };
        setError(refusalText(t, declaration, body));
        return;
      }
      setStatus(t('settingsSaved'));
      await props.onSaved();
    } catch {
      setError(t('settingsSaveFailed'));
    } finally {
      setBusy(false);
    }
  }
  const [busy, setBusy] = useState(false);
  if (declaration.readOnly)
    return (
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
        <p className="text-sm font-medium">
          {fixedSettingText(props.value, declaration, props.language, {
            on: t('settingsOn'),
            off: t('settingsOff'),
          })}
        </p>
      </div>
    );
  if (declaration.control === 'secret')
    return (
      <div className="space-y-1">
        <Label htmlFor={`${declaration.key}-value`}>{label}</Label>
        <p className="text-xs text-muted-foreground">{t('settingsSecretNote')}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    );
  return (
    <form
      className="space-y-2"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (declaration.control === 'number') {
          const parsed = Number(draft);
          void save(Number.isFinite(parsed) && draft.trim() !== '' ? parsed : draft);
        } else {
          void save(draft);
        }
      }}
    >
      <Label htmlFor={`${declaration.key}-value`}>{label}</Label>
      <p className="text-xs text-muted-foreground">{description}</p>
      {declaration.control === 'number' && (
        <div className="flex items-end gap-2">
          <Input
            id={`${declaration.key}-value`}
            type="number"
            {...(declaration.min === undefined ? {} : { min: declaration.min })}
            {...(declaration.max === undefined ? {} : { max: declaration.max })}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setStatus('');
            }}
          />
          {declaration.unit && (
            <span className="text-sm text-muted-foreground">
              {declaration.unit[props.language]}
            </span>
          )}
          <Button type="submit" disabled={busy}>
            {t('settingsSave')}
          </Button>
        </div>
      )}
      {declaration.control === 'toggle' && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-pressed={props.value === true}
            disabled={busy}
            onClick={() => {
              void save(!(props.value === true));
            }}
          >
            {props.value === true ? t('settingsOn') : t('settingsOff')}
          </Button>
        </div>
      )}
      {declaration.control === 'select' && (
        <div className="flex items-end gap-2">
          <Select
            value={draft}
            onValueChange={(value) => {
              setDraft(value);
              setStatus('');
            }}
          >
            <SelectTrigger id={`${declaration.key}-value`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(declaration.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label[props.language]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={busy}>
            {t('settingsSave')}
          </Button>
        </div>
      )}
      {declaration.control === 'text' && (
        <div className="flex items-end gap-2">
          <Input
            id={`${declaration.key}-value`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setStatus('');
            }}
          />
          <Button type="submit" disabled={busy}>
            {t('settingsSave')}
          </Button>
        </div>
      )}
      {status && (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** The declaration's refusal, localized from the response's code and limits. */
function refusalText(
  t: (key: string, options?: Record<string, unknown>) => string,
  declaration: SettingDeclaration,
  body: { error?: string; reasonCode?: string; limit?: number }
): string {
  if (body.error === 'unknown_setting') return t('settingsUnknownSetting');
  if (body.error === 'secret_setting') return t('settingsSecretNote');
  if (body.error === 'invalid_value') {
    if (body.reasonCode === 'read_only') return t('settingsReadOnly');
    if (body.reasonCode === 'below_minimum')
      return t('settingsBelowMinimum', { limit: body.limit ?? declaration.min });
    if (body.reasonCode === 'above_maximum')
      return t('settingsAboveMaximum', { limit: body.limit ?? declaration.max });
    if (body.reasonCode === 'not_an_option') return t('settingsNotAnOption');
    if (body.reasonCode === 'empty') return t('settingsEmpty');
    return t('settingsInvalidValue');
  }
  return t('settingsSaveFailed');
}

export default function App() {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(null);
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [slot, setSlot] = useState<Slot>({ kind: 'openai', baseUrl: '', model: '', keySet: false });
  const [reserve, setReserve] = useState<Slot | null>(null);
  const [reserveOpen, setReserveOpen] = useState(false);
  const [reserveError, setReserveError] = useState('');
  const [passwordStatus, setPasswordStatus] = useState('');
  const [reserveKind, setReserveKind] = useState<'openai' | 'ollama'>('openai');
  const [reserveBaseUrl, setReserveBaseUrl] = useState('');
  const [reserveModel, setReserveModel] = useState('');
  const [reserveKey, setReserveKey] = useState('');
  const [kind, setKind] = useState<'openai' | 'ollama'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [headersOpen, setHeadersOpen] = useState(false);
  // Whether the owner touched the section: an untouched section sends no
  // header list, so the stored one is kept (the rule the key follows);
  // removing every row sends an empty list and clears it explicitly.
  const [headersEdited, setHeadersEdited] = useState(false);
  const [reserveHeaderRows, setReserveHeaderRows] = useState<HeaderRow[]>([]);
  const [reserveHeadersOpen, setReserveHeadersOpen] = useState(false);
  const [reserveHeadersEdited, setReserveHeadersEdited] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelStatusEvent | null>();
  const [settingsSection, setSettingsSection] = useState<SettingsSectionPayload | null>(null);
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  // A slot saved in this page session: an `unknown` state then says so.
  const [slotSaved, setSlotSaved] = useState(false);
  async function load() {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('state');
    const value = (await r.json()) as State;
    if (typeof value.setupNeeded !== 'boolean' || typeof value.loggedIn !== 'boolean')
      throw new Error('state');
    setState(value);
    if (value.loggedIn) {
      const models = await fetch('/api/model', { cache: 'no-store' });
      if (!models.ok) {
        const body = (await models.json().catch(() => ({}))) as { error?: string };
        const code = body.error ?? '';
        setError(codes.includes(code) ? `model_${code}` : 'setupError');
      } else {
        const data = (await models.json()) as { primary: Slot | null; reserve: Slot | null };
        if (data.primary) {
          setSlot(data.primary);
          setKind(data.primary.kind);
          setBaseUrl(data.primary.baseUrl);
          setModel(data.primary.model);
        }
        setReserve(data.reserve);
        if (data.reserve) {
          setReserveKind(data.reserve.kind);
          setReserveBaseUrl(data.reserve.baseUrl);
          setReserveModel(data.reserve.model);
        }
      }
      try {
        const settingsResponse = await fetch('/api/settings', { cache: 'no-store' });
        if (!settingsResponse.ok) throw new Error('settings');
        const section = (await settingsResponse.json()) as SettingsSectionPayload;
        if (
          !Array.isArray(section.declarations) ||
          typeof section.values !== 'object' ||
          section.values === null ||
          typeof section.revision !== 'number' ||
          !Array.isArray(section.problems) ||
          typeof section.projection?.state !== 'string'
        )
          throw new Error('settings');
        setSettingsSection(section);
        setSettingsLoadFailed(false);
      } catch {
        setSettingsLoadFailed(true);
      }
    }
  }
  useEffect(() => {
    void i18n.changeLanguage(languageFor(navigator.language));
  }, []);
  useEffect(() => {
    if (state?.loggedIn !== true) return;
    let active = true;
    const read = async () => {
      try {
        const response = await fetch('/api/model-status', { cache: 'no-store' });
        if (!response.ok) throw new Error('status');
        const value: unknown = await response.json();
        if (!active) return;
        const parsed = parseModelStatus(value);
        setModelStatus(parsed);
        // The projection has no lastSuccessAt: even an ok poll can describe a
        // pre-save request. Keep the save fact for this page session; only an
        // unknown state displays it, never ok/down/unavailable.
      } catch {
        // No status is readable: the settings show the quiet unavailable line.
        if (active) setModelStatus(null);
      }
    };
    void read();
    const timer = window.setInterval(() => {
      void read();
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [state?.loggedIn]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', preference.matches);
    apply();
    preference.addEventListener('change', apply);
    return () => {
      preference.removeEventListener('change', apply);
    };
  }, []);
  useEffect(() => {
    void load().catch(() => {
      setError('setupError');
    });
  }, []);
  async function submitPassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = new URLSearchParams(window.location.search).get('next');
      const response = await fetch(state?.setupNeeded ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, ...(next ? { next } : {}) }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? t('wrong') : t('setupError'));
        return;
      }
      const result = (await response.json().catch(() => ({}))) as { redirectTo?: string };
      if (result.redirectTo) {
        window.location.assign(result.redirectTo);
        return;
      }
      await load();
      setPassword('');
    } catch {
      setError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  async function saveModel(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/model/primary', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state?.csrfToken ?? '' },
        body: JSON.stringify({
          kind,
          baseUrl,
          model,
          ...(key ? { key } : {}),
          ...(headersEdited ? { headers: headerRows } : {}),
        }),
      });
      if (!response.ok) {
        const value = (await response.json()) as { error?: string };
        const code = value.error ?? '';
        setError(codes.includes(code) ? `model_${code}` : 'setupError');
        return;
      }
      setKey('');
      setHeaderRows([]);
      setHeadersEdited(false);
      setSlotSaved(true);
      await load();
    } catch {
      setError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  async function saveReserve(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setReserveError('');
    try {
      const response = await fetch('/api/model/reserve', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state?.csrfToken ?? '' },
        body: JSON.stringify({
          kind: reserveKind,
          baseUrl: reserveBaseUrl,
          model: reserveModel,
          ...(reserveKey ? { key: reserveKey } : {}),
          ...(reserveHeadersEdited ? { headers: reserveHeaderRows } : {}),
        }),
      });
      if (!response.ok) {
        const value = (await response.json()) as { error?: string };
        const code = value.error ?? '';
        setReserveError(codes.includes(code) ? `model_${code}` : 'setupError');
        return;
      }
      setReserveKey('');
      setReserveHeaderRows([]);
      setReserveHeadersEdited(false);
      setReserve(null);
      setReserveKind('openai');
      setReserveBaseUrl('');
      setReserveModel('');
      setSlotSaved(true);
      await load();
    } catch {
      setReserveError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  async function removeReserve() {
    setBusy(true);
    setReserveError('');
    try {
      const response = await fetch('/api/model/reserve', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state?.csrfToken ?? '' },
        body: '{}',
      });
      if (!response.ok) {
        setReserveError(t('setupError'));
        return;
      }
      setReserve(null);
      setReserveKind('openai');
      setReserveBaseUrl('');
      setReserveModel('');
      setReserveKey('');
      setReserveHeaderRows([]);
      setReserveHeadersEdited(false);
      await load();
    } catch {
      setReserveError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  async function acknowledge() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/onboarding/device', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state?.csrfToken ?? '' },
        body: '{}',
      });
      if (!response.ok) {
        setError(t('setupError'));
        return;
      }
      await load();
    } catch {
      setError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setPasswordStatus('');
    try {
      const response = await fetch('/api/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state?.csrfToken ?? '' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        setPasswordStatus(response.status === 401 ? 'wrongCurrentPassword' : 'setupError');
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      await load();
      setPasswordStatus('passwordChanged');
    } catch {
      setError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': state?.csrfToken ?? '', 'content-type': 'application/json' },
      body: '{}',
    });
    window.location.reload();
  }
  if (!state)
    return (
      <main className="grid min-h-svh place-items-center text-muted-foreground" aria-live="polite">
        {error ? t(error) : t('loading')}
      </main>
    );
  const step = state.loggedIn
    ? (state.onboarding?.step ?? 'done')
    : state.setupNeeded
      ? (state.onboarding?.step ?? 'welcome')
      : 'password';
  const instanceName = state.instanceName ?? 'lifemodel';
  const appUrl = `https://${instanceName}.local/`;
  const handoffUrl = `https://boot-${instanceName}.local/login?next=${encodeURIComponent(appUrl)}`;
  const settingsLanguage: 'en' | 'ru' = i18n.language === 'ru' ? 'ru' : 'en';
  const settingsGroups: [string, SettingDeclaration[]][] = [];
  if (settingsSection !== null)
    for (const declaration of settingsSection.declarations) {
      const last = settingsGroups.at(-1);
      if (last?.[0] === declaration.section) last[1].push(declaration);
      else settingsGroups.push([declaration.section, [declaration]]);
    }
  const sectionTitle = (id: string) => (i18n.exists(`section_${id}`) ? t(`section_${id}`) : id);
  return (
    <main className="relative grid min-h-svh place-items-center bg-background px-5 py-16 text-foreground">
      <div className="absolute right-5 top-5 flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void i18n.changeLanguage('en');
          }}
          aria-label={t('en')}
        >
          EN
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void i18n.changeLanguage('ru');
          }}
          aria-label={t('ru')}
        >
          RU
        </Button>
      </div>
      <Card className="w-full max-w-xl">
        <CardContent className="p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Orbit aria-hidden="true" className="size-6" />
            </span>
            <span className="text-lg font-semibold tracking-tight">{t('brand')}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t(
              step === 'welcome'
                ? 'welcomeTitle'
                : step === 'password'
                  ? state.setupNeeded
                    ? 'setupTitle'
                    : 'loginTitle'
                  : step === 'model'
                    ? 'modelTitle'
                    : step === 'device'
                      ? 'deviceTitle'
                      : step === 'done'
                        ? 'doneTitle'
                        : 'settingsTitle'
            )}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(
              step === 'welcome'
                ? 'welcomeDescription'
                : step === 'password'
                  ? 'description'
                  : step === 'model'
                    ? 'modelDescription'
                    : step === 'device'
                      ? 'deviceDescription'
                      : step === 'done'
                        ? 'doneDescription'
                        : 'settingsDescription'
            )}
          </p>
          {error && (
            <Alert className="mt-5" variant="destructive" role="alert">
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          {step === 'welcome' && (
            <Button
              className="mt-6 w-full"
              onClick={() => {
                setState({
                  ...state,
                  setupNeeded: true,
                  loggedIn: false,
                  onboarding: { step: 'password', completedAt: null },
                });
              }}
            >
              {t('begin')}
            </Button>
          )}
          {step === 'password' && (
            <form
              className="mt-8 space-y-5"
              onSubmit={(e) => {
                void submitPassword(e);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="password">{t('password')}</Label>
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={state.setupNeeded ? 'new-password' : 'current-password'}
                  required
                  minLength={state.setupNeeded ? 12 : 1}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                />
                {state.setupNeeded && (
                  <p className="text-xs text-muted-foreground">{t('minimumPassword')}</p>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={showPassword}
                  onClick={() => {
                    setShowPassword(!showPassword);
                  }}
                >
                  {t(showPassword ? 'hidePassword' : 'showPassword')}
                </Button>
              </div>
              <Button className="w-full" disabled={busy}>
                {busy ? t('loading') : t('confirm')}
              </Button>
            </form>
          )}
          {(step === 'model' || step === 'done') && (
            <>
              {step === 'done' && (
                <h2 className="mt-8 text-lg font-semibold">{t('modelAccess')}</h2>
              )}
              <form
                className="mt-6 space-y-4"
                onSubmit={(e) => {
                  void saveModel(e);
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="kind">{t('kind')}</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      setKind(value as 'openai' | 'ollama');
                    }}
                  >
                    <SelectTrigger id="kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI compatible</SelectItem>
                      <SelectItem value="ollama">Ollama</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="url">{t('baseUrl')}</Label>
                  <Input
                    id="url"
                    required
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="model">{t('model')}</Label>
                  <Input
                    id="model"
                    required
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="key">{t('key')}</Label>
                  <Input
                    id="key"
                    type="password"
                    autoComplete="new-password"
                    placeholder={slot.keySet ? t('keySet') : ''}
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {slot.keySet ? t('keySet') : t('keyOptional')}
                  </p>
                </div>
                <HeaderFields
                  id="primary-headers"
                  rows={headerRows}
                  open={headersOpen}
                  names={slot.headerNames ?? []}
                  onToggle={() => {
                    setHeadersOpen(!headersOpen);
                  }}
                  onChange={(rows) => {
                    setHeaderRows(rows);
                    setHeadersEdited(true);
                  }}
                />
                <Button disabled={busy}>{busy ? t('checking') : t('checkSave')}</Button>
              </form>
              <div className="mt-8">
                <Button
                  type="button"
                  variant="outline"
                  aria-expanded={reserveOpen}
                  onClick={() => {
                    setReserveOpen(!reserveOpen);
                  }}
                >
                  {t('reserve')}
                </Button>
                {reserveOpen && (
                  <div>
                    <p className="mt-2 text-sm">
                      {reserve ? t('reserveSet') : t('reserveOptional')}
                    </p>
                    {reserveError && (
                      <Alert className="mt-4" variant="destructive" role="alert">
                        <AlertDescription>{t(reserveError)}</AlertDescription>
                      </Alert>
                    )}
                    <form
                      className="mt-4 space-y-4"
                      onSubmit={(e) => {
                        void saveReserve(e);
                      }}
                    >
                      <div className="space-y-2">
                        <Label htmlFor="reserve-kind">{t('kind')}</Label>
                        <Select
                          value={reserveKind}
                          onValueChange={(value) => {
                            setReserveKind(value as 'openai' | 'ollama');
                          }}
                        >
                          <SelectTrigger id="reserve-kind">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="openai">OpenAI compatible</SelectItem>
                            <SelectItem value="ollama">Ollama</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="reserve-url">{t('baseUrl')}</Label>
                        <Input
                          id="reserve-url"
                          required
                          value={reserveBaseUrl}
                          onChange={(e) => {
                            setReserveBaseUrl(e.target.value);
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="reserve-model">{t('model')}</Label>
                        <Input
                          id="reserve-model"
                          required
                          value={reserveModel}
                          onChange={(e) => {
                            setReserveModel(e.target.value);
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="reserve-key">{t('key')}</Label>
                        <Input
                          id="reserve-key"
                          type="password"
                          autoComplete="new-password"
                          placeholder={reserve?.keySet ? t('keySet') : ''}
                          value={reserveKey}
                          onChange={(e) => {
                            setReserveKey(e.target.value);
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          {reserve?.keySet ? t('keySet') : t('keyOptional')}
                        </p>
                      </div>
                      <HeaderFields
                        id="reserve-headers"
                        rows={reserveHeaderRows}
                        open={reserveHeadersOpen}
                        names={reserve?.headerNames ?? []}
                        onToggle={() => {
                          setReserveHeadersOpen(!reserveHeadersOpen);
                        }}
                        onChange={(rows) => {
                          setReserveHeaderRows(rows);
                          setReserveHeadersEdited(true);
                        }}
                      />
                      <Button disabled={busy}>{busy ? t('checking') : t('checkSave')}</Button>
                      {reserve && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            void removeReserve();
                          }}
                        >
                          {t('removeReserve')}
                        </Button>
                      )}
                    </form>
                  </div>
                )}
              </div>
            </>
          )}
          {step === 'done' && (
            <>
              <section className="mt-8 space-y-4" aria-labelledby="model-access-title">
                <h2 id="model-access-title" className="text-lg font-semibold">
                  {t('modelAccess')}
                </h2>
                {modelStatus !== undefined && <ModelStatus value={modelStatus} saved={slotSaved} />}
              </section>
              <section className="mt-8 space-y-4" aria-labelledby="platform-settings-title">
                <h2 id="platform-settings-title" className="text-lg font-semibold">
                  {t('platformSettings')}
                </h2>
                {settingsLoadFailed && (
                  <Alert role="status">
                    <AlertDescription>{t('settingsLoadFailed')}</AlertDescription>
                  </Alert>
                )}
                {settingsSection !== null && (
                  <>
                    {settingsSection.problems.length > 0 && (
                      <Alert role="status">
                        <AlertDescription>
                          <p>{t('settingsProblemsHeading')}</p>
                          <ul className="list-disc space-y-1 pl-5 text-sm">
                            {settingsSection.problems.map((problem, index) => (
                              <li key={`${problem.key ?? 'file'}-${String(index)}`}>
                                {problem.reason}
                              </li>
                            ))}
                          </ul>
                        </AlertDescription>
                      </Alert>
                    )}
                    {settingsSection.projection.state === 'failed' && (
                      <Alert role="status">
                        <AlertDescription>{t('settingsProjectionFailed')}</AlertDescription>
                      </Alert>
                    )}
                    {settingsGroups.map(([id, declarations]) => (
                      <div key={id} className="space-y-4">
                        <h3 className="text-base font-semibold">{sectionTitle(id)}</h3>
                        {declarations.map((declaration) => (
                          <SettingControl
                            key={declaration.key}
                            declaration={declaration}
                            value={
                              settingsSection.values[declaration.key] ?? declaration.default ?? ''
                            }
                            language={settingsLanguage}
                            csrfToken={state?.csrfToken ?? ''}
                            onSaved={async () => {
                              await load();
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </>
                )}
              </section>
              <section className="mt-8 space-y-4" aria-labelledby="password-change-title">
                <h2 id="password-change-title" className="text-lg font-semibold">
                  {t('changePassword')}
                </h2>
                {passwordStatus && (
                  <Alert
                    className="mb-4"
                    variant={passwordStatus === 'passwordChanged' ? 'default' : 'destructive'}
                    role="status"
                  >
                    <AlertDescription>{t(passwordStatus)}</AlertDescription>
                  </Alert>
                )}
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    void changePassword(e);
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="current-password">{t('currentPassword')}</Label>
                    <Input
                      id="current-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={currentPassword}
                      onChange={(e) => {
                        setCurrentPassword(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-password">{t('newPassword')}</Label>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      required
                      value={newPassword}
                      onChange={(e) => {
                        setNewPassword(e.target.value);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('minimumPassword')}</p>
                  </div>
                  <Button disabled={busy}>{busy ? t('loading') : t('changePassword')}</Button>
                </form>
              </section>
              <section className="mt-8 space-y-3" aria-labelledby="certificate-title">
                <h2 id="certificate-title" className="text-lg font-semibold">
                  {t('certificate')}
                </h2>
                <p className="text-sm">
                  <strong>{t('fingerprint')}: </strong>
                  <code className="break-all">
                    {state.caFingerprint ?? t('fingerprintUnavailable')}
                  </code>
                </p>
                <Button asChild variant="link">
                  <a href="/ca.crt" download>
                    {t('downloadCa')}
                  </a>
                </Button>
              </section>
              <div className="mt-6">
                <a href={handoffUrl}>
                  <Button asChild variant="outline">
                    <span>{t('openChat')}</span>
                  </Button>
                </a>
              </div>
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => {
                  void logout();
                }}
              >
                {t('logout')}
              </Button>
            </>
          )}
          {step === 'device' && (
            <div className="mt-6 space-y-4">
              <p>
                <strong>{t('address')}: </strong>
                <code>{appUrl}</code>
              </p>
              <p>
                <strong>{t('fingerprint')}: </strong>
                <code className="break-all">
                  {state.caFingerprint ?? t('fingerprintUnavailable')}
                </code>
              </p>
              <Button asChild variant="link">
                <a href="/ca.crt" download>
                  {t('downloadCa')}
                </a>
              </Button>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {(['windows', 'macos', 'linux', 'ios', 'android'] as const).map((os) => (
                  <li key={os}>
                    <strong>{t(os)}:</strong> {t(`${os}Steps`)}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => {
                  void acknowledge();
                }}
              >
                {t('continue')}
              </Button>
            </div>
          )}
          {step !== 'welcome' && step !== 'password' && step !== 'done' && (
            <Button
              className="mt-8"
              variant="outline"
              onClick={() => {
                void logout();
              }}
            >
              {t('logout')}
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
