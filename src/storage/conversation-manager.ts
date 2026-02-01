import type { Storage } from './storage.js';
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
 * Stored tool call in conversation history.
 * Mirrors OpenAI's tool_call format for reconstruction.
 */
export interface StoredToolCall {
  /** Unique ID for this tool call (links to tool result) */
  id: string;
  /** Always 'function' for function tools */
  type: 'function';
  /** Function details */
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Message in conversation history.
 * Extended to support full OpenAI message format including tool_calls.
 */
export interface ConversationMessage {
  /** Message role - now includes 'tool' for tool result messages */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Content - can be null for assistant messages with only tool_calls */
  content: string | null;
  /** Timestamp when message was added */
  timestamp?: Date;
  /** Tool calls made by assistant (only for role: 'assistant') */
  tool_calls?: StoredToolCall[];
  /** Tool call ID this message is responding to (only for role: 'tool') */
  tool_call_id?: string;
}

/**
 * Completed action record for preventing LLM re-execution.
 * Tracks side-effect tool calls so autonomous triggers don't repeat them.
 */
export interface CompletedAction {
  /** Tool name (e.g., "core.setInterest", "core.remember") */
  tool: string;
  /** Human-readable summary for prompt inclusion */
  summary: string;
  /** ISO timestamp when action was completed */
  timestamp: string;
}

/**
 * Stored message in persisted format (timestamps as ISO strings).
 */
interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  timestamp: string;
  /** Tool calls made by assistant (only for role: 'assistant') */
  tool_calls?: StoredToolCall[];
  /** Tool call ID this message is responding to (only for role: 'tool') */
  tool_call_id?: string;
}

/**
 * Stored conversation data structure.
 */
interface StoredConversation {
  messages: StoredMessage[];
  compactedSummary?: string;
  lastCompactedAt?: string;
  /** Current conversation status */
  status?: ConversationStatus;
  /** When the status was last updated */
  statusUpdatedAt?: string;
  /** Recent completed actions for preventing re-execution */
  completedActions?: CompletedAction[];
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

  /** Maximum completed actions to track (prevents unbounded growth) */
  private readonly maxCompletedActions = 20;

