import { Bot } from 'grammy';
import type { Context } from 'grammy';
import type { MessageReactionUpdated } from 'grammy/types';
import type { Logger, Signal } from '../../types/index.js';
import { createUserMessageSignal, createMessageReactionSignal } from '../../types/index.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { createCircuitBreaker } from '../../core/circuit-breaker.js';
import type { Channel, CircuitStats, SendOptions, SendResult } from '../../channels/channel.js';
import type { IRecipientRegistry } from '../../core/recipient-registry.js';

/**
 * Telegram message payload structure.
 */
export interface TelegramMessagePayload {
  /** Telegram user ID as string */
  userId: string;
  /** Telegram chat ID as string */
  chatId: string;
  /** Message text content */
  text: string;
  /** Telegram message ID */
  messageId: number;
  /** User's Telegram username (if available) */
  username: string | undefined;
  /** User's first name */
  firstName: string | undefined;
  /** User's last name (if available) */
  lastName: string | undefined;
}

/**
 * Telegram channel configuration.
 */
export interface TelegramConfig {
  /** Bot token from BotFather (required) */
  botToken: string;
  /** Chat IDs allowed to interact with the bot (empty = allow all) */
  allowedChatIds?: string[];
  /** API request timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retries for retryable errors (default: 2) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 1000) */
  retryDelay?: number;
}

const DEFAULT_CONFIG = {
  timeout: 30_000,
  maxRetries: 2,
  retryDelay: 1000,
};

/**
 * Telegram channel error.
 */
export class TelegramError extends Error {
  readonly channelName = 'telegram';
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options?: {
      retryable?: boolean;
      statusCode?: number;
    }
  ) {
    super(message);
    this.name = 'TelegramError';
    this.retryable = options?.retryable ?? false;
    this.statusCode = options?.statusCode;
  }
}

/**
 * Telegram channel using grammY.
 *
 * Provides bidirectional communication:
 * - Inbound: Telegram messages → Events pushed to EventQueue
 * - Outbound: SEND_MESSAGE intents → Telegram Bot API
 *
 * Features:
 * - Circuit breaker for resilience (3 failures → open, 60s reset)
 * - Retry logic (2 retries with exponential backoff)
 * - Graceful start/stop
 */
