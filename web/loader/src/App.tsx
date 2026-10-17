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
interface Slot {
  kind: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  keySet: boolean;
}
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
];
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
  const [reserveKind, setReserveKind] = useState<'openai' | 'ollama'>('openai');
  const [reserveBaseUrl, setReserveBaseUrl] = useState('');
  const [reserveModel, setReserveModel] = useState('');
  const [reserveKey, setReserveKey] = useState('');
  const [kind, setKind] = useState<'openai' | 'ollama'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
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
    }
  }
  useEffect(() => {
    void i18n.changeLanguage(languageFor(navigator.language));
  }, []);
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
        body: JSON.stringify({ kind, baseUrl, model, ...(key ? { key } : {}) }),
      });
      if (!response.ok) {
        const value = (await response.json()) as { error?: string };
        const code = value.error ?? '';
        setError(codes.includes(code) ? `model_${code}` : 'setupError');
        return;
      }
      setKey('');
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
        }),
      });
      if (!response.ok) {
        const value = (await response.json()) as { error?: string };
        const code = value.error ?? '';
        setReserveError(codes.includes(code) ? `model_${code}` : 'setupError');
        return;
      }
      setReserveKey('');
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
    setError('');
    try {
      const response = await fetch('/api/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': state?.csrfToken ?? '' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? 'wrongCurrentPassword' : 'setupError');
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      await load();
      setError('passwordChanged');
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
              <section className="mt-8 space-y-4" aria-labelledby="password-change-title">
                <h2 id="password-change-title" className="text-lg font-semibold">
                  {t('changePassword')}
                </h2>
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
                      onChange={(e) => setCurrentPassword(e.target.value)}
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
                      onChange={(e) => setNewPassword(e.target.value)}
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
