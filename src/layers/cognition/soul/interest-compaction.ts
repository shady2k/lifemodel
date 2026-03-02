/**
 * Interest Compaction
 *
 * Creates display-only groups from user interests during sleep cycles.
 * Groups are used by formatInterests() to show cleaner labels in prompts
 * without modifying the canonical interest keys that downstream systems
 * (news filter, threshold engine) depend on.
 *
 * Key design decisions:
 * - Canonical Interests.weights and Interests.urgency are NEVER modified
 * - Groups stored as separate user property (interest_groups)
 * - Change detection via hash to avoid redundant LLM calls
 * - Large interest sets are chunked to avoid overwhelming local models
 */

import { createHash } from 'node:crypto';
import type { Logger } from '../../../types/logger.js';
import type { Interests } from '../../../types/user/interests.js';
import type { CognitionLLM } from '../agentic-loop-types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InterestGroup {
  label: string; // e.g., "коммунальные отключения"
  topics: string[]; // canonical keys, e.g., ["отключения", "газ", "вода"]
}

export interface CompactionResult {
  groups: InterestGroup[];
  generatedAt: string; // ISO timestamp
  interestsHash: string; // hash of input interests for change detection
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max topics per LLM call. Keeps prompts small for local models. */
export const CHUNK_SIZE = 30;

// ─── Hash ────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash of interest keys for change detection.
 * Only hashes topic names (sorted) — weight/urgency changes don't affect grouping.
 */
export function computeInterestsHash(interests: Interests): string {
  const keys = Object.keys(interests.weights).filter((k) => (interests.weights[k] ?? 0) > 0);
  keys.sort();
  return createHash('sha256').update(keys.join('\0')).digest('hex').slice(0, 16);
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate compaction output. Fail-closed: any invalid group → return null.
 */
function validateGroupsStrict(
  groups: unknown,
  canonicalTopics: Set<string>,
  logger: Logger
): InterestGroup[] | null {
  if (!Array.isArray(groups)) {
    logger.warn('Compaction validation: output is not an array');
    return null;
  }

  const seenTopics = new Set<string>();
  const validated: InterestGroup[] = [];

  for (const group of groups) {
    if (
      typeof group !== 'object' ||
      group === null ||
      typeof (group as Record<string, unknown>)['label'] !== 'string' ||
      !Array.isArray((group as Record<string, unknown>)['topics'])
    ) {
      logger.warn({ group: String(group) }, 'Compaction validation: malformed group');
      return null;
    }

    const label = (group as Record<string, unknown>)['label'] as string;
    const topics = (group as Record<string, unknown>)['topics'] as unknown[];

    // Label length: 2-50 chars
    if (label.length < 2 || label.length > 50) {
      logger.warn(
        { label, length: label.length },
        'Compaction validation: label length out of range'
      );
      return null;
    }

    // Group size: 2-6 topics
    if (topics.length < 2 || topics.length > 6) {
      logger.warn(
        { label, topicCount: topics.length },
        'Compaction validation: group size out of range'
      );
      return null;
    }

    const validatedTopics: string[] = [];
    for (const topic of topics) {
      if (typeof topic !== 'string') {
        logger.warn({ label, topic }, 'Compaction validation: topic is not a string');
        return null;
      }

      // Every topic must exist in canonical interests
      if (!canonicalTopics.has(topic)) {
        logger.warn({ label, topic }, 'Compaction validation: topic not in canonical interests');
        return null;
      }

      // No duplicate topics across groups
      if (seenTopics.has(topic)) {
        logger.warn({ label, topic }, 'Compaction validation: duplicate topic across groups');
        return null;
      }

      seenTopics.add(topic);
      validatedTopics.push(topic);
    }

    validated.push({ label, topics: validatedTopics });
  }

  return validated;
}

/**
 * Soft validation for merge output: drop invalid groups, keep valid ones.
 * Used after the merge pass where partial success is acceptable.
 */
function validateGroupsSoft(
  groups: unknown,
  canonicalTopics: Set<string>,
  seenTopics: Set<string>,
  logger: Logger
): InterestGroup[] {
  if (!Array.isArray(groups)) {
    logger.warn('Merge validation: output is not an array');
    return [];
  }

  const validated: InterestGroup[] = [];

  for (const group of groups) {
    if (
      typeof group !== 'object' ||
      group === null ||
      typeof (group as Record<string, unknown>)['label'] !== 'string' ||
      !Array.isArray((group as Record<string, unknown>)['topics'])
    ) {
      continue; // skip malformed
    }

    const label = (group as Record<string, unknown>)['label'] as string;
    const topics = (group as Record<string, unknown>)['topics'] as unknown[];

    if (label.length < 2 || label.length > 50) continue;
    if (topics.length < 2 || topics.length > 6) continue;

    const validatedTopics: string[] = [];
    let groupValid = true;
    for (const topic of topics) {
      if (typeof topic !== 'string' || !canonicalTopics.has(topic)) {
        groupValid = false;
        break;
      }
      if (seenTopics.has(topic)) {
        groupValid = false;
        break;
      }
      validatedTopics.push(topic);
    }

    if (groupValid && validatedTopics.length >= 2) {
      for (const t of validatedTopics) seenTopics.add(t);
      validated.push({ label, topics: validatedTopics });
    }
  }

  return validated;
}

// ─── LLM Prompts ────────────────────────────────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = `You group related topic interests into logical categories. Each group gets a short descriptive label that captures the theme.

Grouping means finding topics that naturally belong together — for example, "gas", "water", "electricity outages" could be grouped as "utility outages." Location topics like city names, street names, or neighborhoods stay ungrouped (they apply across categories).

Rules:
- Each group must have 2-6 topics. No more, no less.
- Use exact topic strings only. Do not invent or modify topic names.
- Leave unrelated topics ungrouped (omit them from output).
- Use the same language as the topics for labels.

Output valid JSON only: an array of groups.
Each group: {"label": "short descriptive name", "topics": ["topic1", "topic2"]}`;

const MERGE_SYSTEM_PROMPT = `You merge overlapping topic groups from separate analyses into a unified set.

Input: groups from independent analyses that may have thematic overlap.
Task: merge groups that clearly belong together. If two groups cover the same theme, combine their topics under a single label.

Rules:
- Each merged group must have 2-6 topics. If merging would exceed 6, keep them as separate groups.
- Use exact topic strings only. Do not invent or modify topic names.
- Preserve groups that have no overlap with others.
- Use the same language as the topics for labels.

Output valid JSON only: an array of groups.
Each group: {"label": "short descriptive name", "topics": ["topic1", "topic2"]}`;

// ─── LLM Helpers ────────────────────────────────────────────────────────────

/** Parse LLM response as JSON, stripping markdown code blocks. */
function parseLLMJson(response: string, logger: Logger): unknown {
  const jsonStr = response
    .replace(/```json?\n?/g, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    logger.warn({ response: response.slice(0, 200) }, 'Compaction: failed to parse JSON response');
    return null;
  }
}

