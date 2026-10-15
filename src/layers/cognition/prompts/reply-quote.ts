/** Render a reply quote as inert, explicitly untrusted prompt data. */
export interface ReplyQuote {
  sequence: string;
  role: 'user' | 'assistant';
  excerpt: string;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderReplyQuote(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const quote = value as Partial<ReplyQuote>;
  if (
    typeof quote.sequence !== 'string' ||
    !/^[0-9]+$/.test(quote.sequence) ||
    (quote.role !== 'user' && quote.role !== 'assistant') ||
    typeof quote.excerpt !== 'string'
  )
    return '';
  return `<quoted_message role="${escapeAttribute(quote.role)}" sequence="${escapeAttribute(quote.sequence)}">${escapeText(quote.excerpt.slice(0, 280))}</quoted_message>`;
}
