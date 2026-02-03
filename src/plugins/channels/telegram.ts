import { Bot } from 'grammy';
import type { Logger, Signal } from '../../types/index.js';
import { createUserMessageSignal } from '../../types/index.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { createCircuitBreaker } from '../../core/circuit-breaker.js';
import type { Channel, CircuitStats, SendOptions } from '../../channels/channel.js';
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

    // Handle errors
    this.bot.catch((err) => {
      this.logger?.error({ error: err }, 'Telegram bot error');
    });

    // Start polling (non-blocking)
    this.running = true;
    void this.bot.start({
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
   * @returns true if sent successfully
   */
  async sendMessage(target: string, text: string, options?: SendOptions): Promise<boolean> {
    if (!this.isAvailable()) {
      this.logger?.warn('Cannot send message: Telegram not configured');
      return false;
    }

    if (!this.bot) {
      this.logger?.warn('Cannot send message: Telegram bot not started');
      return false;
    }

    try {
      await this.circuitBreaker.execute(async () => {
        await this.executeWithRetry(async () => {
          await this.doSendMessage(target, text, options);
        });
      });

      this.logger?.debug({ chatId: target, textLength: text.length }, 'Message sent');
      return true;
    } catch (error) {
      this.logger?.error({ error, chatId: target }, 'Failed to send message');
      return false;
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
   */
  private async doSendMessage(target: string, text: string, options?: SendOptions): Promise<void> {
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

      await this.bot.api.sendMessage(chatId, text, sendOptions);

      clearTimeout(timeoutId);
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
