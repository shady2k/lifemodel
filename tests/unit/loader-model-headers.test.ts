import { describe, expect, it } from 'vitest';
import {
  MAX_SLOT_HEADERS,
  renderAttemptHeaders,
  renderHeaderValue,
  SlotHeaderError,
  validateSlotHeaders,
  validSessionId,
  type ModelSlotHeader,
} from '../../loader/src/model.js';

const header = (name: string, value: string): ModelSlotHeader => ({ name, value });

describe('slot custom header validation', () => {
  it('accepts an ordered list of RFC 9110 tokens and keeps its order and case', () => {
    expect(
      validateSlotHeaders([header('x-opencode-session', '{session}'), header('X-Api-Version', '2')])
    ).toEqual([header('x-opencode-session', '{session}'), header('X-Api-Version', '2')]);
    expect(validateSlotHeaders([])).toEqual([]);
  });

  it('refuses a name that is not an RFC 9110 token, a colon-prefixed one, and an over-long one', () => {
    for (const name of [':path', ':status', 'bad name', 'bad\tname', 'a'.repeat(65), '', 'na:me']) {
      expect(() => validateSlotHeaders([header(name, 'v')])).toThrow(SlotHeaderError);
      expect(() => validateSlotHeaders([header(name, 'v')])).toThrowError(
        expect.objectContaining({ code: 'header_name_invalid' })
      );
    }
  });

  it('refuses every reserved and hop-by-hop name, case-insensitively', () => {
    for (const name of [
      'host',
      'HOST',
      'Authorization',
      'PROXY-AUTHORIZATION',
      'Content-Length',
      'content-type',
      'Accept',
      'Connection',
      'Keep-Alive',
      'Transfer-Encoding',
      'TE',
      'Trailer',
      'Upgrade',
      'Expect',
      'Cookie',
      'Proxy-Foo',
      'proxy-x',
    ]) {
      expect(() => validateSlotHeaders([header(name, 'v')])).toThrowError(
        expect.objectContaining({ code: 'header_name_reserved' })
      );
    }
  });

  it('refuses a value with a CR, an LF or a NUL and one over 1024 bytes', () => {
    for (const value of ['a\r\nb', 'a\rb', 'a\nb', 'a\0b', 'ю'.repeat(513)]) {
      expect(() => validateSlotHeaders([header('x-ok', value)])).toThrowError(
        expect.objectContaining({ code: 'header_value_invalid' })
      );
    }
    expect(validateSlotHeaders([header('x-ok', 'ю'.repeat(512))])).toHaveLength(1);
    expect(validateSlotHeaders([header('x-ok', 'a'.repeat(1024))])).toHaveLength(1);
  });

  it('refuses a duplicate name in any case and more than sixteen headers', () => {
    expect(() => validateSlotHeaders([header('x-a', '1'), header('X-A', '2')])).toThrowError(
      expect.objectContaining({ code: 'header_duplicate' })
    );
    const many = Array.from({ length: MAX_SLOT_HEADERS }, (_, index) =>
      header(`x-h-${String(index)}`, 'v')
    );
    expect(validateSlotHeaders(many)).toHaveLength(MAX_SLOT_HEADERS);
    expect(() => validateSlotHeaders([...many, header('x-extra', 'v')])).toThrowError(
      expect.objectContaining({ code: 'header_too_many' })
    );
  });

  it('refuses a malformed entry instead of a silent default', () => {
    for (const value of [
      'nope',
      { name: 'x-a' },
      { value: 'v' },
      { name: 'x-a', value: 1 },
      { name: 'x-a', value: 'v', extra: true },
      [null],
    ]) {
      expect(() => validateSlotHeaders(value)).toThrow(SlotHeaderError);
    }
  });

  it('substitutes every {session} occurrence and leaves another value alone', () => {
    expect(renderHeaderValue('{session}-{session}', 'conv-1')).toBe('conv-1-conv-1');
    expect(renderHeaderValue('static', 'conv-1')).toBe('static');
    expect(renderHeaderValue('{session}', 'conv-1')).toBe('conv-1');
  });

  it('accepts only a bounded, URL-safe session id', () => {
    for (const value of ['conv-1', 'a.b_c:d-e', 'x'.repeat(128), 'ABC123']) {
      expect(validSessionId(value)).toBe(value);
    }
    for (const value of [
      '',
      'x'.repeat(129),
      'has space',
      'has\nnewline',
      '{session}',
      'юникод',
      7,
      undefined,
      ['conv-1'],
    ]) {
      expect(validSessionId(value)).toBeUndefined();
    }
  });

  it('renders the headers of one attempt and names the values a response may not echo', () => {
    const slot = {
      kind: 'openai' as const,
      baseUrl: 'https://models.example/v1',
      model: 'm',
      headers: [
        header('x-opencode-session', 'id-{session}'),
        header('x-long-secret', 'RENDERED-HEADER-SECRET-{session}'),
        header('x-short', '1'),
        header('x-version', 'v1.2'),
        header('x-empty', ''),
      ],
    };
    const rendered = renderAttemptHeaders(slot, 'conv-1');
    expect(Object.entries(rendered.headers)).toEqual([
      ['x-opencode-session', 'id-conv-1'],
      ['x-long-secret', 'RENDERED-HEADER-SECRET-conv-1'],
      ['x-short', '1'],
      ['x-version', 'v1.2'],
      ['x-empty', ''],
    ]);
    // Only a value whose static part reaches 16 bytes is credential material,
    // and what is matched is the rendered value of this attempt, not the
    // stored template.
    expect(rendered.secrets).toEqual(['RENDERED-HEADER-SECRET-conv-1']);
  });

  it('counts the static part, not the template, against the 16-byte floor', () => {
    const slot = (value: string) => ({
      kind: 'openai' as const,
      baseUrl: 'https://models.example/v1',
      model: 'm',
      headers: [header('x-a', value)],
    });
    expect(renderAttemptHeaders(slot('{session}'), 'conv-1').secrets).toEqual([]);
    expect(renderAttemptHeaders(slot('123456789012345'), 'conv-1').secrets).toEqual([]);
    expect(renderAttemptHeaders(slot('1234567890123456'), 'conv-1').secrets).toEqual([
      '1234567890123456',
    ]);
    // Fifteen static bytes plus a long session id are still fifteen static bytes.
    expect(renderAttemptHeaders(slot('{session}-12345678901234'), 'x'.repeat(128)).secrets).toEqual(
      []
    );
  });

  it('keeps a token named __proto__ an own header property', () => {
    const rendered = renderAttemptHeaders(
      {
        kind: 'openai' as const,
        baseUrl: 'https://models.example/v1',
        model: 'm',
        headers: [header('__proto__', 'own-value'), header('constructor', 'ctor-value')],
      },
      'conv-1'
    );
    expect(Object.getPrototypeOf(rendered.headers)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(rendered.headers, '__proto__')).toBe(true);
    expect(Object.entries(rendered.headers)).toEqual([
      ['__proto__', 'own-value'],
      ['constructor', 'ctor-value'],
    ]);
  });
});
