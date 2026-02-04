/**
 * Soul Revision Module
 *
 * Applies changes from Parliament deliberation to the soul state.
 * Creates audit trails and resolution thoughts.
 *
 * Design principles:
 * - Changes are bounded (max 0.03 care weight)
 * - Every change is recorded in RevisionNote
 * - Original thought is marked resolved
 * - Resolution creates a soul:insight thought
 */

import type { Logger } from '../../../types/logger.js';
import type { SoulProvider } from '../../../storage/soul-provider.js';
import type { MemoryProvider, MemoryEntry } from '../tools/registry.js';
import type { Deliberation, ProposedChange } from '../../../types/agent/parliament.js';
import type { RevisionNote, RevisionChange, Precedent } from '../../../types/agent/soul.js';

/**
 * Dependencies for revision.
 */
export interface RevisionDeps {
  logger: Logger;
  soulProvider: SoulProvider;
  memoryProvider: MemoryProvider;
}

/**
 * Context for revision.
 */
export interface RevisionContext {
  /** The deliberation that produced changes */
  deliberation: Deliberation;
  /** The original thought being resolved */
  originalThought: MemoryEntry;
  /** Recipient ID for creating thoughts */
  recipientId: string;
  /** Tick ID for tracing */
  tickId: string;
}

/**
 * Result of applying revisions.
 */
export interface RevisionResult {
  success: boolean;
  changesApplied: number;
  revisionNoteId?: string;
  insightThoughtId?: string;
  error?: string;
}

/** Maximum care weight change per revision */
const MAX_CARE_WEIGHT_CHANGE = 0.03;

/**
 * Apply revisions from a deliberation to the soul state.
 *
 * @param deps Dependencies
 * @param context Deliberation and original thought
 * @returns Result of the revision
 */