export class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private readonly config: Required<Pick<TelegramConfig, 'timeout' | 'maxRetries' | 'retryDelay'>> &
    TelegramConfig;
  private readonly logger: Logger | undefined;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly recipientRegistry: IRecipientRegistry;
  private bot: Bot | null = null;
  private running = false;
  private wakeUpCallback: (() => void) | null = null;
  private signalCallback: ((signal: Signal) => void) | null = null;

  constructor(
    config: TelegramConfig,
    logger: Logger | undefined,
    recipientRegistry: IRecipientRegistry
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger ? logger.child({ component: 'telegram' }) : undefined;
    this.recipientRegistry = recipientRegistry;

    const circuitConfig: Parameters<typeof createCircuitBreaker>[0] = {
      name: 'telegram',
      maxFailures: 3,
      resetTimeout: 60_000, // 1 minute
      timeout: this.config.timeout,
    };
    if (this.logger) {
      circuitConfig.logger = this.logger;
    }
    this.circuitBreaker = createCircuitBreaker(circuitConfig);
  }

  /**
   * Check if channel is configured.
   */
  isAvailable(): boolean {
    return Boolean(this.config.botToken);
  }

  /**
   * Set callback to wake up the event loop when messages arrive.
   * This allows immediate processing instead of waiting for next tick.
   */
  setWakeUpCallback(callback: () => void): void {
    this.wakeUpCallback = callback;
  }

  /**
   * Set callback to push signals to CoreLoop (4-layer architecture).
   * When set, incoming messages will be converted to Signals instead of Events.
   */
  setSignalCallback(callback: (signal: Signal) => void): void {
    this.signalCallback = callback;
  }

  /**
   * Start the Telegram bot (begin polling).
   */
  start(): Promise<void> {
    if (!this.isAvailable()) {
      this.logger?.warn('Telegram bot token not configured, skipping start');
      return Promise.resolve();
    }

    if (this.running) {
      this.logger?.warn('Telegram channel already running');
      return Promise.resolve();
    }

    this.bot = new Bot(this.config.botToken);

    // Handle text messages
    this.bot.on('message:text', (ctx) => {
      this.onMessage(ctx);
    });

    // Handle message reactions (non-verbal feedback)
    this.bot.on('message_reaction', (ctx: Context) => {
      this.onReaction(ctx);
    });

    // Handle errors
    this.bot.catch((err) => {
      this.logger?.error({ error: err }, 'Telegram bot error');
    });

    // Start polling (non-blocking)
    // CRITICAL: Enable message_reaction in allowed_updates for reaction events
    this.running = true;
    void this.bot.start({
      allowed_updates: ['message', 'message_reaction'],
      onStart: () => {
        this.logger?.info('Telegram channel started');
      },
    });

    return Promise.resolve();
  }

  /**
   * Stop the Telegram bot.
   */
  async stop(): Promise<void> {
    if (!this.running || !this.bot) {
      return;
    }

    this.running = false;
    await this.bot.stop();
    this.bot = null;
    this.logger?.info('Telegram channel stopped');
  }

  /**
   * Send a message via Telegram.
   *
   * Uses circuit breaker and retry logic for resilience.
   *
   * @param target - Chat ID to send to
   * @param text - Message text
   * @param options - Send options
   * @returns Result with success status and message ID
   */
  async sendMessage(target: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.isAvailable()) {
      this.logger?.warn('Cannot send message: Telegram not configured');
      return { success: false };
    }

    if (!this.bot) {
      this.logger?.warn('Cannot send message: Telegram bot not started');
      return { success: false };
    }

    try {
      let messageId: string | undefined;
      await this.circuitBreaker.execute(async () => {
        await this.executeWithRetry(async () => {
          messageId = await this.doSendMessage(target, text, options);
        });
      });

      this.logger?.debug({ chatId: target, textLength: text.length, messageId }, 'Message sent');
      // Only include messageId if it was successfully captured
      const result: SendResult = { success: true };
      if (messageId) {
        result.messageId = messageId;
      }
      return result;
    } catch (error) {
      this.logger?.error({ error, chatId: target }, 'Failed to send message');
      return { success: false };
    }
  }

  /**
   * Get circuit breaker statistics.
   */
  getCircuitStats(): CircuitStats {
    return this.circuitBreaker.getStats();
  }

  /**
   * Send typing indicator to show the bot is preparing a response.
   */
  async sendTyping(target: string): Promise<void> {
    if (!this.bot) {
      return;
    }

    const chatId = parseInt(target, 10);
    if (isNaN(chatId)) {
      return;
    }

    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
      this.logger?.debug({ chatId: target }, 'Typing indicator sent');
    } catch (error) {
      // Don't fail if typing indicator fails - it's not critical
      this.logger?.debug(
        { chatId: target, error: error instanceof Error ? error.message : String(error) },
        'Failed to send typing indicator'
      );
    }
  }

  /**
   * Handle incoming message - convert to Signal and dispatch.
   */
  private onMessage(ctx: {
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    chat: { id: number };
    message: { message_id: number; text?: string };
  }): void {
    if (!ctx.from || !ctx.message.text) {
      return;
    }

    const chatId = ctx.chat.id.toString();

    // Filter by allowed chat IDs if configured
    const allowedChatIds = this.config.allowedChatIds;
    if (allowedChatIds && allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
      this.logger?.debug({ chatId, allowedChatIds }, 'Ignoring message from non-allowed chat ID');
      return;
    }

    const userId = ctx.from.id.toString();
    const destination = chatId;
    const text = ctx.message.text;
    const recipientId = this.recipientRegistry.getOrCreate(this.name, destination);

    if (this.signalCallback) {
      const signal = createUserMessageSignal({
        text,
        channel: 'telegram',
        userId,
        recipientId,
      });
      this.signalCallback(signal);

      this.logger?.debug(
        {
          signalId: signal.id,
          userId,
          recipientId,
          textLength: text.length,
        },
        'Message received as Signal'
      );
    }

    if (this.wakeUpCallback) {
      this.wakeUpCallback();
    }
  }

  /**
   * Handle incoming reaction using grammy's ctx.reactions() helper.
   */
  private onReaction(ctx: Context): void {
    const update: MessageReactionUpdated | undefined = ctx.messageReaction;
    if (!update) return;

    const chatId = update.chat.id.toString();

    // Apply allowedChatIds filter (same as onMessage)
    if (this.config.allowedChatIds?.length && !this.config.allowedChatIds.includes(chatId)) {
      this.logger?.debug({ chatId }, 'Ignoring reaction from non-allowed chat');
      return;
    }

    // Use grammy's diff helper (handles arrays internally)
    // Note: We only process emojiAdded - removals don't provide useful feedback
    const { emojiAdded } = ctx.reactions();

    // Process added emoji reactions (custom emoji and paid skipped in MVP)
    for (const emoji of emojiAdded) {
      this.processReaction(
        chatId,
        update.message_id,
        emoji,
        update.user?.id,
        update.actor_chat?.id
      );
    }
  }

  /**
   * Process a single reaction and emit signal.
   */
  private processReaction(
    chatId: string,
    messageId: number,
    emoji: string,
    fromUserId?: number,
    actorChatId?: number
  ): void {
    const recipientId = this.recipientRegistry.getOrCreate(this.name, chatId);

    // Create signal - preview will be enriched by CoreLoop via conversation history lookup
    // No sentiment classification - LLM interprets emoji naturally
    // Build params object to avoid passing undefined for optional fields
    const signalParams: Parameters<typeof createMessageReactionSignal>[0] = {
      emoji,
      reactedMessageId: messageId.toString(),
      recipientId,
    };
    // Only add optional fields if they have values (exactOptionalPropertyTypes)
    if (fromUserId !== undefined) {
      signalParams.userId = fromUserId.toString();
    }
    if (actorChatId !== undefined) {
      signalParams.actorChatId = actorChatId.toString();
    }

    const signal = createMessageReactionSignal(signalParams);

    this.signalCallback?.(signal);
    this.wakeUpCallback?.();

    this.logger?.debug(
      {
        signalId: signal.id,
        emoji,
        messageId,
        recipientId,
        isAnonymous: !fromUserId && !!actorChatId,
      },
      'Reaction received as Signal'
    );
  }

  /**
   * Execute with retry logic.
   */
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Extract error details for logging
        const errorInfo = this.extractErrorInfo(error);

        if (error instanceof TelegramError && !error.retryable) {
          this.logger?.error(errorInfo, 'Non-retryable Telegram error');
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          this.logger?.warn(
            {
              attempt: attempt + 1,
              maxRetries: this.config.maxRetries,
              ...errorInfo,
            },
            'Retrying after transient error'
          );
          await this.sleep(this.config.retryDelay * (attempt + 1));
        } else {
          // Final attempt failed
          this.logger?.error(
            {
              attempts: this.config.maxRetries + 1,
              ...errorInfo,
            },
            'All retry attempts exhausted'
          );
        }
      }
    }

    throw lastError ?? new Error('Unknown error');
  }

  /**
   * Extract error information for logging.
   */
  private extractErrorInfo(error: unknown): Record<string, unknown> {
    if (error instanceof TelegramError) {
      return {
        errorType: 'TelegramError',
        message: error.message,
        statusCode: error.statusCode,
        retryable: error.retryable,
      };
    }
    if (error instanceof Error) {
      return {
        errorType: error.name,
        message: error.message,
      };
    }
    return {
      errorType: 'unknown',
      message: String(error),
    };
  }

  /**
   * Perform the actual send message request.
   * @returns The Telegram message ID as a string
   */
  private async doSendMessage(
    target: string,
    text: string,
    options?: SendOptions
  ): Promise<string> {
    if (!this.bot) {
      throw new TelegramError('Bot not initialized');
    }

    const chatId = parseInt(target, 10);
    if (isNaN(chatId)) {
      throw new TelegramError(`Invalid chat ID: ${target}`, { retryable: false });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.timeout);

    try {
      // Build options object conditionally to avoid undefined values
      const sendOptions: Parameters<typeof this.bot.api.sendMessage>[2] = {};

      if (options?.replyTo) {
        sendOptions.reply_parameters = { message_id: parseInt(options.replyTo, 10) };
      }
      if (options?.parseMode) {
        sendOptions.parse_mode = options.parseMode;
      }
      if (options?.disableLinkPreview) {
        sendOptions.link_preview_options = { is_disabled: true };
      }
      if (options?.silent !== undefined) {
        sendOptions.disable_notification = options.silent;
      }

      const result = await this.bot.api.sendMessage(chatId, text, sendOptions);

      clearTimeout(timeoutId);
      return result.message_id.toString();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new TelegramError('Request timed out', { retryable: true });
      }

      // Check if it's a Telegram API error
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Determine if error is retryable (5xx errors, rate limits)
      const retryable = errorMessage.includes('5') || errorMessage.includes('429');

      throw new TelegramError(`Telegram API error: ${errorMessage}`, { retryable });
    }
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Factory function.
 */
export function createTelegramChannel(
  config: TelegramConfig,
  logger: Logger | undefined,
  recipientRegistry: IRecipientRegistry
): TelegramChannel {
  return new TelegramChannel(config, logger, recipientRegistry);
}
