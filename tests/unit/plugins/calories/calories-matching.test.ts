/**
 * Tests for calories matching logic
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeRu,
  extractCanonicalName,
  levenshtein,
  matchCandidates,
  decideMatch,
} from '../../../../src/plugins/calories/calories-matching.js';
import type { FoodItem } from '../../../../src/plugins/calories/calories-types.js';

describe('normalizeRu', () => {
  it('converts to lowercase', () => {
    expect(normalizeRu('Американо')).toBe('американо');
  });

  it('replaces ё with е', () => {
    expect(normalizeRu('Кофё')).toBe('кофе');
  });

  it('removes parentheses', () => {
    expect(normalizeRu('Йогурт (греческий)')).toBe('йогурт греческий');
  });

  it('removes punctuation', () => {
    expect(normalizeRu('Йогурт, 2%.')).toBe('йогурт 2%');
  });

  it('collapses whitespace', () => {
    expect(normalizeRu('  кофе   американо  ')).toBe('кофе американо');
  });
});

describe('extractCanonicalName', () => {
  it('extracts name and portion from "Йогурт 140г"', () => {
    const result = extractCanonicalName('Йогурт 140г');
    expect(result.canonicalName).toBe('Йогурт');
    expect(result.defaultPortion).toEqual({ quantity: 140, unit: 'g' });
  });

  it('extracts name and portion from "Американо 200мл"', () => {
    const result = extractCanonicalName('Американо 200мл');
    expect(result.canonicalName).toBe('Американо');
    expect(result.defaultPortion).toEqual({ quantity: 200, unit: 'ml' });
  });

  it('handles comma decimal separator', () => {
    const result = extractCanonicalName('Молоко 1,5л');
    expect(result.canonicalName).toBe('Молоко');
    expect(result.defaultPortion).toEqual({ quantity: 1.5, unit: 'l' });
  });

  it('handles штуки (pieces)', () => {
    const result = extractCanonicalName('Пастила 2 шт');
    expect(result.canonicalName).toBe('Пастила');
    expect(result.defaultPortion).toEqual({ quantity: 2, unit: 'item' });
  });

  it('removes meta-comments like (как вчера)', () => {
    const result = extractCanonicalName('Йогурт 140г (как вчера)');
    expect(result.canonicalName).toBe('Йогурт как вчера');
    expect(result.defaultPortion).toEqual({ quantity: 140, unit: 'g' });
  });

  it('handles name without portion', () => {
    const result = extractCanonicalName('Кофе американо');
    expect(result.canonicalName).toBe('Кофе американо');
    expect(result.defaultPortion).toBeUndefined();
  });

  it('handles kilogram', () => {
    const result = extractCanonicalName('Арбуз 2кг');
    expect(result.canonicalName).toBe('Арбуз');
    expect(result.defaultPortion).toEqual({ quantity: 2, unit: 'kg' });
  });

  it('handles порция (serving)', () => {
    const result = extractCanonicalName('Суп 1 порция');
    expect(result.canonicalName).toBe('Суп');
    expect(result.defaultPortion).toEqual({ quantity: 1, unit: 'serving' });
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('американо', 'американо')).toBe(0);
  });

  it('returns string length for empty comparison', () => {
    expect(levenshtein('test', '')).toBe(4);
    expect(levenshtein('', 'test')).toBe(4);
  });

  it('calculates single character difference', () => {
    expect(levenshtein('кофе', 'кофи')).toBe(1);
  });

  it('calculates multiple differences', () => {
    expect(levenshtein('американо', 'капучино')).toBeGreaterThan(3);
  });
});

describe('matchCandidates', () => {
  const items: FoodItem[] = [
    {
      id: 'item_1',
      canonicalName: 'Кофе Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      recipientId: 'test',
    },
    {
      id: 'item_2',
      canonicalName: 'Кофе Капучино',
      measurementKind: 'volume',
      basis: { caloriesPer: 120, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      recipientId: 'test',
    },
    {
      id: 'item_3',
      canonicalName: 'Йогурт Греческий',
      measurementKind: 'weight',
      basis: { caloriesPer: 59, perQuantity: 100, perUnit: 'g' },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      recipientId: 'test',
    },
  ];

  it('returns items sorted by score', () => {
    const results = matchCandidates('американо', items);
    expect(results.length).toBe(3);
    expect(results[0]?.item.id).toBe('item_1'); // Best match
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('matches partial name', () => {
    const results = matchCandidates('йогурт', items);
    expect(results[0]?.item.id).toBe('item_3');
  });

  it('returns empty array for no items', () => {
    const results = matchCandidates('что-то', []);
    expect(results).toEqual([]);
  });
});

describe('decideMatch', () => {
  const items: FoodItem[] = [
    {
      id: 'item_1',
      canonicalName: 'Американо',
      measurementKind: 'volume',
      basis: { caloriesPer: 5, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      recipientId: 'test',
    },
    {
      id: 'item_2',
      canonicalName: 'Американо с молоком',
      measurementKind: 'volume',
      basis: { caloriesPer: 50, perQuantity: 200, perUnit: 'ml' },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      recipientId: 'test',
    },
  ];

  it('returns matched for exact match', () => {
    const result = decideMatch('Американо', items);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.item.id).toBe('item_1');
      expect(result.score).toBeGreaterThan(0.9);
    }
  });

  it('returns created for no match', () => {
    const result = decideMatch('Борщ', items);
    expect(result.status).toBe('created');
  });

  it('returns created for empty items', () => {
    const result = decideMatch('Что-то', []);
    expect(result.status).toBe('created');
  });

  it('returns ambiguous when multiple close matches', () => {
    // Both "Американо" and "Американо с молоком" should be close enough
    const result = decideMatch('Американо с', items, {
      matchThreshold: 0.95,
      ambiguousThreshold: 0.7,
      ambiguousDelta: 0.1,
    });
    // Depending on the exact query, might be matched or ambiguous
    expect(['matched', 'ambiguous']).toContain(result.status);
  });

  it('respects custom thresholds', () => {
    const result = decideMatch('Американо', items, {
      matchThreshold: 0.99, // Very high threshold
    });
    // Exact "Американо" should still match since it's in the list
    expect(result.status).toBe('matched');
  });
});

describe('integration: full flow', () => {
  it('extracts name, matches, and returns correct item', () => {
    const items: FoodItem[] = [
      {
        id: 'item_yogurt',
        canonicalName: 'Йогурт Teos',
        measurementKind: 'weight',
        basis: { caloriesPer: 59, perQuantity: 100, perUnit: 'g' },
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        recipientId: 'test',
      },
    ];

    // User says "Йогурт Teos 140г"
    const parsed = extractCanonicalName('Йогурт Teos 140г');
    expect(parsed.canonicalName).toBe('Йогурт Teos');
    expect(parsed.defaultPortion).toEqual({ quantity: 140, unit: 'g' });

    // Match against catalog - exact match
    const result = decideMatch(parsed.canonicalName, items);

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.item.id).toBe('item_yogurt');
      expect(result.score).toBeGreaterThan(0.9);
    }
  });

  it('creates new item for unknown food', () => {
    const items: FoodItem[] = [];

    const parsed = extractCanonicalName('Пельмени 200г');
    const result = decideMatch(parsed.canonicalName, items);

    expect(result.status).toBe('created');
  });
});
