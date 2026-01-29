/**
 * COGNITION Layer Processor
 *
 * Processes aggregated signals using fast LLM.
 * Decides actions or escalates to SMART when uncertain.
 *
 * Like the prefrontal cortex:
 * - Conscious processing
 * - Decision making
 * - Only activated when AGGREGATION layer determines it's needed
 *
 * Supports two modes:
 * - Legacy: ThoughtSynthesizer + ActionDecider (simpler, single LLM call)
 * - Agentic: Full agentic loop with tools (multiple LLM calls, more capable)
 */

import type {
  CognitionLayer,
  CognitionContext,
  CognitionResult,
  SmartContext,
} from '../../types/layers.js';
import type { Intent } from '../../types/intent.js';
import type { Logger } from '../../types/logger.js';
import type { MessageComposer } from '../../llm/composer.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { EventBus } from '../../core/event-bus.js';
import type { Agent } from '../../core/agent.js';
import type { LoopConfig } from '../../types/cognition.js';
import { emitTypingIndicator } from '../shared/index.js';

import type { ThoughtSynthesizer } from './thought-synthesizer.js';
import { createThoughtSynthesizer, type ThoughtSynthesizerConfig } from './thought-synthesizer.js';
import type { ActionDecider } from './action-decider.js';
import { createActionDecider, type ActionDeciderConfig } from './action-decider.js';
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
  /** Use agentic loop instead of legacy mode */
  useAgenticLoop: boolean;

  /** Thought synthesizer config (legacy mode) */
  synthesizer: Partial<ThoughtSynthesizerConfig>;

  /** Action decider config (legacy mode) */
  decider: Partial<ActionDeciderConfig>;

  /** Agentic loop config */
  loopConfig: Partial<LoopConfig>;

  /** Emit typing indicator before LLM calls */
  emitTypingIndicator: boolean;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: CognitionProcessorConfig = {
  useAgenticLoop: true,
  synthesizer: {},
  decider: {},
  loopConfig: {},
  emitTypingIndicator: true,
};

/**
 * Dependencies for COGNITION processor.
 */
export interface CognitionProcessorDeps {
  composer?: MessageComposer | undefined;
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

  // Legacy mode components
  private readonly synthesizer: ThoughtSynthesizer;
  private readonly decider: ActionDecider;

