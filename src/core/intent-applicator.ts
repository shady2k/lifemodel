/**
 * IntentApplicator - extracted from CoreLoop.
 *
 * Applies intents produced by the 3-layer pipeline (AUTONOMIC, AGGREGATION, COGNITION).
 * Each intent maps to a concrete side effect: sending messages, saving memory,
 * updating state, scheduling events, etc.
 */

import { randomUUID } from 'node:crypto';
import type {
  SignalType,
  SignalSource,
  Logger,
  Metrics,
  Channel,
  SendOptions,
  Event,
  ThoughtData,
  InterestIntensity,
  Intent,
} from '../types/index.js';
import type {
  SendMessageIntent,
  ScheduleEventIntent,
  EmitMetricIntent,
  SaveToMemoryIntent,
  AckSignalIntent,
  DeferSignalIntent,
  EmitThoughtIntent,
  RememberIntent,
  SetInterestIntent,
  CommitmentIntent,
  DesireIntent,
  PerspectiveIntent,
} from '../types/intent.js';
import {
  createTraceContext,
  withTraceContext,
  type TraceContext,
} from './trace-context.js';
import type { Agent } from './agent.js';
import type { EventBus } from './event-bus.js';
import type { AggregationProcessor } from '../layers/aggregation/processor.js';
import type { MessageComposer } from '../llm/composer.js';
import type { ConversationManager } from '../storage/conversation-manager.js';
import type { UserModel } from '../models/user-model.js';
import type { MemoryProvider, MemoryEntry } from '../layers/cognition/tools/registry.js';
import type { IRecipientRegistry } from './recipient-registry.js';
import { markdownToTelegramHtml } from '../utils/telegram-html.js';
import type { StatusUpdateService } from './status-update-service.js';
import type { DomainTrackerService } from './domain-trackers.js';

/**
 * Dependencies injected into IntentApplicator.
 */
export interface IntentApplicatorDeps {
  agent: Agent;
  logger: Logger;
  metrics: Metrics;
  recipientRegistry?: IRecipientRegistry | undefined;
  channels: Map<string, Channel>;
  conversationManager?: ConversationManager | undefined;
  memoryProvider?: MemoryProvider | undefined;
  userModel?: UserModel | undefined;
  eventBus: EventBus;
  aggregation: AggregationProcessor;
  statusUpdates?: StatusUpdateService | undefined;
  domainTrackers?: DomainTrackerService | undefined;
  messageComposer?: MessageComposer | undefined;
  enqueueThought: (data: ThoughtData, source: SignalSource) => void;
  running: () => boolean;
}

/**
 * IntentApplicator handles the execution of all intent types
 * produced by the 3-layer pipeline.
 */
export class IntentApplicator {
  private readonly deps: IntentApplicatorDeps;

  /** Timestamp of last message sent (for response timing) */
  private _lastMessageSentAt: number | null = null;
  private _lastMessageRecipientId: string | null = null;

  /**
   * Intensity-to-delta mapping for SET_INTEREST intent.
   */
  private static readonly INTENSITY_DELTAS: Record<InterestIntensity, number> = {
    strong_positive: 0.5,
    weak_positive: 0.2,
    weak_negative: -0.2,
    strong_negative: -0.5,
  };

  constructor(deps: IntentApplicatorDeps) {
    this.deps = deps;
  }

  /** Last message sent timestamp (for response timing in CoreLoop). */
  get lastMessageSentAt(): number | null {
    return this._lastMessageSentAt;
  }

  /** Last message recipient ID (for response timing in CoreLoop). */
  get lastMessageRecipientId(): string | null {
    return this._lastMessageRecipientId;
  }

  /** Reset response timing tracking (called after CoreLoop processes the timing). */
  resetResponseTracking(): void {
    this._lastMessageSentAt = null;
    this._lastMessageRecipientId = null;
  }