// ─── Single Batch Compaction ────────────────────────────────────────────────

/**
 * Compact a single batch of topics into groups via one LLM call.
 * Returns validated groups or null on failure.
 */
async function compactSingleBatch(
  topics: [string, number][],
  interests: Interests,
  llm: CognitionLLM,
  logger: Logger
): Promise<InterestGroup[] | null> {
  const topicLines = topics
    .map(([topic, weight]) => {
      const urgency = interests.urgency[topic] ?? 0.5;
      return `- ${topic} (weight: ${weight.toFixed(1)}, urgency: ${urgency.toFixed(1)})`;
    })
    .join('\n');

  const userPrompt = `Group these ${String(topics.length)} interests where it makes sense:\n\n${topicLines}`;

  const response = await llm.complete(
    { systemPrompt: COMPACTION_SYSTEM_PROMPT, userPrompt },
    // Reasoning models spend 2000-4000 tokens on chain-of-thought before producing
    // the actual JSON output (~500-1000 tokens). 8192 gives generous headroom.
    // This runs during sleep maintenance so latency is not a concern.
    { temperature: 0.1, maxTokens: 8192 }
  );

  const parsed = parseLLMJson(response, logger);
  if (parsed === null) return null;

  const canonicalTopics = new Set(topics.map(([t]) => t));
  return validateGroupsStrict(parsed, canonicalTopics, logger);
}

// ─── Merge Pass ─────────────────────────────────────────────────────────────

/**
 * Merge groups from separate chunk analyses into a unified set.
 * Soft validation: keeps valid groups, drops invalid ones.
 */
async function mergeGroups(
  chunkGroups: InterestGroup[],
  canonicalTopics: Set<string>,
  llm: CognitionLLM,
  logger: Logger
): Promise<InterestGroup[] | null> {
  const groupLines = chunkGroups
    .map((g) => `- "${g.label}": [${g.topics.map((t) => `"${t}"`).join(', ')}]`)
    .join('\n');

  const userPrompt = `Merge these ${String(chunkGroups.length)} groups where they overlap:\n\n${groupLines}`;

  try {
    const response = await llm.complete(
      { systemPrompt: MERGE_SYSTEM_PROMPT, userPrompt },
      { temperature: 0.1, maxTokens: 8192 }
    );

    const parsed = parseLLMJson(response, logger);
    if (parsed === null) return null;

    const seenTopics = new Set<string>();
    const validated = validateGroupsSoft(parsed, canonicalTopics, seenTopics, logger);

    if (validated.length === 0) return null;

    logger.info(
      { inputGroups: chunkGroups.length, outputGroups: validated.length },
      'Merge pass complete'
    );

    return validated;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Merge pass failed'
    );
    return null;
  }
}

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Deduplicate topics across groups. First-seen topic wins (chunk order → group order).
 */
