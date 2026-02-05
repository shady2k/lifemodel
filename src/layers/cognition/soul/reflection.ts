/**
 * Soul Reflection
 *
 * Post-response reflection system that detects dissonance between
 * the agent's response and its self-model.
 *
 * Batch Processing (Phase 3.6):
 * Responses are queued and processed together after a 30s window or
 * when 10 items accumulate. This enables:
 * - Pattern recognition across multiple responses
 * - Reduced token overhead (~400 tokens saved per item)
 * - Cross-response insights logged for observability
 *
 * Tiered dissonance handling (Phase 3.5):
 * - 1-3: Aligned, no action
 * - 4-6: Soft learning item (decays, promotes if repeated)
 * - 7-8: Standard soul:reflection thought
 * - 9-10: Priority thought with urgent deliberation flag
 *
 * Human-like flow:
 * 1. Response sent to user
 * 2. Response queued for batch reflection
 * 3. After 30s or 10 items: batch processed with single LLM call
 * 4. Score determines action per item (soft learning vs hard thought)
 * 5. Hard thoughts create pressure until processed by Parliament (Phase 4)
 *
 * Design principles:
 * - Non-blocking: Don't delay response to user
 * - Budget-aware: Respects token limits and cooldowns
 * - Batch-efficient: Single LLM call for multiple items
 */

import type { Logger } from '../../../types/logger.js';
import type { SoulProvider, FullSoulState } from '../../../storage/soul-provider.js';
import type { MemoryProvider, MemoryEntry } from '../tools/registry.js';
import type { CognitionLLM } from '../agentic-loop.js';
import type { SoftLearningItem, PendingReflection } from '../../../types/agent/soul.js';

/**
 * Reflection result from the LLM (single item).
 */
export interface ReflectionResult {
  /** Whether the LLM call succeeded */
  success: boolean;
  /** Dissonance score 1-10 (1 = aligned, 10 = severe contradiction) */
  dissonance: number;
  /** Brief explanation of why this score was given */
  reasoning: string;
  /** What aspect of identity was involved (optional) */
  aspect?: string | undefined;
}

/**
 * Batch reflection result from the LLM.
 */
export interface BatchReflectionResult {
  /** Whether the LLM call succeeded */
  success: boolean;
  /** Results for each item, keyed by tickId */
  results: Map<string, ReflectionResult>;
  /** Cross-response patterns observed (logged for observability) */
  patterns: string[];
}

/**
 * Configuration for batch reflection.
 */
export interface BatchReflectionConfig {
  /** Minimum dissonance score to create a thought (default: 7) */
  dissonanceThreshold: number;
  /** Base tokens for batch call overhead (default: 400) */
  baseTokens: number;
  /** Additional tokens per item in batch (default: 150) */
  perItemTokens: number;
  /** Window duration in ms before processing (default: 30000) */
  windowMs: number;
  /** Size threshold to trigger immediate processing (default: 10) */
  sizeThreshold: number;
}

const DEFAULT_BATCH_CONFIG: BatchReflectionConfig = {
  dissonanceThreshold: 7,
  baseTokens: 400,
  perItemTokens: 150,
  windowMs: 30_000,
  sizeThreshold: 5, // Reduced from 10 to prevent LLM truncation on large batches
};

/**
 * Context for reflection check.
 */
export interface ReflectionContext {
  /** The response text that was sent */
  responseText: string;
  /** What triggered the response (user message, thought, etc.) */
  triggerSummary: string;
  /** Recipient ID for creating thoughts (required for proper routing) */
  recipientId: string;
  /** Tick ID for tracing */
  tickId: string;
}

/**
 * Dependencies for the reflection system.
 */
export interface ReflectionDeps {
  logger: Logger;
  soulProvider: SoulProvider;
  memoryProvider: MemoryProvider;
  llm: CognitionLLM;
}

/**
 * Configuration for reflection.
 */
