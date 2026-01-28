/**
 * Tool Registry
 *
 * Manages tool registration and execution.
 * Provider-agnostic: works with JSON storage or vector DB.
 */

import type { Logger } from '../../../types/logger.js';
import type { ToolName, ToolResult } from '../../../types/cognition.js';
import type { Tool, ToolRequest } from './types.js';
import { createToolResult } from './types.js';

/**
 * Memory provider interface (abstracts JSON vs vector DB).
 */
export interface MemoryProvider {
  search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  save(entry: MemoryEntry): Promise<void>;
  getRecent(chatId: string, limit: number): Promise<MemoryEntry[]>;
}

export interface MemorySearchOptions {
  limit?: number | undefined;
  types?: ('message' | 'thought' | 'fact')[] | undefined;
  chatId?: string | undefined;
}

export interface MemoryEntry {
  id: string;
  type: 'message' | 'thought' | 'fact';
  content: string;
  timestamp: Date;
  chatId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Agent state provider interface.
 */
export interface AgentStateProvider {
  getState(): Record<string, unknown>;
}

/**
 * User model provider interface.
 */
export interface UserModelProvider {
  getModel(chatId?: string): Record<string, unknown>;
}

/**
 * Conversation provider for time-based queries.
 */
export interface ConversationProvider {
  getLastMessageTime(chatId?: string): Date | null;
  getLastContactTime(chatId?: string): Date | null;
}

/**
 * Dependencies for tool registry.
 */
export interface ToolRegistryDeps {
  memoryProvider?: MemoryProvider | undefined;
  agentStateProvider?: AgentStateProvider | undefined;
  userModelProvider?: UserModelProvider | undefined;
  conversationProvider?: ConversationProvider | undefined;
}

/**
 * Tool Registry - manages tool execution.
 */
export class ToolRegistry {
  private readonly tools = new Map<ToolName, Tool>();
  private readonly logger: Logger;
  private deps: ToolRegistryDeps;

  constructor(logger: Logger, deps: ToolRegistryDeps = {}) {
    this.logger = logger.child({ component: 'tool-registry' });
    this.deps = deps;
    this.registerDefaultTools();
  }

  /**
   * Update dependencies (for late binding).
   */
  setDependencies(deps: Partial<ToolRegistryDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  /**
   * Execute a tool request.
   */
  async execute(request: ToolRequest): Promise<ToolResult> {
    const tool = this.tools.get(request.name);

    if (!tool) {
      this.logger.warn({ toolName: request.name }, 'Unknown tool requested');
      return createToolResult(request.stepId, false, undefined, `Unknown tool: ${request.name}`);
    }

    const startTime = Date.now();

    try {
      this.logger.debug(
        { tool: request.name, args: request.args, stepId: request.stepId },
        'Executing tool'
      );

      const result = await tool.execute(request.args);
      const duration = Date.now() - startTime;

      this.logger.debug(
        { tool: request.name, duration, stepId: request.stepId },
        'Tool executed successfully'
      );

      return createToolResult(request.stepId, true, result);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        { tool: request.name, error: errorMessage, duration, stepId: request.stepId },
        'Tool execution failed'
      );

      return createToolResult(request.stepId, false, undefined, errorMessage);
    }
  }

