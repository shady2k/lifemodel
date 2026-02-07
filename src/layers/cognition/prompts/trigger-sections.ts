/**
 * Trigger Sections
 *
 * Builds specialized prompt sections for different trigger types:
 * proactive contact, plugin events, thoughts, and reactions.
 *
 * Pure functions — no state mutation.
 */

import type { LoopContext } from '../agentic-loop-types.js';

/**
 * Build special section for proactive contact explaining this is NOT a response.
 */
export function buildProactiveContactSection(context: LoopContext, triggerType: string): string {
  const timeSinceMs = context.timeSinceLastMessageMs;
  let timeContext = '';

  if (timeSinceMs !== undefined) {
    const hours = Math.floor(timeSinceMs / (1000 * 60 * 60));
    const minutes = Math.floor((timeSinceMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
      timeContext = `${String(hours)} hour${hours > 1 ? 's' : ''}${minutes > 0 ? ` ${String(minutes)} min` : ''}`;
    } else if (minutes > 0) {
      timeContext = `${String(minutes)} minute${minutes > 1 ? 's' : ''}`;
    } else {
      timeContext = 'less than a minute';
    }
  }

  const isFollowUp = triggerType.includes('follow_up');

  // Check if this is a deferral override
  const data = context.triggerSignal.data as Record<string, unknown> | undefined;
  const isDeferralOverride = data?.['deferralOverride'] === true;

  // Build trigger reason
  const triggerReason = isFollowUp
    ? 'User did not respond to your last message'
    : 'Social debt accumulated';

  const section = `## Proactive Contact

You are INITIATING contact with the user. This is NOT a response.
${isDeferralOverride ? '\n⚠️ Deferral override: pressure increased significantly.\n' : ''}
**Context:**
- Last conversation: ${timeContext || 'unknown'} ago
- Trigger: ${triggerReason}

**Your goal:** Send a message OR defer. Pick one.

**Tool budget: 0-3 calls max.** You already have:
- Runtime Snapshot (agent/user state)
- Conversation history (recent context)

If nothing specific comes to mind, a casual check-in is perfectly valid.

**To reach out:** Output {"response": "your message"}
**To wait:** Call core.defer(signalType="${triggerType}", deferHours=1-24, reason="...") then output {"response": ""}`;

  return section;
}

/**
 * Build special section for plugin events (news, reminders, etc.)
 * Parses the event data and provides clear instructions for delivery.
 */
export function buildPluginEventSection(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return `## Plugin Event\nNo event data available.`;
  }

  const kind = data['kind'] as string | undefined;
  const pluginId = data['pluginId'] as string | undefined;
  const eventKind = data['eventKind'] as string | undefined;
  const urgent = data['urgent'] as boolean | undefined;

  // Handle fact_batch events (news, interesting facts)
  if (kind === 'fact_batch' && Array.isArray(data['facts'])) {
    const facts = data['facts'] as { content: string; url?: string; tags?: string[] }[];

    if (facts.length === 0) {
      return `## Plugin Event\nEmpty fact batch received.`;
    }

    const isUrgent = urgent === true;

    // Format facts with inline URLs
    const factSections = facts
      .map((fact, index) => {
        const url = fact.url ? ` — ${fact.url}` : '';
        return `${String(index + 1)}. ${fact.content}${url}`;
      })
      .join('\n');

    return `## ${isUrgent ? '⚠️ URGENT ' : ''}News Delivery

You are INITIATING contact (not responding).${isUrgent ? ' This overrides previous context.' : ''}

${factSections}

→ Deliver this news with URLs inline.`;
  }

  // Generic plugin event format
  return `## Plugin Event
Type: ${eventKind ?? 'unknown'}
Plugin: ${pluginId ?? 'unknown'}
${urgent ? '⚠️ URGENT: This event requires immediate attention.\n' : ''}Data: ${JSON.stringify(data)}`;
}

/**
 * Build special section for thought triggers (including reactions).
 * Provides clear guidance on when to respond vs when to just process internally.
 */
