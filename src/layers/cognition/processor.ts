/**
 * COGNITION Layer Processor
 *
 * Processes aggregated signals using LLM with automatic smart retry.
 *
 * Like the prefrontal cortex:
 * - Conscious processing
 * - Decision making
 * - Uses fast model by default, smart model when confidence is low
 * - Only activated when AGGREGATION layer determines it's needed
 */

import type { CognitionLayer, CognitionContext, CognitionResult } from '../../types/layers.js';
import type { Signal } from '../../types/signal.js';
import type { Logger } from '../../types/logger.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { EventBus } from '../../core/event-bus.js';
import type { Agent } from '../../core/agent.js';
import type { LoopConfig } from '../../types/cognition.js';
import { emitTypingIndicator } from '../shared/index.js';

import type { AgenticLoop, LoopCallbacks } from './agentic-loop.js';
import {
  createAgenticLoop,
  type CognitionLLM,
  type LoopContext,
  type ConversationMessage,
} from './agentic-loop.js';
import type { Intent } from '../../types/intent.js';
import type { ToolRegistry } from './tools/registry.js';
import { createToolRegistry, type MemoryProvider, type MemoryEntry } from './tools/registry.js';
import type { SoulProvider, FullSoulState } from '../../storage/soul-provider.js';
import {
  processBatchReflection,
  shouldProcessBatch,
  performDeliberation,
  applyRevision,
  type ReflectionDeps,
} from './soul/index.js';
import type { PendingReflection } from '../../types/agent/soul.js';

/**
 * Configuration for COGNITION processor.
 */
export interface CognitionProcessorConfig {
  /** Agentic loop config */
  loopConfig: Partial<LoopConfig>;

  /** Emit typing indicator before LLM calls */
  emitTypingIndicator: boolean;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: CognitionProcessorConfig = {
  loopConfig: {},
  emitTypingIndicator: true,
};

/**
 * Dependencies for COGNITION processor.
 */
export interface CognitionProcessorDeps {
  conversationManager?: ConversationManager | undefined;
  userModel?: UserModel | undefined;
  eventBus?: EventBus | undefined;
  agent?: Agent | undefined;
  memoryProvider?: MemoryProvider | undefined;
  cognitionLLM?: CognitionLLM | undefined;
  /** Soul provider for identity awareness in system prompt */
  soulProvider?: SoulProvider | undefined;
  /**
   * Callback for immediate intent application during loop execution.
   * Used for REMEMBER and SET_INTEREST so data is visible to subsequent tools.
   */
  immediateIntentCallback?: ((intent: Intent) => void) | undefined;
}

/**
 * COGNITION layer processor implementation.
 */
export class CognitionProcessor implements CognitionLayer {
  readonly name = 'cognition' as const;

  private agenticLoop: AgenticLoop | undefined;
  private toolRegistry: ToolRegistry | undefined;
  private cognitionLLM: CognitionLLM | undefined;

  private readonly config: CognitionProcessorConfig;
  private readonly logger: Logger;

  private eventBus: EventBus | undefined;
  private agent: Agent | undefined;
  private conversationManager: ConversationManager | undefined;
  private userModel: UserModel | undefined;
  private memoryProvider: MemoryProvider | undefined;
  private soulProvider: SoulProvider | undefined;
  private immediateIntentCallback: ((intent: Intent) => void) | undefined;

  /**
   * Runtime-only timer for batch reflection processing.
   * NOT persisted - timer is rescheduled on startup based on batchWindowStartAt.
   */
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    logger: Logger,
    config: Partial<CognitionProcessorConfig> = {},
    deps?: CognitionProcessorDeps
  ) {
    this.logger = logger.child({ layer: 'cognition' });
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      loopConfig: { ...DEFAULT_CONFIG.loopConfig, ...config.loopConfig },
    };

    this.eventBus = deps?.eventBus;
    this.agent = deps?.agent;
    this.conversationManager = deps?.conversationManager;
    this.userModel = deps?.userModel;
    this.memoryProvider = deps?.memoryProvider;
    this.soulProvider = deps?.soulProvider;