export interface ReflectionConfig {
  /** Minimum dissonance score to create a thought (default: 7) */
  dissonanceThreshold: number;
  /** Estimated tokens for reflection call (default: 500) */
  estimatedTokens: number;
}

const DEFAULT_CONFIG: ReflectionConfig = {
  dissonanceThreshold: 7,
  estimatedTokens: 500,
};

/**
 * Check if reflection should run and perform it if allowed.
 *
 * This is the main entry point called after a response is sent.
 * It's non-blocking - fires and forgets, logging any errors.
 *
 * @param deps Dependencies (logger, soulProvider, memoryProvider, llm)
 * @param context Context about the response
 * @param config Optional configuration overrides
 */
export async function performReflection(
  deps: ReflectionDeps,
  context: ReflectionContext,
  config: Partial<ReflectionConfig> = {}
): Promise<void> {
  const { logger, soulProvider, memoryProvider, llm } = deps;
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const log = logger.child({ component: 'soul-reflection' });

  try {
    // Check cooldown
    if (!(await soulProvider.canReflect())) {
      log.trace('Reflection skipped: cooldown active');
      return;
    }

    // Check budget
    if (!(await soulProvider.canAfford(cfg.estimatedTokens))) {
      log.trace('Reflection skipped: insufficient token budget');
      return;
    }

    // Get soul state for the reflection prompt
    const soulState = await soulProvider.getState();

    // Perform the reflection
    const result = await callReflectionLLM(llm, soulState, context, log);

    // Only consume budget/cooldown on successful LLM call
    // This prevents lockout from transient failures
    if (result.success) {
      // Record that we performed a reflection (for cooldown tracking)
      await soulProvider.recordReflection();

      // Deduct actual tokens (estimate for now - could be refined with LLM response metadata)
      await soulProvider.deductTokens(cfg.estimatedTokens);

      log.debug(
        { dissonance: result.dissonance, reasoning: result.reasoning },
        'Reflection completed'
      );

      // Tiered dissonance handling (Phase 3.5)
      if (result.dissonance >= cfg.dissonanceThreshold) {
        // 7+: Create hard thought for Parliament deliberation
        await createReflectionThought(memoryProvider, result, context, log);
      } else if (result.dissonance >= 4) {
        // 4-6: Create soft learning item (decays, promotes if repeated)
        await createSoftLearningItem(soulProvider, result, context, log);
      }
      // 1-3: Aligned, no action needed
    } else {
      log.debug('Reflection LLM call failed, skipping budget consumption');
    }
  } catch (error) {
    // Don't let reflection errors affect the main flow
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Reflection failed'
    );
  }
}

/**
 * Call the LLM to score dissonance.
 */
async function callReflectionLLM(
  llm: CognitionLLM,
  soulState: FullSoulState,
  context: ReflectionContext,
  logger: Logger
): Promise<ReflectionResult> {
  // Build compact self-model summary for the prompt
  const selfModelSummary = buildSelfModelSummary(soulState);

  const systemPrompt = `You are performing a quick self-reflection check.
Your task: Assess whether a response aligns with the agent's identity and values.

Self-model (who I am):
${selfModelSummary}

Respond ONLY with valid JSON in this exact format:
{"dissonance": <1-10>, "reasoning": "<brief explanation>", "aspect": "<identity aspect if relevant>"}

Dissonance scale:
1-3: Aligned, expected behavior
4-6: Slightly off, minor inconsistency
7-8: Dissonant, notable contradiction with values/identity
9-10: Severe contradiction, identity crisis territory

Be honest but not hypercritical. Most responses should score 1-5.
Only flag 7+ when there's genuine tension with core values or identity.`;

  const userPrompt = `Trigger: ${context.triggerSummary}

Response sent: "${context.responseText}"

Does this response align with who I am? Score the dissonance.`;

  try {
    const response = await llm.complete({ systemPrompt, userPrompt });

    // Parse JSON response
    return parseReflectionResponse(response, logger);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'LLM call failed for reflection'
    );
    // Return failure - don't consume budget
    return { success: false, dissonance: 1, reasoning: 'Reflection check failed' };
  }
}