  /**
   * Apply intents from all layers.
   * Each intent is applied under its own trace context.
   */
  apply(intents: Intent[], tickCtx: TraceContext): void {
    for (const intent of intents) {
      // Create trace context for this intent
      // Use intent's trace info if available, otherwise fall back to tick context
      const trace = intent.trace;

      let intentCtx: TraceContext;
      if (trace?.parentSignalId ?? trace?.tickId) {
        const traceId = trace.parentSignalId ?? trace.tickId ?? tickCtx.traceId;
        const options: { correlationId?: string; parentId?: string } = {};
        if (trace.tickId !== undefined) options.correlationId = trace.tickId;
        else if (tickCtx.correlationId !== undefined) options.correlationId = tickCtx.correlationId;
        if (trace.parentSignalId !== undefined) options.parentId = trace.parentSignalId;
        intentCtx = createTraceContext(traceId, options);
      } else {
        intentCtx = tickCtx;
      }

      withTraceContext(intentCtx, () => {
        switch (intent.type) {
          case 'UPDATE_STATE':
            this.deps.agent.applyIntent(intent);
            break;

          case 'SEND_MESSAGE':
            this.applySendMessage(intent);
            break;

          case 'SCHEDULE_EVENT':
            this.applyScheduleEvent(intent);
            break;

          case 'LOG':
            this.deps.logger[intent.payload.level](
              intent.payload.context ?? {},
              intent.payload.message
            );
            break;

          case 'EMIT_METRIC':
            this.applyEmitMetric(intent);
            break;

          case 'CANCEL_EVENT':
            this.deps.logger.debug({ intent }, 'CANCEL_EVENT not yet implemented');
            break;

          case 'SAVE_TO_MEMORY':
            this.applySaveToMemory(intent);
            break;

          case 'ACK_SIGNAL':
            this.applyAckSignal(intent);
            break;

          case 'DEFER_SIGNAL':
            this.applyDeferSignal(intent);
            break;

          case 'EMIT_THOUGHT':
            this.applyEmitThought(intent);
            break;

          case 'REMEMBER':
            this.applyRemember(intent);
            break;

          case 'SET_INTEREST':
            this.applySetInterest(intent);
            break;

          case 'COMMITMENT':
            this.applyCommitment(intent);
            break;

          case 'DESIRE':
            this.applyDesire(intent);
            break;

          case 'PERSPECTIVE':
            this.applyPerspective(intent);
            break;
        }
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Intent handlers
  // ──────────────────────────────────────────────────────────────────────────

  private applySendMessage(intent: SendMessageIntent): void {
    const { recipientId, text, replyTo, conversationStatus } = intent.payload;

    if (!this.deps.recipientRegistry) {
      this.deps.logger.error({ recipientId }, 'RecipientRegistry not configured');
      this.deps.metrics.counter('messages_failed', { reason: 'no_registry' });
      return;
    }

    const route = this.deps.recipientRegistry.resolve(recipientId);
    if (!route) {
      this.deps.logger.error({ recipientId }, 'Could not resolve recipientId');
      this.deps.metrics.counter('messages_failed', { reason: 'unresolved_recipient' });
      return;
    }

    const channelImpl = this.deps.channels.get(route.channel);
    if (!channelImpl) {
      this.deps.logger.error(
        {
          recipientId,
          channel: route.channel,
          registeredChannels: Array.from(this.deps.channels.keys()),
        },
        'Channel not found'
      );
      this.deps.metrics.counter('messages_failed', {
        channel: route.channel,
        reason: 'channel_not_found',
      });
      return;
    }

    const htmlText = markdownToTelegramHtml(text);
    const sendOptions: SendOptions = {
      ...(replyTo && { replyTo }),
      parseMode: 'HTML',
    };
    Promise.resolve()
      .then(async () => {
        // Duplicate detection: skip sending if message is identical to last assistant message
        // This prevents proactive contacts from repeating the same response
        if (this.deps.conversationManager) {
          const lastMessage =
            await this.deps.conversationManager.getLastAssistantMessage(recipientId);
          if (lastMessage && lastMessage === text) {
            this.deps.logger.warn(
              { recipientId, textLength: text.length },
              'Skipping duplicate message - identical to last assistant message'
            );
            this.deps.metrics.counter('messages_skipped', { reason: 'duplicate' });
            return { success: false, skipped: true };
          }
        }
        return channelImpl.sendMessage(route.destination, htmlText, sendOptions);
      })
      .then((result) => {
        if (result.success) {
          this._lastMessageSentAt = Date.now();
          this._lastMessageRecipientId = recipientId;
          this.deps.metrics.counter('messages_sent', { channel: route.channel });
          this.deps.agent.onMessageSent();

          if (this.deps.conversationManager) {
            // Type guard: messageId only exists on actual send results, not on skipped results
            const messageId = 'messageId' in result ? result.messageId : undefined;
            // Note: toolCalls and toolResults are NOT saved to history
            // They're kept in agentic loop memory only to prevent pollution across triggers
            void this.saveAgentMessage(
              recipientId,
              text,
              conversationStatus,
              messageId
                ? { channelMessageId: messageId, channel: route.channel }
                : undefined
            );
          }
        } else if ('skipped' in result && result.skipped) {
          // Message was intentionally skipped (duplicate detection)
          // Already logged and tracked in the duplicate check
        } else {
          this.deps.logger.warn(
            { recipientId, channel: route.channel, textLength: text.length },
            'Message send returned false'
          );
          this.deps.metrics.counter('messages_failed', {
            channel: route.channel,
            reason: 'returned_false',
          });
        }
      })
      .catch((error: unknown) => {
        this.deps.logger.error(
          { error: error instanceof Error ? error.message : String(error), recipientId },
          'Message send threw an error'
        );
        this.deps.metrics.counter('messages_failed', {
          channel: route.channel,
          reason: 'exception',
        });
      });
  }

  private applyScheduleEvent(intent: ScheduleEventIntent): void {
    const { event, delay, scheduleId } = intent.payload;
    const fullEvent: Event = {
      id: scheduleId ?? randomUUID(),
      source: event.source as Event['source'],
      type: event.type,
      priority: event.priority,
      timestamp: new Date(),
      payload: event.payload,
    };
    if (event.channel) {
      fullEvent.channel = event.channel;
    }

    if (delay <= 0) {
      void this.deps.eventBus.publish(fullEvent);
    } else {
      setTimeout(() => {
        if (this.deps.running()) {
          void this.deps.eventBus.publish(fullEvent);
        }
      }, delay);
    }
  }

  private applyEmitMetric(intent: EmitMetricIntent): void {
    const { type: metricType, name, value, labels } = intent.payload;
    switch (metricType) {
      case 'gauge':
        this.deps.metrics.gauge(name, value, labels);
        break;
      case 'counter':
        this.deps.metrics.counter(name, labels);
        break;
      case 'histogram':
        this.deps.metrics.histogram(name, value, labels);
        break;
    }
  }

  private applySaveToMemory(intent: SaveToMemoryIntent): void {
    const {
      type: memoryType,
      recipientId: memoryRecipientId,
      content,
      fact,
      tags,
    } = intent.payload;

    if (this.deps.memoryProvider) {
      const subject = fact?.subject ?? '';
      const predicate = fact?.predicate ?? '';
      const object = fact?.object ?? '';
      const evidence = fact?.evidence ?? '';
      const entryContent = fact
        ? `${subject} ${predicate} ${object}${evidence ? ` (${evidence})` : ''}`
        : (content ?? '');

      if (entryContent.trim()) {
        const entry = {
          id: `mem_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`,
          type: memoryType as 'fact' | 'thought' | 'message' | 'intention',
          content: entryContent,
          timestamp: new Date(),
          recipientId: memoryRecipientId,
          tags: tags ?? fact?.tags,
          confidence: fact?.confidence,
          metadata: fact ? { subject, predicate, object } : undefined,
        };

        this.deps.memoryProvider.save(entry).catch((err: unknown) => {
          this.deps.logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'Failed to save to memory'
          );
        });

        this.deps.logger.debug(
          { entryId: entry.id, type: memoryType, content: entryContent.slice(0, 50) },
          'Memory entry saved'
        );
      }
    } else {
      this.deps.logger.debug(
        {
          memoryType,
          recipientId: memoryRecipientId,
          hasFact: !!fact,
          hasContent: !!content,
        },
        'Memory save skipped (no provider)'
      );
    }

    this.deps.metrics.counter('memory_saves', { type: memoryType });
  }

  private applyAckSignal(intent: AckSignalIntent): void {
    const { signalId, signalType, source, reason } = intent.payload;

    const ackRegistry = this.deps.aggregation.getAckRegistry();

    if (signalType === 'thought') {
      if (signalId) {
        ackRegistry.markHandled(signalId);
      } else {
        this.deps.logger.warn({ signalType }, 'Thought ACK missing signalId');
      }
    }

    ackRegistry.registerAck({
      signalType: signalType as SignalType,
      source: source as SignalSource | undefined,
      ackType: 'handled',
      reason,
    });

    this.deps.logger.debug({ signalId, signalType, source, reason }, 'Signal acknowledged');
    this.deps.metrics.counter('signal_acks', { signalType, ackType: 'handled' });
  }

  private applyDeferSignal(intent: DeferSignalIntent): void {
    const { signalType, source, deferMs, valueAtDeferral, overrideDelta, reason } =
      intent.payload;

    let currentValue = valueAtDeferral;
    if (currentValue === undefined) {
      const aggregate = this.deps.aggregation.getAggregate(signalType as SignalType);
      currentValue = aggregate?.currentValue;
    }

    const ackRegistry = this.deps.aggregation.getAckRegistry();
    ackRegistry.registerAck({
      signalType: signalType as SignalType,
      source: source as SignalSource | undefined,
      ackType: 'deferred',
      deferUntil: new Date(Date.now() + deferMs),
      valueAtAck: currentValue,
      overrideDelta,
      reason,
    });

    this.deps.logger.info(
      {
        signalType,
        deferMs,
        deferHours: (deferMs / (60 * 60 * 1000)).toFixed(1),
        reason,
        valueAtDeferral: currentValue?.toFixed(2),
      },
      'Signal deferred'
    );
    this.deps.metrics.counter('signal_acks', { signalType, ackType: 'deferred' });
  }

  private applyEmitThought(intent: EmitThoughtIntent): void {
    const {
      content,
      triggerSource,
      depth,
      rootThoughtId,
      parentThoughtId,
      signalSource,
      recipientId: thoughtRecipientId,
    } = intent.payload;

    const thoughtData: ThoughtData = {
      kind: 'thought',
      content,
      triggerSource,
      depth,
      rootThoughtId,
      ...(parentThoughtId !== undefined && { parentThoughtId }),
      ...(thoughtRecipientId !== undefined && { recipientId: thoughtRecipientId }),
    };

    this.deps.enqueueThought(thoughtData, signalSource as SignalSource);
  }

  private applyRemember(intent: RememberIntent): void {
    const {
      subject,
      attribute,
      value,
      confidence,
      source,
      evidence,
      isUserFact,
      recipientId: rememberRecipientId,
    } = intent.payload;
    const trace = intent.trace;

    if (isUserFact && this.deps.userModel) {
      const strValue = value.trim();
      const isDelta = strValue.startsWith('+') || strValue.startsWith('-');
      const deltaNum = isDelta ? this.parseDelta(value) : null;

      if (isDelta && deltaNum !== null) {
        const currentProp = this.deps.userModel.getProperty(attribute);
        const currentNum = typeof currentProp?.value === 'number' ? currentProp.value : 0.5;
        const newValue = Math.max(0, Math.min(1, currentNum + deltaNum));
        this.deps.userModel.setProperty(attribute, newValue, confidence, source, evidence);
        this.deps.logger.debug(
          {
            attribute,
            delta: deltaNum,
            current: currentNum,
            newValue,
            tickId: trace?.tickId,
          },
          'User property updated (delta)'
        );
      } else {
        this.deps.userModel.setProperty(attribute, value, confidence, source, evidence);
        this.deps.logger.debug(
          {
            attribute,
            value,
            confidence,
            tickId: trace?.tickId,
            parentSignalId: trace?.parentSignalId,
          },
          'User property stored'
        );
      }
    }

    if (this.deps.memoryProvider) {
      const memoryEntry = {
        id: `mem_${randomUUID()}`,
        type: 'fact' as const,
        content: `${subject}.${attribute}: ${value}`,
        timestamp: new Date(),
        recipientId: rememberRecipientId,
        confidence,
        metadata: { subject, attribute, source, evidence, isUserFact },
        tickId: trace?.tickId,
        parentSignalId: trace?.parentSignalId,
      };

      this.deps.memoryProvider.save(memoryEntry).catch((err: unknown) => {
        this.deps.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Failed to save remembered fact to memory'
        );
      });

      this.deps.logger.debug(
        {
          subject,
          attribute,
          tickId: trace?.tickId,
          parentSignalId: trace?.parentSignalId,
        },
        'Memory stored'
      );
    }

    if (rememberRecipientId && this.deps.conversationManager) {
      const summary = `${subject}.${attribute}="${value}"`;
      this.deps.conversationManager
        .addCompletedAction(rememberRecipientId, {
          tool: 'core.remember',
          summary,
        })
        .catch((err: unknown) => {
          this.deps.logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            'Failed to record completed action for remember'
          );
        });
    }

    this.deps.metrics.counter('facts_remembered', { isUserFact: String(isUserFact) });
  }

  private applySetInterest(intent: SetInterestIntent): void {
    const {
      topic,
      intensity,
      urgent,
      source,
      recipientId: interestRecipientId,
    } = intent.payload;
    const trace = intent.trace;

    if (!this.deps.userModel) {
      this.deps.logger.warn({ topic }, 'SET_INTEREST skipped: no UserModel');
      return;
    }

    if (typeof topic !== 'string' || topic.length === 0) {
      this.deps.logger.error({ topic, intensity }, 'SET_INTEREST: invalid topic');
      return;
    }

    const keywords = topic
      .split(',')
      .map((kw) => kw.trim().toLowerCase())
      .filter((kw) => kw.length >= 2);

    if (keywords.length === 0) {
      this.deps.logger.error({ topic, intensity }, 'SET_INTEREST: no valid keywords');
      return;
    }

    const delta = IntentApplicator.INTENSITY_DELTAS[intensity];
    const interests = this.deps.userModel.getInterests();

    for (const keyword of keywords) {
      const currentWeight = interests?.weights[keyword] ?? 0.5;
      const newWeight = Math.max(0, Math.min(1, currentWeight + delta));
      this.deps.userModel.setTopicWeight(keyword, newWeight);

      if (urgent) {
        const currentUrgency = interests?.urgency[keyword] ?? 0.5;
        const newUrgency = Math.max(0, Math.min(1, currentUrgency + 0.5));
        this.deps.userModel.setTopicUrgency(keyword, newUrgency);
      }
    }

    if (interestRecipientId && this.deps.conversationManager) {
      const summary = `topic="${topic}", intensity=${intensity}${urgent ? ', urgent' : ''}`;
      this.deps.conversationManager
        .addCompletedAction(interestRecipientId, {
          tool: 'core.setInterest',
          summary,
        })
        .catch((err: unknown) => {
          this.deps.logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            'Failed to record completed action for setInterest'
          );
        });
    }

    this.deps.logger.debug(
      {
        originalTopic: topic,
        keywords,
        intensity,
        delta,
        urgent,
        source,
        tickId: trace?.tickId,
      },
      'Topic interests updated'
    );

    this.deps.metrics.counter('interests_set', { intensity, urgent: String(urgent) });

    // Bump curiosity when user shows interest (Phase 2: Dynamic Curiosity)
    // Random bump between 0.1-0.15 to add natural variation
    const curiosityBump = 0.1 + Math.random() * 0.05;
    this.deps.agent.applyIntent({
      type: 'UPDATE_STATE',
      payload: { key: 'curiosity', value: curiosityBump, delta: true },
    });
  }

