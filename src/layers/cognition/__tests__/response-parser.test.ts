/**
 * Tests for response-parser.ts
 *
 * Validates parsing of LLM responses: JSON schema mode, plain text fallback,
 * malformed/truncated response detection, and plain-text policy gating.
 */

import { describe, it, expect } from 'vitest';
import { parseResponseContent } from '../response-parser.js';

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
});