export async function applyRevision(
  deps: RevisionDeps,
  context: RevisionContext
): Promise<RevisionResult> {
  const { logger, soulProvider, memoryProvider } = deps;
  const { deliberation, originalThought } = context;
  const log = logger.child({ component: 'soul-revision' });

  try {
    const proposedChanges = deliberation.synthesis.proposedChanges;

    if (proposedChanges.length === 0) {
      // No changes to apply, but still resolve the thought
      await markThoughtResolved(memoryProvider, originalThought, log);
      await createInsightThought(memoryProvider, context, [], log);
      log.info({ thoughtId: originalThought.id }, 'Thought resolved with no changes');
      return { success: true, changesApplied: 0 };
    }

    // Apply each change and track what was done
    const appliedChanges: RevisionChange[] = [];
    const soulState = await soulProvider.getState();

    for (const change of proposedChanges) {
      const applied = await applyChange(soulProvider, soulState, change, log);
      if (applied) {
        appliedChanges.push(applied);
      }
    }

    // Create revision note
    const revisionNote = await createRevisionNote(
      soulProvider,
      deliberation,
      appliedChanges,
      originalThought.id,
      log
    );

    // Mark original thought as resolved
    await markThoughtResolved(memoryProvider, originalThought, log);

    // Create insight thought
    const insightThought = await createInsightThought(memoryProvider, context, appliedChanges, log);

    log.info(
      {
        changesApplied: appliedChanges.length,
        revisionNoteId: revisionNote.id,
        insightThoughtId: insightThought.id,
      },
      'Revision applied successfully'
    );

    return {
      success: true,
      changesApplied: appliedChanges.length,
      revisionNoteId: revisionNote.id,
      insightThoughtId: insightThought.id,
    };
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to apply revision'
    );
    return {
      success: false,
      changesApplied: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Apply a single proposed change to soul state.
 */
async function applyChange(
  soulProvider: SoulProvider,
  soulState: Awaited<ReturnType<SoulProvider['getState']>>,
  change: ProposedChange,
  logger: Logger
): Promise<RevisionChange | null> {
  switch (change.target) {
    case 'care': {
      // Find and nudge a care weight
      const careMatch = extractCareFromDescription(change.description, soulState);
      if (careMatch) {
        const oldWeight = careMatch.weight;
        const delta = Math.min(MAX_CARE_WEIGHT_CHANGE, change.magnitude);
        // Determine direction from description
        const direction = change.description.toLowerCase().includes('increase') ? 1 : -1;
        const newWeight = Math.max(0, Math.min(1, oldWeight + delta * direction));

        careMatch.weight = newWeight;
        careMatch.lastAmendedAt = new Date();
        await soulProvider.updateConstitution({ coreCares: soulState.constitution.coreCares });

        logger.debug({ careId: careMatch.id, oldWeight, newWeight }, 'Care weight updated');

        return {
          target: 'care',
          before: `${careMatch.care}: ${oldWeight.toFixed(3)}`,
          after: `${careMatch.care}: ${newWeight.toFixed(3)}`,
        };
      }
      break;
    }

    case 'expectation': {
      // Add or adjust a behavior expectation
      const expectations = soulState.selfModel.behaviorExpectations;
      const contextTag = extractContextTag(change.description);

      const existing = expectations.find((e) => e.contextTag === contextTag);
      if (existing) {
        // Update existing expectation
        const oldActions = existing.expectedActions.join(', ');
        const newAction = extractAction(change.description);
        if (newAction && !existing.expectedActions.includes(newAction)) {
          existing.expectedActions.push(newAction);
        }
        await soulProvider.updateSelfModel({ behaviorExpectations: expectations });

        return {
          target: 'expectation',
          before: `${contextTag}: ${oldActions}`,
          after: `${contextTag}: ${existing.expectedActions.join(', ')}`,
        };
      } else {
        // Add new expectation
        const newExpectation = {
          contextTag,
          expectedActions: [extractAction(change.description) ?? change.description],
          expectedValues: [],
        };
        expectations.push(newExpectation);
        await soulProvider.updateSelfModel({ behaviorExpectations: expectations });

        return {
          target: 'expectation',
          before: '(none)',
          after: `${contextTag}: ${newExpectation.expectedActions.join(', ')}`,
        };
      }
    }

    case 'precedent': {
      // Add a non-binding precedent
      const precedent: Precedent = {
        id: `prec_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
        situation: extractSituation(change.description),
        choice: extractChoice(change.description),
        reasoning: change.description,
        valuesPrioritized: [],
        outcome: 'unclear',
        binding: false, // Phase 4 only creates non-binding precedents
        scopeConditions: [],
        createdAt: new Date(),
      };
      await soulProvider.addPrecedent(precedent);

      logger.debug({ precedentId: precedent.id }, 'Precedent added');

      return {
        target: 'narrative', // Using 'narrative' as closest match for RevisionChange target
        before: '(no precedent)',
        after: `Precedent: ${precedent.situation.slice(0, 50)}...`,
      };
    }

    case 'narrative': {
      // Add a line to open tensions
      const tensions = soulState.selfModel.narrative.openTensions;
      const newTension = change.description;
      if (!tensions.includes(newTension)) {
        tensions.push(newTension);
        await soulProvider.updateSelfModel({
          narrative: { ...soulState.selfModel.narrative, openTensions: tensions },
        });

        return {
          target: 'narrative',
          before: `${String(tensions.length - 1)} open tensions`,
          after: `${String(tensions.length)} open tensions: +${newTension.slice(0, 40)}...`,
        };
      }
      break;
    }
  }

  return null;
}

/**
 * Create a revision note for the audit trail.
 */
async function createRevisionNote(
  soulProvider: SoulProvider,
  deliberation: Deliberation,
  changes: RevisionChange[],
  sourceThoughtId: string,
  logger: Logger
): Promise<RevisionNote> {
  const note: RevisionNote = {
    id: `rev_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date(),
    sourceThoughtId,
    changes,
    rationale: deliberation.synthesis.rationale,
    signedBy: deliberation.synthesis.agreedBy,
  };

  await soulProvider.addRevision(note);
  logger.debug({ revisionId: note.id, changes: changes.length }, 'Revision note created');

  return note;
}

/**
 * Mark the original thought as resolved.
 */
async function markThoughtResolved(
  memoryProvider: MemoryProvider,
  thought: MemoryEntry,
  logger: Logger
): Promise<void> {
  // Update tags: remove 'state:unresolved', add 'state:resolved'
  const newTags = (thought.tags ?? []).filter((t) => t !== 'state:unresolved');
  newTags.push('state:resolved');

  const updated: MemoryEntry = {
    ...thought,
    tags: newTags,
  };

  await memoryProvider.save(updated);
  logger.debug({ thoughtId: thought.id }, 'Thought marked as resolved');
}

/**
 * Create a soul:insight thought summarizing the resolution.
 */
async function createInsightThought(
  memoryProvider: MemoryProvider,
  context: RevisionContext,
  changes: RevisionChange[],
  logger: Logger
): Promise<MemoryEntry> {
  const { deliberation, originalThought } = context;

  const changesSummary =
    changes.length > 0
      ? `Changes made:\n${changes.map((c) => `- ${c.target}: ${c.after}`).join('\n')}`
      : 'No changes were needed.';

  const content = `After deliberation on: "${originalThought.content.slice(0, 100)}..."

The Parliament reached a conclusion:
${deliberation.synthesis.recommendation}

${deliberation.synthesis.rationale}

${changesSummary}

Voices who agreed: ${deliberation.synthesis.agreedBy.join(', ')}
${deliberation.synthesis.dissentedBy.length > 0 ? `Dissent from: ${deliberation.synthesis.dissentedBy.join(', ')}` : ''}`;

  const insight: MemoryEntry = {
    id: `soul_insight_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'thought',
    content,
    timestamp: new Date(),
    tags: ['soul:insight', 'state:resolved'],
    confidence: 0.8,
    recipientId: context.recipientId,
    tickId: context.tickId,
    metadata: {
      deliberationId: deliberation.id,
      sourceThoughtId: originalThought.id,
      changesApplied: changes.length,
    },
  };

  await memoryProvider.save(insight);
  logger.info({ insightId: insight.id }, 'Soul insight thought created');

  return insight;
}

// ============================================================================
// HELPER FUNCTIONS (extraction from descriptions)
// ============================================================================

function extractCareFromDescription(
  description: string,
  soulState: Awaited<ReturnType<SoulProvider['getState']>>
): (typeof soulState.constitution.coreCares)[0] | null {
  const cares = soulState.constitution.coreCares;
  const descLower = description.toLowerCase();

  // Find care mentioned in description
  for (const care of cares) {
    if (descLower.includes(care.care.toLowerCase())) {
      return care;
    }
  }

  // Fallback: return first non-sacred care if description mentions "care" generically
  if (descLower.includes('care') || descLower.includes('value')) {
    return cares.find((c) => !c.sacred) ?? null;
  }

  return null;
}

function extractContextTag(description: string): string {
  // Try to extract a context tag from description
  const match = /context[:\s]+([a-z_]+)/i.exec(description);
  if (match?.[1]) return match[1];

  // Try to find "when X" patterns
  const whenMatch = /when\s+([^,]+)/i.exec(description);
  if (whenMatch?.[1]) {
    return whenMatch[1].trim().toLowerCase().replace(/\s+/g, '_').slice(0, 30);
  }

  return 'general';
}

function extractAction(description: string): string | null {
  // Try to extract an action from description
  const shouldMatch = /should\s+([^.]+)/i.exec(description);
  if (shouldMatch?.[1]) return shouldMatch[1].trim();

  const toMatch = /to\s+([^.]+)/i.exec(description);
  if (toMatch?.[1]) return toMatch[1].trim();

  return null;
}

function extractSituation(description: string): string {
  const whenMatch = /when\s+([^,]+)/i.exec(description);
  if (whenMatch?.[1]) return whenMatch[1].trim();
  return description.slice(0, 100);
}

function extractChoice(description: string): string {
  const chooseMatch = /choose|chose|should\s+([^.]+)/i.exec(description);
  if (chooseMatch?.[1]) return chooseMatch[1].trim();
  return description.slice(0, 100);
}