  private applyCommitment(intent: CommitmentIntent): void {
    const {
      action,
      commitmentId,
      text,
      dueAt,
      source,
      confidence,
      repairNote,
      recipientId: commitmentRecipientId,
    } = intent.payload;
    const trace = intent.trace;

    if (!this.deps.memoryProvider) {
      this.deps.logger.warn({ action }, 'COMMITMENT skipped: no MemoryProvider');
      return;
    }

    if (action === 'create') {
      if (!commitmentId || !text || !dueAt) {
        this.deps.logger.error(
          { commitmentId, text, dueAt },
          'COMMITMENT create: missing fields'
        );
        return;
      }

      // Store commitment as MemoryEntry
      const entry: MemoryEntry = {
        id: commitmentId,
        type: 'fact',
        content: text,
        timestamp: new Date(),
        recipientId: commitmentRecipientId,
        tags: ['commitment', 'state:active'],
        confidence: confidence ?? 0.9,
        metadata: {
          kind: 'commitment',
          dueAt: dueAt.toISOString(),
          source: source ?? 'explicit',
          createdAt: new Date().toISOString(),
        },
        tickId: trace?.tickId,
        parentSignalId: trace?.parentSignalId,
      };

      this.deps.memoryProvider.save(entry).catch((err: unknown) => {
        this.deps.logger.error(
          { commitmentId, error: err instanceof Error ? err.message : String(err) },
          'Failed to save commitment'
        );
      });

      // Record completed action
      if (commitmentRecipientId && this.deps.conversationManager) {
        const dueDate = new Date(dueAt);
        const summary = `promise: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" (due ${dueDate.toLocaleDateString()})`;
        this.deps.conversationManager
          .addCompletedAction(commitmentRecipientId, {
            tool: 'core.commitment',
            summary,
          })
          .catch((err: unknown) => {
            this.deps.logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              'Failed to record completed action for commitment'
            );
          });
      }

      this.deps.logger.info(
        { commitmentId, text: text.slice(0, 50), dueAt, source },
        'Commitment created'
      );
      this.deps.metrics.counter('commitments_created', { source: source ?? 'explicit' });
    } else if (action === 'mark_kept') {
      // Update commitment status to kept
      if (commitmentId && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updateCommitmentStatus(
          commitmentId, 'kept',
          this.deps.domainTrackers!.signaledDueCommitments, this.deps.domainTrackers!.signaledOverdueCommitments,
          commitmentRecipientId,
        );
        this.deps.logger.info({ commitmentId }, 'Commitment marked as kept');
        this.deps.metrics.counter('commitments_kept');
      }
    } else if (action === 'mark_repaired') {
      // Update commitment status to repaired with note
      if (commitmentId && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updateCommitmentStatus(
          commitmentId, 'repaired',
          this.deps.domainTrackers!.signaledDueCommitments, this.deps.domainTrackers!.signaledOverdueCommitments,
          commitmentRecipientId, repairNote,
        );
        this.deps.logger.info({ commitmentId, repairNote }, 'Commitment marked as repaired');
        this.deps.metrics.counter('commitments_repaired');
      }
    } else if (action === 'cancel') {
      // Update commitment status to cancelled
      if (commitmentId && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updateCommitmentStatus(
          commitmentId, 'cancelled',
          this.deps.domainTrackers!.signaledDueCommitments, this.deps.domainTrackers!.signaledOverdueCommitments,
          commitmentRecipientId,
        );
        this.deps.logger.info({ commitmentId }, 'Commitment cancelled');
        this.deps.metrics.counter('commitments_cancelled');
      }
    }
  }

  private applyDesire(intent: DesireIntent): void {
    const {
      action,
      desireId,
      want,
      intensity,
      source,
      evidence,
      recipientId: desireRecipientId,
    } = intent.payload;
    const trace = intent.trace;

    if (!this.deps.memoryProvider) {
      this.deps.logger.warn({ action }, 'DESIRE skipped: no MemoryProvider');
      return;
    }

    if (action === 'create') {
      if (!desireId || !want) {
        this.deps.logger.error({ desireId, want }, 'DESIRE create: missing fields');
        return;
      }

      // Store desire as MemoryEntry
      const entry: MemoryEntry = {
        id: desireId,
        type: 'fact',
        content: want,
        timestamp: new Date(),
        recipientId: desireRecipientId,
        tags: ['desire', 'state:active'],
        confidence: intensity ?? 0.5,
        metadata: {
          kind: 'desire',
          intensity: intensity ?? 0.5,
          source: source ?? 'self_inference',
          evidence: evidence ?? '',
          createdAt: new Date().toISOString(),
        },
        tickId: trace?.tickId,
        parentSignalId: trace?.parentSignalId,
      };

      this.deps.memoryProvider.save(entry).catch((err: unknown) => {
        this.deps.logger.error(
          { desireId, error: err instanceof Error ? err.message : String(err) },
          'Failed to save desire'
        );
      });

      this.deps.logger.info(
        { desireId, want: want.slice(0, 50), intensity, source },
        'Desire created'
      );
      this.deps.metrics.counter('desires_created', { source: source ?? 'self_inference' });
    } else if (action === 'adjust') {
      // Update desire intensity
      if (desireId && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updateDesireStatus(desireId, 'active', intensity);
        this.deps.logger.info({ desireId, intensity }, 'Desire intensity adjusted');
        this.deps.metrics.counter('desires_adjusted');
      }
    } else if (action === 'resolve') {
      // Mark desire as satisfied
      if (desireId && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updateDesireStatus(desireId, 'satisfied');
        this.deps.logger.info({ desireId }, 'Desire resolved');
        this.deps.metrics.counter('desires_resolved');
      }
    }
  }

  private applyPerspective(intent: PerspectiveIntent): void {
    const {
      action,
      opinionId,
      predictionId,
      topic,
      stance,
      rationale,
      confidence,
      claim,
      horizonAt,
      outcome,
      recipientId: perspectiveRecipientId,
    } = intent.payload;
    const trace = intent.trace;

    if (!this.deps.memoryProvider) {
      this.deps.logger.warn({ action }, 'PERSPECTIVE skipped: no MemoryProvider');
      return;
    }

    if (action === 'set_opinion') {
      if (!opinionId || !topic || !stance) {
        this.deps.logger.error(
          { opinionId, topic, stance },
          'PERSPECTIVE set_opinion: missing fields'
        );
        return;
      }

      // Store opinion as MemoryEntry
      const entry: MemoryEntry = {
        id: opinionId,
        type: 'fact',
        content: `${topic}: ${stance}`,
        timestamp: new Date(),
        recipientId: perspectiveRecipientId,
        tags: ['opinion', 'state:active'],
        confidence: confidence ?? 0.7,
        metadata: {
          kind: 'opinion',
          topic,
          stance,
          rationale: rationale ?? '',
          confidence: confidence ?? 0.7,
          createdAt: new Date().toISOString(),
        },
        tickId: trace?.tickId,
        parentSignalId: trace?.parentSignalId,
      };

      this.deps.memoryProvider.save(entry).catch((err: unknown) => {
        this.deps.logger.error(
          { opinionId, error: err instanceof Error ? err.message : String(err) },
          'Failed to save opinion'
        );
      });

      this.deps.logger.info(
        { opinionId, topic, stance: stance.slice(0, 50), confidence },
        'Opinion created'
      );
      this.deps.metrics.counter('opinions_created');
    } else if (action === 'predict') {
      if (!predictionId || !claim || !horizonAt) {
        this.deps.logger.error(
          { predictionId, claim, horizonAt },
          'PERSPECTIVE predict: missing fields'
        );
        return;
      }

      // Store prediction as MemoryEntry
      const entry: MemoryEntry = {
        id: predictionId,
        type: 'fact',
        content: claim,
        timestamp: new Date(),
        recipientId: perspectiveRecipientId,
        tags: ['prediction', 'state:pending'],
        confidence: confidence ?? 0.6,
        metadata: {
          kind: 'prediction',
          claim,
          horizonAt: horizonAt.toISOString(),
          confidence: confidence ?? 0.6,
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
        tickId: trace?.tickId,
        parentSignalId: trace?.parentSignalId,
      };

      this.deps.memoryProvider.save(entry).catch((err: unknown) => {
        this.deps.logger.error(
          { predictionId, error: err instanceof Error ? err.message : String(err) },
          'Failed to save prediction'
        );
      });

      this.deps.logger.info(
        { predictionId, claim: claim.slice(0, 50), horizonAt, confidence },
        'Prediction created'
      );
      this.deps.metrics.counter('predictions_created');
    } else if (action === 'resolve_prediction') {
      if (predictionId && outcome && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updatePredictionStatus(
          predictionId, outcome, this.deps.domainTrackers!.signaledDuePredictions,
        );
        this.deps.logger.info({ predictionId, outcome }, 'Prediction resolved');
        this.deps.metrics.counter('predictions_resolved', { outcome });
      }
    } else if (action === 'revise_opinion') {
      if (opinionId && this.deps.statusUpdates) {
        void this.deps.statusUpdates.updateOpinionStatus(
          opinionId,
          stance,
          confidence,
        );
        this.deps.logger.info({ opinionId }, 'Opinion revised');
        this.deps.metrics.counter('opinions_revised');
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helper methods
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Parse a delta value from string.
   * Accepts formats: "+0.2", "-0.1", "0.3" (treated as +0.3)
   * Returns null if parsing fails.
   */
  private parseDelta(value: unknown): number | null {
    const str = String(value).trim();
    const num = parseFloat(str);
    if (Number.isNaN(num)) return null;
    // Clamp delta to reasonable range (-1 to +1)
    return Math.max(-1, Math.min(1, num));
  }

  /**
   * Save agent message to conversation history.
   * When tool call data is present, saves as a full turn (assistant + tool results).
   */
  private async saveAgentMessage(
    chatId: string,
    text: string,
    conversationStatus?: 'active' | 'awaiting_answer' | 'closed' | 'idle',
    channelMeta?: {
      channelMessageId?: string;
      channel?: string;
    }
  ): Promise<void> {
    if (!this.deps.conversationManager) return;

    try {
      // Only save the final response text - tool calls are internal to the agentic loop
      // This keeps conversation history clean: user messages, reactions, and assistant responses
      await this.deps.conversationManager.addMessage(
        chatId,
        {
          role: 'assistant',
          content: text,
        },
        channelMeta
      );

      // Use inline status if provided, otherwise fall back to LLM classification
      if (conversationStatus) {
        await this.deps.conversationManager.setStatus(chatId, conversationStatus);
      } else if (this.deps.messageComposer) {
        // Fallback: classify via separate LLM call (legacy path)
        const classification = await this.deps.messageComposer.classifyConversationStatus(text);
        await this.deps.conversationManager.setStatus(chatId, classification.status);
      }
    } catch (error) {
      this.deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error), chatId },
        'Failed to save agent message'
      );
    }
  }
}
