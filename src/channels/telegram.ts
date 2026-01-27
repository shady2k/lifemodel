import { randomUUID } from 'node:crypto';
import { Bot } from 'grammy';
import type { Logger, EventQueue, Event } from '../types/index.js';
import { Priority } from '../types/index.js';
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import { createCircuitBreaker } from '../core/circuit-breaker.js';
import type { Channel, CircuitStats, SendOptions } from './channel.js';

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
  private readonly eventQueue: EventQueue;
  private readonly circuitBreaker: CircuitBreaker;
  private bot: Bot | null = null;
  private running = false;

  constructor(config: TelegramConfig, eventQueue: EventQueue, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventQueue = eventQueue;
    this.logger = logger ? logger.child({ component: 'telegram' }) : undefined;

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
      void this.onMessage(ctx);
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
   * Handle incoming message - convert to Event and push to queue.
   */
  private async onMessage(ctx: {
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    chat: { id: number };
    message: { message_id: number; text?: string };
  }): Promise<void> {
    if (!ctx.from || !ctx.message.text) {
      return;
    }

    const payload: TelegramMessagePayload = {
      userId: ctx.from.id.toString(),
      chatId: ctx.chat.id.toString(),
      text: ctx.message.text,
      messageId: ctx.message.message_id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    };

    const event: Event = {
      id: randomUUID(),
      source: 'communication',
      channel: 'telegram',
      type: 'message_received',
      priority: Priority.HIGH,
      timestamp: new Date(),
      payload,
    };

    await this.eventQueue.push(event);

    this.logger?.debug(
      {
        eventId: event.id,
        userId: payload.userId,
        chatId: payload.chatId,
        textLength: payload.text.length,
      },
      'Message received and queued'
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

        if (error instanceof TelegramError && !error.retryable) {
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          this.logger?.warn(
            { attempt: attempt + 1, maxRetries: this.config.maxRetries },
            'Retrying after error'
          );
          await this.sleep(this.config.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError ?? new Error('Unknown error');
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
  eventQueue: EventQueue,
  logger?: Logger
): TelegramChannel {
  return new TelegramChannel(config, eventQueue, logger);
}
