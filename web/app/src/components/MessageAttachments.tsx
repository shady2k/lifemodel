import { Download, File } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@kit/components/ui/button';
import type { TranscriptMessage } from '../transport';

export function formatAttachmentSize(size: number, language: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  const unitIndex =
    size > 0 ? Math.max(0, Math.min(Math.floor(Math.log10(size) / 3), units.length - 1)) : 0;
  const formatter = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: units[unitIndex] ?? 'byte',
    unitDisplay: 'short',
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  });
  // CLDR's English short byte label is "byte", unlike the other unit symbols.
  return formatter
    .formatToParts(size / 1000 ** unitIndex)
    .map((part) => (part.type === 'unit' && part.value === 'byte' ? 'B' : part.value))
    .join('');
}

export function MessageAttachments({
  attachments,
}: {
  attachments: TranscriptMessage['attachments'];
}) {
  const { t, i18n } = useTranslation();
  if (!attachments?.length) return null;
  return (
    <ul aria-label={t('attachments')} className="mt-2 flex min-w-0 flex-col gap-2">
      {attachments.map((attachment) => {
        const size = formatAttachmentSize(attachment.size, i18n.language);
        return (
          <li key={attachment.artifactId} className="min-w-0">
            <Button
              asChild
              variant="outline"
              className="h-auto w-full min-w-0 justify-start gap-3 px-3 py-2 text-left whitespace-normal"
            >
              <a
                href={`/api/attachments/${encodeURIComponent(attachment.artifactId)}`}
                download={attachment.name}
                aria-label={t('downloadAttachment', { name: attachment.name, size })}
              >
                <File aria-hidden="true" className="size-5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="wrap-anywhere">{attachment.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">{size}</span>
                </span>
                <Download aria-hidden="true" className="size-4" />
              </a>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
