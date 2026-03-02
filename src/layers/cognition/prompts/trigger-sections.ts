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
import type { InterestGroup } from '../soul/interest-compaction.js';

/**
 * Structured result from formatInterests — lines to display plus metadata.
 */
export interface FormattedInterests {
  lines: string[];
  omittedCount: number;
}

/**
 * Format user interests as a prioritized list with priority buckets.
 *
 * Selection logic:
 * 1. Sort all positive interests by: weight DESC → urgency DESC → topic ASC (deterministic tie-break)
 * 2. All interests with urgency > 0.7 are always included (high-urgency bucket)
 * 3. Fill remaining slots up to maxItems from the sorted remainder
 * 4. When interestGroups are available, non-pinned topics are grouped by label
 *
 * @param interests User's interests (weights + urgency)
 * @param maxItems Soft cap on displayed items (high-urgency may exceed this)
 * @param interestGroups Optional display groups from sleep compaction
 */
export function formatInterests(
  interests: Interests,
  maxItems = 15,
  interestGroups?: InterestGroup[]
): FormattedInterests {
  const entries = Object.entries(interests.weights).filter(([, weight]) => weight > 0);

  if (entries.length === 0) {
    return { lines: [], omittedCount: 0 };
  }

  // Deterministic sort: weight DESC → urgency DESC → topic ASC
  const sorted = entries.sort((a, b) => {
    const weightDiff = b[1] - a[1];
    if (weightDiff !== 0) return weightDiff;
    const urgencyDiff = (interests.urgency[b[0]] ?? 0.5) - (interests.urgency[a[0]] ?? 0.5);
    if (urgencyDiff !== 0) return urgencyDiff;
    return a[0].localeCompare(b[0]);
  });

  // Partition into high-urgency (pinned) and remainder
  const pinned: [string, number][] = [];
  const remainder: [string, number][] = [];

  for (const entry of sorted) {
    const urgency = interests.urgency[entry[0]] ?? 0.5;
    if (urgency > 0.7) {
      pinned.push(entry);
    } else {
      remainder.push(entry);
    }
  }

  // Fill remaining slots
  const remainderSlots = Math.max(0, maxItems - pinned.length);
  const selected = remainder.slice(0, remainderSlots);
  const omittedCount = remainder.length - selected.length;

  // Build lines — pinned topics always shown individually
  const lines: string[] = [];
  const pinnedTopics = new Set(pinned.map(([topic]) => topic));

  // Render pinned topics
  for (const [topic] of pinned) {
    lines.push(`- ${topic} (high urgency)`);
  }

  // Render remaining topics — group if interestGroups available
  // Collect as (sortKey, line) tuples for deterministic output order
  const remainderLines: { weight: number; urgency: number; key: string; line: string }[] = [];

  if (interestGroups && interestGroups.length > 0) {
    const selectedTopics = new Set(selected.map(([topic]) => topic));
    const groupedTopics = new Set<string>();

    for (const group of interestGroups) {
      // Only include groups where at least one member is in selected and none are pinned
      const membersInSelected = group.topics.filter(
        (t) => selectedTopics.has(t) && !pinnedTopics.has(t)
      );
      if (membersInSelected.length < 2) continue;

      // Use max weight/urgency of members for the group label
      const maxWeight = Math.max(...membersInSelected.map((t) => interests.weights[t] ?? 0));
      const maxUrgency = Math.max(...membersInSelected.map((t) => interests.urgency[t] ?? 0.5));
      const urgencyLabel = maxUrgency > 0.4 ? '' : ' (low urgency)';

      remainderLines.push({
        weight: maxWeight,
        urgency: maxUrgency,
        key: group.label,
        line: `- ${group.label} [${membersInSelected.join(', ')}]${urgencyLabel} (w:${maxWeight.toFixed(1)})`,
      });
      for (const t of membersInSelected) groupedTopics.add(t);
    }

    // Add ungrouped remainder
    for (const [topic] of selected) {
      if (groupedTopics.has(topic)) continue;
      const urgency = interests.urgency[topic] ?? 0.5;
      const urgencyLabel = urgency > 0.4 ? '' : ' (low urgency)';
      remainderLines.push({
        weight: interests.weights[topic] ?? 0,
        urgency,
        key: topic,
        line: `- ${topic}${urgencyLabel}`,
      });
    }
  } else {
    // No groups — render individually
    for (const [topic] of selected) {
      const urgency = interests.urgency[topic] ?? 0.5;
      const urgencyLabel = urgency > 0.4 ? '' : ' (low urgency)';
      remainderLines.push({
        weight: interests.weights[topic] ?? 0,
        urgency,
        key: topic,
        line: `- ${topic}${urgencyLabel}`,
      });
    }
  }

  // Sort remainder deterministically: weight DESC → urgency DESC → key ASC
  remainderLines.sort((a, b) => {
    const wDiff = b.weight - a.weight;
    if (wDiff !== 0) return wDiff;
    const uDiff = b.urgency - a.urgency;
    if (uDiff !== 0) return uDiff;
    return a.key.localeCompare(b.key);
  });

  for (const entry of remainderLines) {
    lines.push(entry.line);
  }

  if (omittedCount > 0) {
    lines.push(`(+${String(omittedCount)} lower-priority interests omitted)`);
  }

  return { lines, omittedCount };
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
  let interestsSection = '';
  if (hasInterests) {
    const formatted = formatInterests(interests, 15, context.interestGroups);
    interestsSection = `\n\nUser's interests (sorted by weight):\n${formatted.lines.join('\n')}`;
  }

  // Build desires hint (Phase 6: Lightweight Desires)
  const desires = context.activeDesires;
  const desireHint =
    desires && desires.length > 0 ? '\nYou have things you want to do. See <active_desires>.' : '';

  // Sleep status hint — explain the situation, let the LLM reason about it
  const sleepNote = context.userSleeping
    ? '\nThe user is currently sleeping. Sending a message now would wake them up with a notification.'
    : '';

  return `<trigger type="proactive_contact">
<context>
Last conversation: ${timeContext || 'unknown'} ago
Reason: ${triggerReason}${isDeferralOverride ? '\nDeferral override: pressure increased significantly.' : ''}${curiosityNote}${sleepNote}${interestsSection}${desireHint}
</context>

<task>
Look at the conversation history, <msg_time> tags, <completed_actions>, and <active_desires>. Understand what happened recently and what matters right now.

Only reach out when you have something concrete and new to share. Every message should carry actual information — a finding, an update, a result. When a check yields nothing, defer silently. Never tell the user that you checked and found nothing, or that "everything is quiet" — absence of news is not a message.

When you search for news or information, check each result's timestamp. Share only fresh changes since your last conversation — results from days ago are old facts the user already knows.

For local checks, topic interests describe what to look for and location interests describe where it applies; keeping both together avoids generic results from unrelated places.

Then decide what to do. You might:
- finish something that was left incomplete or failed
- follow up on something the user cared about
- act on a desire (verify it's not already done first — if done, resolve it with core.desire)
- share something you found interesting about their interests (search first, share with URL — must be fresh, not old news)
- ask something you genuinely want to know
- do nothing: core.defer(signalType="${triggerType}", deferHours=1-24, reason="...")

Use tools to research before messaging. Do not repeat completed actions. Max 7 tool calls.
Respond with {"response": "your message"} or defer.
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

  // Flatten nested payload into top-level for consistent access.
  // PluginEventData stores event-specific fields in `payload`, but handlers
  // read from the top level. Spreading payload last lets it override.
  const payload = data['payload'] as Record<string, unknown> | undefined;
  const d = payload ? { ...data, ...payload } : data;

  const kind = d['kind'] as string | undefined;
  const pluginId = d['pluginId'] as string | undefined;
  const eventKind = d['eventKind'] as string | undefined;
  const urgent = d['urgent'] as boolean | undefined;

  // Handle fact_batch events (news, interesting facts)
  if (kind === 'fact_batch' && Array.isArray(d['facts'])) {
    const facts = d['facts'] as { content: string; provenance?: { url?: string } }[];

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
Deliver this news with URLs inline in your response. Do not send teasers or previews — include the full news content directly.
</task>
</trigger>`;
  }

  // Handle daily agenda events — pre-filtered agenda items from plugin
  if (eventKind === 'reminder:daily_agenda') {
    const agendaItems = d['agendaItems'] as string[] | undefined;
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
    const content = (d['content'] as string | undefined) ?? 'Unknown task';
    const isRecurring = d['isRecurring'] === true;

    return `<trigger type="self_scheduled">
<context>
You scheduled this for yourself: "${content}"${isRecurring ? ' (recurring)' : ''}
</context>

<task>
Act on your own reminder. You set this because it mattered.
If the task is complete, you can cancel it with plugin.reminder(action:"cancel", reminderId:"${(d['reminderId'] as string | undefined) ?? ''}").

This is a proactive check — you initiated it. Speak up only when you find something concrete and new. When a routine check yields no results, complete silently: {"response": ""}.
</task>
</trigger>`;
  }

  // Handle commitment due events (Phase 5: Commitment Tracking)
  if (eventKind === 'commitment:due') {
    const commitmentId = (d['commitmentId'] as string | undefined) ?? '';
    const text = (d['text'] as string | undefined) ?? 'Unknown commitment';
    const dueAt = d['dueAt'] as string | undefined;

    return `<trigger type="commitment_due">
<context>
You promised: "${text}"
Due: ${dueAt ?? 'now'}
This commitment is due now.
</context>

<task>
FIRST: Check conversation history. If the user recently asked you to stop this activity or cancel related work, call core.commitment(action:"cancel", commitmentId:"${commitmentId}") immediately. User instructions override commitments.
Then decide:
1. Fulfill now: do it, then core.commitment(action:"mark_kept", commitmentId:"${commitmentId}").
2. Bad timing (user busy, active conversation, late hour): defer with {"response": ""}. The commitment stays active — you will be reminded again.
3. Circumstances changed: core.commitment(action:"cancel", commitmentId:"${commitmentId}").
</task>
</trigger>`;
  }

  // Handle commitment overdue events (Phase 5: Commitment Tracking)
  if (eventKind === 'commitment:overdue') {
    const commitmentId = (d['commitmentId'] as string | undefined) ?? '';
    const text = (d['text'] as string | undefined) ?? 'Unknown commitment';
    const dueAt = d['dueAt'] as string | undefined;

    return `<trigger type="commitment_overdue">
<context>
You promised: "${text}"
Due: ${dueAt ?? 'unknown'}
You missed this commitment.
</context>

<task>
FIRST: Check conversation history. If the user recently asked you to stop this activity or cancel related work, call core.commitment(action:"cancel", commitmentId:"${commitmentId}") immediately. User instructions override commitments.
Then decide:
1. Fulfill now: do it, then core.commitment(action:"mark_kept", commitmentId:"${commitmentId}").
2. Repair: acknowledge to user, then core.commitment(action:"mark_repaired", commitmentId:"${commitmentId}", repairNote:"...").
3. Bad timing (user busy, active conversation, late hour): defer with {"response": ""}. The commitment stays active — you will be reminded again.
4. Circumstances changed: core.commitment(action:"cancel", commitmentId:"${commitmentId}").
</task>
</trigger>`;
  }

  // Handle prediction due events (Phase 7: Opinions + Predictions)
  if (eventKind === 'perspective:prediction_due') {
    const predictionId = (d['predictionId'] as string | undefined) ?? '';
    const claim = (d['claim'] as string | undefined) ?? 'Unknown prediction';
    const confidence = (d['confidence'] as number | undefined) ?? 0.5;

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
    const claim = (d['claim'] as string | undefined) ?? 'Unknown prediction';

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

  // Calories anomaly: structured prompt with goal framing
  if (eventKind === 'calories:anomaly') {
    const consumed = (d['consumed'] as number | undefined) ?? 0;
    const mealCount = (d['mealCount'] as number | undefined) ?? 0;
    const baselineDays = (d['baselineDays'] as number | undefined) ?? 0;
    const expectedByNow = (d['expectedByNow'] as number | undefined) ?? 0;
    const expectedMeals = (d['expectedMeals'] as number | undefined) ?? 0;
    const goal = (d['goal'] as number | undefined) ?? 0;
    const anomalyType = (d['anomalyType'] as string | undefined) ?? 'unknown';
    const normalRange = d['normalRange'] as { low?: number; high?: number } | undefined;
    const rangeLow = normalRange?.low ?? 0;
    const rangeHigh = normalRange?.high ?? 0;
    return `<trigger type="plugin_event">
<context>
Calorie tracking anomaly detected.
Today's intake: ${String(consumed)} kcal (${String(mealCount)} meals)
Expected by now (based on ${String(baselineDays)}-day history): ${String(expectedByNow)} kcal (${String(expectedMeals)} meals)
Normal range: ${String(rangeLow)}–${String(rangeHigh)} kcal
Daily limit: ${String(goal)} kcal (this is a CEILING — staying under is good)
Anomaly type: ${anomalyType}
</context>

<task>The user's intake today is unusually low compared to their own pattern. Check in gently — they may be fasting intentionally, busy, or simply haven't started eating yet. The calorie goal is a MAXIMUM (ceiling), not a target to reach.</task>
</trigger>`;
  }

  // Generic plugin event format
  return `<trigger type="plugin_event">
<context>
Event: ${eventKind ?? 'unknown'}
Plugin: ${pluginId ?? 'unknown'}
${urgent ? 'URGENT: This event requires immediate attention.\n' : ''}Data: ${JSON.stringify(d)}
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
${content}
A reaction is nonverbal feedback — like a nod or thumbs up in real life.
Use conversation context to understand what the reaction means and decide what, if anything, to do.
An empty response {"response": ""} is fine when no reply is needed.
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
The user reacted ${emoji ?? '(thumbs up)'} to: ${messageContext}
A reaction is nonverbal feedback — like a nod or thumbs up in real life.
Use conversation context to understand what the reaction means and decide what, if anything, to do.
An empty response {"response": ""} is fine when no reply is needed.
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

      // Build artifacts hint (if any files were produced)
      const artifacts = result?.artifacts;
      const hasArtifacts = artifacts && artifacts.length > 0;
      if (hasArtifacts) {
        context += ` Artifacts available: [${artifacts.join(', ')}].`;
      }

      // Build task
      let task = `Report the result to the user. Include the run ID (${runId}) so the user can reference it.`;
      if (hasArtifacts) {
        task += `\nArtifacts produced: ${artifacts.join(', ')}. To read: core.task(action:"artifact", runId:"${runId}", path:"<filename>").`;
        task += '\nIf the summary references a file, read it before responding to the user.';
      }
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

      // Determine terminal vs retryable using explicit retry budget metadata
      const attemptsRemaining =
        typeof data.attemptsRemaining === 'number' ? data.attemptsRemaining : undefined;
      const maxAttempts = typeof data.maxAttempts === 'number' ? data.maxAttempts : undefined;
      const terminalByBudget = attemptsRemaining === 0;
      const isTerminal = !failure.retryable || terminalByBudget;

      // Include attempt budget in context when available
      const budgetLabel =
        attemptIndex !== undefined && maxAttempts !== undefined && attemptsRemaining !== undefined
          ? `\nAttempt budget: ${String(attemptIndex + 1)}/${String(maxAttempts)} (remaining retries: ${String(attemptsRemaining)})`
          : '';

      if (isTerminal) {
        // Terminal failure — mandatory reporting, no retry option
        return `<trigger type="motor_result_failed">
<context>
Task run ${runId}${attemptLabel}${skillLabel} FAILED (terminal — no more retries).
Category: ${failure.category} | Retryable: ${String(failure.retryable)}${budgetLabel}
${failure.lastErrorCode ? `Last error: ${failure.lastErrorCode}\n` : ''}Last tool results:
${toolResultsStr || '  (none)'}${failure.hint ? `\nAnalysis: ${failure.hint}` : ''}
</context>
<task>
A background task FAILED and cannot be retried. You MUST report this to the user:
1. Tell the user the task failed. Be explicit — do NOT present partial results as if the task succeeded.
2. Include what the task was trying to do${data.skill ? ` (skill: "${data.skill}")` : ''}.
3. Explain why it failed (category: ${failure.category}).
4. Include the run ID (${runId}).
5. If you need more detail first, call core.task(action:"log", runId:"${runId}").
Do NOT create a new core.act run for the same task.${skillRetryHint}
</task>
</trigger>`;
      }

      // Retryable failure — offer retry/log/report protocol
      return `<trigger type="motor_result_failed">
<context>
Task run ${runId}${attemptLabel}${skillLabel} failed.
Category: ${failure.category} | Retryable: ${String(failure.retryable)}${budgetLabel}
${failure.lastErrorCode ? `Last error: ${failure.lastErrorCode}\n` : ''}Last tool results:
${toolResultsStr || '  (none)'}${failure.hint ? `\nAnalysis: ${failure.hint}` : ''}
</context>
<task>
A background task failed. Follow this protocol:
1. Review the failure summary above.
2. If retryable and you can provide useful guidance, call core.task(action:"retry", runId:"${runId}", guidance:"your corrective instructions").
3. If you need more detail, call core.task(action:"log", runId:"${runId}") first.
4. If retries are exhausted, report the failure to the user clearly. Include the run ID (${runId}).
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
