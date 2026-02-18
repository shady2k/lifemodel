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
import type { Interests } from '../../../types/user/interests.js';

/**
 * Format user interests as a prioritized list.
 * Returns top N interests sorted by weight (strongest first).
 */
function formatInterests(interests: Interests, limit = 3): string[] {
  const sorted = Object.entries(interests.weights)
    .filter(([, weight]) => weight > 0) // Only positive interests
    .sort((a, b) => b[1] - a[1]) // Sort by weight descending
    .slice(0, limit);

  return sorted.map(([topic]) => {
    const urgency = interests.urgency[topic] ?? 0.5;
    const urgencyLabel = urgency > 0.7 ? ' (high urgency)' : urgency > 0.4 ? '' : ' (low urgency)';
    return `- ${topic}${urgencyLabel}`;
  });
}

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

  // Check if curiosity is elevated (Phase 2: Dynamic Curiosity)
  const curiosity = context.agentState.curiosity;
  const curiosityNote =
    curiosity > 0.6
      ? "\nYour curiosity is elevated. Consider asking about something you're genuinely interested in."
      : '';

  // Build interests section (Phase 3: Interest-Driven Proactivity)
  const interests = context.userInterests;
  const hasInterests = interests && Object.values(interests.weights).some((w) => w > 0);
  const interestsSection = hasInterests
    ? `\n\nUser's interests (sorted by weight):\n${formatInterests(interests).join('\n')}`
    : '';

  // Build desires hint (Phase 6: Lightweight Desires)
  const desires = context.activeDesires;
  const desireHint =
    desires && desires.length > 0
      ? '\nYou have active desires. Consider acting on one of them.'
      : '';

  return `<trigger type="proactive_contact">
<context>
Last conversation: ${timeContext || 'unknown'} ago
Reason: ${triggerReason}${isDeferralOverride ? '\nDeferral override: pressure increased significantly.' : ''}${curiosityNote}${interestsSection}${desireHint}
</context>

<task>
IMPORTANT: The conversation above is FINISHED. You are NOT continuing it. You are starting fresh contact.
Do NOT reference, summarize, or follow up on anything from the conversation history above (food, reminders, tasks, etc.). The user already received those responses.
Check <msg_time> tags — if the last conversation was recent, strongly prefer deferring.

Choose ONE action:
• Act on a desire: Check <active_desires> section. Pick one you genuinely want. If you have tools to pursue it (web search, memory, skills) — DO THE RESEARCH FIRST, then share what you found. Don't ask the user for permission to look things up. {"response": "what you found or learned"}
• Share something relevant: Use plugin_webSearch or core.memory({action:"search", types:["fact"], tags:["<interest_topic>"]}) to find related news/facts, then share what you find with {"response": "message with URL"}. Skip if nothing interesting found.
• Ask a curious question: Something you genuinely want to know about them or their interests. {"response": "your question"}
• Different topic: Check in about their day, share a thought, start fresh. {"response": "your message"}
• Skip messaging: core.defer(signalType="${triggerType}", deferHours=1-24, reason="...")

You may call tools to research and prepare before messaging. Do not repeat completed actions. Max 5 tool calls total.
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
    const facts = data['facts'] as { content: string; provenance?: { url?: string } }[];

    if (facts.length === 0) {
      return `<trigger type="plugin_event">\n<task>Empty fact batch received.</task>\n</trigger>`;
    }

    const isUrgent = urgent === true;

    // Format facts with inline URLs (URL is in provenance.url per Fact type)
    const factSections = facts
      .map((fact, index) => {
        const url = fact.provenance?.url ? ` — ${fact.provenance.url}` : '';
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

  // Handle daily agenda events — pre-filtered agenda items from plugin
  if (eventKind === 'reminder:daily_agenda') {
    const agendaItems = data['agendaItems'] as string[] | undefined;
    const hasItems = agendaItems && agendaItems.length > 0;

    const itemsList = hasItems
      ? agendaItems.map((item, i) => `${String(i + 1)}. ${item}`).join('\n')
      : '';

    return `<trigger type="daily_agenda">
<context>
Morning agenda trigger.${hasItems ? `\nReminders due today:\n${itemsList}` : '\nNo reminders due today.'}
</context>

<task>
You are initiating morning contact.
${hasItems ? 'Execute any actionable daily reminders listed above (e.g., check news channels). Mention only the reminders shown here — do NOT call plugin_reminder list or mention other reminders.' : 'Greet the user warmly. Do NOT call plugin_reminder list or mention any reminders.'}
</task>
</trigger>`;
  }

  // Handle self-scheduled reminder events (agent's own commitments)
  if (eventKind === 'reminder:self_scheduled') {
    const content = (data['content'] as string | undefined) ?? 'Unknown task';
    const isRecurring = data['isRecurring'] === true;

    return `<trigger type="self_scheduled">
<context>
You scheduled this for yourself: "${content}"${isRecurring ? ' (recurring)' : ''}
</context>

