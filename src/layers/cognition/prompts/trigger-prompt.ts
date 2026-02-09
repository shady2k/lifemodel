/**
 * Trigger Prompt Builder
 *
 * Builds the trigger prompt combining context sections and the trigger-specific section.
 * Pure function — no state mutation.
 */

import type { Signal } from '../../../types/signal.js';
import type { LoopContext } from '../agentic-loop-types.js';
import { isProactiveTrigger } from './runtime-snapshot.js';
import {
  buildUserProfileSection,
  buildRecentThoughtsSection,
  buildPendingIntentionsSection,
  buildSoulSection,
  buildBehaviorRulesSection,
  buildRuntimeSnapshotSection,
  buildCompletedActionsSection,
} from './context-sections.js';
import {
  buildProactiveContactSection,
  buildPluginEventSection,
  buildThoughtTriggerSection,
  buildReactionTriggerSection,
} from './trigger-sections.js';

/**
 * Build trigger prompt for current context.
 * Contains: user profile, recent thoughts, runtime snapshot, completed actions, current trigger.
 * Conversation history is injected as proper OpenAI messages separately.
 */
export function buildTriggerPrompt(context: LoopContext, useSmart = false): string {
  const sections: string[] = [];

  // User profile (stable facts)
  const userProfile = buildUserProfileSection(context);
  if (userProfile) {
    sections.push(userProfile);
  }

  // Recent thoughts (internal context) - after user profile, before soul
  const thoughtsSection = buildRecentThoughtsSection(context);
  if (thoughtsSection) {
    sections.push(thoughtsSection);
  }

  // Pending intentions (insights from thought processing to weave into conversation)
  // Only for user-facing triggers — not internal processing (thoughts, reactions, plugin events)
  const isUserFacing =
    context.triggerSignal.type === 'user_message' ||
    context.triggerSignal.type === 'contact_urge' ||
    isProactiveTrigger(context.triggerSignal);
  if (isUserFacing) {
    const intentionsSection = buildPendingIntentionsSection(context);
    if (intentionsSection) {
      sections.push(intentionsSection);
    }
  }

  // Soul section (identity awareness) - after thoughts, before tensions
  const soulSection = buildSoulSection(context);
  if (soulSection) {
    sections.push(soulSection);
  }

  // Behavioral rules (learned from user feedback) - after soul, before runtime
  const behaviorRulesSection = buildBehaviorRulesSection(context);
  if (behaviorRulesSection) {
    sections.push(behaviorRulesSection);
  }

  // Runtime snapshot (conditional, for state-related queries)
  const runtimeSnapshot = buildRuntimeSnapshotSection(context, useSmart);
  if (runtimeSnapshot) {
    sections.push(runtimeSnapshot);
  }

  // Completed actions (for non-user-message triggers to prevent re-execution)
  const actionsSection = buildCompletedActionsSection(context);
  if (actionsSection) {
    sections.push(actionsSection);
  }

  // Current trigger
  sections.push(buildTriggerSection(context.triggerSignal, context));

  return sections.join('\n\n');
}

function buildTriggerSection(signal: Signal, context: LoopContext): string {
  const data = signal.data as Record<string, unknown> | undefined;

  if (signal.type === 'user_message' && data) {
    const text = (data['text'] as string | undefined) ?? '';
    return `<user_input>${text}</user_input>`;
  }

  // Handle contact_urge triggers (proactive contact from ThresholdEngine)
  if (signal.type === 'contact_urge') {
    return buildProactiveContactSection(context, 'contact_urge');
  }

  // Handle proactive contact triggers specially
  if (signal.type === 'threshold_crossed' && data) {
    const thresholdName = data['thresholdName'] as string | undefined;
    if (thresholdName?.includes('proactive')) {
      return buildProactiveContactSection(context, thresholdName);
    }
  }

  // Handle plugin_event triggers (news, reminders, etc.)
  if (signal.type === 'plugin_event') {
    return buildPluginEventSection(data);
  }

  // Handle thought triggers
  if (signal.type === 'thought' && data) {
    return buildThoughtTriggerSection(data, context);
  }

  // Handle message_reaction triggers (direct, not converted to thought)
  if (signal.type === 'message_reaction' && data) {
    return buildReactionTriggerSection(data);
  }

  return `<trigger type="${signal.type}">\n<context>${JSON.stringify(data ?? {})}</context>\n</trigger>`;
}
