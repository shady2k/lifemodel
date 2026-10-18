import { describe, expect, it } from 'vitest';
import { MODEL_STATUS_ERROR_KEYS, modelErrorKey, parseModelStatus } from '../../src/web/model-status.js';
import { parseLoaderModelStatus } from '../../loader/src/model-status.js';
import { GATEWAY_ERROR_CODES } from '../../loader/src/model-error-codes.js';
import {
  MODEL_STATUS_CONFORMANCE_CASES,
  UNSAFE_ERROR_CODE,
} from '../fixtures/model-status-conformance.js';

/**
 * One table, both parsers. The web module's parser and the loader's parser
 * project the same `/status` body for the two screens, so every adversarial
 * shape must come out the same on both paths (ADR-013 D6).
 */
const parsers = [
  ['the web parser', parseModelStatus],
  ['the loader parser', parseLoaderModelStatus],
] as const;

describe('both parsers project the gateway status alike', () => {
  for (const [side, parse] of parsers) {
    describe(side, () => {
      for (const testCase of MODEL_STATUS_CONFORMANCE_CASES) {
        it(`${testCase.name}`, () => {
          expect(parse(testCase.body)).toEqual(testCase.expected);
        });
      }

      it('keeps every owned gateway code and normalizes everything else', () => {
        for (const code of GATEWAY_ERROR_CODES)
          expect(parse({ state: 'down', outageSince: '2026-10-16T11:03:00.000Z', lastErrorCode: code }))
            .toEqual({
              state: 'down',
              outageSince: '2026-10-16T11:03:00.000Z',
              lastErrorCode: code,
            });
        for (const code of ['wat', 'UPSTREAM_500', 'upstream-500', ' upstream_500', '', 'tls', 'auth_failed'])
          expect(
            parse({ state: 'down', outageSince: '2026-10-16T11:03:00.000Z', lastErrorCode: code }),
            code
          ).toEqual({
            state: 'down',
            outageSince: '2026-10-16T11:03:00.000Z',
            lastErrorCode: UNSAFE_ERROR_CODE,
          });
      });
    });
  }

  it('gives the fixed unknown code the generic phrase, never a raw string', () => {
    expect(modelErrorKey(UNSAFE_ERROR_CODE)).toBe('modelErrorUnknown');
  });
});

describe('the two safe-code lists agree', () => {
  it('holds the gateway code list the web module maps to words', () => {
    expect([...Object.keys(MODEL_STATUS_ERROR_KEYS)].sort()).toEqual([...GATEWAY_ERROR_CODES].sort());
  });

  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    'maps the inherited name %s to the generic phrase',
    (code) => {
      expect(modelErrorKey(code)).toBe('modelErrorUnknown');
    }
  );

  it('maps no code to something that is not a translation key', () => {
    for (const code of [...GATEWAY_ERROR_CODES, UNSAFE_ERROR_CODE, 'upstream_500', 'nonsense'])
      expect(typeof modelErrorKey(code)).toBe('string');
  });
});
