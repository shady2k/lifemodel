import type { Storage } from './storage.js';
import type { Message } from '../llm/provider.js';
import type { Logger } from '../types/index.js';

/**
 * Conversation status indicating the state of the conversation.
 * Used to determine appropriate follow-up timing.
 */
export type ConversationStatus =
  | 'active' // Mid-conversation, expect quick reply
  | 'awaiting_answer' // Asked specific question, waiting for response
  | 'closed' // Farewell, busy signal - don't disturb
  | 'idle'; // Natural pause, can reach out later

/**
 * Follow-up timeouts in milliseconds for each conversation status.
 */
export const CONVERSATION_TIMEOUTS: Record<ConversationStatus, number> = {
  awaiting_answer: 10 * 60 * 1000, // 10 minutes
  active: 30 * 60 * 1000, // 30 minutes
  idle: 2 * 60 * 60 * 1000, // 2 hours
  closed: 4 * 60 * 60 * 1000, // 4 hours
};

/**
 * Extended message with timestamp for history tracking.
 */
export interface ConversationMessage extends Message {
  timestamp: Date;
}

/**
 * Stored conversation data structure.
 */
interface StoredConversation {
  messages: {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: string;
  }[];
  compactedSummary?: string;
  lastCompactedAt?: string;
  /** Current conversation status */
  status?: ConversationStatus;
  /** When the status was last updated */
  statusUpdatedAt?: string;
}

/**
 * Options for retrieving conversation history.
 */
export interface GetHistoryOptions {
  /** Maximum number of recent messages to return in full (default: 3) */
  maxRecent?: number;
  /** Whether to include compacted summary as first message (default: true) */
  includeCompacted?: boolean;
}

/**
 * ConversationManager - manages conversation history per user.
 *
 * Features:
 * - Stores messages with timestamps
 * - Returns recent messages in full, older ones as compacted summary
 * - Handles compaction to reduce storage size
 *
 * Storage key format: conversation:{userId}
 */
export class ConversationManager {
  private readonly storage: Storage;
  private readonly logger: Logger;

  /** Maximum messages before auto-compaction */
  private readonly maxMessagesBeforeCompaction = 10;

  /** Number of recent messages to keep in full during compaction */
  private readonly recentMessagesToKeep = 3;

  constructor(storage: Storage, logger: Logger) {
    this.storage = storage;
    this.logger = logger.child({ component: 'conversation-manager' });
  }

  /**
   * Get storage key for a user's conversation.
   */
  private getKey(userId: string): string {
    return `conversation:${userId}`;
  }

  /**
   * Add a message to the conversation history.
   */
  async addMessage(userId: string, message: Message): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    stored.messages.push({
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
    });

    await this.storage.save(key, stored);

    this.logger.debug(
      {
        userId,
        role: message.role,
        contentLength: message.content.length,
        totalMessages: stored.messages.length,
      },
      'Message added to conversation history'
    );