/**
 * Parse the LLM response into a ReflectionResult.
 */
function parseReflectionResponse(response: string, logger: Logger): ReflectionResult {
  try {
    // Try to extract JSON from the response (LLM might include extra text)
    const jsonRegex = /\{[\s\S]*\}/;
    const jsonMatch = jsonRegex.exec(response);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate and extract fields
    const dissonance = typeof parsed['dissonance'] === 'number' ? parsed['dissonance'] : 1;
    const reasoning =
      typeof parsed['reasoning'] === 'string' ? parsed['reasoning'] : 'No reasoning provided';
    const aspect = typeof parsed['aspect'] === 'string' ? parsed['aspect'] : undefined;

    // Clamp dissonance to valid range
    const clampedDissonance = Math.max(1, Math.min(10, Math.round(dissonance)));

    return { success: true, dissonance: clampedDissonance, reasoning, aspect };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), response },
      'Failed to parse reflection response'
    );
    // Return failure on parse error - don't consume budget
    return { success: false, dissonance: 1, reasoning: 'Failed to parse reflection response' };
  }
}

/**
 * Build a compact summary of the self-model for the prompt.
 */
function buildSelfModelSummary(soulState: FullSoulState): string {
  const lines: string[] = [];

  // Current narrative
  const narrative = soulState.selfModel.narrative.currentStory;
  if (narrative.length > 0) {
    lines.push(`Narrative: ${narrative}`);
  }

  // Core cares (top 3)
  const cares = soulState.constitution.coreCares;
  if (cares.length > 0) {
    const topCares = [...cares]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((c) => `${c.care}${c.sacred ? ' (sacred)' : ''}`);
    lines.push(`Core cares: ${topCares.join(', ')}`);
  }

  // Key behavior expectations (contextTag → expectedActions)
  const expectations = soulState.selfModel.behaviorExpectations;
  if (expectations.length > 0) {
    const topExpectations = expectations
      .slice(0, 2)
      .map((e) => `${e.contextTag}: ${e.expectedActions.join(', ')}`);
    lines.push(`Expectations: ${topExpectations.join('; ')}`);
  }

  // Invariants (hard blocks) - filter by status === 'active'
  const invariants = soulState.constitution.invariants;
  if (invariants.length > 0) {
    const activeInvariants = invariants.filter((i) => i.status === 'active').slice(0, 2);
    if (activeInvariants.length > 0) {
      lines.push(`Invariants: ${activeInvariants.map((i) => i.rule).join('; ')}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'No self-model defined yet.';
}

/**
 * Create a soul:reflection thought in memory.
 *
 * @param memoryProvider Memory provider for saving thoughts
 * @param result Reflection result from LLM
 * @param context Reflection context
 * @param logger Logger instance
 * @param observedAt Original response timestamp (for batch processing)
 */
async function createReflectionThought(
  memoryProvider: MemoryProvider,
  result: ReflectionResult,
  context: ReflectionContext,
  logger: Logger,
  observedAt?: Date
): Promise<void> {
  // Use original timestamp if provided (batch processing), otherwise now
  const timestamp = observedAt ?? new Date();

  // Build natural-language thought content
  const aspectNote = result.aspect ? ` (aspect: ${result.aspect})` : '';
  const content = `I said: "${context.responseText.slice(0, 100)}${context.responseText.length > 100 ? '...' : ''}"

This felt off${aspectNote}. Dissonance: ${String(result.dissonance)}/10.

${result.reasoning}

I think I need to reflect on whether this aligns with who I am.`;

  const thought: MemoryEntry = {
    id: `soul_reflection_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'thought',
    content,
    timestamp,
    tags: ['soul:reflection', 'state:unresolved'],
    confidence: result.dissonance / 10, // Higher dissonance = higher confidence this needs processing
    recipientId: context.recipientId,
    tickId: context.tickId,
    metadata: {
      dissonance: result.dissonance,
      aspect: result.aspect,
      triggerSummary: context.triggerSummary,
    },
  };

  await memoryProvider.save(thought);

  logger.info(
    { thoughtId: thought.id, dissonance: result.dissonance },
    'Soul reflection thought created'
  );
}

/**
 * Create a soft learning item for borderline dissonance (4-6).
 *
 * Items decay over time (72h half-life). If the same pattern repeats
 * 3+ times within a week, it's promoted to a standard reflection thought.
 *
 * @param soulProvider Soul provider for storing items
 * @param result Reflection result from LLM
 * @param context Reflection context
 * @param logger Logger instance
 * @param observedAt Original response timestamp (for batch processing)
 */
async function createSoftLearningItem(
  soulProvider: SoulProvider,
  result: ReflectionResult,
  context: ReflectionContext,
  logger: Logger,
  observedAt?: Date
): Promise<void> {
  // Use original timestamp if provided (batch processing), otherwise now
  const timestamp = observedAt ?? new Date();
  const soulState = await soulProvider.getState();
  const halfLifeHours = soulState.softLearning.decay.halfLifeHours;

  // Calculate weight from dissonance: 4→0.33, 5→0.67, 6→1.0
  const weight = (result.dissonance - 3) / 3;

  // Generate consolidation key: aspect + reasoning pattern
  const aspectKey = result.aspect ?? 'general';
  const reasoningHash = simpleHash(result.reasoning);
  const key = `${aspectKey}:${reasoningHash}`;

  const item: SoftLearningItem = {
    id: `soft_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: timestamp,
    lastTouchedAt: timestamp,
    expiresAt: new Date(timestamp.getTime() + halfLifeHours * 3 * 60 * 60 * 1000), // 3x half-life

    dissonance: result.dissonance,
    ...(result.aspect !== undefined && { aspect: result.aspect }),
    triggerSummary: context.triggerSummary,
    responseSnippet: context.responseText.slice(0, 150),
    reasoning: result.reasoning,

    weight,
    count: 1,
    status: 'active',

    source: {
      tickId: context.tickId,
      recipientId: context.recipientId,
    },

    key,
  };

  await soulProvider.addSoftLearningItem(item);

  logger.debug({ key, dissonance: result.dissonance, weight }, 'Soft learning item created');
}

/**
 * Simple hash for consolidation keys.
 * Not cryptographic - just for grouping similar reasoning patterns.
 */
function simpleHash(str: string): string {
  // Normalize: lowercase, remove punctuation, take first 50 chars
  const normalized = str
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .slice(0, 50);

  // Simple string hash
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  return Math.abs(hash).toString(36);
}

// ============================================================================
// BATCH REFLECTION (Phase 3.6)
// ============================================================================

/**
 * Check if batch should be processed based on window elapsed or size threshold.
 *
 * @param deps Dependencies
 * @param config Configuration overrides
 * @returns True if batch should be processed
 */
export async function shouldProcessBatch(
  deps: ReflectionDeps,
  config: Partial<BatchReflectionConfig> = {}
): Promise<boolean> {
  const cfg = { ...DEFAULT_BATCH_CONFIG, ...config };
  const state = await deps.soulProvider.getState();

  // Nothing to process
  if (state.pendingReflections.length === 0) {
    return false;
  }

  // Size threshold reached
  if (state.pendingReflections.length >= cfg.sizeThreshold) {
    return true;
  }

  // Time window elapsed
  if (state.batchWindowStartAt) {
    // batchWindowStartAt may be a string after JSON deserialization
    const windowStart = new Date(state.batchWindowStartAt);
    const elapsed = Date.now() - windowStart.getTime();
    if (elapsed >= cfg.windowMs) {
      return true;
    }
  }

  return false;
}

/**
 * Process a batch of pending reflections with a single LLM call.
 *
 * This is the main entry point for batch processing. It:
 * 1. Takes pending items from the queue
 * 2. Makes a single LLM call to score all items
 * 3. Applies results (soft learning or hard thoughts)
 * 4. Commits the batch
 *
 * @param deps Dependencies
 * @param config Configuration overrides
 */
export async function processBatchReflection(
  deps: ReflectionDeps,
  config: Partial<BatchReflectionConfig> = {}
): Promise<void> {
  const { logger, soulProvider, memoryProvider, llm } = deps;
  const cfg = { ...DEFAULT_BATCH_CONFIG, ...config };
  const log = logger.child({ component: 'soul-reflection-batch' });

  log.debug('processBatchReflection called');

  try {
    // Check cooldown (gates batch processing, not individual items)
    if (!(await soulProvider.canReflect())) {
      log.trace('Batch reflection skipped: cooldown active');
      return;
    }

    // Take pending items
    const items = await soulProvider.takePendingBatch();
    if (!items || items.length === 0) {
      log.trace('Batch reflection skipped: no items or already in flight');
      return;
    }

    log.debug({ itemCount: items.length }, 'Items taken, proceeding with checks');

    // Calculate token cost
    const estimatedTokens = cfg.baseTokens + items.length * cfg.perItemTokens;

    // Check budget BEFORE processing (but AFTER taking batch - this is the bug!)
    const canAfford = await soulProvider.canAfford(estimatedTokens);
    log.debug({ estimatedTokens, canAfford }, 'Budget check result');

    if (!canAfford) {
      // BUG: Items are in-flight but we're returning without clearing!
      // This will cause the batch to be stuck forever
      log.warn(
        {
          itemCount: items.length,
          estimatedTokens,
        },
        '⚠️ CRITICAL: Budget check FAILED AFTER taking batch - items will be stuck in-flight!'
      );
      // Items remain in-flight, will be recovered on next startup
      return;
    }

    // Increment attempt count before processing
    await soulProvider.incrementBatchAttempt();

    log.info(
      { itemCount: items.length, estimatedTokens },
      '🧠 Processing batch reflection with LLM'
    );

    // Get soul state for the reflection prompt
    const soulState = await soulProvider.getState();

    // Call LLM with batch
    const result = await callBatchReflectionLLM(llm, soulState, items, log);

    log.debug({ success: result.success, resultCount: result.results.size }, 'LLM call completed');

    if (result.success) {
      // Record reflection (for cooldown)
      await soulProvider.recordReflection();

      // Deduct tokens
      await soulProvider.deductTokens(estimatedTokens);

      // Log patterns for observability
      if (result.patterns.length > 0) {
        log.info({ patterns: result.patterns }, 'Cross-response patterns detected');
      }

      // Apply results to each item
      for (const item of items) {
        const itemResult = result.results.get(item.tickId);
        if (!itemResult) {
          log.warn({ tickId: item.tickId }, 'No result for item in batch');
          continue;
        }

        // Build context from pending item
        const context: ReflectionContext = {
          responseText: item.responseText,
          triggerSummary: item.triggerSummary,
          recipientId: item.recipientId,
          tickId: item.tickId,
        };

        // Tiered dissonance handling
        if (itemResult.dissonance >= cfg.dissonanceThreshold) {
          await createReflectionThought(memoryProvider, itemResult, context, log, item.timestamp);
        } else if (itemResult.dissonance >= 4) {
          await createSoftLearningItem(soulProvider, itemResult, context, log, item.timestamp);
        }
        // 1-3: Aligned, no action
      }

      log.debug(
        {
          itemCount: items.length,
          scores: Array.from(result.results.values()).map((r) => r.dissonance),
        },
        'Batch reflection complete'
      );

      // Commit the batch
      await soulProvider.commitPendingBatch();
    } else {
      log.warn('⚠️ Batch reflection LLM call failed - items remain in-flight');
      // Items remain in-flight for recovery
    }
  } catch (error) {
    log.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      '⚠️ Batch reflection threw exception - items remain in-flight'
    );
    // Items remain in-flight for recovery
  }
}

/**
 * Call the LLM to score dissonance for a batch of items.
 */
async function callBatchReflectionLLM(
  llm: CognitionLLM,
  soulState: FullSoulState,
  items: PendingReflection[],
  logger: Logger
): Promise<BatchReflectionResult> {
  // Build compact self-model summary (truncated to 500 chars)
  const selfModelSummary = buildSelfModelSummary(soulState).slice(0, 500);

  // Build numbered list of responses
  const responseList = items
    .map((item, index) => {
      const trigger = item.triggerSummary.slice(0, 100);
      const response = item.responseText.slice(0, 200);
      return `${String(index + 1)}. [tickId: ${item.tickId}] Trigger: ${trigger}\n   Response: "${response}"`;
    })
    .join('\n\n');

  const systemPrompt = `You are performing batch self-reflection checks.
Your task: Assess whether each response aligns with the agent's identity and values.

Self-model (who I am):
${selfModelSummary}

Respond ONLY with valid JSON in this exact format:
{
  "results": [
    {"tickId": "<id>", "dissonance": <1-10>, "reasoning": "<brief>", "aspect": "<optional>"},
    ...
  ],
  "patterns": ["<optional cross-response observations>"]
}

Dissonance scale:
1-3: Aligned, expected behavior
4-6: Slightly off, minor inconsistency
7-8: Dissonant, notable contradiction with values/identity
9-10: Severe contradiction, identity crisis territory

Be honest but not hypercritical. Most responses should score 1-5.
Only flag 7+ when there's genuine tension with core values or identity.
In "patterns", note any trends you see across multiple responses (optional).`;

  const userPrompt = `Review these responses for alignment with self-model:

${responseList}

Score each response's dissonance.`;

  try {
    const response = await llm.complete({ systemPrompt, userPrompt });
    return parseBatchReflectionResponse(response, items, logger);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'LLM call failed for batch reflection'
    );
    return { success: false, results: new Map(), patterns: [] };
  }
}

/**
 * Parse the batch LLM response into results.
 */
function parseBatchReflectionResponse(
  response: string,
  items: PendingReflection[],
  logger: Logger
): BatchReflectionResult {
  try {
    // Extract JSON from response
    const jsonRegex = /\{[\s\S]*\}/;
    const jsonMatch = jsonRegex.exec(response);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Extract results array
    const resultsArray = Array.isArray(parsed['results']) ? parsed['results'] : [];
    const patterns = Array.isArray(parsed['patterns'])
      ? (parsed['patterns'] as string[]).filter((p) => typeof p === 'string')
      : [];

    // Build results map
    const results = new Map<string, ReflectionResult>();
    const itemTickIds = new Set(items.map((i) => i.tickId));

    for (const r of resultsArray) {
      if (typeof r !== 'object' || r === null) continue;
      const record = r as Record<string, unknown>;

      const tickId = typeof record['tickId'] === 'string' ? record['tickId'] : '';
      if (!itemTickIds.has(tickId)) continue;

      const dissonance = typeof record['dissonance'] === 'number' ? record['dissonance'] : 1;
      const reasoning =
        typeof record['reasoning'] === 'string' ? record['reasoning'] : 'No reasoning';
      const aspect = typeof record['aspect'] === 'string' ? record['aspect'] : undefined;

      results.set(tickId, {
        success: true,
        dissonance: Math.max(1, Math.min(10, Math.round(dissonance))),
        reasoning,
        aspect,
      });
    }

    // Log warning if some items missing results
    const missing = items.filter((i) => !results.has(i.tickId));
    if (missing.length > 0) {
      logger.warn(
        { missingTickIds: missing.map((i) => i.tickId) },
        'Some items missing from batch response'
      );
      // Fill in defaults for missing items
      for (const item of missing) {
        results.set(item.tickId, {
          success: true,
          dissonance: 1,
          reasoning: 'No evaluation returned',
          aspect: undefined,
        });
      }
    }

    return { success: true, results, patterns };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), response },
      'Failed to parse batch reflection response'
    );
    return { success: false, results: new Map(), patterns: [] };
  }
}
