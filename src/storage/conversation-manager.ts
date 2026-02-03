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
  /** Channel-specific message ID (e.g., Telegram message ID) for sent messages */
  channelMessageId?: string;
  /** Which channel sent this message */
  channel?: string;
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
  /** Channel-specific message ID (e.g., Telegram message ID) for sent messages */
  channelMessageId?: string;
  /** Which channel sent this message */
  channel?: string;
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
  /**
   * Maximum number of recent turns to return in full (default: 10).
   * A turn is a user message plus assistant response (including tool calls/results).
   * This ensures tool-heavy conversations get enough context.
   */
  maxRecentTurns?: number;
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

  /**
   * Maximum turns before auto-compaction.
   * A "turn" is a user message plus the assistant's response (including tool calls/results).
   * This ensures we count meaningful exchanges, not individual tool messages.
   */
  private readonly maxTurnsBeforeCompaction = 10;

  /**
   * Number of recent turns to keep in full during compaction.
   * Each turn may contain multiple messages (assistant + tool results).
   */
  private readonly recentTurnsToKeep = 3;

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
   * Count the number of turns in a message array.
   * A turn = user message (+ assistant response with optional tool calls).
   * Tool results are part of the preceding assistant's turn, not separate turns.
   * This gives us a consistent count that doesn't inflate with tool-heavy interactions.
   */
  private countTurns(messages: StoredMessage[]): number {
    // Count user messages as turn starts (most reliable metric)
    return messages.filter((msg) => msg.role === 'user').length;
  }

  /**
   * Find the message index where the Nth turn from the end starts.
   * Returns the start index of recent turns to keep.
   */
  private findTurnStartIndex(messages: StoredMessage[], turnsToKeep: number): number {
    if (messages.length === 0 || turnsToKeep <= 0) {
      return messages.length;
    }

    // Walk backwards counting turns
    let turnsFound = 0;
    let turnStartIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // User message marks the start of a turn
      if (msg?.role === 'user') {
        turnsFound++;
        turnStartIndex = i;

        if (turnsFound >= turnsToKeep) {
          break;
        }
      }
    }

    // Ensure we don't start in the middle of a tool call group
    // If turnStartIndex points to a tool result, walk back to find the assistant
    while (turnStartIndex > 0) {
      const msg = messages[turnStartIndex];
      if (msg?.role === 'tool') {
        turnStartIndex--;
      } else if (msg?.role === 'assistant' && turnStartIndex > 0) {
        // Check if there's a user message before this assistant
        const prevMsg = messages[turnStartIndex - 1];
        if (prevMsg?.role === 'tool') {
          turnStartIndex--;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return turnStartIndex;
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
    },
    channelMeta?: {
      channelMessageId?: string;
      channel?: string;
    }
  ): Promise<void> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    const storedMsg: StoredMessage = {
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString(),
    };
    // Add channel metadata for reaction lookup (only for assistant messages)
    if (message.role === 'assistant') {
      if (channelMeta?.channelMessageId) {
        storedMsg.channelMessageId = channelMeta.channelMessageId;
      }
      if (channelMeta?.channel) {
        storedMsg.channel = channelMeta.channel;
      }
    }
    stored.messages.push(storedMsg);

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

    // Check if compaction needed (count turns, not individual messages)
    const turnCount = this.countTurns(stored.messages);
    if (turnCount > this.maxTurnsBeforeCompaction) {
      this.logger.debug({ userId, turnCount }, 'Conversation needs compaction');
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
   * @param channelMeta Optional channel metadata (for reaction lookup)
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
    }[],
    channelMeta?: {
      channelMessageId?: string;
      channel?: string;
    }
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
    // Add channel metadata for reaction lookup
    if (channelMeta?.channelMessageId) {
      assistantMsg.channelMessageId = channelMeta.channelMessageId;
    }
    if (channelMeta?.channel) {
      assistantMsg.channel = channelMeta.channel;
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

    // Check if compaction needed (count turns, not individual messages)
    const turnCount = this.countTurns(stored.messages);
    if (turnCount > this.maxTurnsBeforeCompaction) {
      this.logger.debug({ userId, turnCount }, 'Conversation needs compaction');
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
    const { maxRecentTurns = 8, includeCompacted = true } = options;

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

    // Get recent turns (not just messages) - this ensures tool call groups stay together
    const sliceStart = this.findTurnStartIndex(stored.messages, maxRecentTurns);
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
      if (msg.channelMessageId) {
        convMsg.channelMessageId = msg.channelMessageId;
      }
      if (msg.channel) {
        convMsg.channel = msg.channel;
      }
      return convMsg;
    });
  }

  /**
   * Look up a message by channel-specific message ID.
   * Used for enriching reaction signals with the original message content.
   *
   * @param recipientId The recipient (conversation) ID
   * @param channel Which channel (e.g., 'telegram')
   * @param channelMessageId The channel-specific message ID
   * @returns The message if found, null otherwise
   */
  async getMessageByChannelId(
    recipientId: string,
    channel: string,
    channelMessageId: string
  ): Promise<ConversationMessage | null> {
    const key = this.getKey(recipientId);
    const stored = await this.loadConversation(key);

    // Search from newest to oldest (most recent messages more likely to get reactions)
    for (const msg of stored.messages.slice().reverse()) {
      if (msg.channelMessageId === channelMessageId && msg.channel === channel) {
        return {
          role: msg.role,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          channelMessageId: msg.channelMessageId,
          channel: msg.channel,
        };
      }
    }

    return null;
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

    // Keep only recent turns (not just recent messages)
    // This ensures we don't break up tool call groups
    const keepStartIndex = this.findTurnStartIndex(stored.messages, this.recentTurnsToKeep);
    const recentMessages = stored.messages.slice(keepStartIndex);
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
   * Uses turn counting, not raw message count, so tool-heavy conversations don't trigger early.
   */
  async needsCompaction(userId: string): Promise<boolean> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);
    const turnCount = this.countTurns(stored.messages);
    return turnCount > this.maxTurnsBeforeCompaction;
  }

  /**
   * Get messages that would be compacted (for generating summary).
   * Filters out tool messages and returns only user/assistant for summarization.
   */
  async getMessagesToCompact(userId: string): Promise<ConversationMessage[]> {
    const key = this.getKey(userId);
    const stored = await this.loadConversation(key);

    // Find where to start keeping recent turns
    const keepStartIndex = this.findTurnStartIndex(stored.messages, this.recentTurnsToKeep);
    // All messages before the recent turns
    const toCompact = stored.messages.slice(0, keepStartIndex);

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
