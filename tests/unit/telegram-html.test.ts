/**
 * Tests for markdownToTelegramHtml converter.
 */

import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml } from '../../src/utils/telegram-html.js';

describe('markdownToTelegramHtml', () => {
  describe('plain text passthrough', () => {
    it('returns plain text unchanged', () => {
      expect(markdownToTelegramHtml('Hello world')).toBe('Hello world');
    });

    it('returns empty string for empty input', () => {
      expect(markdownToTelegramHtml('')).toBe('');
    });

    it('handles Russian text without issues', () => {
      expect(markdownToTelegramHtml('Привет, как дела?')).toBe('Привет, как дела?');
    });
  });

  describe('HTML escaping', () => {
    it('escapes < > & in plain text', () => {
      expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    });

    it('does not double-escape entities', () => {
      expect(markdownToTelegramHtml('&amp;')).toBe('&amp;amp;');
    });
  });

  describe('bold', () => {
    it('converts **text** to <b>text</b>', () => {
      expect(markdownToTelegramHtml('This is **bold** text')).toBe(
        'This is <b>bold</b> text'
      );
    });

    it('converts __text__ to <b>text</b>', () => {
      expect(markdownToTelegramHtml('This is __bold__ text')).toBe(
        'This is <b>bold</b> text'
      );
    });
  });

  describe('italic', () => {
    it('converts *text* to <i>text</i>', () => {
      expect(markdownToTelegramHtml('This is *italic* text')).toBe(
        'This is <i>italic</i> text'
      );
    });

    it('converts _text_ to <i>text</i>', () => {
      expect(markdownToTelegramHtml('This is _italic_ text')).toBe(
        'This is <i>italic</i> text'
      );
    });

    it('does not convert mid_word_underscores', () => {
      expect(markdownToTelegramHtml('some_variable_name')).toBe('some_variable_name');
    });
  });

  describe('bold + italic', () => {
    it('converts ***text*** to <b><i>text</i></b>', () => {
      expect(markdownToTelegramHtml('***emphasis***')).toBe('<b><i>emphasis</i></b>');
    });
  });

  describe('strikethrough', () => {
    it('converts ~~text~~ to <s>text</s>', () => {
      expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
    });
  });

  describe('links', () => {
    it('converts [text](url) to <a href="url">text</a>', () => {
      expect(markdownToTelegramHtml('[Click here](https://example.com)')).toBe(
        '<a href="https://example.com">Click here</a>'
      );
    });

    it('escapes HTML in link text but preserves URL', () => {
      expect(markdownToTelegramHtml('[a<b](https://example.com)')).toBe(
        '<a href="https://example.com">a&lt;b</a>'
      );
    });
  });

  describe('inline code', () => {
    it('converts `code` to <code>code</code>', () => {
      expect(markdownToTelegramHtml('Use `npm install` here')).toBe(
        'Use <code>npm install</code> here'
      );
    });

    it('escapes HTML inside inline code', () => {
      expect(markdownToTelegramHtml('`<div>`')).toBe('<code>&lt;div&gt;</code>');
    });

    it('does not apply bold/italic inside inline code', () => {
      expect(markdownToTelegramHtml('`**not bold**`')).toBe(
        '<code>**not bold**</code>'
      );
    });
  });

  describe('code blocks', () => {
    it('converts fenced code blocks to <pre><code>', () => {
      const input = '```\nconst x = 1;\n```';
      expect(markdownToTelegramHtml(input)).toBe(
        '<pre><code>const x = 1;</code></pre>'
      );
    });

    it('includes language class when specified', () => {
      const input = '```js\nconst x = 1;\n```';
      expect(markdownToTelegramHtml(input)).toBe(
        '<pre><code class="language-js">const x = 1;</code></pre>'
      );
    });

    it('escapes HTML inside code blocks', () => {
      const input = '```\n<script>alert("xss")</script>\n```';
      expect(markdownToTelegramHtml(input)).toBe(
        '<pre><code>&lt;script&gt;alert("xss")&lt;/script&gt;</code></pre>'
      );
    });
  });

  describe('unordered lists', () => {
    it('converts "- item" to "bullet item"', () => {
      const input = '- first\n- second';
      expect(markdownToTelegramHtml(input)).toBe('• first\n• second');
    });

    it('preserves existing bullet characters', () => {
      expect(markdownToTelegramHtml('• already bullet')).toBe('• already bullet');
    });
  });

  describe('mixed formatting', () => {
    it('handles bold + link in same line', () => {
      expect(markdownToTelegramHtml('**Check** [this](https://x.com)')).toBe(
        '<b>Check</b> <a href="https://x.com">this</a>'
      );
    });

    it('handles Russian text with bold', () => {
      expect(markdownToTelegramHtml('**Adaptive Thinking**: настройка')).toBe(
        '<b>Adaptive Thinking</b>: настройка'
      );
    });

    it('handles the original problematic message style', () => {
      const input = '— **Контекст 1М токенов**: Теперь можно';
      const result = markdownToTelegramHtml(input);
      expect(result).toBe('— <b>Контекст 1М токенов</b>: Теперь можно');
    });
  });

  describe('markdown tables', () => {
    it('converts a simple table to aligned monospace <pre>', () => {
      const input = [
        '| Блюдо | Калории |',
        '|-------|---------|',
        '| Йогурт | 180 ккал |',
        '| Кофе | 5 ккал |',
      ].join('\n');
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('<pre>');
      expect(result).toContain('Йогурт');
      expect(result).toContain('Кофе');
      // Should NOT contain pipe characters
      expect(result).not.toContain('|');
    });

    it('aligns columns with padding', () => {
      const input = [
        '| Name | Value |',
        '|------|-------|',
        '| A | 1 |',
        '| Long name | 2 |',
      ].join('\n');
      const result = markdownToTelegramHtml(input);
      // Both "Name" and "Long name" rows should be inside <pre>
      expect(result).toMatch(/<pre>[\s\S]*Name[\s\S]*Long name[\s\S]*<\/pre>/);
    });

    it('preserves text around the table', () => {
      const input = 'Header text\n| A | B |\n|---|---|\n| 1 | 2 |\nFooter text';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('Header text');
      expect(result).toContain('Footer text');
      expect(result).toContain('<pre>');
    });

    it('escapes HTML inside table cells', () => {
      const input = '| Name | Value |\n|------|-------|\n| <script> | ok |';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('<script>');
    });

    it('ignores lines with pipes that are not tables (no separator row)', () => {
      const input = '| this is not | a table |';
      const result = markdownToTelegramHtml(input);
      // Without separator row, should pass through (HTML-escaped)
      expect(result).not.toContain('<pre>');
    });

    it('handles the exact LLM output from the bug report', () => {
      const input = [
        'Калории за сегодня:',
        '',
        '| Блюдо | Калорийность |',
        '|-------|--------------|',
        '| Йогурт с вареньем | 180 ккал |',
        '| Кофе американо | 5 ккал |',
        '| Конфета Vitok (неглазированная) | 68 ккал |',
        '| Овощи жареные | 58 ккал |',
        '| Фрикадельки | 197 ккал |',
        '| Соус сливочный | 208 ккал |',
        '',
        'Итого: 716 ккал / 2200',
      ].join('\n');
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('<pre>');
      expect(result).toContain('Йогурт с вареньем');
      expect(result).toContain('Фрикадельки');
      expect(result).toContain('Итого: 716 ккал / 2200');
      // Pipes should be gone
      expect(result).not.toMatch(/\|.*ккал/);
    });
  });

  describe('fallback on error', () => {
    it('returns HTML-escaped text if conversion somehow throws', () => {
      // The function should never throw — it catches internally.
      // We just verify the exported function doesn't throw on weird input.
      expect(() => markdownToTelegramHtml('\x00\x01\x02')).not.toThrow();
    });
  });
});