export function buildThoughtTriggerSection(
  data: Record<string, unknown>,
  context: LoopContext
): string {
  const content = data['content'] as string | undefined;
  const rootId = data['rootThoughtId'] as string | undefined;

  // Check if this is a reaction-based thought
  const hasReactionRootId = rootId?.startsWith('reaction_') === true;
  const hasReactionContent = content?.startsWith('User reacted') === true;
  const isReaction = hasReactionRootId || hasReactionContent;

  if (isReaction && content) {
    return `## User Reaction

${content}

**This is feedback, not a question.** Interpret based on CONTEXT:

**Examples of context-aware interpretation:**
- 👍 on closing/check-in ("How are you?", "Talk soon") → acknowledgment, no action
- 👍 on suggestion/recommendation ("Try this...", "Have you considered...") → user likes it, call core.setInterest
- 👍 on factual statement ("It's 3 PM", "Python was released in 1991") → acknowledgment, no action
- 👍 on question asking for opinion ("Don't you think...?", "Wouldn't you agree...?") → user agrees, call core.remember

**Action guidance:**
- If reaction shows genuine interest in a topic → core.setInterest
- If it reveals a preference worth remembering → core.remember
- If it's simple acknowledgment on non-substantive content → no response needed

**IMPORTANT:** Never repeat your previous message. If responding, say something NEW.

**To end without sending a message:** output {"response": ""}
**To respond:** output {"response": "your NEW message"} (only if you have something meaningful to add)`;
  }

  // Internal thought processing - clear, directive prompt
  // No conversation history is loaded for thoughts (energy efficient)
  // Filtered out: core.thought, core.say, core.state, core.agent
  const activeConvWarning =
    context.conversationStatus === 'active'
      ? `\n**Note: The user is currently in an active conversation.** Use core.defer to reach out later if needed.\n`
      : '';

  return `## Processing Internal Thought

You are processing an internal thought. No conversation history is loaded.
${activeConvWarning}
**Thought:** ${content ?? JSON.stringify(data)}

**Available actions:**
- core.setInterest - if this reveals a topic of interest
- core.remember - if this contains a fact worth saving
- core.memory({ action: "search", types: ["fact"] }) - if you need context from saved facts

**NOT available:** core.thought, core.say, core.state, core.agent
**NOTE:** Message history is NOT indexed for thought processing. Do NOT search types: ["message"] — it will always return 0 results.

**Rules:**
- Most thoughts complete with {"response": ""} after 0-2 tool calls
- Tool budget: 3 calls max. Be efficient.
- Return concise result; stop when complete

**To end without sending (default):** output {"response": ""}
**To save insight for next conversation:** output {"response": "your insight"}
**To message user NOW (urgent only):** output {"response": "message", "urgent": true} — ONLY for immediate, time-sensitive user impact that becomes wrong or harmful if delayed (safety risk, deadline in hours). Reflections, insights, observations, emotional context → NEVER urgent.`;
}

/**
 * Build special section for message_reaction triggers.
 * Reactions are direct signals (not converted to thoughts) that need clear guidance.
 */
export function buildReactionTriggerSection(data: Record<string, unknown>): string {
  const emoji = data['emoji'] as string | undefined;
  const preview = data['reactedMessagePreview'] as string | undefined;

  const messageContext = preview
    ? `Your message: "${preview.slice(0, 100)}${preview.length > 100 ? '...' : ''}"`
    : 'Message preview not available';

  return `## User Reaction

The user reacted ${emoji ?? '👍'} to: ${messageContext}

This is feedback, not a conversation turn. Most reactions need NO action and NO response.

**Default: output {"response": ""} (no message)**

Only act if the reaction reveals something worth saving:
- Genuine topic interest → ONE core.setInterest call
- Clear preference worth remembering → ONE core.remember call
- Simple acknowledgment (most cases) → no tools, no response

Never repeat your previous message. Max 1 tool call total.`;
}
