/**
 * Telegram Shared Parser Tests
 *
 * Tests for the shared Telegram HTML parser and URL helpers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTelegramHtml,
  formatTelegramAsMarkdown,
  isTelegramUrl,
  normalizeTelegramUrl,
  detectMessageTypes,
  buildMediaTags,
  cleanText,
  truncate,
} from '../../../../src/plugins/web-shared/telegram.js';
import { parse } from 'node-html-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load real HTML fixture
const TEST_CHANNEL_HTML = readFileSync(
  join(__dirname, '../../../fixtures/telegram-test-channel.html'),
  'utf-8'
);

// ═══════════════════════════════════════════════════════════════
// parseTelegramHtml
// ═══════════════════════════════════════════════════════════════

describe('parseTelegramHtml', () => {
  it('should parse messages from real channel HTML', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.channelHandle).toBe('test_channel');
  });

  it('should extract message IDs as numeric strings', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');

    for (const msg of result.messages) {
      expect(msg.id).toMatch(/^\d+$/);
    }
  });

  it('should build correct message URLs', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');

    for (const msg of result.messages) {
      expect(msg.url).toMatch(/^https:\/\/t\.me\/test_channel\/\d+$/);
    }
  });

  it('should extract dates when available', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');
    const withDates = result.messages.filter((m) => m.date !== undefined);
    expect(withDates.length).toBeGreaterThan(0);
  });

  it('should sort messages newest-first', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');

    if (result.messages.length > 1) {
      for (let i = 1; i < result.messages.length; i++) {
        const prevId = parseInt(result.messages[i - 1].id, 10);
        const currId = parseInt(result.messages[i].id, 10);
        expect(prevId).toBeGreaterThanOrEqual(currId);
      }
    }
  });

  it('should detect media types', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');
    for (const msg of result.messages) {
      expect(msg.mediaTypes.length).toBeGreaterThan(0);
    }
  });

  it('should return empty messages for channel with no messages', () => {
    const html = `
      <!DOCTYPE html><html><body>
      <div class="tgme_channel_info"><div class="tgme_page_title">Empty</div></div>
      </body></html>
    `;
    const result = parseTelegramHtml(html, 'empty');
    expect(result.messages).toEqual([]);
    expect(result.channelHandle).toBe('empty');
  });

  it('should return empty messages for private channel HTML', () => {
    const html = `
      <!DOCTYPE html><html><body>
      <div class="tgme_page_description">This channel is private</div>
      </body></html>
    `;
    const result = parseTelegramHtml(html, 'private');
    expect(result.messages).toEqual([]);
  });

  it('should extract channel name from HTML', () => {
    const result = parseTelegramHtml(TEST_CHANNEL_HTML);
    expect(result.channelName).toBeDefined();
    expect(typeof result.channelName).toBe('string');
  });

  it('should infer handle from message data-post when not provided', () => {
    const html = `
      <div class="tgme_widget_message" data-post="mychannel/42">
        <div class="tgme_widget_message_text">Hello</div>
        <div class="tgme_widget_message_date"><time datetime="2025-01-01T00:00:00Z"></time></div>
      </div>
    `;
    const result = parseTelegramHtml(html);
    expect(result.channelHandle).toBe('mychannel');
    expect(result.messages[0].url).toBe('https://t.me/mychannel/42');
  });
});

// ═══════════════════════════════════════════════════════════════
// formatTelegramAsMarkdown
// ═══════════════════════════════════════════════════════════════

describe('formatTelegramAsMarkdown', () => {
  it('should produce readable markdown from parsed content', () => {
    const parsed = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');
    const md = formatTelegramAsMarkdown(parsed);

    expect(md).toContain('test_channel');
    expect(md).toContain('---');
    expect(md).toContain('[View message]');
  });

  it('should handle empty messages gracefully', () => {
    const md = formatTelegramAsMarkdown({
      channelName: 'Empty',
      channelHandle: 'empty',
      messages: [],
    });

    expect(md).toContain('Empty');
    expect(md).toContain('No messages found');
  });

  it('should include pagination link when nextBefore is present', () => {
    const parsed = parseTelegramHtml(TEST_CHANNEL_HTML, 'test_channel');
    if (parsed.nextBefore) {
      const md = formatTelegramAsMarkdown(parsed);
      expect(md).toContain('Load older messages');
      expect(md).toContain(parsed.nextBefore);
    }
  });

  it('should include forwarded-from info', () => {
    const md = formatTelegramAsMarkdown({
      channelName: 'Test',
      channelHandle: 'test',
      messages: [
        {
          id: '1',
          url: 'https://t.me/test/1',
          text: 'Hello',
          mediaTypes: ['text'],
          forwardedFrom: 'Another Channel',
        },
      ],
    });

    expect(md).toContain('Forwarded from: Another Channel');
  });
});

// ═══════════════════════════════════════════════════════════════
// isTelegramUrl
// ═══════════════════════════════════════════════════════════════

describe('isTelegramUrl', () => {
  it('should detect t.me URLs', () => {
    expect(isTelegramUrl(new URL('https://t.me/channel'))).toBe(true);
  });

  it('should detect telegram.me URLs', () => {
    expect(isTelegramUrl(new URL('https://telegram.me/channel'))).toBe(true);
  });

  it('should reject non-telegram hosts', () => {
    expect(isTelegramUrl(new URL('https://example.com/t.me'))).toBe(false);
    expect(isTelegramUrl(new URL('https://not-t.me/channel'))).toBe(false);
    expect(isTelegramUrl(new URL('https://google.com'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// normalizeTelegramUrl — table-driven
// ═══════════════════════════════════════════════════════════════

describe('normalizeTelegramUrl', () => {
  const cases: Array<{
    input: string;
    expectedPath: string;
    postId?: string;
    description: string;
  }> = [
    {
      input: 'https://t.me/channel/123',
      expectedPath: '/s/channel',
      postId: '123',
      description: 'channel + post ID → /s/channel with postId',
    },
    {
      input: 'https://t.me/channel',
      expectedPath: '/s/channel',
      description: 'channel without post → /s/channel',
    },
    {
      input: 'https://t.me/s/channel',
      expectedPath: '/s/channel',
      description: 'already /s/ URL → unchanged',
    },
    {
      input: 'https://t.me/s/channel?before=100',
      expectedPath: '/s/channel',
      description: '/s/ URL with query → preserved',
    },
    {
      input: 'https://telegram.me/channel/123',
      expectedPath: '/s/channel',
      postId: '123',
      description: 'telegram.me → normalized same way',
    },
    {
      input: 'https://t.me/+xxx',
      expectedPath: '/+xxx',
      description: 'invite link → NOT rewritten',
    },
    {
      input: 'https://t.me/joinchat/xxx',
      expectedPath: '/joinchat/xxx',
      description: 'joinchat → NOT rewritten',
    },
    {
      input: 'https://t.me/c/xxx',
      expectedPath: '/c/xxx',
      description: 'private channel link → NOT rewritten',
    },
    {
      input: 'https://t.me/share/url?url=test',
      expectedPath: '/share/url',
      description: 'share link → NOT rewritten',
    },
    {
      input: 'https://t.me/addstickers/xxx',
      expectedPath: '/addstickers/xxx',
      description: 'addstickers → NOT rewritten',
    },
  ];

  for (const tc of cases) {
    it(tc.description, () => {
      const result = normalizeTelegramUrl(new URL(tc.input));
      expect(result.url.pathname).toBe(tc.expectedPath);
      expect(result.postId).toBe(tc.postId);
      expect(result.url.protocol).toBe('https:');
    });
  }

  it('should force HTTPS for http input', () => {
    const result = normalizeTelegramUrl(new URL('http://t.me/channel'));
    expect(result.url.protocol).toBe('https:');
  });

  it('should not rewrite short handles (< 4 chars)', () => {
    const result = normalizeTelegramUrl(new URL('https://t.me/abc'));
    expect(result.url.pathname).toBe('/abc');
  });

  it('should pass through non-telegram URLs unchanged', () => {
    const url = new URL('https://example.com/path');
    const result = normalizeTelegramUrl(url);
    expect(result.url.href).toBe(url.href);
    expect(result.postId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Helper function unit tests
// ═══════════════════════════════════════════════════════════════

describe('cleanText', () => {
  it('should decode HTML entities', () => {
    expect(cleanText('&amp; &lt; &gt; &quot;')).toBe('& < > "');
  });

  it('should normalize whitespace', () => {
    expect(cleanText('  hello   world  ')).toBe('hello world');
  });

  it('should return empty for empty input', () => {
    expect(cleanText('')).toBe('');
  });
});

describe('truncate', () => {
  it('should not truncate short text', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate long text with ellipsis', () => {
    expect(truncate('hello world foo bar', 10)).toBe('hello w...');
  });
});

describe('detectMessageTypes', () => {
  it('should detect service messages', () => {
    const html = '<div class="tgme_widget_message service_message">Service</div>';
    const el = parse(html).querySelector('.tgme_widget_message')!;
    expect(detectMessageTypes(el)).toEqual(['service']);
  });

  it('should detect text messages', () => {
    const html = '<div class="tgme_widget_message"><div class="tgme_widget_message_text">Hi</div></div>';
    const el = parse(html).querySelector('.tgme_widget_message')!;
    expect(detectMessageTypes(el)).toEqual(['text']);
  });

  it('should detect photo messages', () => {
    const html = '<div class="tgme_widget_message"><div class="tgme_widget_message_photo"></div></div>';
    const el = parse(html).querySelector('.tgme_widget_message')!;
    expect(detectMessageTypes(el)).toContain('photo');
  });
});

describe('buildMediaTags', () => {
  it('should skip text type', () => {
    expect(buildMediaTags(['text'])).toBe('');
  });

  it('should build tags for media types', () => {
    expect(buildMediaTags(['photo', 'video'])).toBe('[Photo] [Video]');
  });

  it('should support emoji mode', () => {
    expect(buildMediaTags(['photo'], true)).toBe('🖼');
  });
});
