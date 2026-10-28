import { describe, expect, it } from 'vitest';
import { modelErrorExcerpt } from '../../loader/src/model-error-excerpt.js';

describe('model error excerpt allowlist', () => {
  it('rejects any shared 16-character input window, including JSON-escaped text', () => {
    const prompt = 'secret input across windows and newlines\nwhich must not escape';
    const request = JSON.stringify({ messages: [{ content: prompt }] });
    expect(
      modelErrorExcerpt(
        JSON.stringify({ error: { message: `input_value='${prompt}'`, type: 'validation' } }),
        [],
        request
      )
    ).toBe('validation');
    expect(
      modelErrorExcerpt(
        JSON.stringify({
          error: { message: `prefix ${prompt.slice(7, 23)} suffix`, type: 'validation' },
        }),
        [],
        request
      )
    ).toBe('validation');
    expect(
      modelErrorExcerpt(
        JSON.stringify({ error: { message: 'ordinary independent capacity error' } }),
        [],
        request
      )
    ).toBe('ordinary independent capacity error');
  });

  it('uses message first, falls back to type/code, and strips control characters', () => {
    expect(
      modelErrorExcerpt(
        JSON.stringify({ error: { message: 'rate\nlimited\u0000', type: 'type', code: 'code' } })
      )
    ).toBe('rate limited ');
    expect(
      modelErrorExcerpt(
        JSON.stringify({ error: { type: 'quota', code: 429, detail: 'PRIVATE-CANARY' } })
      )
    ).toBe('quota; 429');
    for (const body of [
      'null',
      '[]',
      'raw canary',
      '{}',
      '{"message":"canary"}',
      '{"error":"canary"}',
    ])
      expect(modelErrorExcerpt(body)).toBe('');
  });
  it('does not let encoded or unlabeled known credentials through JSON error fields', () => {
    expect(
      modelErrorExcerpt('{"error":{"message":"prefix s\\u0065cret suffix"}}', ['secret'])
    ).toBe('prefix [redacted] suffix');
    expect(modelErrorExcerpt('{"error":{"message":"Authorization: unknown","code":"safe"}}')).toBe(
      'safe'
    );
  });
});