  /**
   * Check if a tool exists.
   */
  hasTool(name: ToolName): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): ToolName[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Register default tools.
   */
  private registerDefaultTools(): void {
    // searchMemory
    this.tools.set('searchMemory', {
      name: 'searchMemory',
      description: 'Search past conversations and facts',
      parameters: [
        { name: 'query', type: 'string', description: 'Search query', required: true },
        { name: 'limit', type: 'number', description: 'Max results', required: false, default: 5 },
      ],
      execute: async (args) => {
        if (!this.deps.memoryProvider) {
          return { results: [], message: 'Memory provider not available' };
        }

        const query = args['query'] as string;
        const limit = (args['limit'] as number | undefined) ?? 5;
        const types = args['types'] as ('message' | 'thought' | 'fact')[] | undefined;
        const chatId = args['chatId'] as string | undefined;

        const options: MemorySearchOptions = { limit };
        if (types) options.types = types;
        if (chatId) options.chatId = chatId;

        const results = await this.deps.memoryProvider.search(query, options);
        return {
          results: results.map((r) => ({
            type: r.type,
            content: r.content,
            timestamp: r.timestamp.toISOString(),
            tags: r.tags,
          })),
          count: results.length,
        };
      },
    });

    // saveToMemory
    this.tools.set('saveToMemory', {
      name: 'saveToMemory',
      description: 'Save fact or observation to memory',
      parameters: [
        { name: 'type', type: 'string', description: 'Type of memory', required: true },
        { name: 'content', type: 'string', description: 'Content to save', required: true },
      ],
      execute: async (args) => {
        if (!this.deps.memoryProvider) {
          return { success: false, message: 'Memory provider not available' };
        }

        const entryType = args['type'] as string;
        const content = args['content'] as string;
        const tags = (args['tags'] as string[] | undefined) ?? [];
        const confidence = (args['confidence'] as number | undefined) ?? 0.8;

        const entry: MemoryEntry = {
          id: `mem-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
          type: entryType === 'fact' ? 'fact' : 'thought',
          content,
          timestamp: new Date(),
          tags,
          confidence,
        };

        await this.deps.memoryProvider.save(entry);
        return { success: true, id: entry.id };
      },
    });

    // getCurrentTime
    this.tools.set('getCurrentTime', {
      name: 'getCurrentTime',
      description: 'Get current time',
      parameters: [{ name: 'timezone', type: 'string', description: 'Timezone', required: false }],
      execute: (args) => {
        const now = new Date();
        const timezone = args['timezone'] as string | undefined;

        if (timezone) {
          try {
            const formatted = now.toLocaleString('en-US', { timeZone: timezone });
            return Promise.resolve({ time: formatted, timezone, iso: now.toISOString() });
          } catch {
            return Promise.resolve({
              time: now.toISOString(),
              timezone: 'UTC',
              iso: now.toISOString(),
            });
          }
        }

        return Promise.resolve({
          time: now.toISOString(),
          timezone: 'system',
          iso: now.toISOString(),
        });
      },
    });

    // getTimeSince
    this.tools.set('getTimeSince', {
      name: 'getTimeSince',
      description: 'Calculate time since event',
      parameters: [
        { name: 'event', type: 'string', description: 'Event identifier', required: true },
      ],
      execute: (args) => {
        const event = args['event'] as string;
        const chatId = args['chatId'] as string | undefined;
        let eventTime: Date | null = null;

        if (event === 'lastMessage' && this.deps.conversationProvider) {
          eventTime = this.deps.conversationProvider.getLastMessageTime(chatId);
        } else if (event === 'lastContact' && this.deps.conversationProvider) {
          eventTime = this.deps.conversationProvider.getLastContactTime(chatId);
        } else {
          // Try parsing as ISO timestamp
          const parsed = new Date(event);
          if (!isNaN(parsed.getTime())) {
            eventTime = parsed;
          }
        }

        if (!eventTime) {
          return Promise.resolve({ found: false, message: `Event not found: ${event}` });
        }

        const now = Date.now();
        const diffMs = now - eventTime.getTime();
        const diffSeconds = Math.floor(diffMs / 1000);
        const diffMinutes = Math.floor(diffSeconds / 60);
        const diffHours = Math.floor(diffMinutes / 60);
        const diffDays = Math.floor(diffHours / 24);

        return Promise.resolve({
          found: true,
          eventTime: eventTime.toISOString(),
          elapsed: {
            ms: diffMs,
            seconds: diffSeconds,
            minutes: diffMinutes,
            hours: diffHours,
            days: diffDays,
          },
          human: this.formatDuration(diffMs),
        });
      },
    });

    // getAgentState
    this.tools.set('getAgentState', {
      name: 'getAgentState',
      description: 'Get current agent state',
      parameters: [],
      execute: () => {
        if (!this.deps.agentStateProvider) {
          return Promise.resolve({
            available: false,
            message: 'Agent state provider not available',
          });
        }
        return Promise.resolve(this.deps.agentStateProvider.getState());
      },
    });

    // getUserModel
    this.tools.set('getUserModel', {
      name: 'getUserModel',
      description: 'Get user model',
      parameters: [{ name: 'chatId', type: 'string', description: 'Chat ID', required: false }],
      execute: (args) => {
        if (!this.deps.userModelProvider) {
          return Promise.resolve({
            available: false,
            message: 'User model provider not available',
          });
        }
        const chatId = args['chatId'] as string | undefined;
        return Promise.resolve(this.deps.userModelProvider.getModel(chatId));
      },
    });
  }

  /**
   * Format duration for human readability.
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${String(days)} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${String(hours)} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${String(minutes)} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
  }
}

/**
 * Create a tool registry.
 */
export function createToolRegistry(logger: Logger, deps?: ToolRegistryDeps): ToolRegistry {
  return new ToolRegistry(logger, deps);
}
