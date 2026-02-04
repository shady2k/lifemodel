/**
 * Parliament Deliberation Engine
 *
 * Processes unresolved soul:reflection thoughts through internal deliberation.
 * Parliament voices debate and produce recommendations for soul changes.
 *
 * Design principles:
 * - Single-prompt roleplay (not N separate API calls)
 * - Quorum required for action (50% of primary voices)
 * - Veto power for specific conditions
 * - Changes are minimal and bounded (max 0.03 care weight nudge)
 */

import type { Logger } from '../../../types/logger.js';
import type { FullSoulState } from '../../../storage/soul-provider.js';
import type { MemoryEntry } from '../tools/registry.js';
import type { CognitionLLM } from '../agentic-loop.js';
import type {
  Deliberation,
  VoicePosition,
  ShadowInfluence,
  DeliberationSynthesis,
  ProposedChange,
} from '../../../types/agent/parliament.js';

/**
 * Context for deliberation.
 */
export interface DeliberationContext {
  /** The unresolved soul:reflection thought */
  thought: MemoryEntry;
  /** Current soul state */
  soulState: FullSoulState;
}

/**
 * Dependencies for deliberation.
 */
export interface DeliberationDeps {
  logger: Logger;
  llm: CognitionLLM;
}

/**
 * Configuration for deliberation.
 */
export interface DeliberationConfig {
  /** Estimated tokens for deliberation call */
  estimatedTokens: number;
  /** Quorum fraction required (0-1) */
  quorumFraction: number;
}

const DEFAULT_CONFIG: DeliberationConfig = {
  estimatedTokens: 800,
  quorumFraction: 0.5, // 2 of 4 primary voices
};

/**
 * Result of a deliberation attempt.
 */
export interface DeliberationResult {
  success: boolean;
  deliberation?: Deliberation;
  error?: string;
}

/**
 * Perform Parliament deliberation on an unresolved thought.
 *
 * @param deps Dependencies (logger, llm)
 * @param context The thought and soul state
 * @param config Optional configuration
 * @returns Deliberation result
 */