  /** How long to keep completed actions (24 hours in ms) */
  private readonly actionRetentionMs = 24 * 60 * 60 * 1000;

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
   * For simple user/assistant messages without tool calls.
   */
  async addMessage(
    userId: string,
    message: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }
  ): Promise<void> {
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
   * Add a complete turn to the conversation history.
   * A turn includes: assistant message (with optional tool_calls) + tool results.
   * This preserves the full OpenAI message format for history reconstruction.
   *
   * @param userId User/conversation ID
   * @param assistantMessage The assistant's message (may include tool_calls)
   * @param toolResults Array of tool result messages (linked via tool_call_id)
   */
  async addTurn(
    userId: string,
    assistantMessage: {
      content: string | null;
      tool_calls?: StoredToolCall[];
    },
    toolResults?: {
      tool_call_id: string;
      content: string;
    }[]
  ): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);
    const timestamp = new Date().toISOString();

    // Add assistant message (may have tool_calls)
    const assistantMsg: StoredMessage = {
      role: 'assistant',
      content: assistantMessage.content,
      timestamp,
    };
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      assistantMsg.tool_calls = assistantMessage.tool_calls;
    }
    stored.messages.push(assistantMsg);

    // Add tool result messages
    if (toolResults && toolResults.length > 0) {
      for (const result of toolResults) {
        stored.messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
          timestamp,
        });
      }
    }

    await this.storage.save(key, stored);

    this.logger.debug(
      {
        userId,
        hasToolCalls: (assistantMessage.tool_calls?.length ?? 0) > 0,
        toolCallCount: assistantMessage.tool_calls?.length ?? 0,
        toolResultCount: toolResults?.length ?? 0,
        totalMessages: stored.messages.length,
      },
      'Turn added to conversation history'
    );

    // Check if compaction needed
    if (stored.messages.length > this.maxMessagesBeforeCompaction) {
      this.logger.debug({ userId }, 'Conversation needs compaction');
    }
  }

  /**
   * Get conversation history for a user.
   * Returns proper OpenAI message array with tool_calls preserved.
   *
   * @param userId User/conversation ID
   * @param options Retrieval options
   * @returns Array of messages in OpenAI format (with tool_calls visible)
   */
  async getHistory(
    userId: string,
    options: GetHistoryOptions = {}
  ): Promise<ConversationMessage[]> {
    const { maxRecent = 10, includeCompacted = true } = options;

    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    const result: ConversationMessage[] = [];

    // Add compacted summary if available and requested
    if (includeCompacted && stored.compactedSummary) {
      result.push({
        role: 'system',
        content: `[Earlier conversation summary: ${stored.compactedSummary}]`,
      });
    }

    // Get recent messages - but we need to keep tool_call groups together
    // Find a safe slice point that doesn't break tool_call/tool pairs
    let sliceStart = Math.max(0, stored.messages.length - maxRecent);

    // If we're slicing, make sure we don't start in the middle of a tool_call group
    // Look for a user message or standalone assistant message to start from
    while (sliceStart > 0 && sliceStart < stored.messages.length) {
      const msg = stored.messages[sliceStart];
      // Safe starting points: user message, system message, or assistant without pending tool_calls
      if (msg?.role === 'user' || msg?.role === 'system') {
        break;
      }
      // If it's a tool result, we need to go back to include the assistant message with tool_calls
      if (msg?.role === 'tool') {
        sliceStart--;
        continue;
      }
      // Assistant message is a valid start point
      if (msg?.role === 'assistant') {
        break;
      }
      sliceStart--;
    }

    const recentMessages = stored.messages.slice(sliceStart);

    // Convert stored messages to ConversationMessage format
    for (const msg of recentMessages) {
      const convMsg: ConversationMessage = {
        role: msg.role,
        content: msg.content,
      };

      // Include tool_calls for assistant messages
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        convMsg.tool_calls = msg.tool_calls;
      }

      // Include tool_call_id for tool messages
      if (msg.tool_call_id) {
        convMsg.tool_call_id = msg.tool_call_id;
      }

      result.push(convMsg);
    }

    this.logger.debug(
      {
        userId,
        recentCount: recentMessages.length,
        hasCompacted: !!stored.compactedSummary,
        totalReturned: result.length,
        hasToolCalls: recentMessages.some((m) => m.tool_calls && m.tool_calls.length > 0),
      },
      'Retrieved conversation history as messages'
    );

    return result;
  }

  /**
   * Get full conversation history with timestamps.
   */
  async getFullHistory(userId: string): Promise<ConversationMessage[]> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    return stored.messages.map((msg) => {
      const convMsg: ConversationMessage = {
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
      };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        convMsg.tool_calls = msg.tool_calls;
      }
      if (msg.tool_call_id) {
        convMsg.tool_call_id = msg.tool_call_id;
      }
      return convMsg;
    });
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
   * Filters out tool messages and returns only user/assistant for summarization.
   */
  async getMessagesToCompact(userId: string): Promise<ConversationMessage[]> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    // All messages except recent ones
    const toCompact = stored.messages.slice(0, -this.recentMessagesToKeep);

    // Filter to only user/assistant messages for summarization (skip tool results)
    return toCompact
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role,
        content: msg.content ?? '', // Coerce null to empty string
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
   * Record a completed action to prevent LLM re-execution.
   * Used by CoreLoop when applying side-effect intents (REMEMBER, SET_INTEREST).
   *
   * @param userId User/conversation ID
   * @param action Completed action details
   */
  async addCompletedAction(
    userId: string,
    action: Omit<CompletedAction, 'timestamp'>
  ): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    // Initialize if needed
    stored.completedActions ??= [];

    // Add new action
    stored.completedActions.push({
      ...action,
      timestamp: new Date().toISOString(),
    });

    // Prune old actions (older than retention period)
    const cutoff = Date.now() - this.actionRetentionMs;
    stored.completedActions = stored.completedActions.filter(
      (a) => new Date(a.timestamp).getTime() > cutoff
    );

    // Keep only most recent N actions
    if (stored.completedActions.length > this.maxCompletedActions) {
      stored.completedActions = stored.completedActions.slice(-this.maxCompletedActions);
    }

    await this.storage.save(key, stored);

    this.logger.debug(
      {
        userId,
        tool: action.tool,
        summary: action.summary,
        totalActions: stored.completedActions.length,
      },
      'Completed action recorded'
    );
  }

  /**
   * Get recent completed actions for a user.
   * Used by AgenticLoop to include in prompt for autonomous triggers.
   *
   * @param userId User/conversation ID
   * @param maxAge Maximum age in ms (default: 4 hours)
   * @returns List of recent actions, newest first
   */
  async getRecentActions(userId: string, maxAge?: number): Promise<CompletedAction[]> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    if (!stored.completedActions || stored.completedActions.length === 0) {
      return [];
    }

    const cutoff = Date.now() - (maxAge ?? 4 * 60 * 60 * 1000); // Default 4 hours

    return stored.completedActions
      .filter((a) => new Date(a.timestamp).getTime() > cutoff)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /**
   * Clear all completed actions for a user.
   * Called during compaction to reset action tracking.
   */
  async clearCompletedActions(userId: string): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    if (stored.completedActions && stored.completedActions.length > 0) {
      const count = stored.completedActions.length;
      stored.completedActions = [];
      await this.storage.save(key, stored);

      this.logger.debug({ userId, clearedCount: count }, 'Completed actions cleared');
    }
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
