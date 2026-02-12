/**
 * Markdown → Telegram HTML converter.
 *
 * Converts common LLM markdown output to Telegram-safe HTML.
 * Handles: bold, italic, strikethrough, inline code, code blocks,
 * links, and unordered lists. Escapes HTML entities first to prevent
 * injection from LLM output.
 *
 * Falls back to plain text (HTML-escaped) if conversion throws.
 */

/**
 * Escape HTML special characters so raw LLM text is safe inside HTML.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert markdown-formatted text to Telegram-compatible HTML.
 *
 * Conversion order matters — code blocks and inline code are extracted
 * first (as placeholders) so their contents aren't processed by
 * bold/italic/link rules.
 *
 * Returns plain HTML-escaped text if anything goes wrong.
 */
export function markdownToTelegramHtml(md: string): string {
  try {
    return convert(md);
  } catch {
    // Fallback: return HTML-escaped plain text
    return escapeHtml(md);
  }
}

function convert(md: string): string {
  // Placeholder storage for code blocks / inline code
  const placeholders: string[] = [];
  function placeholder(html: string): string {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\u2060PH${String(idx)}\u2060`;
  }

  let text = md;

  // 1. Extract fenced code blocks BEFORE escaping
  //    ```lang\ncode\n``` → <pre><code class="language-lang">escaped</code></pre>
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''));
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return placeholder(`<pre><code${cls}>${escaped}</code></pre>`);
  });

  // 1b. Convert markdown tables to monospace <pre> blocks
  //     Telegram doesn't render markdown tables — use fixed-width code block
  text = text.replace(/(?:^|\n)((?:\|[^\n]+\|\n?)+)/g, (_m, tableBlock: string) => {
    const rows = tableBlock
      .trim()
      .split('\n')
      .filter((r) => r.trim().length > 0);
    // Must have at least header + separator + 1 data row
    // Separator row looks like |---|---| or | :---: | --- |
    const sepIdx = rows.findIndex((r) => /^\|[\s:]*-{2,}[\s:|-]*\|$/.test(r.trim()));
    if (sepIdx < 1 || rows.length < sepIdx + 2) return _m; // not a valid table

    // Parse cells (drop separator row)
    const dataRows = rows.filter((_, i) => i !== sepIdx);
    const parsed = dataRows.map((r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
    );

    // Compute column widths
    const colCount = Math.max(...parsed.map((r) => r.length));
    const widths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      widths.push(Math.max(...parsed.map((r) => (r[c] ?? '').length), 1));
    }

    // Format aligned rows
    const formatted = parsed.map((cells) =>
      cells.map((cell, c) => cell.padEnd(widths[c] ?? 1)).join('  ')
    );

    return placeholder(`<pre>${escapeHtml(formatted.join('\n'))}</pre>`);
  });

  // 2. Extract inline code BEFORE escaping
  //    `code` → <code>escaped</code>
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    return placeholder(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. Now escape remaining HTML entities
  text = escapeHtml(text);

  // 4. Links: [text](url) → <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${url}">${label}</a>`;
  });

  // 5. Bold + italic: ***text*** or ___text___
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<b><i>$1</i></b>');
  text = text.replace(/_{3}(.+?)_{3}/g, '<b><i>$1</i></b>');

  // 6. Bold: **text** or __text__
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>');
  text = text.replace(/_{2}(.+?)_{2}/g, '<b>$1</b>');

  // 7. Italic: *text* or _text_
  //    Negative lookbehind for word chars prevents matching mid_word_underscores
  text = text.replace(/\*(.+?)\*/g, '<i>$1</i>');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

  // 8. Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 9. Unordered list items: lines starting with "- " or "• "
  //    Convert to simple "• " prefix (Telegram doesn't support <ul>/<li>)
  text = text.replace(/^[-•] +/gm, '• ');

  // 10. Restore placeholders
  text = text.replace(/\u2060PH(\d+)\u2060/g, (_m, idx: string) => {
    return placeholders[parseInt(idx, 10)] ?? '';
  });

  return text;
}
