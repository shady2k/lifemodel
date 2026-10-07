import { Bot, GrammyError } from 'grammy';
import type { Context } from 'grammy';
import type { MessageReactionUpdated } from 'grammy/types';
import type { Logger, Signal } from '../../types/index.js';
import type { ImageAttachment, UserMessageData } from '../../types/signal.js';
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

/** How long stopIntake waits for in-flight inbound handlers (bounded). */
const IN_FLIGHT_EMIT_DRAIN_MS = 5_000;

/** Photos above this size are refused (handler entry + after download). */
const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5MB

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
  /**
   * A download-only client (no handlers, no polling). A photo receipt that is
   * replayed while the channel has not started yet (the container replays
   * BEFORE index.ts starts the channels, review round 2 finding 7) is
   * re-fetched through it; once the channel runs, downloads use the polling
   * client. Sending still requires a started bot (see sendMessage).
   */
  private downloadClient: Bot | null = null;
  private running = false;
  /**
   * Inbound callbacks may be async: the durable inbound log (lifemodel-ctc.2.1)
   * writes and flushes the message BEFORE the signal is queued, and awaiting
   * the callback here is what makes the write happen at emit time.
   */
  private signalCallback: ((signal: Signal) => void | Promise<void>) | null = null;

  /** In-flight inbound emits, awaited (bounded) by stopIntake. */
  private readonly inFlightEmits = new Set<Promise<unknown>>();

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
  setSignalCallback(callback: (signal: Signal) => void | Promise<void>): void {
    this.signalCallback = callback;
  }

  /** Run the inbound callback, awaiting it so its durability promise lands
   * at emit time, and keep it tracked for stopIntake. */
  private async emitSignal(signal: Signal, span: string): Promise<void> {
    const emit = (async () => {
      const result = this.signalCallback?.(signal);
      if (result instanceof Promise) {
        await result;
      }
    })();
    this.inFlightEmits.add(emit);
    try {
      await emit;
    } finally {
      this.inFlightEmits.delete(emit);
      this.logger?.debug(
        { signalId: signal.id, span },
        'Signal emitted (inbound callback settled)'
      );
    }
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

    // Handle text messages (awaited: the durable log flushes at emit time)
    this.bot.on('message:text', async (ctx) => {
      await this.onMessage(ctx);
    });

    // Handle photo messages (vision support; awaited through its downloads)
    this.bot.on('message:photo', async (ctx) => {
      await this.onPhoto(ctx);
    });

    // Handle message reactions (non-verbal feedback)
    this.bot.on('message_reaction', async (ctx: Context) => {
      await this.onReaction(ctx);
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
   * Stop intake: end long polling so no new updates are accepted.
   * Sending keeps working (the bot API stays up) — a cognition turn still in
   * flight during the shutdown drain must be able to deliver its answer.
   */
  async stopIntake(): Promise<void> {
    if (!this.running || !this.bot) {
      return;
    }

    this.running = false;
    await this.bot.stop();
    // An intake handler still running (e.g. a photo download) may not have
    // emitted yet: give it a bounded moment so its message reaches the
    // durable inbound log at emit time (the emit itself awaits the flush).
    const pending = [...this.inFlightEmits];
    if (pending.length > 0) {
      const settled = Promise.allSettled(pending).then(() => 'settled' as const);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => {
          resolve('deadline');
        }, IN_FLIGHT_EMIT_DRAIN_MS);
      });
      const outcome = await Promise.race([settled, cap]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (outcome === 'deadline') {
        this.logger?.warn(
          { stillInFlight: this.inFlightEmits.size },
          'Inbound handlers still running at the intake stop deadline; whatever they emit is recoverable from the durable log only after their callback settles'
        );
      }
    }
    this.logger?.info('Telegram intake stopped (polling stopped, sending kept)');
  }

  /**
   * Stop the Telegram bot entirely: intake plus the client (sending refuses
   * after this).
   */
  async stop(): Promise<void> {
    if (!this.bot) {
      return;
    }

    this.running = false;
    await this.bot.stop();
    this.bot = null;
    this.downloadClient = null;
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
  private async onMessage(ctx: {
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    chat: { id: number };
    message: { message_id: number; text?: string };
    /** grammY's wrapping update: its update_id is the dedup key (lifemodel-ctc.2.1) */
    update?: { update_id: number };
  }): Promise<void> {
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
    const updateId = ctx.update?.update_id !== undefined ? String(ctx.update.update_id) : undefined;
    const signal = createUserMessageSignal(
      {
        text,
        channel: 'telegram',
        userId,
        recipientId,
        ...(updateId !== undefined && { updateId }),
      },
      { correlationId }
    );

    // Wrap callback in trace context (signal.id as root). The emit is
    // awaited: the durable inbox writes+flushes BEFORE the signal is queued.
    const span = `msg_${String(ctx.message.message_id)}`;
    await withTraceContext(createTraceContext(signal.id, { correlationId, spanId: span }), () => {
      if (this.signalCallback) {
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
      return this.emitSignal(signal, span);
    });
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
    /** grammY's wrapping update: its update_id is the dedup key (lifemodel-ctc.2.1) */
    update?: { update_id: number };
  }): Promise<void> {
    if (!ctx.from || !ctx.message.photo?.length) {
      return;
    }

    const chatId = ctx.chat.id.toString();

    // Filter by allowed chat IDs if configured
    const allowedChatIds = this.config.allowedChatIds;
    if (allowedChatIds && allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
      this.logger?.debug({ chatId, allowedChatIds }, 'Ignoring photo from non-allowed chat ID');
      return;
    }

    // Get largest photo (grammY sorts ascending by size)
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) return;

    // Pre-check size from Telegram metadata (if available)
    if (photo.file_size && photo.file_size > PHOTO_MAX_BYTES) {
      this.logger?.warn({ fileSize: photo.file_size }, 'Photo too large, skipping');
      // Keep the durable receipt uncommitted: a smaller future variant (a
      // re-sent photo) still completes through replay. The current update
      // itself must not wedge the log in a never-committed state, so the
      // caption-only fallback is queued here too.
      const text = ctx.message.caption ?? '[Photo]';
      const recipientId = this.recipientRegistry.getOrCreate(this.name, chatId);
      const updateId =
        ctx.update?.update_id !== undefined ? String(ctx.update.update_id) : undefined;
      const fallback = createUserMessageSignal(
        {
          text,
          channel: 'telegram',
          userId: ctx.from.id.toString(),
          recipientId,
          ...(updateId === undefined ? {} : { updateId }),
        },
        { correlationId: ctx.message.message_id.toString() }
      );
      const span = `photo_${String(ctx.message.message_id)}`;
      await this.emitSignal(fallback, span);
      return;
    }

    const userId = ctx.from.id.toString();
    const text = ctx.message.caption ?? '[Photo]';
    const recipientId = this.recipientRegistry.getOrCreate(this.name, chatId);
    const correlationId = ctx.message.message_id.toString();
    const updateId = ctx.update?.update_id !== undefined ? String(ctx.update.update_id) : undefined;
    const span = `photo_${String(ctx.message.message_id)}`;

    // DURABLE RECEIPT at handler entry (review round 2, finding 7): a stop or
    // kill during getFile/fetch confirms the update without losing the photo -
    // the receipt is on disk before any network work, and a restart re-fetches
    // it through completePhotoReceipt().
    const receipt = createUserMessageSignal(
      {
        text,
        channel: 'telegram',
        userId,
        recipientId,
        pendingPhoto: { fileId: photo.file_id },
        ...(updateId === undefined ? {} : { updateId }),
      },
      { correlationId }
    );
    await withTraceContext(createTraceContext(receipt.id, { correlationId, spanId: span }), () => {
      this.logger?.debug(
        { signalId: receipt.id, fileName: photo.file_id, recipientId },
        'Photo received; durable receipt recorded before the download'
      );
      return this.emitSignal(receipt, span);
    });

    let completed: { base64: string; mediaType: string } | null = null;
    try {
      completed = await this.downloadPhoto(photo.file_id, PHOTO_MAX_BYTES);
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error), fileName: photo.file_id },
        'Failed to download incoming photo; the caption-only fallback is queued'
      );
    }

    if (completed === null) {
      // Deliver the receipt as a plain caption-only message now (rather than
      // an entry that can never commit): the durable log replaces the receipt
      // payload with it, so no photo-less duplicate can replay later.
      const fallback = createUserMessageSignal(
        {
          text,
          channel: 'telegram',
          userId,
          recipientId,
          ...(updateId === undefined ? {} : { updateId }),
        },
        { correlationId }
      );
      await withTraceContext(
        createTraceContext(fallback.id, { correlationId, spanId: span }),
        () => {
          this.logger?.debug(
            { signalId: fallback.id, recipientId },
            'Photo download unavailable; the caption-only message is queued'
          );
          return this.emitSignal(fallback, span);
        }
      );
      return;
    }

    const image: ImageAttachment = { data: completed.base64, mediaType: completed.mediaType };
    const signal = createUserMessageSignal(
      {
        text,
        channel: 'telegram',
        userId,
        recipientId,
        images: [image],
        ...(updateId === undefined ? {} : { updateId }),
      },
      { correlationId }
    );

    // Wrap callback in trace context (same pattern as onMessage; awaited
    // so the durable inbox flush completes at emit time)
    await withTraceContext(createTraceContext(signal.id, { correlationId, spanId: span }), () => {
      this.logger?.debug(
        {
          signalId: signal.id,
          userId,
          recipientId,
          hasCaption: !!ctx.message.caption,
          mediaType: completed?.mediaType,
        },
        'Photo received as Signal'
      );
      return this.emitSignal(signal, span);
    });
  }

  /**
   * Download a photo by file_id: getFile for the path, then the file (not
   * logged - the URL contains the bot token). Returns null when the photo
   * is unusable (missing path, HTTP error, oversized), throws on transport
   * errors.
   */
  private async downloadPhoto(
    fileId: string,
    maxBytes: number
  ): Promise<{ base64: string; mediaType: string } | null> {
    const client = this.bot ?? (this.downloadClient ??= new Bot(this.config.botToken));
    const file = await client.api.getFile(fileId);
    if (!file?.file_path) {
      this.logger?.warn('Photo file_path missing from Telegram API response');
      return null;
    }
    // Build download URL (not logged - contains bot token)
    const downloadUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      this.logger?.warn(
        { status: response.status, statusText: response.statusText },
        'Photo download failed'
      );
      return null;
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      this.logger?.warn(
        { byteLength: buffer.byteLength },
        'Photo too large after download, skipping'
      );
      return null;
    }
    const base64 = Buffer.from(buffer).toString('base64');
    // Determine media type: prefer Content-Type header, fall back to extension
    let mediaType = response.headers.get('content-type') ?? '';
    if (!mediaType.startsWith('image/')) {
      const ext = file.file_path.split('.').pop()?.toLowerCase();
      mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    }
    return { base64, mediaType };
  }

  /**
   * Complete a replayed pendingPhoto receipt after a restart: re-fetch the
   * file and emit the full photo message through the same awaited callback
   * (review round 2, finding 7). Returns false when the photo cannot be
   * fetched; the caller then queues the receipt itself as its caption text.
   */
  async completePhotoReceipt(receipt: Signal): Promise<boolean> {
    const data = receipt.data as
      | (UserMessageData & { pendingPhoto?: { fileId: string } })
      | undefined;
    if (!data?.pendingPhoto || typeof data.pendingPhoto.fileId !== 'string') {
      return false;
    }
    const route = this.recipientRegistry.resolve(data.recipientId ?? '');
    if (!route) {
      this.logger?.warn(
        { signalId: receipt.id },
        'Cannot complete a photo receipt without its route'
      );
      return false;
    }
    try {
      const completed = await this.downloadPhoto(data.pendingPhoto.fileId, PHOTO_MAX_BYTES);
      if (completed === null) {
        return false;
      }
      const updateId = typeof data.updateId === 'string' ? data.updateId : undefined;
      const signal = createUserMessageSignal(
        {
          text: data.text,
          channel: 'telegram',
          ...(data.userId !== undefined && { userId: data.userId }),
          recipientId: data.recipientId,
          images: [{ data: completed.base64, mediaType: completed.mediaType }],
          ...(updateId === undefined ? {} : { updateId }),
        },
        { correlationId: receipt.correlationId ?? receipt.id }
      );
      await this.emitSignal(signal, 'photo_receipt_complete');
      return true;
    } catch (error) {
      this.logger?.error(
        {
          error: error instanceof Error ? error.message : String(error),
          fileName: data.pendingPhoto.fileId,
        },
        'Failed to re-fetch a photo receipt'
      );
      return false;
    }
  }

  /**
   * Handle incoming reaction using grammy's ctx.reactions() helper.
   */
  private async onReaction(ctx: Context): Promise<void> {
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
      await this.processReaction(
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
  private async processReaction(
    chatId: string,
    messageId: number,
    emoji: string,
    fromUserId?: number,
    actorChatId?: number
  ): Promise<void> {
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

    // Wrap callbacks in trace context (signal.id as root). A reaction is not
    // written to the durable log, but the emit is still awaited so intake
    // handlers settle in order (same pattern as onMessage).
    const span = `reaction_${String(messageId)}`;
    await withTraceContext(createTraceContext(signal.id, { correlationId, spanId: span }), () => {
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
      return this.emitSignal(signal, span);
    });
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