    // Check if compaction needed
    if (stored.messages.length > this.maxMessagesBeforeCompaction) {
      this.logger.debug({ userId }, 'Conversation needs compaction');
    }
  }

  /**
   * Get conversation history for a user.
   *
   * Returns recent messages in full, with optional compacted summary prefix.
   * Always ensures history starts with a user message (not assistant).
   */
  async getHistory(userId: string, options: GetHistoryOptions = {}): Promise<Message[]> {
    const { maxRecent = 3, includeCompacted = true } = options;

    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    const result: Message[] = [];

    // Add compacted summary if available and requested
    if (includeCompacted && stored.compactedSummary) {
      result.push({
        role: 'system',
        content: `[Earlier conversation summary: ${stored.compactedSummary}]`,
      });
    }

    // Get recent messages (last N)
    let recentMessages = stored.messages.slice(-maxRecent);

    // Ensure we start with a user message, not assistant
    // If slice starts with assistant, include the preceding user message
    const firstMessage = recentMessages[0];
    if (recentMessages.length > 0 && firstMessage?.role === 'assistant') {
      const sliceStart = stored.messages.length - maxRecent;
      if (sliceStart > 0) {
        // Include one more message (should be the user message that prompted this assistant reply)
        recentMessages = stored.messages.slice(sliceStart - 1);
      } else {
        // Can't go further back - just skip the leading assistant message
        recentMessages = recentMessages.slice(1);
      }
    }

    for (const msg of recentMessages) {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }

    this.logger.debug(
      {
        userId,
        recentCount: recentMessages.length,
        hasCompacted: !!stored.compactedSummary,
        totalReturned: result.length,
      },
      'Retrieved conversation history'
    );

    return result;
  }

  /**
   * Get full conversation history with timestamps.
   */
  async getFullHistory(userId: string): Promise<ConversationMessage[]> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    return stored.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      timestamp: new Date(msg.timestamp),
    }));
  }

  /**
   * Compact older messages into a summary.
   *
   * @param userId User ID
   * @param summary Summary of older messages (generated by LLM)
   */
  async compact(userId: string, summary: string): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    // Keep only recent messages
    const recentMessages = stored.messages.slice(-this.recentMessagesToKeep);
    const compactedCount = stored.messages.length - recentMessages.length;

    if (compactedCount <= 0) {
      this.logger.debug({ userId }, 'No messages to compact');
      return;
    }

    // Update stored data
    stored.messages = recentMessages;
    stored.compactedSummary = summary;
    stored.lastCompactedAt = new Date().toISOString();

    await this.storage.save(key, stored);

    this.logger.info(
      {
        userId,
        compactedCount,
        remainingCount: recentMessages.length,
        summaryLength: summary.length,
      },
      'Conversation compacted'
    );
  }

  /**
   * Check if conversation needs compaction.
   */
  async needsCompaction(userId: string): Promise<boolean> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);
    return stored.messages.length > this.maxMessagesBeforeCompaction;
  }

  /**
   * Get messages that would be compacted (for generating summary).
   */
  async getMessagesToCompact(userId: string): Promise<Message[]> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    // All messages except recent ones
    const toCompact = stored.messages.slice(0, -this.recentMessagesToKeep);

    return toCompact.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /**
   * Clear conversation history for a user.
   */
  async clear(userId: string): Promise<void> {
    const key = this.getKey(userId);
    await this.storage.delete(key);
    this.logger.info({ userId }, 'Conversation cleared');
  }

  /**
   * Get conversation stats for a user.
   */
  async getStats(userId: string): Promise<{
    messageCount: number;
    hasCompactedSummary: boolean;
    lastCompactedAt: Date | null;
  }> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    return {
      messageCount: stored.messages.length,
      hasCompactedSummary: !!stored.compactedSummary,
      lastCompactedAt: stored.lastCompactedAt ? new Date(stored.lastCompactedAt) : null,
    };
  }

  /**
   * Set conversation status.
   */
  async setStatus(userId: string, status: ConversationStatus): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    stored.status = status;
    stored.statusUpdatedAt = new Date().toISOString();

    await this.storage.save(key, stored);

    this.logger.debug({ userId, status }, 'Conversation status updated');
  }

  /**
   * Get conversation status and timing info.
   */
  async getStatus(userId: string): Promise<{
    status: ConversationStatus;
    updatedAt: Date | null;
    lastMessageAt: Date | null;
    lastMessageRole: 'user' | 'assistant' | null;
  }> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    const lastMessage = stored.messages[stored.messages.length - 1];

    return {
      status: stored.status ?? 'idle',
      updatedAt: stored.statusUpdatedAt ? new Date(stored.statusUpdatedAt) : null,
      lastMessageAt: lastMessage ? new Date(lastMessage.timestamp) : null,
      lastMessageRole:
        lastMessage?.role === 'user' || lastMessage?.role === 'assistant' ? lastMessage.role : null,
    };
  }

  /**
   * Check if follow-up is due based on conversation status and time.
   */
  async shouldFollowUp(userId: string): Promise<{
    shouldFollowUp: boolean;
    reason: string;
    status: ConversationStatus;
    timeSinceLastMessage: number;
  }> {
    const { status, lastMessageAt, lastMessageRole } = await this.getStatus(userId);

    // Can't follow up if no messages
    if (!lastMessageAt) {
      return {
        shouldFollowUp: false,
        reason: 'No conversation history',
        status,
        timeSinceLastMessage: 0,
      };
    }

    // Don't follow up if user was the last to message (we should have responded)
    if (lastMessageRole === 'user') {
      return {
        shouldFollowUp: false,
        reason: 'Waiting for our response, not user response',
        status,
        timeSinceLastMessage: Date.now() - lastMessageAt.getTime(),
      };
    }

    const timeSinceLastMessage = Date.now() - lastMessageAt.getTime();
    const timeout = CONVERSATION_TIMEOUTS[status];

    if (timeSinceLastMessage >= timeout) {
      return {
        shouldFollowUp: true,
        reason: `Status "${status}" timeout (${String(Math.round(timeout / 60000))} min) exceeded`,
        status,
        timeSinceLastMessage,
      };
    }

    return {
      shouldFollowUp: false,
      reason: `Status "${status}" timeout not reached (${String(Math.round((timeout - timeSinceLastMessage) / 60000))} min remaining)`,
      status,
      timeSinceLastMessage,
    };
  }

  /**
   * Load conversation from storage, returning empty if not found.
   */
  private async loadConversation(key: string): Promise<StoredConversation> {
    const data = await this.storage.load(key);

    if (!data) {
      return { messages: [] };
    }

    // Validate and return
    const stored = data as StoredConversation;
    if (!Array.isArray(stored.messages)) {
      return { messages: [] };
    }

    return stored;
  }
}

/**
 * Factory function for creating a ConversationManager.
 */
export function createConversationManager(storage: Storage, logger: Logger): ConversationManager {
  return new ConversationManager(storage, logger);
}
