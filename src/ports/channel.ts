/**
 * Channel Port - Hexagonal Architecture
 *
 * Defines the interface for communication channels (Telegram, Discord, etc.).
 * Channels are adapters that implement this port to connect external messaging
 * systems to the core domain.
 *
 * Key responsibilities:
 * - Receive messages from external systems → emit as Signals
 * - Send messages to external systems ← from Intent execution
 * - Manage connection lifecycle (start/stop)
 */

import type { Signal } from '../types/signal.js';

/**
 * Result of sending a message.
 */
export interface ChannelSendResult {
  /** Whether the message was sent successfully */
  success: boolean;
  /** Channel-specific message ID (e.g., Telegram message ID) */
  messageId?: string;
}

/**
 * Options for sending messages through a channel.
 */
export interface ChannelSendOptions {
  /** Reply to a specific message ID */
  replyTo?: string;
  /** Parse mode for formatting (channel-specific) */
  parseMode?: string;
  /** Disable link previews */
  disableLinkPreview?: boolean;
  /** Send silently (no notification) */
  silent?: boolean;
}

/**
 * Inbound message from a channel.
 * Normalized structure from any channel.
 */
export interface InboundMessage {
  /** Channel name (e.g., "telegram", "discord") */
  channel: string;
  /** Channel-specific destination (e.g., chatId for Telegram) */
  destination: string;
  /** Message text content */
  text: string;
  /** Original message ID from the channel */
  messageId: string;
  /** Sender information */
  sender: {
    id: string;
    username?: string;
    displayName?: string;
  };
  /** Message timestamp */
  timestamp: Date;
  /** Channel-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Channel health status.
 */
export interface ChannelHealth {
  /** Whether the channel is operational */
  healthy: boolean;
  /** Current circuit breaker state (if applicable) */
  circuitState?: 'closed' | 'open' | 'half-open';
  /** Number of consecutive failures */
  failures?: number;
  /** Descriptive message */
  message?: string;
}

/**
 * IChannel - Primary port for bidirectional messaging.
 *
 * This is the interface that channel adapters must implement.
 * The core domain depends only on this interface, not on concrete
 * implementations like TelegramChannel.
 */
export interface IChannel {
  /** Channel identifier (e.g., "telegram", "discord") */
  readonly name: string;

  /**
   * Check if the channel is configured and available.
   * Returns false if required credentials/config are missing.
   */
  isAvailable(): boolean;

  /**
   * Send a message through the channel.
   *
   * @param destination - Target identifier (chat ID, user ID, channel ID, etc.)
   * @param text - Message content
   * @param options - Optional send options
   * @returns Result with success status and optional messageId
   */
  sendMessage(
    destination: string,
    text: string,
    options?: ChannelSendOptions
  ): Promise<ChannelSendResult>;

  /**
   * Send typing indicator (optional).
   * Shows the bot is preparing a response.
   */
  sendTyping?(destination: string): Promise<void>;

  /**
   * Start receiving messages from the channel.
   * Should be idempotent (safe to call multiple times).
   */
  start?(): Promise<void>;

  /**
   * Stop receiving messages (graceful shutdown).
   * Should clean up resources and connections.
   */
  stop?(): Promise<void>;

  /**
   * Get channel health status (optional).
   */
  getHealth?(): ChannelHealth;

  /**
   * Register callback for incoming signals.
   * Called when the channel receives a message.
   */
  onSignal?(callback: (signal: Signal) => void): void;

  /**
   * Register wake-up callback.
   * Called when the channel needs the core loop to wake up immediately.
   */
  onWakeUp?(callback: () => void): void;
}

/**
 * INotifier - Simplified outbound-only messaging port.
 *
 * Use when you only need to send messages (e.g., in plugins)
 * without the full channel lifecycle management.
 */
export interface INotifier {
  /**
   * Send a message to a destination.
   */
  send(destination: string, content: string, options?: ChannelSendOptions): Promise<boolean>;

  /**
   * Send typing indicator.
   */
  sendTyping?(destination: string): Promise<void>;
}

/**
 * Type guard to check if a channel is fully functional.
 */
export function isFullChannel(channel: Partial<IChannel>): channel is IChannel {
  return (
    typeof channel.name === 'string' &&
    typeof channel.isAvailable === 'function' &&
    typeof channel.sendMessage === 'function'
  );
}
