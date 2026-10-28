import { describe, expect, it } from 'vitest';
import { REASONING_EFFORTS, isReasoningEffort } from '../../src/config/reasoning-effort.js';
import {
  REASONING_EFFORTS as SLOT_EFFORTS,
  isReasoningEffort as isSlotEffort,
} from '../../loader/src/reasoning-effort.js';

describe('independently built core and loader effort contracts', () => {
  it('agree on the OpenAI-compatible values and reject other shapes', () => {
    expect(REASONING_EFFORTS).toEqual(['none', 'minimal', 'low', 'medium', 'high']);
    expect(SLOT_EFFORTS).toEqual(REASONING_EFFORTS);
    for (const value of [...REASONING_EFFORTS, undefined, null, '', 'maximum', 1, true, ['low']]) {
      const expected =
        typeof value === 'string' && REASONING_EFFORTS.some((effort) => effort === value);
      expect(isReasoningEffort(value)).toBe(expected);
      expect(isSlotEffort(value)).toBe(expected);
    }
  });
});