  // Agentic mode components
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
      synthesizer: { ...DEFAULT_CONFIG.synthesizer, ...config.synthesizer },
      decider: { ...DEFAULT_CONFIG.decider, ...config.decider },
      loopConfig: { ...DEFAULT_CONFIG.loopConfig, ...config.loopConfig },
    };

    // Legacy mode setup
    this.synthesizer = createThoughtSynthesizer(this.logger, this.config.synthesizer);
    this.decider = createActionDecider(this.logger, this.config.decider, {
      composer: deps?.composer,
      conversationManager: deps?.conversationManager,
      userModel: deps?.userModel,
    });

    this.eventBus = deps?.eventBus;
    this.agent = deps?.agent;
    this.conversationManager = deps?.conversationManager;
    this.userModel = deps?.userModel;

    // Agentic mode setup
    if (this.config.useAgenticLoop && deps?.cognitionLLM) {
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
    // Legacy mode
    this.decider.setDependencies({
      composer: deps.composer,
      conversationManager: deps.conversationManager,
      userModel: deps.userModel,
    });

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

    // Agentic mode - setup if we have LLM now
    if (this.config.useAgenticLoop && deps.cognitionLLM && !this.agenticLoop) {
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
   * @returns Cognition result with response or escalation
   */
  async process(context: CognitionContext): Promise<CognitionResult> {
    // Use agentic loop if enabled and available
    if (this.config.useAgenticLoop && this.agenticLoop) {
      return this.processAgentic(context);
    }

    // Legacy mode
    return this.processLegacy(context);
  }

  /**
   * Process using the agentic loop (new mode).
   */
  private async processAgentic(context: CognitionContext): Promise<CognitionResult> {
    const startTime = Date.now();

    // Find the trigger signal (usually user_message)
    const triggerSignal = context.triggerSignals[0];
    if (!triggerSignal) {
      return {
        escalateToSmart: false,
        confidence: 1.0,
        intents: [],
      };
    }

    // Extract chat info
    const signalData = triggerSignal.data as
      | { chatId?: string; userId?: string; channel?: string }
      | undefined;
    const chatId = signalData?.chatId;
    const channel = signalData?.channel ?? 'telegram';

    // Emit typing indicator only for user messages (not proactive triggers)
    // For proactive contact, we don't know if we'll respond until LLM decides
    const isUserMessage = triggerSignal.type === 'user_message';
    if (this.config.emitTypingIndicator && chatId && channel && isUserMessage) {
      await this.emitTypingIndicatorEvent(chatId, channel);
    }

    // Get agent identity
    const identity = this.agent?.getIdentity();

    // Get time since last message (for proactive contact context)
    const timeSinceLastMessageMs = await this.getTimeSinceLastMessage(chatId);

    // Build loop context
    const loopContext: LoopContext = {
      triggerSignal,
      agentState: context.agentState,
      agentIdentity: identity
        ? { name: identity.name, gender: identity.gender, values: identity.values }
        : undefined,
      conversationHistory: await this.getConversationHistory(chatId),
      userModel: this.userModel?.getBeliefs() ?? {},
      correlationId: context.correlationId,
      chatId,
      userId: signalData?.userId,
      timeSinceLastMessageMs,
    };

    // Run the agentic loop (we know it exists because processAgentic is only called when agenticLoop is set)
    const agenticLoop = this.agenticLoop;
    if (!agenticLoop) {
      throw new Error('Agentic loop not initialized');
    }
    const loopResult = await agenticLoop.run(loopContext);

    const duration = Date.now() - startTime;

    this.logger.debug(
      {
        success: loopResult.success,
        terminalType: loopResult.terminal.type,
        steps: loopResult.steps.length,
        intents: loopResult.intents.length,
        pendingEscalation: loopResult.pendingEscalation.length,
        duration,
      },
      'Agentic loop complete'
    );

    // Build result based on terminal state
    const result: CognitionResult = {
      escalateToSmart: loopResult.terminal.type === 'escalate',
      confidence: loopResult.success ? 0.8 : 0.3,
      intents: loopResult.intents,
    };

    if (loopResult.terminal.type === 'respond') {
      result.response = loopResult.terminal.text;
    }

    if (loopResult.terminal.type === 'escalate') {
      result.escalationReason = loopResult.terminal.reason;
      result.smartContext = this.buildSmartContext(context, loopResult);
    }

    // Handle pending escalation (low confidence updates)
    if (loopResult.pendingEscalation.length > 0) {
      this.logger.debug(
        { pendingSteps: loopResult.pendingEscalation.length },
        'Some steps need SMART confirmation'
      );
      // TODO: Could escalate or store for later review
    }

    // Trigger compaction check (non-blocking, fire-and-forget)
    if (chatId) {
      void this.triggerCompactionIfNeeded(chatId);
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

      const prompt = `Summarize the key facts from this conversation in 2-3 sentences:\n${toCompact.map((m) => `${m.role}: ${m.content}`).join('\n')}`;

      const summary = await this.cognitionLLM.complete(prompt);
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
   * Process using legacy mode (ThoughtSynthesizer + ActionDecider).
   */
  private async processLegacy(context: CognitionContext): Promise<CognitionResult> {
    const startTime = Date.now();

    // 1. Synthesize understanding
    const synthesis = this.synthesizer.synthesize(context);

    this.logger.debug(
      {
        situation: synthesis.situation,
        requiresResponse: synthesis.requiresResponse,
        initiateContact: synthesis.initiateContact,
        summary: synthesis.summary,
      },
      'Thought synthesis complete'
    );

    // 2. Emit typing indicator if responding to user message
    if (
      this.config.emitTypingIndicator &&
      synthesis.situation === 'user_message' &&
      synthesis.chatId &&
      synthesis.channel
    ) {
      await this.emitTypingIndicatorEvent(synthesis.chatId, synthesis.channel);
    }

    // 3. Decide action
    const decision = await this.decider.decide(synthesis, context);

    const duration = Date.now() - startTime;

    this.logger.debug(
      {
        action: decision.action,
        escalateToSmart: decision.escalateToSmart,
        confidence: decision.confidence,
        hasResponse: !!decision.response,
        duration,
      },
      'COGNITION tick complete'
    );

    // 4. Build result
    const result: CognitionResult = {
      escalateToSmart: decision.escalateToSmart,
      confidence: decision.confidence,
      intents: decision.intents,
    };

    if (decision.escalationReason) {
      result.escalationReason = decision.escalationReason;
    }

    if (decision.response) {
      result.response = decision.response;
    }

    if (decision.smartContext) {
      result.smartContext = decision.smartContext;
    }

    // Add send_message intent if we have a response
    if (decision.response && decision.chatId && decision.channel) {
      result.intents.push(
        this.buildSendMessageIntent(decision.response, decision.chatId, decision.channel)
      );
    }

    return result;
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
   * Build SMART context from agentic loop result.
   */
  private buildSmartContext(
    context: CognitionContext,
    loopResult: { terminal: { type: string; reason?: string; parentId?: string }; steps: unknown[] }
  ): SmartContext {
    return {
      cognitionContext: context,
      escalationReason:
        loopResult.terminal.type === 'escalate'
          ? (loopResult.terminal.reason ?? 'Unknown')
          : 'Escalated',
      partialAnalysis: `COGNITION completed ${String(loopResult.steps.length)} steps before escalating`,
    };
  }

  /**
   * Build a send_message intent.
   */
  private buildSendMessageIntent(message: string, chatId: string, channel: string): Intent {
    return {
      type: 'SEND_MESSAGE',
      payload: {
        text: message,
        target: chatId,
        channel,
      },
    };
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
   * Creates a default registry if not in agentic mode.
   */
  getToolRegistry(): ToolRegistry {
    // Create a minimal registry for tool registration if not in agentic mode
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
