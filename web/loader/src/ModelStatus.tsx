import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@kit/components/ui/alert';
import { Badge } from '@kit/components/ui/badge';
import {
  MODEL_STATUS_OUTAGE_KEY,
  MODEL_STATUS_UNAVAILABLE_KEY,
  modelStatusView,
} from '../../../src/web/model-status.js';
import type { ModelStatusEvent } from '../../../src/web/contract.js';

/**
 * The model's connection in the loader's settings (ADR-013 D6): the same line
 * and the same wording as the chat's "Сейчас" panel.
 */
export function ModelStatus({ value }: { value: ModelStatusEvent | null }) {
  const { t, i18n } = useTranslation();
  const view = modelStatusView(value, i18n.language, Date.now());
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