    // Setup agentic loop if LLM available
    if (deps?.cognitionLLM) {
      this.setupAgenticLoop(deps.cognitionLLM, deps.memoryProvider);
    }
  }

  /**
   * Setup the agentic loop.
   */
  private setupAgenticLoop(llm: CognitionLLM, memoryProvider?: MemoryProvider): void {
    const agent = this.agent;
    const userModel = this.userModel;

    // Store LLM reference for compaction
    this.cognitionLLM = llm;

    this.toolRegistry = createToolRegistry(this.logger, {
      memoryProvider,
      agentStateProvider: agent
        ? { getState: () => agent.getState() as unknown as Record<string, unknown> }
        : undefined,
      userModelProvider: userModel ? { getModel: () => userModel.getBeliefs() } : undefined,
    });

    // Build callbacks for immediate intent processing
    const callbacks: LoopCallbacks | undefined = this.immediateIntentCallback
      ? { onImmediateIntent: this.immediateIntentCallback }
      : undefined;

    this.agenticLoop = createAgenticLoop(
      this.logger,
      llm,
      this.toolRegistry,
      this.config.loopConfig,
      callbacks
    );

    this.logger.info('Agentic loop initialized');
  }

  /**
   * Set dependencies after construction.
   */
  setDependencies(deps: CognitionProcessorDeps): void {
    if (deps.eventBus) {
      this.eventBus = deps.eventBus;
    }
    if (deps.agent) {
      this.agent = deps.agent;
    }
    if (deps.conversationManager) {
      this.conversationManager = deps.conversationManager;
    }
    if (deps.userModel) {
      this.userModel = deps.userModel;
    }
    if (deps.memoryProvider) {
      this.memoryProvider = deps.memoryProvider;
    }
    if (deps.soulProvider) {
      this.soulProvider = deps.soulProvider;
    }

    // Store immediate intent callback if provided
    const callbackChanged =
      deps.immediateIntentCallback !== undefined &&
      deps.immediateIntentCallback !== this.immediateIntentCallback;
    if (deps.immediateIntentCallback !== undefined) {
      this.immediateIntentCallback = deps.immediateIntentCallback;
    }

    // Setup agentic loop if we have LLM now, or recreate if callback changed
    if (deps.cognitionLLM && (!this.agenticLoop || callbackChanged)) {
      this.setupAgenticLoop(deps.cognitionLLM, deps.memoryProvider);
    }

    // Update tool registry dependencies
    if (this.toolRegistry) {
      const depsAgent = deps.agent;
      const depsUserModel = deps.userModel;
      this.toolRegistry.setDependencies({
        memoryProvider: deps.memoryProvider,
        agentStateProvider: depsAgent
          ? { getState: () => depsAgent.getState() as unknown as Record<string, unknown> }
          : undefined,
        userModelProvider: depsUserModel
          ? { getModel: () => depsUserModel.getBeliefs() }
          : undefined,
      });
    }

    this.logger.debug('COGNITION processor dependencies updated');
  }

  /**
   * Process aggregated context and decide on action.
   *
   * @param context Context from AGGREGATION layer
   * @returns Cognition result with response
   */
  async process(context: CognitionContext): Promise<CognitionResult> {
    if (!this.agenticLoop) {
      this.logger.error('Agentic loop not initialized');
      return {
        confidence: 0,
        intents: [],
      };
    }

    const startTime = Date.now();

    // Find the trigger signal (usually user_message)
    const triggerSignal = context.triggerSignals[0];
    if (!triggerSignal) {
      return {
        confidence: 1.0,
        intents: [],
      };
    }

    // Extract chat info
    const signalData = triggerSignal.data as
      | { recipientId?: string; userId?: string; channel?: string }
      | undefined;
    const recipientId = signalData?.recipientId;
    const channel = signalData?.channel ?? 'telegram';

    // Emit typing indicator only for user messages (not proactive triggers)
    // For proactive contact, we don't know if we'll respond until LLM decides
    const isUserMessage = triggerSignal.type === 'user_message';
    if (this.config.emitTypingIndicator && recipientId && channel && isUserMessage) {
      await this.emitTypingIndicatorEvent(recipientId, channel);
    }

    // Get agent identity
    const identity = this.agent?.getIdentity();

    // Get time since last message (for proactive contact context)
    const timeSinceLastMessageMs = await this.getTimeSinceLastMessage(recipientId);

    // Get completed actions (for autonomous triggers to prevent re-execution)
    const completedActions = await this.getCompletedActions(recipientId, triggerSignal.type);

    // Get recent thoughts for context priming
    const recentThoughts = await this.getRecentThoughts(recipientId);

    // Get soul state for identity awareness
    const soulState = await this.getSoulState();

    // Get unresolved soul tensions (for visibility in system prompt)
    const unresolvedTensions = await this.getUnresolvedTensions(recipientId);

    // Build loop context with runtime config
    const loopContext: LoopContext = {
      triggerSignal,
      agentState: context.agentState,
      agentIdentity: identity
        ? { name: identity.name, gender: identity.gender, values: identity.values }
        : undefined,
      conversationHistory: await this.getConversationHistory(recipientId),
      userModel: this.userModel?.getBeliefs() ?? {},
      tickId: context.tickId,
      recipientId,
      userId: signalData?.userId,
      timeSinceLastMessageMs,
      completedActions,
      recentThoughts: recentThoughts.length > 0 ? recentThoughts : undefined,
      soulState,
      unresolvedTensions: unresolvedTensions.length > 0 ? unresolvedTensions : undefined,
      runtimeConfig: {
        enableSmartRetry: context.runtimeConfig?.enableSmartRetry ?? true,
      },
      drainPendingUserMessages: context.drainPendingUserMessages,
    };

    // Run the agentic loop
    let loopResult;
    try {
      loopResult = await this.agenticLoop.run(loopContext);
    } catch (error) {
      // AgenticLoop threw an error - send generic error response
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error), recipientId },
        'COGNITION failed'
      );

      // Send error response to user if we have a recipient
      const errorIntents = recipientId
        ? [
            {
              type: 'SEND_MESSAGE' as const,
              payload: {
                recipientId,
                text: 'Извини, произошла ошибка. Попробуй ещё раз.',
              },
            },
          ]
        : [];

      return {
        confidence: 0,
        intents: errorIntents,
      };
    }

    const duration = Date.now() - startTime;

    this.logger.debug(
      {
        success: loopResult.success,
        terminalType: loopResult.terminal.type,
        intents: loopResult.intents.length,
        usedSmartRetry: loopResult.usedSmartRetry,
        duration,
      },
      'Agentic loop complete'
    );

    // Build result based on terminal state
    const confidence =
      loopResult.terminal.type === 'respond'
        ? loopResult.terminal.confidence
        : loopResult.success
          ? 0.8
          : 0.3;

    const result: CognitionResult = {
      confidence,
      intents: loopResult.intents,
    };

    if (loopResult.usedSmartRetry !== undefined) {
      result.usedSmartRetry = loopResult.usedSmartRetry;
    }

    if (loopResult.terminal.type === 'respond') {
      result.response = loopResult.terminal.text;

      // Trigger post-response reflection (non-blocking, fire-and-forget)
      // This checks if the response aligned with our self-model
      // Skip if no recipientId - thoughts need routing
      if (recipientId) {
        this.triggerReflectionIfEnabled(
          loopResult.terminal.text,
          triggerSignal,
          recipientId,
          context.tickId
        );
      }
    }

    // ACK all processed thought signals to prevent duplicate processing within session
    // Note: This is in-memory only and won't persist across restarts
    if (triggerSignal.type === 'thought') {
      result.intents.push({
        type: 'ACK_SIGNAL',
        payload: {
          signalId: triggerSignal.id,
          signalType: 'thought',
          reason: `Thought processed with terminal: ${loopResult.terminal.type}`,
        },
      });
      this.logger.debug(
        { thoughtId: triggerSignal.id, terminal: loopResult.terminal.type },
        'Thought processed, marking as handled'
      );
    }

    // Trigger compaction check (non-blocking, fire-and-forget)
    if (recipientId) {
      void this.triggerCompactionIfNeeded(recipientId);
    }

    return result;
  }

  /**
   * Check if conversation needs compaction and run if needed.
   */
  private async triggerCompactionIfNeeded(chatId: string): Promise<void> {
    if (!this.conversationManager || !this.cognitionLLM) {
      return;
    }

    try {
      if (!(await this.conversationManager.needsCompaction(chatId))) {
        return;
      }

      const toCompact = await this.conversationManager.getMessagesToCompact(chatId);
      if (toCompact.length === 0) {
        return;
      }

      const conversationText = toCompact.map((m) => `${m.role}: ${m.content ?? ''}`).join('\n');

      const summary = await this.cognitionLLM.complete({
        systemPrompt: 'You are a helpful assistant that summarizes conversations.',
        userPrompt: `Summarize the key facts from this conversation in 2-3 sentences:\n${conversationText}`,
      });
      await this.conversationManager.compact(chatId, summary);

      this.logger.info({ chatId, messageCount: toCompact.length }, 'Conversation compacted');
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), chatId },
        'Compaction failed'
      );
    }
  }

  /**
   * Get conversation history for context.
   * Returns proper OpenAI format with tool_calls preserved.
   */
  private async getConversationHistory(chatId?: string): Promise<ConversationMessage[]> {
    if (!chatId || !this.conversationManager) {
      return [];
    }

    try {
      const history = await this.conversationManager.getHistory(chatId, { maxRecentTurns: 10 });
      return history.map((msg): ConversationMessage => {
        const convMsg: ConversationMessage = {
          role: msg.role,
          content: msg.content,
        };
        // Only include optional fields when they have values (TypeScript exactOptionalPropertyTypes)
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          convMsg.tool_calls = msg.tool_calls;
        }
        if (msg.tool_call_id) {
          convMsg.tool_call_id = msg.tool_call_id;
        }
        return convMsg;
      });
    } catch (error) {
      this.logger.trace(
        { chatId, error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get conversation history, using empty'
      );
      return [];
    }
  }

  /**
   * Get time since last message in conversation.
   */
  private async getTimeSinceLastMessage(chatId?: string): Promise<number | undefined> {
    if (!chatId || !this.conversationManager) {
      return undefined;
    }

    try {
      const status = await this.conversationManager.getStatus(chatId);
      if (status.lastMessageAt) {
        return Date.now() - status.lastMessageAt.getTime();
      }
      return undefined;
    } catch (error) {
      this.logger.trace(
        { chatId, error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get conversation status for time since'
      );
      return undefined;
    }
  }

  /**
   * Get completed actions for preventing LLM re-execution.
   * Only fetched for non-user-message triggers (autonomous events).
   *
   * @param chatId Conversation ID
   * @param triggerType Type of trigger signal
   * @returns List of recent completed actions, or undefined
   */
  private async getCompletedActions(
    chatId?: string,
    triggerType?: string
  ): Promise<{ tool: string; summary: string; timestamp: string }[] | undefined> {
    // Only fetch for non-user-message triggers
    // User messages start fresh conversation turns
    if (triggerType === 'user_message') {
      return undefined;
    }

    if (!chatId || !this.conversationManager) {
      return undefined;
    }

    try {
      const actions = await this.conversationManager.getRecentActions(chatId);
      return actions.length > 0 ? actions : undefined;
    } catch (error) {
      this.logger.trace(
        { chatId, error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get completed actions'
      );
      return undefined;
    }
  }

  /**
   * Get recent thoughts for context priming.
   * Returns thoughts from the last 30 minutes for the agent to consider.
   */
  private async getRecentThoughts(
    recipientId?: string
  ): Promise<{ id: string; type: 'thought'; content: string; timestamp: Date }[]> {
    if (!this.memoryProvider) {
      return [];
    }

    try {
      const thoughts = await this.memoryProvider.getRecentByType('thought', {
        recipientId,
        windowMs: 30 * 60 * 1000, // 30 minutes
        limit: 10,
      });
      return thoughts.map((t) => ({
        id: t.id,
        type: 'thought' as const,
        content: t.content,
        timestamp: t.timestamp,
      }));
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get recent thoughts'
      );
      return [];
    }
  }

  /**
   * Get unresolved soul tensions (soul:reflection + state:unresolved thoughts).
   * Returns thoughts sorted by dissonance (highest first), limited to 3.
   */
  private async getUnresolvedTensions(
    recipientId?: string
  ): Promise<{ id: string; content: string; dissonance: number; timestamp: Date }[]> {
    if (!this.memoryProvider) {
      return [];
    }

    try {
      // Get recent thoughts (1 week window for unresolved tensions)
      const thoughts = await this.memoryProvider.getRecentByType('thought', {
        recipientId,
        windowMs: 7 * 24 * 60 * 60 * 1000, // 1 week
        limit: 50,
      });

      // Filter for soul:reflection + state:unresolved
      const unresolvedTensions = thoughts.filter((t) => {
        if (!t.tags) return false;
        return t.tags.includes('soul:reflection') && t.tags.includes('state:unresolved');
      });

      // Sort by dissonance (highest first) and limit to 3
      return unresolvedTensions
        .map((t) => ({
          id: t.id,
          content: t.content,
          dissonance: (t.metadata?.['dissonance'] as number | undefined) ?? 7,
          timestamp: t.timestamp,
        }))
        .sort((a, b) => b.dissonance - a.dissonance)
        .slice(0, 3);
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get unresolved tensions'
      );
      return [];
    }
  }

  /**
   * Get full MemoryEntry objects for unresolved soul tensions.
   * Used by Parliament deliberation which needs the full thought object.
   */
  private async getFullUnresolvedThoughts(recipientId?: string): Promise<MemoryEntry[]> {
    if (!this.memoryProvider) {
      return [];
    }

    try {
      const thoughts = await this.memoryProvider.getRecentByType('thought', {
        recipientId,
        windowMs: 7 * 24 * 60 * 60 * 1000, // 1 week
        limit: 50,
      });

      return thoughts.filter((t) => {
        if (!t.tags) return false;
        return t.tags.includes('soul:reflection') && t.tags.includes('state:unresolved');
      });
    } catch {
      return [];
    }
  }

  /**
   * Get soul state for identity awareness in system prompt.
   * Returns undefined if soul provider not configured (graceful degradation).
   */
  private async getSoulState(): Promise<FullSoulState | undefined> {
    if (!this.soulProvider) {
      return undefined;
    }

    try {
      return await this.soulProvider.getState();
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : 'Unknown' },
        'Failed to get soul state'
      );
      return undefined;
    }
  }

  /**
   * Trigger post-response reflection if soul system is enabled.
   * Non-blocking - queues for batch processing and logs any errors.
   *
   * Responses are queued and processed together after a 30s window or
   * when 10 items accumulate. This enables pattern recognition and
   * reduces token overhead.
   */
  private triggerReflectionIfEnabled(
    responseText: string,
    triggerSignal: Signal,
    recipientId: string,
    tickId: string
  ): void {
    // Skip if soul system not configured
    if (!this.soulProvider || !this.cognitionLLM || !this.memoryProvider) {
      return;
    }

    // Build trigger summary for context
    const triggerSummary = this.buildTriggerSummary(triggerSignal);

    const pendingReflection: PendingReflection = {
      responseText,
      triggerSummary,
      recipientId,
      tickId,
      timestamp: new Date(),
    };

    // Enqueue and schedule batch processing (fire and forget)
    this.enqueueAndScheduleBatch(pendingReflection).catch((error: unknown) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Reflection enqueue failed'
      );
    });
  }

  /**
   * Enqueue a pending reflection and schedule batch processing if needed.
   */
  private async enqueueAndScheduleBatch(item: PendingReflection): Promise<void> {
    if (!this.soulProvider) return;

    const wasEmpty = await this.soulProvider.enqueuePendingReflection(item);

    // Schedule timer if this was the first item and no timer running
    if (wasEmpty && !this.batchTimer) {
      this.scheduleBatchTimer(30_000);
    }

    // Check if size threshold reached (immediate processing)
    const deps = this.getReflectionDeps();
    if (deps && (await shouldProcessBatch(deps))) {
      this.clearBatchTimer();
      await this.processBatchReflectionNow();
    }
  }

  /**
   * Schedule the batch timer to fire after the given delay.
   */
  private scheduleBatchTimer(delayMs: number): void {
    this.clearBatchTimer();
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.processBatchReflectionNow().catch((error: unknown) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Batch reflection processing failed'
        );
      });
    }, delayMs);

    this.logger.debug({ delayMs }, 'Batch timer scheduled');
  }

  /**
   * Clear the batch timer if running.
   */
  private clearBatchTimer(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Process batch reflection now.
   */
  private async processBatchReflectionNow(): Promise<void> {
    const deps = this.getReflectionDeps();
    if (!deps) return;

    await processBatchReflection(deps);
  }

  /**
   * Get reflection dependencies if all are available.
   */
  private getReflectionDeps(): ReflectionDeps | null {
    if (!this.soulProvider || !this.cognitionLLM || !this.memoryProvider) {
      return null;
    }
    return {
      logger: this.logger,
      soulProvider: this.soulProvider,
      memoryProvider: this.memoryProvider,
      llm: this.cognitionLLM,
    };
  }

  /**
   * Initialize batch reflection on startup.
   *
   * Recovers any stale in-flight batches and schedules timer
   * for pending items based on elapsed window time.
   *
   * Should be called after all dependencies are set.
   */
  async initializeBatchReflection(): Promise<void> {
    if (!this.soulProvider) return;

    try {
      // Recover any stale batches (crash recovery)
      const recovered = await this.soulProvider.recoverStaleBatch();
      if (recovered.length > 0) {
        this.logger.info({ itemCount: recovered.length }, 'Recovered stale batch items');
      }

      // Check if we have pending items that need scheduling
      const state = await this.soulProvider.getState();
      if (state.pendingReflections.length > 0 && state.batchWindowStartAt) {
        const elapsed = Date.now() - state.batchWindowStartAt.getTime();

        if (elapsed >= 30_000) {
          // Window already expired, process immediately
          this.logger.debug('Window expired on startup, processing immediately');
          await this.processBatchReflectionNow();
        } else {
          // Schedule for remaining time
          const remainingMs = 30_000 - elapsed;
          this.logger.debug({ remainingMs }, 'Scheduling batch timer for remaining window');
          this.scheduleBatchTimer(remainingMs);
        }
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Batch reflection initialization failed'
      );
    }
  }

  /**
   * Trigger Parliament deliberation if soul system is enabled and conditions are met.
   *
   * This processes unresolved soul:reflection thoughts through Parliament deliberation,
   * potentially leading to soul changes (care nudges, expectations, precedents).
   *
   * Conditions:
   * - Soul system configured
   * - Unresolved soul:reflection thoughts exist
   * - Deliberation budget allows (cooldown + daily limit)
   *
   * @param recipientId Recipient ID for creating resolution thoughts
   * @param tickId Tick ID for tracing
   * @returns True if deliberation was performed
   */
  async triggerParliamentIfEnabled(recipientId: string, tickId: string): Promise<boolean> {
    // Skip if soul system not configured
    if (!this.soulProvider || !this.cognitionLLM || !this.memoryProvider) {
      return false;
    }

    // Check if deliberation is allowed (cooldown + daily limit)
    if (!(await this.soulProvider.canDeliberate())) {
      this.logger.trace('Parliament skipped: cooldown or daily limit');
      return false;
    }

    // Get unresolved soul thoughts (full MemoryEntry for deliberation)
    const thoughts = await this.getFullUnresolvedThoughts(recipientId);
    if (thoughts.length === 0) {
      this.logger.trace('Parliament skipped: no unresolved tensions');
      return false;
    }

    // Take the oldest unresolved thought (FIFO processing)
    const thought = thoughts[thoughts.length - 1];
    if (!thought) {
      return false;
    }

    // Check token budget
    const DELIBERATION_TOKENS = 800;
    if (!(await this.soulProvider.canAfford(DELIBERATION_TOKENS))) {
      this.logger.trace('Parliament skipped: insufficient token budget');
      return false;
    }

    const soulState = await this.soulProvider.getState();

    this.logger.info({ thoughtId: thought.id }, 'Triggering Parliament deliberation');

    try {
      // Perform deliberation
      const deliberationResult = await performDeliberation(
        { logger: this.logger, llm: this.cognitionLLM },
        { thought, soulState }
      );

      if (!deliberationResult.success || !deliberationResult.deliberation) {
        this.logger.warn('Parliament deliberation failed');
        return false;
      }

      // Record deliberation in budget
      await this.soulProvider.recordDeliberation();
      await this.soulProvider.deductTokens(DELIBERATION_TOKENS);

      // Store deliberation record
      await this.soulProvider.addDeliberation(deliberationResult.deliberation);

      // Apply revision (changes + resolution)
      const revisionResult = await applyRevision(
        {
          logger: this.logger,
          soulProvider: this.soulProvider,
          memoryProvider: this.memoryProvider,
        },
        {
          deliberation: deliberationResult.deliberation,
          originalThought: thought,
          recipientId,
          tickId,
        }
      );

      if (revisionResult.success) {
        this.logger.info(
          {
            deliberationId: deliberationResult.deliberation.id,
            changesApplied: revisionResult.changesApplied,
          },
          'Parliament deliberation completed successfully'
        );
      }

      return revisionResult.success;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Parliament deliberation failed unexpectedly'
      );
      return false;
    }
  }

  /**
   * Build a human-readable summary of the trigger signal.
   */
  private buildTriggerSummary(signal: Signal): string {
    const data = signal.data as Record<string, unknown> | undefined;

    if (signal.type === 'user_message' && data) {
      const text = (data['text'] as string | undefined) ?? '';
      return `User message: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`;
    }

    if (signal.type === 'thought' && data) {
      const content = (data['content'] as string | undefined) ?? '';
      return `Thought: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`;
    }

    if (signal.type === 'threshold_crossed' && data) {
      const thresholdName = (data['thresholdName'] as string | undefined) ?? 'unknown';
      return `Threshold crossed: ${thresholdName}`;
    }

    return `Signal: ${signal.type}`;
  }

  /**
   * Emit typing indicator event.
   */
  private async emitTypingIndicatorEvent(chatId: string, channel: string): Promise<void> {
    await emitTypingIndicator(this.eventBus, chatId, channel, this.logger);
  }

  /**
   * Reset the processor state.
   */
  reset(): void {
    this.logger.debug('COGNITION processor reset');
  }

  /**
   * Get the tool registry for dynamic tool registration.
   */
  getToolRegistry(): ToolRegistry {
    this.toolRegistry ??= createToolRegistry(this.logger);
    return this.toolRegistry;
  }
}

/**
 * Create a COGNITION processor.
 */
export function createCognitionProcessor(
  logger: Logger,
  config?: Partial<CognitionProcessorConfig>,
  deps?: CognitionProcessorDeps
): CognitionProcessor {
  return new CognitionProcessor(logger, config, deps);
}
