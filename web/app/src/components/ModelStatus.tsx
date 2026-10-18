import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import { Badge } from '@kit/components/ui/badge';
import {
  MODEL_STATUS_OUTAGE_KEY,
  MODEL_STATUS_UNAVAILABLE_KEY,
  modelStatusView,
} from '../../../../src/web/model-status.js';
import type { ModelStatusEvent } from '../../../../src/web/contract.js';

/**
 * The model's connection in "Сейчас" (ADR-013 D6): an outage with its local
 * time and the error in words, a quieter line when no status could be read,
 * and nothing while the model answers.
 */
export function ModelStatus({ value, now }: { value: ModelStatusEvent | null; now?: number }) {
  const { t, i18n } = useTranslation();
  const [clock, setClock] = useState(() => now ?? Date.now());
  useEffect(() => {
    if (now !== undefined) {
      setClock(now);
      return;
    }
    // An outage that began on an earlier day shows its date; re-read the clock
    // so the line stays right across midnight.
    const timer = window.setInterval(() => {
      setClock(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [now]);
  const view = modelStatusView(value, i18n.language, clock);
  if (view.kind === 'hidden') return null;
  if (view.kind === 'unavailable')
    return (
      <Badge variant="outline" className="text-muted-foreground" role="status" aria-live="polite">
        {t(MODEL_STATUS_UNAVAILABLE_KEY)}
      </Badge>
    );
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertDescription>
        {t(MODEL_STATUS_OUTAGE_KEY, { time: view.time, error: t(view.errorKey) })}
      </AlertDescription>
    </Alert>
  );
}
