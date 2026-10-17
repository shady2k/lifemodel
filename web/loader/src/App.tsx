import { useEffect, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Orbit } from 'lucide-react';
import { Button } from '@kit/components/ui/button';
import { Input } from '@kit/components/ui/input';
import { Card, CardContent } from '@kit/components/ui/card';
import { Label } from '@kit/components/ui/label';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import i18n, { languageFor } from './i18n';
interface State {
  setupNeeded: boolean;
  loggedIn: boolean;
  csrfToken?: string;
  onboarding?: { step: string; completedAt: string | null };
}
export default function App() {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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
    void fetch('/api/state', { cache: 'no-store' })
      .then(async (r): Promise<unknown> => {
        if (!r.ok) throw new Error('state');
        return (await r.json()) as unknown;
      })
      .then((value: unknown) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as State).setupNeeded !== 'boolean' ||
          typeof (value as State).loggedIn !== 'boolean'
        )
          throw new Error('state');
        setState(value as State);
      })
      .catch(() => {
        setError('setupError');
      });
  }, []);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(state?.setupNeeded ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password,
          next: new URLSearchParams(window.location.search).get('next') ?? undefined,
        }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? t('wrong') : t('setupError'));
        return;
      }
      const result = (await response.json()) as { redirectTo?: string };
      window.location.assign(result.redirectTo ?? '/');
    } catch {
      setError(t('setupError'));
    } finally {
      setBusy(false);
    }
  }
  if (state?.loggedIn)
    return (
      <main className="grid min-h-svh place-items-center bg-background px-5 text-foreground">
        <Card className="w-full max-w-md">
          <CardContent className="p-8">
            <h1 className="text-2xl font-semibold">{t('settingsTitle')}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t('settingsDescription')}</p>
            <Button
              className="mt-6"
              onClick={() => {
                void (async () => {
                  await fetch('/api/logout', {
                    method: 'POST',
                    headers: {
                      'x-csrf-token': state.csrfToken ?? '',
                      'content-type': 'application/json',
                    },
                  });
                  window.location.reload();
                })();
              }}
            >
              {t('logout')}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  if (!state)
    return (
      <main className="grid min-h-svh place-items-center text-muted-foreground" aria-live="polite">
        {error ? t(error) : t('loading')}
      </main>
    );
  return (
    <main className="relative grid min-h-svh place-items-center bg-background px-5 text-foreground">
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
      <Card className="w-full max-w-md">
        <CardContent className="p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Orbit aria-hidden="true" className="size-6" />
            </span>
            <span className="text-lg font-semibold tracking-tight">{t('brand')}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {state.setupNeeded ? t('setupTitle') : t('loginTitle')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('description')}</p>
          <form
            className="mt-8 space-y-5"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Input
                id="password"
                name="password"
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
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button className="w-full" disabled={busy}>
              {busy ? t('loading') : t('confirm')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
