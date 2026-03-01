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
function validateGroups(
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

// ─── LLM Compaction ──────────────────────────────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = `You group related topic interests into logical categories. Each group gets a short descriptive label that captures the theme.

Grouping means finding topics that naturally belong together — for example, "gas", "water", "electricity outages" could be grouped as "utility outages." Location topics like city names, street names, or neighborhoods stay ungrouped (they apply across categories).

Output valid JSON: an array of groups.
Each group: {"label": "short descriptive name", "topics": ["topic1", "topic2"]}

Only group topics that clearly relate. Leave unrelated topics ungrouped (omit them from output). Use the same language as the topics for labels.`;

/**
 * Compact interests into display groups using LLM.
 *
 * Returns null on any failure (fail-closed). Groups are display-only metadata —
 * canonical interest keys are never modified.
 */
export async function compactInterests(
  interests: Interests,
  llm: CognitionLLM,
  logger: Logger
): Promise<CompactionResult | null> {
  const log = logger.child({ component: 'interest-compaction' });

  const positiveTopics = Object.entries(interests.weights)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);

  if (positiveTopics.length < 3) {
    log.debug('Too few interests to compact');
    return null;
  }

  const hash = computeInterestsHash(interests);

  // Build user prompt listing topics with weights
  const topicLines = positiveTopics
    .map(([topic, weight]) => {
      const urgency = interests.urgency[topic] ?? 0.5;
      return `- ${topic} (weight: ${weight.toFixed(1)}, urgency: ${urgency.toFixed(1)})`;
    })
    .join('\n');

  const userPrompt = `Group these ${String(positiveTopics.length)} interests where it makes sense:\n\n${topicLines}`;

  try {
    const response = await llm.complete(
      {
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        userPrompt,
      },
      {
        temperature: 0.1,
        maxTokens: 2000,
      }
    );

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = response
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      log.warn({ response: response.slice(0, 200) }, 'Compaction: failed to parse JSON response');
      return null;
    }

    // Validate
    const canonicalTopics = new Set(positiveTopics.map(([t]) => t));
    const validated = validateGroups(parsed, canonicalTopics, log);

    if (!validated) {
      return null;
    }

    if (validated.length === 0) {
      log.debug('Compaction produced no groups');
      return null;
    }

    log.info(
      {
        groupCount: validated.length,
        topicsGrouped: validated.reduce((n, g) => n + g.topics.length, 0),
      },
      'Interest compaction complete'
    );

    return {
      groups: validated,
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
