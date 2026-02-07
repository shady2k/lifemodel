/**
 * Context Sections
 *
 * Builds the 7 context sections injected into the trigger prompt:
 * user profile, recent thoughts, pending intentions, soul, unresolved tensions,
 * runtime snapshot, and completed actions.
 *
 * Pure functions — no state mutation.
 */

import type { LoopContext } from '../agentic-loop-types.js';
import {
  shouldIncludeRuntimeSnapshot,
  getRuntimeSnapshotScope,
  getTriggerText,
  asNumber,
  describeLevel,
} from './runtime-snapshot.js';

/**
 * Format age in human-readable form.
 * Shared by thoughts, intentions, and completed actions sections.
 */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / (1000 * 60));
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} hr`;
  }
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days > 1 ? 's' : ''}`;
}

export function buildUserProfileSection(context: LoopContext): string | null {
  const { userModel } = context;

  const name = typeof userModel['name'] === 'string' ? userModel['name'].trim() : '';
  const lines: string[] = [];

  if (name.length > 0) {
    lines.push(`- name: ${name}`);
  }

  if (lines.length === 0) {
    return null;
  }

  return `## User Profile (stable facts)
${lines.join('\n')}
NOTE: Use the user's name sparingly; check conversation history first.`;
}

/**
 * Build recent thoughts section for context priming.
 * Shows what the agent was thinking about recently (internal context).
 */
export function buildRecentThoughtsSection(context: LoopContext): string | null {
  const thoughts = context.recentThoughts;
  if (!thoughts || thoughts.length === 0) {
    return null;
  }

  const now = Date.now();
  const lines = thoughts.map((thought) => {
    const ageMs = now - thought.timestamp.getTime();
    const ageStr = formatAge(ageMs);
    return `- [${ageStr} ago] ${thought.content}`;
  });

  return `## Recent Thoughts
${lines.join('\n')}
NOTE: Your recent internal thoughts. Background context, not visible to user.`;
}

/**
 * Build pending intentions section.
 * Shows insights from thought processing that should be woven into conversation naturally.
 * These are non-urgent thought outputs saved for the next user interaction.
 */
export function buildPendingIntentionsSection(context: LoopContext): string | null {
  const intentions = context.pendingIntentions;
  if (!intentions || intentions.length === 0) {
    return null;
  }

  const now = Date.now();
  const lines = intentions.map((intention) => {
    const ageMs = now - intention.timestamp.getTime();
    const ageStr = formatAge(ageMs);
    return `- [${ageStr} ago] ${intention.content}`;
  });

  return `## Pending Insights
${lines.join('\n')}
NOTE: Insights from your background thinking. Weave naturally into conversation if relevant — don't force them.`;
}

/**
 * Build soul section for identity awareness.
 * Surfaces enough identity context for the agent to act from its values,
 * not just be scored against them. ~250 tokens target.
 */
export function buildSoulSection(context: LoopContext): string | null {
  const { soulState } = context;
  if (!soulState) {
    return null;
  }

  const lines: string[] = [];

  // Current narrative arc (who I am / becoming)
  const narrative = soulState.selfModel.narrative.currentStory;
  if (narrative.length > 0) {
    lines.push(narrative);
  }
  const becoming = soulState.narrative.currentNarrative.whoIAmBecoming;
  if (becoming) {
    lines.push(`Becoming: ${becoming}`);
  }

  // All core cares, sorted by weight, sacred marker instead of numeric weight
  const cares = soulState.constitution.coreCares;
  if (cares.length > 0) {
    const sortedCares = [...cares]
      .sort((a, b) => b.weight - a.weight)
      .map((c) => {
        const sacred = c.sacred ? ' [sacred]' : '';
        return `- ${c.care}${sacred}`;
      });
    lines.push('');
    lines.push('Core cares (ranked):');
    lines.push(...sortedCares);
  }

  // Active invariants — hard identity constraints
  const invariants = soulState.constitution.invariants;
  if (invariants.length > 0) {
    const activeInvariants = invariants
      .filter((inv) => inv.status === 'active')
      .map((inv) => `- ${inv.rule}`);
    if (activeInvariants.length > 0) {
      lines.push('');
      lines.push('Lines I do not cross:');
      lines.push(...activeInvariants);
    }
  }

  // Identity themes — emergent self-perception (top 2-3)
  const themes = soulState.selfModel.identityThemes;
  if (themes.length > 0) {
    const topThemes = [...themes]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 3)
      .map((t) => t.theme);
    lines.push('');
    lines.push(`I see myself as: ${topThemes.join(', ')}`);
  }

  // Active cornerstone — deepest identity anchor (commitment only)
  const activeCornerstone = soulState.cornerstones.find((c) => c.status === 'active');
  if (activeCornerstone) {
    lines.push(`Cornerstone: ${activeCornerstone.commitment}`);
  }

  if (lines.length === 0) {
    return null;
  }

  return `## Who I Am (Living)
${lines.join('\n')}

These shape HOW you respond, not WHAT you say. Never reference your values or identity explicitly — just act accordingly.`;
}