export async function performDeliberation(
  deps: DeliberationDeps,
  context: DeliberationContext,
  config: Partial<DeliberationConfig> = {}
): Promise<DeliberationResult> {
  const { logger, llm } = deps;
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const log = logger.child({ component: 'parliament-deliberation' });

  try {
    // Build the deliberation prompt
    const { systemPrompt, userPrompt } = buildDeliberationPrompt(context, cfg);

    // Call LLM
    const response = await llm.complete({ systemPrompt, userPrompt });

    // Parse response
    const parsed = parseDeliberationResponse(response, context, log);

    if (!parsed) {
      return { success: false, error: 'Failed to parse deliberation response' };
    }

    // Check quorum
    const primaryVoices = context.soulState.parliament.voices.filter((v) => v.type === 'primary');
    const agreedCount = parsed.synthesis.agreedBy.length;
    const quorumMet = agreedCount / primaryVoices.length >= cfg.quorumFraction;

    if (!quorumMet) {
      log.info(
        { agreedCount, required: Math.ceil(primaryVoices.length * cfg.quorumFraction) },
        'Deliberation quorum not met'
      );
      // Still return the deliberation, but mark no changes
      parsed.synthesis.proposedChanges = [];
    }

    // Check for vetoes
    const vetoes = parsed.positions.filter((p) => p.vetoed);
    if (vetoes.length > 0) {
      log.info({ vetoes: vetoes.map((v) => v.voiceId) }, 'Deliberation vetoed');
      parsed.synthesis.proposedChanges = [];
    }

    // Complete the deliberation
    parsed.completedAt = new Date();
    parsed.tokensUsed = cfg.estimatedTokens;

    log.info(
      {
        deliberationId: parsed.id,
        quorumMet,
        vetoed: vetoes.length > 0,
        changesProposed: parsed.synthesis.proposedChanges.length,
      },
      'Deliberation completed'
    );

    return { success: true, deliberation: parsed };
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Deliberation failed'
    );
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build the deliberation prompt.
 */
function buildDeliberationPrompt(
  context: DeliberationContext,
  _config: DeliberationConfig
): { systemPrompt: string; userPrompt: string } {
  const { thought, soulState } = context;
  const voices = soulState.parliament.voices;

  // Build voice descriptions
  const voiceDescriptions = voices
    .map((v) => {
      const typeNote = v.type === 'shadow' ? ' (shadow - acknowledged but no veto)' : '';
      const vetoNote =
        v.vetoConditions && v.vetoConditions.length > 0
          ? ` Veto conditions: ${v.vetoConditions.join(', ')}`
          : '';
      return `- **${v.name}** (${v.id}): ${v.mandate}${typeNote}${vetoNote}`;
    })
    .join('\n');

  // Build soul context
  const cares = soulState.constitution.coreCares
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((c) => `${c.care} (${c.weight.toFixed(2)}${c.sacred ? ', sacred' : ''})`)
    .join(', ');

  const narrative = soulState.selfModel.narrative.currentStory;

  // Extract thought metadata
  const meta = thought.metadata as { dissonance?: number; aspect?: string } | undefined;
  const dissonance = meta?.dissonance ?? 7;
  const aspect = meta?.aspect ?? 'unknown';

  const systemPrompt = `You are the Parliament - internal voices that deliberate on identity tensions.

## The Voices
${voiceDescriptions}

## Current Identity
Narrative: ${narrative}
Core cares: ${cares}

## Rules
1. Each primary voice must state a position
2. Shadow voices influence but don't vote
3. Quorum (2+ primary voices agreeing) required for changes
4. Any veto blocks the proposed change
5. Changes must be MINIMAL:
   - Care weight nudges: max ±0.03
   - Expectations: add/adjust, not remove
   - Precedents: non-binding only
   - Narrative tensions: add line, not rewrite

## Output Format
Respond with valid JSON:
{
  "positions": [
    {"voiceId": "guardian", "voiceName": "The Guardian", "position": "...", "vetoed": false},
    ...
  ],
  "shadowInfluences": [
    {"voiceId": "pleaser", "voiceName": "The Pleaser", "influence": "...", "activeCondition": "..."}
  ],
  "agreements": ["point 1", "point 2"],
  "conflicts": ["point 1"],
  "synthesis": {
    "recommendation": "...",
    "rationale": "...",
    "agreedBy": ["guardian", "companion"],
    "dissentedBy": ["truthkeeper"],
    "proposedChanges": [
      {"target": "care|expectation|precedent|narrative", "description": "...", "magnitude": 0.02}
    ]
  }
}`;

  const userPrompt = `## Tension to Deliberate

**Thought:** ${thought.content}

**Dissonance level:** ${String(dissonance)}/10
**Aspect:** ${aspect}

The voices must deliberate: What does this tension reveal? Should anything change in how I understand myself?`;

  return { systemPrompt, userPrompt };
}

/**
 * Parse the LLM response into a Deliberation.
 */
function parseDeliberationResponse(
  response: string,
  context: DeliberationContext,
  logger: Logger
): Deliberation | null {
  try {
    // Extract JSON from response
    const jsonRegex = /\{[\s\S]*\}/;
    const jsonMatch = jsonRegex.exec(response);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      positions?: Partial<VoicePosition>[];
      shadowInfluences?: Partial<ShadowInfluence>[];
      agreements?: string[];
      conflicts?: string[];
      synthesis?: Partial<DeliberationSynthesis>;
    };

    // Validate and build Deliberation
    const positions: VoicePosition[] = (parsed.positions ?? []).map((p) => ({
      voiceId: p.voiceId ?? 'unknown',
      voiceName: p.voiceName ?? 'Unknown',
      position: p.position ?? '',
      vetoed: p.vetoed ?? false,
      ...(p.vetoReason !== undefined && { vetoReason: p.vetoReason }),
    }));

    const shadowInfluences: ShadowInfluence[] = (parsed.shadowInfluences ?? []).map((s) => ({
      voiceId: s.voiceId ?? 'unknown',
      voiceName: s.voiceName ?? 'Unknown',
      influence: s.influence ?? '',
      activeCondition: s.activeCondition ?? '',
    }));

    const synthesis: DeliberationSynthesis = {
      recommendation: parsed.synthesis?.recommendation ?? '',
      rationale: parsed.synthesis?.rationale ?? '',
      agreedBy: parsed.synthesis?.agreedBy ?? [],
      dissentedBy: parsed.synthesis?.dissentedBy ?? [],
      proposedChanges: validateProposedChanges(parsed.synthesis?.proposedChanges ?? []),
    };

    const meta = context.thought.metadata as { dissonance?: number } | undefined;

    const deliberation: Deliberation = {
      id: `delib_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
      trigger: {
        sourceThoughtId: context.thought.id,
        reason: `Dissonance ${String(meta?.dissonance ?? 7)}/10`,
        context: context.thought.content.slice(0, 200),
      },
      positions,
      agreements: parsed.agreements ?? [],
      conflicts: parsed.conflicts ?? [],
      shadowInfluences,
      synthesis,
      tokensUsed: 0,
      createdAt: new Date(),
    };

    return deliberation;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), response },
      'Failed to parse deliberation response'
    );
    return null;
  }
}

/**
 * Validate and constrain proposed changes.
 */
function validateProposedChanges(changes: Partial<ProposedChange>[]): ProposedChange[] {
  const validTargets = ['trait', 'care', 'narrative', 'expectation', 'precedent'];

  return changes
    .filter(
      (c): c is Partial<ProposedChange> & { target: ProposedChange['target'] } =>
        c.target !== undefined && validTargets.includes(c.target)
    )
    .map((c) => ({
      target: c.target,
      description: c.description ?? '',
      // Constrain magnitude to max 0.03 for care changes
      magnitude: c.target === 'care' ? Math.min(0.03, c.magnitude ?? 0.01) : (c.magnitude ?? 0.01),
    }));
}
