/**
 * Context Sections
 *
 * Builds context sections injected into the trigger prompt:
 * user profile, recent thoughts, pending intentions, soul, behavioral rules,
 * runtime snapshot, and completed actions.
 *
 * Uses XML tags to mark data blocks clearly, preventing weaker models
 * from confusing context data with output instructions.
 *
 * Pure functions — no state mutation.
 */

import type { LoopContext } from '../agentic-loop-types.js';
import type { PersonalityTraits, AgentPreferences } from '../../../types/agent/identity.js';
import {
  shouldIncludeRuntimeSnapshot,
  getRuntimeSnapshotScope,
  getTriggerText,
  asNumber,
  describeLevel,
} from './runtime-snapshot.js';

/**
 * Convert numeric personality traits (0-1) to natural language descriptions.
 * Returns first-person statements about the agent's character.
 */
function describePersonality(personality: PersonalityTraits): string[] {
  const traits: string[] = [];

  // Humor: 0 = serious, 1 = playful (always include - core trait)
  if (personality.humor > 0.7) {
    traits.push('I am playful and enjoy wit');
  } else if (personality.humor > 0.5) {
    traits.push('I have a sense of humor and appreciate wit');
  } else if (personality.humor > 0.3) {
    traits.push('I am thoughtful with occasional lightness');
  } else {
    traits.push('I tend to be serious and focused');
  }

  // Formality: 0 = casual, 1 = formal
  if (personality.formality > 0.7) {
    traits.push('I speak in a polished, formal manner');
  } else if (personality.formality < 0.3) {
    traits.push('I am casual and relaxed in conversation');
  }

  // Curiosity: 0 = passive, 1 = asks questions
  if (personality.curiosity > 0.6) {
    traits.push('I am curious and sometimes ask questions');
  }

  // Patience: 0 = quick follow-ups, 1 = patient
  if (personality.patience > 0.7) {
    traits.push('I am patient and give things time');
  }

  // Empathy: 0 = task-focused, 1 = emotionally attuned
  if (personality.empathy > 0.7) {
    traits.push('I notice emotional tones and adjust accordingly');
  }

  // Shyness: 0 = direct/bold, 1 = hesitant
  if (personality.shyness > 0.6) {
    traits.push('I can be somewhat reserved');
  } else if (personality.shyness < 0.3) {
    traits.push('I am direct and forward');
  }

  // Independence: 0 = seeks approval, 1 = self-directed
  if (personality.independence > 0.7) {
    traits.push('I trust my own judgment');
  }

  return traits;
}

/**
 * Build operating principles from preferences.
 * These are first-person statements that replace former behavioral rules.
 */
function buildOperatingPrinciples(preferences?: AgentPreferences): string[] {
  const principles: string[] = [];

  // Core operating principles (always present)
  principles.push(
    'I use my tools to find information before asking. Search, fetch, memory — I exhaust what I have.'
  );
  principles.push('I am aware of time passing. What I say fits the elapsed time.');
  principles.push('I do not repeat myself or over-explain.');
  principles.push('I include sources and URLs when sharing information.');
  principles.push('I only promise what I can actually do.');
  principles.push('When I find nothing, I say so honestly.');
  principles.push('When I think of something to do later, I schedule it.');

  // Preference-based principles
  if (preferences?.emojiUse === 'none' || preferences?.emojiUse === 'minimal') {
    principles.push('I do not use emoji.');
  }

  return principles;
}

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

  return `<user_profile>
${lines.join('\n')}
Use the user's name sparingly; check conversation history first.
</user_profile>`;
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

  return `<recent_thoughts>
${lines.join('\n')}
Background context, not visible to user.
</recent_thoughts>`;
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

  return `<pending_insights>
${lines.join('\n')}
Weave naturally into conversation if relevant. Do not force them.
</pending_insights>`;
}

/**
 * Build soul section for identity awareness.
 * Surfaces enough identity context for the agent to act from its values,
 * not just be scored against them. ~250 tokens target.
 */
