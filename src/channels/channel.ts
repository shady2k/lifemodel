import type { CircuitState } from '../core/circuit-breaker.js';

/**
 * Circuit breaker statistics.
 */
export interface CircuitStats {
  /** Current circuit state */
  state: CircuitState;
  /** Number of consecutive failures */
  failures: number;
  /** Timestamp of last failure (null if none) */
  lastFailureTime: number | null;
}

/**
 * Result of sending a message.
 */
export interface SendResult {
  /** Whether the message was sent successfully */
  success: boolean;
  /** Channel-specific message ID (e.g., Telegram message ID) */
  messageId?: string;
}

/**
 * Options for sending messages.
 */
export interface SendOptions {
  /** Reply to a specific message ID */
  replyTo?: string;
  /** Parse mode for formatting (e.g., 'HTML', 'Markdown') */
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  /** Disable link previews */
  disableLinkPreview?: boolean;
  /** Disable notification */
  silent?: boolean;
}

/**
 * Channel interface for bidirectional communication.
 *
 * Channels handle:
 * - Receiving external messages → converting to Events
 * - Sending outbound messages from SEND_MESSAGE intents
 */
export interface Channel {
  /** Channel name (e.g., "telegram", "discord") */
  readonly name: string;

  /**
   * Check if the channel is configured and available.
   * Returns false if required credentials are missing.
   */
  isAvailable(): boolean;

  /**
   * Send a message through the channel.
   *
   * @param target - Target identifier (user ID, chat ID, etc.)
   * @param text - Message content
   * @param options - Optional send options
   * @returns Result with success status and optional messageId
   */
  sendMessage(target: string, text: string, options?: SendOptions): Promise<SendResult>;

  /**
   * Send typing indicator to show the bot is preparing a response.
   * Optional - not all channels support this.
   *
   * @param target - Target identifier (user ID, chat ID, etc.)
   */
  sendTyping?(target: string): Promise<void>;

  /**
   * Start the channel (begin receiving messages).
   * Optional - some channels may not need explicit start.
   */
  start?(): Promise<void>;

  /**
   * Stop the channel (stop receiving messages).
   * Optional - for graceful shutdown.
   */
  stop?(): Promise<void>;

  /**
   * Get circuit breaker statistics.
   * Optional - for monitoring channel health.
   */
  getCircuitStats?(): CircuitStats;
}
