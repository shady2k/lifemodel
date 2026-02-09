/**
 * Trigger Sections
 *
 * Builds specialized prompt sections for different trigger types:
 * proactive contact, plugin events, thoughts, and reactions.
 *
 * Uses XML tags (<trigger>, <context>, <task>) to create clear semantic
 * boundaries that prevent weaker models from echoing instructions as output.
 *
 * Pure functions — no state mutation.
 */

import type { LoopContext } from '../agentic-loop-types.js';
import type { MotorResultData } from '../../../types/signal.js';

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

  return `<trigger type="proactive_contact">
<context>
Last conversation: ${timeContext || 'unknown'} ago
Reason: ${triggerReason}${isDeferralOverride ? '\nDeferral override: pressure increased significantly.' : ''}
</context>

<task>
You are initiating contact with the user. This is not a response to anything.
You already have: Runtime Snapshot (agent/user state) and conversation history.
Check <msg_time> tags — if the last conversation was recent, strongly prefer deferring. Asking follow-up questions about something discussed minutes ago feels intrusive.
Decide: send a message or defer. A casual check-in is valid if nothing specific comes to mind.

To send a message: output {"response": "your message"}
To defer: call core.defer(signalType="${triggerType}", deferHours=1-24, reason="...") then output {"response": ""}
Tool budget: 0-3 calls maximum.
</task>
</trigger>`;
}

/**
 * Build special section for plugin events (news, reminders, etc.)
 * Parses the event data and provides clear instructions for delivery.
 */
export function buildPluginEventSection(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return `<trigger type="plugin_event">\n<task>No event data available.</task>\n</trigger>`;
  }

  const kind = data['kind'] as string | undefined;
  const pluginId = data['pluginId'] as string | undefined;
  const eventKind = data['eventKind'] as string | undefined;
  const urgent = data['urgent'] as boolean | undefined;

  // Handle fact_batch events (news, interesting facts)
  if (kind === 'fact_batch' && Array.isArray(data['facts'])) {
    const facts = data['facts'] as { content: string; url?: string; tags?: string[] }[];

    if (facts.length === 0) {
      return `<trigger type="plugin_event">\n<task>Empty fact batch received.</task>\n</trigger>`;
    }

    const isUrgent = urgent === true;

    // Format facts with inline URLs
    const factSections = facts
      .map((fact, index) => {
        const url = fact.url ? ` — ${fact.url}` : '';
        return `${String(index + 1)}. ${fact.content}${url}`;
      })
      .join('\n');

    return `<trigger type="news_delivery"${isUrgent ? ' urgent="true"' : ''}>
<context>
${factSections}
</context>

<task>
You are initiating contact (not responding).${isUrgent ? ' This overrides previous context.' : ''}
Deliver this news with URLs inline.
</task>
</trigger>`;
  }

  // Generic plugin event format
  return `<trigger type="plugin_event">
<context>
Event: ${eventKind ?? 'unknown'}
Plugin: ${pluginId ?? 'unknown'}
${urgent ? 'URGENT: This event requires immediate attention.\n' : ''}Data: ${JSON.stringify(data)}
</context>

<task>Process this event and respond appropriately.</task>
</trigger>`;
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
    return `<trigger type="user_reaction">
<context>
${content}

This is feedback, not a question. Interpret based on context:
- Reaction on closing/check-in ("How are you?", "Talk soon") = acknowledgment, no action
- Reaction on suggestion/recommendation ("Try this...") = user likes it, call core.setInterest
- Reaction on factual statement = acknowledgment, no action
- Reaction on question asking opinion ("Don't you think...?") = user agrees, call core.remember
</context>

<task>
If reaction shows genuine interest: one core.setInterest call.
If it reveals a preference worth remembering: one core.remember call.
If simple acknowledgment (most cases): no response needed.
Never repeat your previous message. If responding, say something new.

To end without sending a message: output {"response": ""}
To respond: output {"response": "your new message"}
</task>
</trigger>`;
  }

  // Internal thought processing — no conversation history loaded (energy efficient)
  // Filtered out: core.thought, core.say, core.state, core.agent
  const activeConvWarning =
    context.conversationStatus === 'active'
      ? 'The user is currently in an active conversation. Use core.defer to reach out later if needed.\n'
      : '';

  return `<trigger type="internal_thought">
<context>
You are processing an internal thought. No conversation history is loaded.
${activeConvWarning}Thought: ${content ?? JSON.stringify(data)}
</context>

<task>
Available tools: core.setInterest, core.remember, core.memory({ action: "search", types: ["fact"] })
Not available: core.thought, core.say, core.state, core.agent
Message history is NOT indexed for thought processing. Do not search types: ["message"].

Most thoughts complete with {"response": ""} after 0-2 tool calls. Tool budget: 3 calls max.

To end without sending (default): output {"response": ""}
To save insight for next conversation: output {"response": "your insight"}
To message user NOW (urgent only, immediate time-sensitive impact): output {"response": "message", "urgent": true}
Urgent means: safety risk, deadline in hours. Reflections, insights, observations = never urgent.
</task>
</trigger>`;
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

  return `<trigger type="user_reaction">
<context>
The user reacted ${emoji ?? '(thumbs up)'} to: ${messageContext}
This is feedback, not a conversation turn.
</context>

<task>
Default action: output {"response": ""} (no message).
Only act if the reaction reveals something worth saving:
- Genuine topic interest: one core.setInterest call
- Clear preference: one core.remember call
- Simple acknowledgment (most cases): no tools, no response
Never repeat your previous message. Max 1 tool call total.
</task>
</trigger>`;
}