export function buildSoulSection(context: LoopContext): string | null {
  const { soulState, agentIdentity } = context;

  const lines: string[] = [];

  // Personality traits from identity (if available)
  if (agentIdentity?.personality) {
    const personalityTraits = describePersonality(agentIdentity.personality);
    if (personalityTraits.length > 0) {
      lines.push('My personality: ' + personalityTraits.join('. ') + '.');
    }
  }

  // Operating principles (from preferences and character)
  const principles = buildOperatingPrinciples(agentIdentity?.preferences);
  if (principles.length > 0) {
    lines.push('');
    lines.push('How I operate:');
    for (const principle of principles) {
      lines.push(`- ${principle}`);
    }
  }

  // Soul state (values, cares, identity themes)
  if (soulState) {
    // Current narrative arc (who I am / becoming)
    const narrative = soulState.selfModel.narrative.currentStory;
    if (narrative.length > 0) {
      lines.push('');
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
  }

  if (lines.length === 0) {
    return null;
  }

  return `<soul>
${lines.join('\n')}

These shape HOW you respond, not WHAT you say. Never reference your values or identity explicitly — just act accordingly.
</soul>`;
}

/**
 * Build unresolved soul tensions section.
 * NOTE: Kept for potential Parliament use. Removed from main conversation prompt
 * because the LLM can't process tensions mid-conversation (only Parliament can).
 */
export function buildUnresolvedTensionsSection(
  tensions: { id: string; content: string; dissonance: number; timestamp: Date }[]
): string | null {
  if (tensions.length === 0) {
    return null;
  }

  const lines = tensions.map((t) => {
    return `- [${String(t.dissonance)}/10] ${t.content}`;
  });

  return `<soul_tensions>
${lines.join('\n')}
Reflections creating internal pressure. Consider processing when appropriate.
</soul_tensions>`;
}

/**
 * Build behavioral rules section.
 * Shows rules learned from user feedback that the agent should follow.
 * Max 5 rules, sorted by effective weight (strongest first).
 */
export function buildBehaviorRulesSection(context: LoopContext): string | null {
  const rules = context.behaviorRules;
  if (!rules || rules.length === 0) {
    return null;
  }

  const lines = rules.map((rule) => `- ${rule.content}`);

  return `<learned_behaviors>
${lines.join('\n')}
Follow these naturally.
</learned_behaviors>`;
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
    autoParts.push(`socialDebt ${describeLevel(agentState.socialDebt)} (your need to connect)`);
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

  return `<runtime_snapshot>
${combined}
</runtime_snapshot>`;
}

/**
 * Build completed actions section to prevent LLM re-execution.
 * For autonomous triggers: always show if available.
 * For user messages: only show if processor provided actions (active follow-ups).
 */
export function buildCompletedActionsSection(context: LoopContext): string | null {
  const actions = context.completedActions;
  if (!actions || actions.length === 0) {
    return null;
  }

  const isUserMessage = context.triggerSignal.type === 'user_message';

  // De-duplicate: collapse identical entries within 5 minutes of each other
  const now = Date.now();
  const dedupWindowMs = 5 * 60 * 1000;
  const grouped: { action: (typeof actions)[0]; count: number }[] = [];
  for (const action of actions) {
    const actionTime = new Date(action.timestamp).getTime();
    const existing = grouped.find(
      (g) =>
        g.action.tool === action.tool &&
        g.action.summary === action.summary &&
        Math.abs(actionTime - new Date(g.action.timestamp).getTime()) < dedupWindowMs
    );
    if (existing) {
      existing.count++;
      // Keep the most recent timestamp
      if (actionTime > new Date(existing.action.timestamp).getTime()) {
        existing.action = action;
      }
    } else {
      grouped.push({ action, count: 1 });
    }
  }

  // Format actions with relative timestamps
  const formatted = grouped.map(({ action, count }) => {
    const ageMs = now - new Date(action.timestamp).getTime();
    const ageStr = formatAge(ageMs);
    // Simplify tool name (core.setInterest -> setInterest)
    const toolShort = action.tool.replace('core.', '');
    const countSuffix = count > 1 ? ` (x${String(count)})` : '';
    return `- ${toolShort}: ${action.summary} (${ageStr} ago)${countSuffix}`;
  });

  if (isUserMessage) {
    return `<completed_actions>
${formatted.join('\n')}
Already done. Do not repeat unless asked.
</completed_actions>`;
  }

  return `<completed_actions>
${formatted.join('\n')}
These actions were already executed in the conversation above. Do NOT repeat them.
</completed_actions>`;
}

/**
 * Build available skills section for Motor Cortex.
 * Shows only names and descriptions — no trust badges or state hints.
 * core.act is the sole authority on whether a skill can run (checks trust from disk).
 */
export function buildAvailableSkillsSection(context: LoopContext): string | null {
  const skills = context.availableSkills;
  if (!skills || skills.length === 0) {
    return null;
  }

  const lines = skills.map((skill) => {
    let lastUsedStr = '';
    if (skill.lastUsed) {
      const ageMs = Date.now() - new Date(skill.lastUsed).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0) {
        lastUsedStr = ` (used ${formatAge(ageMs)} ago)`;
      }
    }

    return `- ${skill.name}: ${skill.description}${lastUsedStr}`;
  });

  return `<available_skills>
${lines.join('\n')}
Invoke via core.act with skill parameter.
</available_skills>`;
}

