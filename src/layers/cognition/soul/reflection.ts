/**
 * Soul Reflection
 *
 * Post-response reflection system that detects dissonance between
 * the agent's response and its self-model.
 *
 * Human-like flow:
 * 1. Response sent to user
 * 2. Quick reflection check: "Did that feel aligned with who I am?"
 * 3. If dissonance detected (score ≥ 7), create a soul:reflection thought
 * 4. The thought creates pressure until processed by Parliament (Phase 4)
 *
 * Design principles:
 * - Non-blocking: Don't delay response to user
 * - Budget-aware: Respects token limits and cooldowns
 * - Lightweight: Single LLM call (~300-500 tokens)
 */

import type { Logger } from '../../../types/logger.js';
import type { SoulProvider, FullSoulState } from '../../../storage/soul-provider.js';
import type { MemoryProvider, MemoryEntry } from '../tools/registry.js';
import type { CognitionLLM } from '../agentic-loop.js';

/**
 * Reflection result from the LLM.
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

      // If dissonance is high enough, create a soul thought
      if (result.dissonance >= cfg.dissonanceThreshold) {
        await createReflectionThought(memoryProvider, result, context, log);
      }
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
 */
async function createReflectionThought(
  memoryProvider: MemoryProvider,
  result: ReflectionResult,
  context: ReflectionContext,
  logger: Logger
): Promise<void> {
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
    timestamp: new Date(),
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
