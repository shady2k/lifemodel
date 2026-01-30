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
import type { Logger } from '../../types/logger.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { EventBus } from '../../core/event-bus.js';
import type { Agent } from '../../core/agent.js';
import type { LoopConfig } from '../../types/cognition.js';
import { emitTypingIndicator } from '../shared/index.js';

import type { AgenticLoop } from './agentic-loop.js';
import {
  createAgenticLoop,
  type CognitionLLM,
  type LoopContext,
  type ConversationMessage,
} from './agentic-loop.js';
import type { ToolRegistry } from './tools/registry.js';
import { createToolRegistry, type MemoryProvider } from './tools/registry.js';

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

    this.agenticLoop = createAgenticLoop(
      this.logger,
      llm,
      this.toolRegistry,
      this.config.loopConfig
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

    // Setup agentic loop if we have LLM now
    if (deps.cognitionLLM && !this.agenticLoop) {
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

    // Build loop context with runtime config
    const loopContext: LoopContext = {
      triggerSignal,
      agentState: context.agentState,
      agentIdentity: identity
        ? { name: identity.name, gender: identity.gender, values: identity.values }
        : undefined,
      conversationHistory: await this.getConversationHistory(recipientId),
      userModel: this.userModel?.getBeliefs() ?? {},
      correlationId: context.correlationId,
      recipientId,
      userId: signalData?.userId,
      timeSinceLastMessageMs,
      runtimeConfig: {
        enableSmartRetry: context.runtimeConfig?.enableSmartRetry ?? true,
      },
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

      const conversationText = toCompact.map((m) => `${m.role}: ${m.content}`).join('\n');

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
   */
  private async getConversationHistory(chatId?: string): Promise<ConversationMessage[]> {
    if (!chatId || !this.conversationManager) {
      return [];
    }

    try {
      const history = await this.conversationManager.getHistory(chatId, { maxRecent: 10 });
      return history.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));
    } catch {
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
    } catch {
      return undefined;
    }
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
