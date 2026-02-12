/**
 * Tests for response-parser.ts
 *
 * Validates parsing of LLM responses: JSON schema mode, plain text fallback,
 * malformed/truncated response detection, and plain-text policy gating.
 */

import { describe, it, expect } from 'vitest';
import { parseResponseContent } from '../../../../src/layers/cognition/response-parser.js';

describe('parseResponseContent', () => {
  it('parses valid JSON with response and status', () => {
    const result = parseResponseContent('{"response":"hello","status":"active"}');
    expect(result).toEqual({ text: 'hello', status: 'active' });
  });

  it('returns null text for empty response string', () => {
    const result = parseResponseContent('{"response":""}');
    expect(result).toEqual({ text: null });
  });

  it('marks truncated JSON as malformed', () => {
    const result = parseResponseContent('{"response":"hel');
    expect(result).toEqual({ text: null, malformed: true });
  });

  it('marks JSON without response field as malformed', () => {
    const result = parseResponseContent('{"status":"active"}');
    expect(result).toEqual({ text: null, malformed: true });
  });

  it('marks JSON with wrong response type as malformed', () => {
    const result = parseResponseContent('{"response":123}');
    expect(result).toEqual({ text: null, malformed: true });
  });

  it('unwraps code-fence wrapped JSON', () => {
    const result = parseResponseContent('```json\n{"response":"hello"}\n```');
    expect(result).toEqual({ text: 'hello' });
  });

  it('marks code-fence with truncated JSON as malformed', () => {
    const result = parseResponseContent('```json\n{"response":"hel');
    expect(result).toEqual({ text: null, malformed: true });
  });

  it('returns plain text as-is', () => {
    const result = parseResponseContent('Hello world');
    expect(result).toEqual({ text: 'Hello world' });
  });

  it('strips leading timestamp from plain text', () => {
    const result = parseResponseContent('[20:14] Hello world');
    expect(result).toEqual({ text: 'Hello world' });
  });

  it('strips leading timestamp from JSON response', () => {
    const result = parseResponseContent('{"response":"[09:07] Hello world"}');
    expect(result).toEqual({ text: 'Hello world' });
  });

  it('returns null text for null input', () => {
    const result = parseResponseContent(null);
    expect(result).toEqual({ text: null });
  });

  it('parses urgent flag', () => {
    const result = parseResponseContent('{"response":"fire!","urgent":true}');
    expect(result).toEqual({ text: 'fire!', urgent: true });
  });

  it('trims whitespace from response text', () => {
    const result = parseResponseContent('{"response":"  hello  "}');
    expect(result).toEqual({ text: 'hello' });
  });

  it('ignores invalid status values', () => {
    const result = parseResponseContent('{"response":"hello","status":"bogus"}');
    expect(result).toEqual({ text: 'hello' });
  });

  it('handles code-fence without json language tag', () => {
    const result = parseResponseContent('```\n{"response":"hello"}\n```');
    expect(result).toEqual({ text: 'hello' });
  });

  it('marks JSON with response: null as malformed', () => {
    const result = parseResponseContent('{"response":null}');
    expect(result).toEqual({ text: null, malformed: true });
  });

  it('preserves conversation status from valid response', () => {
    const result = parseResponseContent('{"response":"thinking...","status":"awaiting_answer"}');
    expect(result).toEqual({ text: 'thinking...', status: 'awaiting_answer' });
  });

  describe('allowPlainText option', () => {
    it('rejects plain text when allowPlainText is false', () => {
      const result = parseResponseContent('Hello world', { allowPlainText: false });
      expect(result).toEqual({ text: null, malformed: true });
    });

    it('rejects leaked prompt instructions when allowPlainText is false', () => {
      const leaked = `(empty)\n\n**Rules:**\n- Keep it short\n- Do NOT ask multiple questions`;
      const result = parseResponseContent(leaked, { allowPlainText: false });
      expect(result).toEqual({ text: null, malformed: true });
    });

    it('still accepts valid JSON when allowPlainText is false', () => {
      const result = parseResponseContent('{"response":"hello"}', { allowPlainText: false });
      expect(result).toEqual({ text: 'hello' });
    });

    it('still accepts code-fence JSON when allowPlainText is false', () => {
      const result = parseResponseContent('```json\n{"response":"hello"}\n```', {
        allowPlainText: false,
      });
      expect(result).toEqual({ text: 'hello' });
    });

    it('allows plain text by default (no options)', () => {
      const result = parseResponseContent('Hello world');
      expect(result).toEqual({ text: 'Hello world' });
    });

    it('allows plain text when allowPlainText is true', () => {
      const result = parseResponseContent('Hello world', { allowPlainText: true });
      expect(result).toEqual({ text: 'Hello world' });
    });
  });

  describe('<msg_time> prefix handling', () => {
    it('strips <msg_time> before code-fence detection', () => {
      const content =
        '<msg_time>just now</msg_time>\n<msg_time>just now</msg_time>\n```json\n{"response":"Да, всегда буду показывать полный список."}\n```';
      const result = parseResponseContent(content);
      expect(result).toEqual({ text: 'Да, всегда буду показывать полный список.' });
    });

    it('strips <msg_time> before JSON-start detection', () => {
      const content =
        '<msg_time>just now</msg_time>\n{"response":"Hello","status":"active"}';
      const result = parseResponseContent(content);
      expect(result).toEqual({ text: 'Hello', status: 'active' });
    });

    it('marks <msg_time> + single-quoted JSON as malformed', () => {
      const content =
        "<msg_time>just now</msg_time>\n{'response': 'Hello'}";
      const result = parseResponseContent(content);
      expect(result).toEqual({ text: null, malformed: true });
    });
  });

  describe('JSON at end of content (model leak)', () => {
    it('extracts JSON from end of content when model outputs text then JSON', () => {
      const leaked = `Here are articles:

1. Article one
2. Article two

{"response":"Here are articles:\\n\\n1. Article one\\n2. Article two"}`;
      const result = parseResponseContent(leaked);
      expect(result).toEqual({
        text: 'Here are articles:\n\n1. Article one\n2. Article two',
      });
    });

    it('handles markdown text followed by JSON', () => {
      const leaked = `**Bold title**

Some description

[Link](url)

{"response":"**Bold title**\\n\\nSome description\\n\\n[Link](url)","status":"active"}`;
      const result = parseResponseContent(leaked);
      expect(result).toEqual({
        text: '**Bold title**\n\nSome description\n\n[Link](url)',
        status: 'active',
      });
    });

    it('ignores trailing text when valid JSON is found at end', () => {
      // This is the canonical case from the bug report
      const leaked = `Теперь есть! По Хабу появились свежие статьи:

1. **ИИ повис на стекловолокне**: дефицит специфического стекловолокна от японской компании Nittobo ограничивает производство ИИ-чипов
   Читать (https://habr.com/ru/companies/bothub/news/994392/?utm_source=habrahabr&utm_medium=rss&utm_campaign=994392)

Тебе какая‑то из них особенно интересна?

{"response":"Теперь есть! По Хабу появились свежие статьи:\\n\\n1. **ИИ повис на стекловолокне**: дефицит специфического стекловолокна от японской компании Nittobo ограничивает производство ИИ-чипов  \\n   Читать (https://habr.com/ru/companies/bothub/news/994392/?utm_source=habrahabr&utm_medium=rss&utm_campaign=994392)\\n\\nТебе какая‑то из них особенно интересна?"}`;
      const result = parseResponseContent(leaked);
      expect(result.text).toContain('ИИ повис на стекловолокне');
      expect(result.text).toContain('Тебе какая‑то из них особенно интересна?');
      // Should NOT contain JSON wrapper
      expect(result.text).not.toContain('{"response":');
    });
  });

  describe('XML tool-call detection', () => {
    it('detects <core.say> tag pair as malformed', () => {
      const result = parseResponseContent('<core.say>Hello there!</core.say>');
      expect(result).toEqual({ text: null, malformed: true });
    });

    it('detects multiple XML tool-call tags as malformed', () => {
      const content =
        '<core.say>text</core.say>\n\n<core.act>\n  <mode>agentic</mode>\n</core.act>';
      const result = parseResponseContent(content);
      expect(result).toEqual({ text: null, malformed: true });
    });

    it('detects opening <core.act> tag at line start as malformed', () => {
      const content = '<core.act>\n  <mode>agentic</mode>\n  <task>create a skill</task>';
      const result = parseResponseContent(content);
      expect(result).toEqual({ text: null, malformed: true });
    });

    it('does not flag normal text mentioning core.act', () => {
      const result = parseResponseContent('I used core.act to run task');
      expect(result).toEqual({ text: 'I used core.act to run task' });
    });

    it('does not flag backtick-quoted tool references in normal text', () => {
      const result = parseResponseContent('Use `core.say` tool to respond');
      expect(result).toEqual({ text: 'Use `core.say` tool to respond' });
    });

    it('still rejects plain text when allowPlainText is false (existing behavior)', () => {
      const result = parseResponseContent('Hello world', { allowPlainText: false });
      expect(result).toEqual({ text: null, malformed: true });
    });
  });
});
