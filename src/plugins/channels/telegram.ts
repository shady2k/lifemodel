import { Bot, GrammyError } from 'grammy';
import type { Context } from 'grammy';
import type { MessageReactionUpdated } from 'grammy/types';
import type { Logger, Signal } from '../../types/index.js';
import type { ImageAttachment } from '../../types/signal.js';
import { createUserMessageSignal, createMessageReactionSignal } from '../../types/index.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { createCircuitBreaker } from '../../core/circuit-breaker.js';
import type { Channel, CircuitStats, SendOptions, SendResult } from '../../channels/channel.js';
import type { IRecipientRegistry } from '../../core/recipient-registry.js';
import { withTraceContext, createTraceContext } from '../../core/trace-context.js';

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
  maxRetries: 3,
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

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Prefers splitting at paragraph boundaries, then newlines, then mid-text.
 */
export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find best split point within maxLength
    let splitAt = -1;

    // 1. Try paragraph boundary (\n\n)
    const paraIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (paraIdx > 0) {
      splitAt = paraIdx;
    }

    // 2. Try newline
    if (splitAt === -1) {
      const nlIdx = remaining.lastIndexOf('\n', maxLength);
      if (nlIdx > 0) {
        splitAt = nlIdx;
      }
    }

    // 3. Try space
    if (splitAt === -1) {
      const spIdx = remaining.lastIndexOf(' ', maxLength);
      if (spIdx > 0) {
        splitAt = spIdx;
      }
    }

    // 4. Hard cut
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^[\n ]+/, '');
  }

  return chunks;
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
 * - Retry logic (3 retries with exponential backoff)
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

    // Handle photo messages (vision support)
    this.bot.on('message:photo', (ctx) => {
      void this.onPhoto(ctx);
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
   * Each message gets its own trace context for causal chain tracking.
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

    const correlationId = ctx.message.message_id.toString();
    const signal = createUserMessageSignal(
      {
        text,
        channel: 'telegram',
        userId,
        recipientId,
      },
      { correlationId }
    );

    // Wrap callback in trace context (signal.id as root)
    withTraceContext(
      createTraceContext(signal.id, {
        correlationId,
        spanId: `msg_${String(ctx.message.message_id)}`,
      }),
      () => {
        if (this.signalCallback) {
          this.signalCallback(signal);

          this.logger?.debug(
            {
              signalId: signal.id,
              userId,
              recipientId,
              textLength: text.length,
              text: text.slice(0, 200).replace(/\n/g, ' '),
            },
            'Message received as Signal'
          );
        }
      }
    );
  }

  /**
   * Handle incoming photo messages.
   * Downloads the photo, encodes as base64, and emits a user_message signal with image data.
   */
  private async onPhoto(ctx: {
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    chat: { id: number };
    message: {
      message_id: number;
      photo?: { file_id: string; file_size?: number }[];
      caption?: string;
    };
    api: { getFile: (fileId: string) => Promise<{ file_path?: string }> };
  }): Promise<void> {
    if (!ctx.from || !ctx.message.photo?.length) {
      return;
    }

    const chatId = ctx.chat.id.toString();

    // Filter by allowed chat IDs if configured
    const allowedChatIds = this.config.allowedChatIds;
    if (allowedChatIds && allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
      this.logger?.debug({ chatId }, 'Ignoring photo from non-allowed chat ID');
      return;
    }

    const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB

    try {
      // Get largest photo (grammY sorts ascending by size)
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      if (!photo) return;

      // Pre-check size from Telegram metadata (if available)
      if (photo.file_size && photo.file_size > MAX_PHOTO_BYTES) {
        this.logger?.warn({ fileSize: photo.file_size }, 'Photo too large, skipping');
        return;
      }

      // Download the photo
      const file = await ctx.api.getFile(photo.file_id);
      if (!file.file_path) {
        this.logger?.warn('Photo file_path missing from Telegram API response');
        return;
      }

      // Build download URL (not logged — contains bot token)
      const downloadUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
      const response = await fetch(downloadUrl);

      if (!response.ok) {
        this.logger?.warn(
          { status: response.status, statusText: response.statusText },
          'Photo download failed'
        );
        return;
      }

      const buffer = await response.arrayBuffer();

      // Post-download size guard
      if (buffer.byteLength > MAX_PHOTO_BYTES) {
        this.logger?.warn(
          { byteLength: buffer.byteLength },
          'Photo too large after download, skipping'
        );
        return;
      }

      const base64 = Buffer.from(buffer).toString('base64');

      // Determine media type: prefer Content-Type header, fall back to extension
      let mediaType = response.headers.get('content-type') ?? '';
      if (!mediaType.startsWith('image/')) {
        const ext = file.file_path.split('.').pop()?.toLowerCase();
        mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      }

      const userId = ctx.from.id.toString();
      const destination = chatId;
      const text = ctx.message.caption ?? '[Photo]';
      const recipientId = this.recipientRegistry.getOrCreate(this.name, destination);

      const image: ImageAttachment = { data: base64, mediaType };
      const correlationId = ctx.message.message_id.toString();
      const signal = createUserMessageSignal(
        {
          text,
          channel: 'telegram',
          userId,
          recipientId,
          images: [image],
        },
        { correlationId }
      );

      // Wrap callback in trace context (same pattern as onMessage)
      withTraceContext(
        createTraceContext(signal.id, {
          correlationId,
          spanId: `photo_${String(ctx.message.message_id)}`,
        }),
        () => {
          if (this.signalCallback) {
            this.signalCallback(signal);

            this.logger?.debug(
              {
                signalId: signal.id,
                userId,
                recipientId,
                hasCaption: !!ctx.message.caption,
                imageSize: buffer.byteLength,
                mediaType,
              },
              'Photo received as Signal'
            );
          }
        }
      );
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to process incoming photo'
      );
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
   * Each reaction gets its own trace context for causal chain tracking.
   */
  private processReaction(
    chatId: string,
    messageId: number,
    emoji: string,
    fromUserId?: number,
    actorChatId?: number
  ): void {
    const recipientId = this.recipientRegistry.getOrCreate(this.name, chatId);
    const correlationId = messageId.toString();

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

    const signal = createMessageReactionSignal(signalParams, { correlationId });

    // Wrap callbacks in trace context (signal.id as root)
    withTraceContext(
      createTraceContext(signal.id, {
        correlationId,
        spanId: `reaction_${String(messageId)}`,
      }),
      () => {
        this.signalCallback?.(signal);

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

    const chunks = splitMessage(text);
    let lastMessageId = '';

    for (const chunk of chunks) {
      lastMessageId = await this.doSendChunk(chatId, chunk, options);
    }

    return lastMessageId;
  }

  /**
   * Send a single chunk to Telegram.
   */
  private async doSendChunk(chatId: number, text: string, options?: SendOptions): Promise<string> {
    if (!this.bot) {
      throw new TelegramError('Bot not initialized');
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

      // Determine if error is retryable (5xx server errors, rate limits)
      const retryable =
        error instanceof GrammyError && (error.error_code >= 500 || error.error_code === 429);
      const errorMessage = error instanceof Error ? error.message : String(error);

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