function dedupeGroups(groups: InterestGroup[]): InterestGroup[] {
  const seenTopics = new Set<string>();
  const result: InterestGroup[] = [];

  for (const group of groups) {
    const uniqueTopics = group.topics.filter((t) => {
      if (seenTopics.has(t)) return false;
      seenTopics.add(t);
      return true;
    });

    // Keep group only if it still has ≥ 2 topics after dedup
    if (uniqueTopics.length >= 2) {
      result.push({ label: group.label, topics: uniqueTopics });
    }
  }

  return result;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Compact interests into display groups using LLM.
 *
 * For large interest sets (> CHUNK_SIZE), splits into chunks, compacts each
 * independently, then merges overlapping groups in a final pass. Graceful
 * degradation: failed chunks are skipped, failed merge falls back to
 * unmerged chunk results.
 *
 * Returns null on total failure. Groups are display-only metadata —
 * canonical interest keys are never modified.
 */
export async function compactInterests(
  interests: Interests,
  llm: CognitionLLM,
  logger: Logger
): Promise<CompactionResult | null> {
  const log = logger.child({ component: 'interest-compaction' });

  const positiveTopics: [string, number][] = Object.entries(interests.weights)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);

  if (positiveTopics.length < 3) {
    log.debug('Too few interests to compact');
    return null;
  }

  const hash = computeInterestsHash(interests);

  try {
    let groups: InterestGroup[];

    if (positiveTopics.length <= CHUNK_SIZE) {
      // ─── Single batch ───────────────────────────────────────
      const result = await compactSingleBatch(positiveTopics, interests, llm, log);
      if (!result || result.length === 0) return null;
      groups = result;
    } else {
      // ─── Chunked compaction ─────────────────────────────────
      const chunks: [string, number][][] = [];
      for (let i = 0; i < positiveTopics.length; i += CHUNK_SIZE) {
        chunks.push(positiveTopics.slice(i, i + CHUNK_SIZE));
      }

      log.info(
        { totalTopics: positiveTopics.length, chunkCount: chunks.length, chunkSize: CHUNK_SIZE },
        'Starting chunked compaction'
      );

      // Process chunks sequentially (local model stability)
      const allChunkGroups: InterestGroup[] = [];
      for (const [i, chunk] of chunks.entries()) {
        try {
          const chunkResult = await compactSingleBatch(chunk, interests, llm, log);
          if (chunkResult && chunkResult.length > 0) {
            log.debug(
              { chunkIndex: i, topicsInChunk: chunk.length, groupsProduced: chunkResult.length },
              'Chunk compaction succeeded'
            );
            allChunkGroups.push(...chunkResult);
          } else {
            log.debug({ chunkIndex: i, topicsInChunk: chunk.length }, 'Chunk produced no groups');
          }
        } catch (error) {
          log.warn(
            { chunkIndex: i, error: error instanceof Error ? error.message : String(error) },
            'Chunk compaction failed, skipping'
          );
        }
      }

      if (allChunkGroups.length === 0) {
        log.warn('All chunks failed or produced no groups');
        return null;
      }

      // Deduplicate topics across chunk results
      const deduped = dedupeGroups(allChunkGroups);
      if (deduped.length === 0) {
        log.warn('No groups survived deduplication');
        return null;
      }

      // Merge pass: combine overlapping groups across chunks
      if (deduped.length > 1) {
        const canonicalTopics = new Set(positiveTopics.map(([t]) => t));
        const merged = await mergeGroups(deduped, canonicalTopics, llm, log);
        groups = merged ?? deduped; // fall back to unmerged on failure
      } else {
        groups = deduped;
      }
    }

    if (groups.length === 0) {
      log.debug('Compaction produced no groups');
      return null;
    }

    log.info(
      {
        groupCount: groups.length,
        topicsGrouped: groups.reduce((n, g) => n + g.topics.length, 0),
      },
      'Interest compaction complete'
    );

    return {
      groups,
      generatedAt: new Date().toISOString(),
      interestsHash: hash,
    };
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Interest compaction failed'
    );
    return null;
  }
}