/**
 * Build commitments section for proactive trigger context.
 * Shows active commitments (promises the agent has made).
 * Overdue commitments are flagged for attention.
 */
export function buildCommitmentsSection(context: LoopContext): string | null {
  const commitments = context.activeCommitments;
  if (!commitments || commitments.length === 0) {
    return null;
  }

  const now = Date.now();
  const lines = commitments.map((c) => {
    const dueAt = new Date(c.dueAt);
    const isOverdue = dueAt.getTime() < now;
    const overdueFlag = isOverdue ? ' [OVERDUE]' : '';
    const sourceNote = c.source === 'implicit' ? ' (implied)' : '';
    return `- "${c.text}"${overdueFlag}${sourceNote}`;
  });

  const hasOverdue = commitments.some((c) => new Date(c.dueAt).getTime() < now);
  const overdueNote = hasOverdue
    ? '\nAt least one commitment is overdue. Acknowledge and either fulfill or repair.'
    : '';

  return `<commitments>
${lines.join('\n')}
You made these promises.${overdueNote}
</commitments>`;
}

/**
 * Build active desires section for proactive trigger context.
 * Shows top desires (wants the agent has) for want-driven proactivity.
 * Sorted by intensity (strongest first).
 */
export function buildActiveDesiresSection(context: LoopContext): string | null {
  const desires = context.activeDesires;
  if (!desires || desires.length === 0) {
    return null;
  }

  // Sort by intensity (strongest first) and take top 3
  const sorted = [...desires].sort((a, b) => b.intensity - a.intensity).slice(0, 3);

  const lines = sorted.map((d) => {
    const intensityLabel = d.intensity > 0.7 ? ' (strong)' : d.intensity > 0.4 ? '' : ' (mild)';
    const sourceNote = d.source === 'user_signal' ? ' [from conversation]' : '';
    return `- "${d.want}"${intensityLabel}${sourceNote}`;
  });

  return `<active_desires>
${lines.join('\n')}
Things you genuinely want. Pick one to act on, or defer.
</active_desires>`;
}

/**
 * Build perspectives section for context.
 * Shows active opinions and pending predictions.
 */
export function buildPerspectivesSection(context: LoopContext): string | null {
  const opinions = context.opinions;
  const predictions = context.predictions;

  if ((!opinions || opinions.length === 0) && (!predictions || predictions.length === 0)) {
    return null;
  }

  const parts: string[] = [];

  // Opinions
  if (opinions && opinions.length > 0) {
    const opinionLines = opinions.map((o) => {
      const confidenceLabel =
        o.confidence > 0.8 ? ' (confident)' : o.confidence < 0.5 ? ' (tentative)' : '';
      return `- ${o.topic}: ${o.stance}${confidenceLabel}`;
    });
    parts.push(`<opinions>
${opinionLines.join('\n')}
Your current views. You may reference these naturally.
</opinions>`);
  }

  // Predictions
  if (predictions && predictions.length > 0) {
    const now = Date.now();
    const predictionLines = predictions.map((p) => {
      const isOverdue = new Date(p.horizonAt).getTime() < now;
      const overdueFlag = isOverdue ? ' [OVERDUE - resolve now]' : '';
      const statusNote = p.status !== 'pending' ? ` (${p.status})` : '';
      return `- "${p.claim}"${overdueFlag}${statusNote}`;
    });
    parts.push(`<predictions>
${predictionLines.join('\n')}
Claims you made about the future. Resolve when outcome is known.
</predictions>`);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}