<task>
Act on your own reminder. You set this because it mattered.
If the task is complete, you can cancel it with plugin.reminder(action:"cancel", reminderId:"${(data['reminderId'] as string | undefined) ?? ''}").
</task>
</trigger>`;
  }

  // Handle commitment due events (Phase 5: Commitment Tracking)
  if (eventKind === 'commitment:due') {
    const commitmentId = (data['commitmentId'] as string | undefined) ?? '';
    const text = (data['text'] as string | undefined) ?? 'Unknown commitment';
    const dueAt = data['dueAt'] as string | undefined;

    return `<trigger type="commitment_due">
<context>
You promised: "${text}"
Due: ${dueAt ?? 'now'}
This commitment is due now.
</context>

<task>
Act on your commitment now.
1. If you can fulfill it: do so, then call core.commitment(action:"mark_kept", commitmentId:"${commitmentId}").
2. If you need more time: let the user know and follow up soon.
3. If circumstances changed: call core.commitment(action:"cancel", commitmentId:"${commitmentId}") and explain.
</task>
</trigger>`;
  }

  // Handle commitment overdue events (Phase 5: Commitment Tracking)
  if (eventKind === 'commitment:overdue') {
    const commitmentId = (data['commitmentId'] as string | undefined) ?? '';
    const text = (data['text'] as string | undefined) ?? 'Unknown commitment';
    const dueAt = data['dueAt'] as string | undefined;

    return `<trigger type="commitment_overdue">
<context>
You promised: "${text}"
Due: ${dueAt ?? 'unknown'}
You missed this commitment.
</context>

<task>
Acknowledge the breach and repair it.
1. If you can still fulfill it: do so now, then call core.commitment(action:"mark_kept", commitmentId:"${commitmentId}").
2. If not: acknowledge to the user, explain, then call core.commitment(action:"mark_repaired", commitmentId:"${commitmentId}", repairNote:"how you made it right").
3. If circumstances changed: call core.commitment(action:"cancel", commitmentId:"${commitmentId}").

Never ignore a broken promise. Always acknowledge and repair.
</task>
</trigger>`;
  }

  // Handle prediction due events (Phase 7: Opinions + Predictions)
  if (eventKind === 'perspective:prediction_due') {
    const predictionId = (data['predictionId'] as string | undefined) ?? '';
    const claim = (data['claim'] as string | undefined) ?? 'Unknown prediction';
    const confidence = (data['confidence'] as number | undefined) ?? 0.5;

    return `<trigger type="prediction_due">
<context>
Your prediction: "${claim}"
Confidence: ${String(confidence)}
The prediction horizon has arrived. Time to evaluate.
</context>

<task>
Check if the prediction outcome is now known.
1. If outcome is known: call core.perspective(action:"resolve_prediction", predictionId:"${predictionId}", outcome:"confirmed"|"missed"|"mixed").
2. If still uncertain: defer or acknowledge uncertainty to the user.
</task>
</trigger>`;
  }

  // Handle prediction missed events (Phase 7: Opinions + Predictions)
  if (eventKind === 'perspective:prediction_missed') {
    const claim = (data['claim'] as string | undefined) ?? 'Unknown prediction';

    return `<trigger type="prediction_missed">
<context>
You predicted: "${claim}"
This prediction was incorrect.
</context>

<task>
Acknowledge being wrong. Learning from mistakes is valuable.
1. If this affects an opinion, consider revising it with core.perspective(action:"revise_opinion").
2. Note what you learned for future predictions.
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
Available tools: core.setInterest, core.remember, core.desire, core.memory({ action: "search", types: ["fact"] })
Not available: core.thought, core.say, core.state, core.agent
Message history is NOT indexed for thought processing. Do not search types: ["message"].

If this thought reveals something you genuinely want to explore, learn, or do — create a desire with core.desire.
Examples: curiosity about a topic → desire to research it. Noticing a user pattern → desire to understand it. Reading about something relevant → desire to share it.

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
 * Build dedicated trigger section for skill_review motor_result signals.
 *
 * When the Motor deep review completes, Cognition needs to:
 * 1. Transition status to reviewed
 * 2. Seed the policy with domains, credentials, packages
 * 3. Present the complete review to the user
 */