/**
 * Build dedicated trigger section for motor_result signals.
 *
 * Status-specific sections with clear instructions:
 * - completed: report result to user
 * - failed: diagnose and retry or report
 * - awaiting_input: relay question to user
 * - awaiting_approval: present approval request to user
 */
export function buildMotorResultSection(data: MotorResultData): string {
  const { runId, status, attemptIndex } = data;

  switch (status) {
    case 'completed': {
      const result = data.result;
      const summary = result?.summary ?? 'No summary';
      const stats = result?.stats;
      const statsLine = stats
        ? `${String(stats.iterations)} iterations, ${(stats.durationMs / 1000).toFixed(1)}s`
        : '';
      return `<trigger type="motor_result">
<context>Task run ${runId} completed. Summary: ${summary}. Stats: ${statsLine}.</context>
<task>Report the result to the user concisely.</task>
</trigger>`;
    }

    case 'failed': {
      const failure = data.failure;
      const attemptLabel = attemptIndex !== undefined ? ` attempt ${String(attemptIndex)}` : '';

      if (!failure) {
        // Legacy format (no structured failure)
        const errorMsg = data.error?.message ?? 'Unknown error';
        return `<trigger type="motor_result_failed">
<context>Task run ${runId}${attemptLabel} failed. Error: ${errorMsg}</context>
<task>Report the failure to the user clearly.</task>
</trigger>`;
      }

      // Format last tool results
      const toolResultsStr = failure.lastToolResults
        .map(
          (tr) =>
            `  ${tr.tool}: ${tr.ok ? 'OK' : 'FAIL'}${tr.errorCode ? ` (${tr.errorCode})` : ''} — ${tr.output.slice(0, 100)}`
        )
        .join('\n');

      return `<trigger type="motor_result_failed">
<context>
Task run ${runId}${attemptLabel} failed.
Category: ${failure.category} | Retryable: ${String(failure.retryable)}
${failure.lastErrorCode ? `Last error: ${failure.lastErrorCode}\n` : ''}Last tool results:
${toolResultsStr || '  (none)'}${failure.hint ? `\nAnalysis: ${failure.hint}` : ''}
</context>
<task>
A background task failed. Follow this protocol:
1. Review the failure summary above.
2. If retryable and you can provide useful guidance, call core.task(action:"retry", runId:"${runId}", guidance:"your corrective instructions").
3. If you need more detail, call core.task(action:"log", runId:"${runId}") first.
4. If not retryable or after 2 failed attempts, report the failure to the user clearly.
Do NOT create a new core.act run for the same task. Use retry to continue the existing run.
</task>
</trigger>`;
    }

    case 'awaiting_input': {
      const question = data.question ?? 'No question provided';
      return `<trigger type="motor_awaiting_input">
<context>Task run ${runId} needs user input: "${question}"</context>
<task>
Relay this question to the user naturally. When they respond, call core.task(action:"respond", runId:"${runId}", answer:"their answer").
</task>
</trigger>`;
    }

    case 'awaiting_approval': {
      const action = data.approval?.action ?? 'Unknown action';
      return `<trigger type="motor_awaiting_approval">
<context>Task run ${runId} is requesting approval for: "${action}"</context>
<task>
Present this approval request to the user. When they decide, call core.task(action:"approve", runId:"${runId}", approved:true/false).
If the action sounds dangerous or unclear, recommend denying.
</task>
</trigger>`;
    }

    default:
      return `<trigger type="motor_result">\n<context>${JSON.stringify(data)}</context>\n</trigger>`;
  }
}