/**
 * Build unresolved soul tensions section.
 * Shows dissonant reflections that need processing (Zeigarnik pressure).
 * Limited to 2-3 highest dissonance items.
 */
export function buildUnresolvedTensionsSection(context: LoopContext): string | null {
  const tensions = context.unresolvedTensions;
  if (!tensions || tensions.length === 0) {
    return null;
  }

  const lines = tensions.map((t) => {
    return `- [${String(t.dissonance)}/10] ${t.content}`;
  });

  return `## Unresolved Soul Tensions
${lines.join('\n')}

These are reflections creating internal pressure. They represent moments where
your response felt misaligned with who you are. Consider processing them when
appropriate, or use \`core.memory\` to search for more context.`;
}

export function buildRuntimeSnapshotSection(
  context: LoopContext,
  useSmart: boolean
): string | null {
  if (!shouldIncludeRuntimeSnapshot(context, useSmart)) {
    return null;
  }

  const { agentState, userModel } = context;
  const triggerText = getTriggerText(context.triggerSignal);
  const scope = getRuntimeSnapshotScope(context, triggerText);

  const agentParts: string[] = [];
  const userParts: string[] = [];

  // Automatic fields — read-only context, managed by autonomic layer
  const autoParts: string[] = [];
  if (scope.includeAgentEnergy) {
    autoParts.push(`energy ${describeLevel(agentState.energy)}`);
  }
  if (scope.includeSocialDebt) {
    autoParts.push(`socialDebt ${describeLevel(agentState.socialDebt)}`);
  }

  if (scope.includeTaskPressure) {
    agentParts.push(`taskPressure ${describeLevel(agentState.taskPressure)}`);
  }
  if (scope.includeCuriosity) {
    agentParts.push(`curiosity ${describeLevel(agentState.curiosity)}`);
  }
  if (scope.includeAcquaintancePressure) {
    agentParts.push(`acquaintancePressure ${describeLevel(agentState.acquaintancePressure)}`);
  }

  const userEnergy = asNumber(userModel['energy']);
  if (scope.includeUserEnergy && userEnergy !== null) {
    userParts.push(`energy ${describeLevel(userEnergy)}`);
  }
  const userAvailability = asNumber(userModel['availability']);
  if (scope.includeUserAvailability && userAvailability !== null) {
    userParts.push(`availability ${describeLevel(userAvailability)}`);
  }

  if (autoParts.length === 0 && agentParts.length === 0 && userParts.length === 0) {
    return null;
  }

  const autoChunk =
    autoParts.length > 0 ? `Automatic (do not update): ${autoParts.join(', ')}` : '';
  const agentChunk = agentParts.length > 0 ? `Agent: ${agentParts.join(', ')}` : '';
  const userChunk = userParts.length > 0 ? `User: ${userParts.join(', ')}` : '';
  const combined = [autoChunk, agentChunk, userChunk].filter((part) => part.length > 0).join('; ');

  return `## Runtime Snapshot
${combined}`;
}

/**
 * Build completed actions section to prevent LLM re-execution.
 * Only included for non-user-message triggers (autonomous events).
 */
export function buildCompletedActionsSection(context: LoopContext): string | null {
  // Only include for non-user-message triggers
  // User messages start fresh - the LLM should respond to what the user just said
  if (context.triggerSignal.type === 'user_message') {
    return null;
  }

  const actions = context.completedActions;
  if (!actions || actions.length === 0) {
    return null;
  }

  // Format actions with relative timestamps
  const now = Date.now();
  const formatted = actions.map((action) => {
    const ageMs = now - new Date(action.timestamp).getTime();
    const ageStr = formatAge(ageMs);
    // Simplify tool name (core.setInterest -> setInterest)
    const toolShort = action.tool.replace('core.', '');
    return `- ${toolShort}: ${action.summary} (${ageStr} ago)`;
  });

  return `## Actions Already Completed (DO NOT repeat these)
${formatted.join('\n')}
IMPORTANT: These actions were already executed in previous sessions. Do NOT call these tools again for the same data.`;
}