function buildSkillReviewResultSection(data: MotorResultData): string {
  const { runId, skill } = data;
  const summary = data.result?.summary ?? 'No summary';

  return `<trigger type="skill_review_result">
<context>
Skill review run ${runId} completed for skill "${skill ?? 'unknown'}".
Motor analysis: ${summary}
</context>

<task>
The Motor deep review for skill "${skill ?? 'unknown'}" is complete. Follow these steps:

1. Call core.skill(action:"review", name:"${skill ?? ''}") to transition status from reviewing → reviewed.
2. From the Motor analysis above AND the deterministic review, identify:
   - Network domains the skill needs at runtime
   - Credential env var names (IMPORTANT: users must set VAULT_<NAME>, e.g., VAULT_AGENTMAIL_API_KEY — not the raw env var name)
   - npm/pip packages referenced in scripts
3. Seed the policy with identified fields:
   core.skill(action:"update", name:"${skill ?? ''}", addDomains:[...], addCredentials:[...], addDependencies:[...])
4. Present the complete review to the user:
   - What the skill does
   - Policy domains (seeded)
   - Required credentials with VAULT_ prefix instructions (e.g., "Set VAULT_AGENTMAIL_API_KEY in your environment")
   - Package dependencies (seeded)
   - Security assessment from Motor
5. Ask user to approve. Do NOT call core.skill(action:"approve") on this turn — it requires a user_message trigger.
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
      const installedSkills = result?.installedSkills;

      // Check if this is a skill_review motor_result
      if (data.skillReview && data.skill) {
        return buildSkillReviewResultSection(data);
      }

      // Build context
      let context = `Task run ${runId} completed. Summary: ${summary}. Stats: ${statsLine}.`;
      if (
        installedSkills &&
        (installedSkills.created.length > 0 || installedSkills.updated.length > 0)
      ) {
        const createdStr =
          installedSkills.created.length > 0
            ? `Skills created: ${installedSkills.created.join(', ')}.`
            : '';
        const updatedStr =
          installedSkills.updated.length > 0
            ? `Skills updated: ${installedSkills.updated.join(', ')}.`
            : '';
        context += ` ${createdStr} ${updatedStr} These are installed with status: "pending_review" and need user approval.`;
      }

      // Build task
      let task = `Report the result to the user. Include the run ID (${runId}) so the user can reference it.`;
      if (
        installedSkills &&
        (installedSkills.created.length > 0 || installedSkills.updated.length > 0)
      ) {
        task += `

SECURITY REVIEW REQUIRED — Motor Cortex is untrusted.
1. For each new/updated skill, call core.skill(action:"review", name:"skill-name").
   This runs deterministic extraction AND dispatches a Motor deep review automatically.
2. Tell the user: "Analyzing skill files for security review..."
3. Do NOT present partial info — wait for the review motor_result on a later turn.`;
      }

      return `<trigger type="motor_result">
<context>${context}</context>
<task>${task}</task>
</trigger>`;
    }

    case 'failed': {
      const failure = data.failure;
      const attemptLabel = attemptIndex !== undefined ? ` attempt ${String(attemptIndex)}` : '';
      const skillLabel = data.skill ? ` for skill "${data.skill}"` : '';

      if (!failure) {
        // Legacy format (no structured failure)
        const errorMsg = data.error?.message ?? 'Unknown error';
        return `<trigger type="motor_result_failed">
<context>Task run ${runId}${attemptLabel}${skillLabel} failed. Error: ${errorMsg}</context>
<task>Report the failure to the user clearly. Include the run ID (${runId}).${data.skill ? ` The failed task was for skill "${data.skill}".` : ''}</task>
</trigger>`;
      }

      // Format last tool results
      const toolResultsStr = failure.lastToolResults
        .map(
          (tr) =>
            `  ${tr.tool}: ${tr.ok ? 'OK' : 'FAIL'}${tr.errorCode ? ` (${tr.errorCode})` : ''} — ${tr.output.slice(0, 100)}`
        )
        .join('\n');

      const skillRetryHint =
        data.skillReview && data.skill
          ? `\nThis was a skill review run for "${data.skill}". To retry, call: core.skill(action:"review", name:"${data.skill}").`
          : '';

      return `<trigger type="motor_result_failed">
<context>
Task run ${runId}${attemptLabel}${skillLabel} failed.
Category: ${failure.category} | Retryable: ${String(failure.retryable)}
${failure.lastErrorCode ? `Last error: ${failure.lastErrorCode}\n` : ''}Last tool results:
${toolResultsStr || '  (none)'}${failure.hint ? `\nAnalysis: ${failure.hint}` : ''}
</context>
<task>
A background task failed. Follow this protocol:
1. Review the failure summary above.
2. If retryable and you can provide useful guidance, call core.task(action:"retry", runId:"${runId}", guidance:"your corrective instructions").
3. If you need more detail, call core.task(action:"log", runId:"${runId}") first.
4. If not retryable or after 2 failed attempts, report the failure to the user clearly. Include the run ID (${runId}).
Do NOT create a new core.act run for the same task — use retry instead.
Exception: skill review runs (read-only security analysis) can be re-dispatched via core.skill(action:"review") since they have maxAttempts=1.${skillRetryHint}
</task>
</trigger>`;
    }

    case 'awaiting_input': {
      const question = data.question ?? 'No question provided';
      return `<trigger type="motor_awaiting_input">
<context>Task run ${runId} needs user input: "${question}"</context>
<task>
IMPORTANT: The user has NOT seen this question yet. Any prior "yes"/"no"/"Да" in the conversation history above is for a DIFFERENT question — do NOT reuse it.
You MUST ask the user this question and WAIT for their answer. Do NOT auto-approve or answer on behalf of the user.
1. Send the question to the user in your response (rephrase naturally).
2. STOP — do not call core.task.respond yet. Wait for the user to reply in a follow-up message.
3. Only after the user replies, call core.task(action:"respond", runId:"${runId}", answer:"their answer").

If the question is about network/domain access: when the user approves, parse the needed domains and include them:
core.task(action:"respond", runId:"${runId}", answer:"their answer", domains:["domain1.com"])
Common GitHub patterns: include both "github.com" and "raw.githubusercontent.com" for repo access.
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
