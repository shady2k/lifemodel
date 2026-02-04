/**
 * Matching helpers for the calories plugin (RU-friendly).
 */

import type { FoodItem, NormalizedNameResult, Unit, Portion } from './calories-types.js';

const UNIT_MAP: { re: RegExp; unit: Unit }[] = [
  { re: /^(г|гр|грамм|грамма|граммов)$/i, unit: 'g' },
  { re: /^(кг|килограмм|килограмма|килограммов)$/i, unit: 'kg' },
  { re: /^(мл|миллилитр|миллилитра|миллилитров)$/i, unit: 'ml' },
  { re: /^(л|литр|литра|литров)$/i, unit: 'l' },
  { re: /^(шт|штука|штуки|штук)$/i, unit: 'item' },
  { re: /^(порция|порции|порций)$/i, unit: 'serving' },
];

const STOPWORDS = new Set(['кофе', 'чай', 'напиток']);

export function normalizeRu(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[()]/g, ' ')
    .replace(/[.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapUnit(unitText: string): Unit {
  const found = UNIT_MAP.find(({ re }) => re.test(unitText));
  return found ? found.unit : 'custom';
}

interface ParsedPortion extends Portion {
  token: string;
}

function parseDefaultPortion(raw: string): ParsedPortion | null {
  const match =
    /(\d+(?:[.,]\d+)?)\s*(г|гр|грамм(?:а|ов)?|кг|килограмм(?:а|ов)?|мл|миллилитр(?:а|ов)?|л|литр(?:а|ов)?|шт|штук(?:а|и)?|порци(?:я|и|й))/i.exec(
      raw
    );
  if (!match?.[1] || !match[2]) return null;
  const quantity = Number(match[1].replace(',', '.'));
  const unit = mapUnit(match[2].toLowerCase());
  return { quantity, unit, token: match[0] };
}

export function extractCanonicalName(raw: string): NormalizedNameResult {
  const portion = parseDefaultPortion(raw);

  let cleaned = raw;
  const removedTokens: string[] = [];

  if (portion) {
    cleaned = cleaned.replace(portion.token, ' ');
    removedTokens.push(portion.token);
  }

  cleaned = cleaned.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();

  const canonicalName = cleaned;
  const normalizedKey = normalizeRu(canonicalName);

  const result: NormalizedNameResult = {
    canonicalName,
    normalizedKey,
    removedTokens,
  };

  if (portion) {
    result.defaultPortion = { quantity: portion.quantity, unit: portion.unit };
  }

  return result;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const m = a.length;
  const n = b.length;

  // Use two rows instead of full matrix for memory efficiency
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n] ?? 0;
}

function normalizeForMatch(s: string): string {
  return normalizeRu(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t))
    .join(' ')
    .trim();
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function matchCandidates(
  query: string,
  items: FoodItem[]
): { item: FoodItem; score: number }[] {
  const nq = normalizeForMatch(query);
  return items
    .map((item) => {
      const ni = normalizeForMatch(item.canonicalName);
      const score = similarity(nq, ni);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}

export interface MatchDecisionOptions {
  matchThreshold?: number;
  ambiguousThreshold?: number;
  ambiguousDelta?: number;
  maxCandidates?: number;
}

export type MatchDecision =
  | { status: 'matched'; item: FoodItem; score: number }
  | { status: 'created' }
  | { status: 'ambiguous'; candidates: { item: FoodItem; score: number }[] };

export function decideMatch(
  query: string,
  items: FoodItem[],
  options: MatchDecisionOptions = {}
): MatchDecision {
  const matchThreshold = options.matchThreshold ?? 0.9;
  const ambiguousThreshold = options.ambiguousThreshold ?? 0.8;
  const ambiguousDelta = options.ambiguousDelta ?? 0.05;
  const maxCandidates = options.maxCandidates ?? 3;

  const ranked = matchCandidates(query, items);
  if (ranked.length === 0) return { status: 'created' };

  const best = ranked[0];
  if (!best) return { status: 'created' };

  if (best.score >= matchThreshold) {
    return { status: 'matched', item: best.item, score: best.score };
  }

  const candidates = ranked.filter((c) => c.score >= ambiguousThreshold).slice(0, maxCandidates);
  if (candidates.length >= 2) {
    const second = candidates[1];
    if (second && best.score - second.score < ambiguousDelta) {
      return { status: 'ambiguous', candidates };
    }
  }

  if (best.score >= ambiguousThreshold) {
    return { status: 'matched', item: best.item, score: best.score };
  }

  return { status: 'created' };
}
