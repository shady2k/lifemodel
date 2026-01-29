/**
 * Tool Registry
 *
 * Manages tool registration and execution.
 * Provider-agnostic: works with JSON storage or vector DB.
 */

import type { Logger } from '../../../types/logger.js';
import type { ToolName, ToolResult } from '../../../types/cognition.js';
import type { Tool, ToolRequest, ToolParameter } from './types.js';
import { createToolResult } from './types.js';

/**
 * Tool schema for on-demand retrieval.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParameter[];
  tags: string[];
}

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
      return createToolResult(
        request.stepId,
        request.name,
        false,
        undefined,
        `Unknown tool: ${request.name}`
      );
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

      return createToolResult(request.stepId, request.name, true, result);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        { tool: request.name, error: errorMessage, duration, stepId: request.stepId },
        'Tool execution failed'
      );

      return createToolResult(request.stepId, request.name, false, undefined, errorMessage);
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
   * Get tool cards for prompt (brief descriptions + capability tags).
   * Format: "name: description [tag1,tag2]"
   */
  getToolCards(): string[] {
    const cards: string[] = [];
    // Sort by name for stable ordering
    const sortedTools = Array.from(this.tools.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, tool] of sortedTools) {
      // Skip the 'tools' meta-tool itself from the card list
      if (name === 'tools') continue;

      // Get first sentence of description (brief)
      const firstLine = tool.description.split('\n')[0] ?? '';
      const firstSentence = firstLine.split('.')[0] ?? '';
      const briefDesc = firstSentence.length > 0 ? firstSentence : tool.description;
      const tags = tool.tags && tool.tags.length > 0 ? ` [${tool.tags.join(', ')}]` : '';
      cards.push(`- ${name}: ${briefDesc}${tags}`);
    }
    return cards;
  }

  /**
   * Get full schema for a specific tool.
   * Used by the 'tools' meta-tool for on-demand schema retrieval.
   */
  getToolSchema(name: ToolName): ToolSchema | null {
    const tool = this.tools.get(name);
    if (!tool) return null;

    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tags: tool.tags ?? [],
    };
  }

  /**
   * Register a new tool dynamically.
   * Used by plugins to add tools at runtime.
   */
  registerTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn({ toolName: tool.name }, 'Tool already registered, replacing');
    }
    this.tools.set(tool.name, tool);
    this.logger.info({ toolName: tool.name }, 'Tool registered dynamically');
  }

  /**
   * Unregister a tool.
   * Used by plugins when being unloaded.
   * @returns true if tool was removed, false if it didn't exist
   */
  unregisterTool(name: ToolName): boolean {
    const existed = this.tools.has(name);
    if (existed) {
      this.tools.delete(name);
      this.logger.info({ toolName: name }, 'Tool unregistered');
    }
    return existed;
  }

  /**
   * Register default tools (consolidated).
   */
  private registerDefaultTools(): void {
    // memory - search and save
    this.tools.set('memory', {
      name: 'memory',
      description:
        'Manage long-term memory. Actions: search (find past info), save (store new facts).',
      tags: ['search', 'save', 'facts', 'history'],
      parameters: [
        { name: 'action', type: 'string', description: 'Action: search or save', required: true },
        {
          name: 'query',
          type: 'string',
          description: 'Search query (for search)',
          required: false,
        },
        {
          name: 'content',
          type: 'string',
          description: 'Content to save (for save)',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Max results (for search, default: 5)',
          required: false,
        },
        {
          name: 'types',
          type: 'array',
          description: 'Filter by type: message, thought, fact (for search)',
          required: false,
        },
        {
          name: 'chatId',
          type: 'string',
          description: 'Conversation ID (for search filter or save scope)',
          required: false,
        },
        {
          name: 'type',
          type: 'string',
          description: 'Memory type: fact or thought (for save, default: fact)',
          required: false,
        },
        {
          name: 'tags',
          type: 'array',
          description: 'Tags for categorization (for save)',
          required: false,
        },
        {
          name: 'confidence',
          type: 'number',
          description: 'Confidence 0-1 (for save, default: 0.8)',
          required: false,
        },
      ],
      execute: async (args) => {
        const action = args['action'] as string;

        switch (action) {
          case 'search': {
            if (!this.deps.memoryProvider) {
              return { success: false, action: 'search', message: 'Memory provider not available' };
            }

            const query = args['query'] as string | undefined;
            if (!query) {
              return {
                success: false,
                action: 'search',
                error: 'Missing required parameter: query',
              };
            }

            const limit = (args['limit'] as number | undefined) ?? 5;
            const types = args['types'] as ('message' | 'thought' | 'fact')[] | undefined;
            const chatId = args['chatId'] as string | undefined;

            const options: MemorySearchOptions = { limit };
            if (types) options.types = types;
            if (chatId) options.chatId = chatId;

            const results = await this.deps.memoryProvider.search(query, options);
            return {
              success: true,
              action: 'search',
              results: results.map((r) => ({
                type: r.type,
                content: r.content,
                timestamp: r.timestamp.toISOString(),
                tags: r.tags,
              })),
              count: results.length,
            };
          }

          case 'save': {
            if (!this.deps.memoryProvider) {
              return { success: false, action: 'save', message: 'Memory provider not available' };
            }

            const content = args['content'] as string | undefined;
            if (!content) {
              return {
                success: false,
                action: 'save',
                error: 'Missing required parameter: content',
              };
            }

            const entryType = (args['type'] as string | undefined) ?? 'fact';
            const tags = (args['tags'] as string[] | undefined) ?? [];
            const confidence = (args['confidence'] as number | undefined) ?? 0.8;
            const chatId = args['chatId'] as string | undefined;

            const entry: MemoryEntry = {
              id: `mem-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
              type: entryType === 'fact' ? 'fact' : 'thought',
              content,
              timestamp: new Date(),
              chatId,
              tags,
              confidence,
            };

            await this.deps.memoryProvider.save(entry);
            return { success: true, action: 'save', id: entry.id };
          }

          default:
            return {
              success: false,
              action,
              error: `Unknown action: ${action}. Use "search" or "save".`,
            };
        }
      },
    });

    // time - now and since
    this.tools.set('time', {
      name: 'time',
      description:
        'Get time information. Actions: now (current time), since (elapsed time from event).',
      tags: ['current-time', 'elapsed', 'timezone'],
      parameters: [
        { name: 'action', type: 'string', description: 'Action: now or since', required: true },
        {
          name: 'timezone',
          type: 'string',
          description: 'IANA timezone (for now)',
          required: false,
        },
        {
          name: 'event',
          type: 'string',
          description: 'Event: lastMessage, lastContact, or ISO timestamp (for since)',
          required: false,
        },
        {
          name: 'chatId',
          type: 'string',
          description: 'Chat ID for chat-specific events (for since)',
          required: false,
        },
      ],
      execute: (args) => {
        const action = args['action'] as string;

        switch (action) {
          case 'now': {
            const now = new Date();
            const timezone = args['timezone'] as string | undefined;

            if (timezone) {
              try {
                const formatted = now.toLocaleString('en-US', { timeZone: timezone });
                return Promise.resolve({
                  success: true,
                  action: 'now',
                  time: formatted,
                  timezone,
                  iso: now.toISOString(),
                });
              } catch {
                return Promise.resolve({
                  success: true,
                  action: 'now',
                  time: now.toISOString(),
                  timezone: 'UTC',
                  iso: now.toISOString(),
                });
              }
            }

            return Promise.resolve({
              success: true,
              action: 'now',
              time: now.toISOString(),
              timezone: 'system',
              iso: now.toISOString(),
            });
          }

          case 'since': {
            const event = args['event'] as string | undefined;
            if (!event) {
              return Promise.resolve({
                success: false,
                action: 'since',
                error: 'Missing required parameter: event',
              });
            }

            const chatId = args['chatId'] as string | undefined;
            let eventTime: Date | null = null;

            if (event === 'lastMessage' && this.deps.conversationProvider) {
              eventTime = this.deps.conversationProvider.getLastMessageTime(chatId);
            } else if (event === 'lastContact' && this.deps.conversationProvider) {
              eventTime = this.deps.conversationProvider.getLastContactTime(chatId);
            } else {
              const parsed = new Date(event);
              if (!isNaN(parsed.getTime())) {
                eventTime = parsed;
              }
            }

            if (!eventTime) {
              return Promise.resolve({
                success: false,
                action: 'since',
                error: `Event not found: ${event}`,
              });
            }

            const now = Date.now();
            const diffMs = now - eventTime.getTime();
            const diffSeconds = Math.floor(diffMs / 1000);
            const diffMinutes = Math.floor(diffSeconds / 60);
            const diffHours = Math.floor(diffMinutes / 60);
            const diffDays = Math.floor(diffHours / 24);

            return Promise.resolve({
              success: true,
              action: 'since',
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
          }

          default:
            return Promise.resolve({
              success: false,
              action,
              error: `Unknown action: ${action}. Use "now" or "since".`,
            });
        }
      },
    });

    // state - agent and user
    this.tools.set('state', {
      name: 'state',
      description: 'Get current state. Actions: agent (energy, mood), user (beliefs about user).',
      tags: ['agent-state', 'user-model'],
      parameters: [
        { name: 'action', type: 'string', description: 'Action: agent or user', required: true },
        {
          name: 'chatId',
          type: 'string',
          description: 'Chat ID (for user action)',
          required: false,
        },
      ],
      execute: (args) => {
        const action = args['action'] as string;

        switch (action) {
          case 'agent': {
            if (!this.deps.agentStateProvider) {
              return Promise.resolve({
                success: false,
                action: 'agent',
                error: 'Agent state provider not available',
              });
            }
            return Promise.resolve({
              success: true,
              action: 'agent',
              ...this.deps.agentStateProvider.getState(),
            });
          }

          case 'user': {
            if (!this.deps.userModelProvider) {
              return Promise.resolve({
                success: false,
                action: 'user',
                error: 'User model provider not available',
              });
            }
            const chatId = args['chatId'] as string | undefined;
            return Promise.resolve({
              success: true,
              action: 'user',
              ...this.deps.userModelProvider.getModel(chatId),
            });
          }

          default:
            return Promise.resolve({
              success: false,
              action,
              error: `Unknown action: ${action}. Use "agent" or "user".`,
            });
        }
      },
    });

    // tools - meta-tool for schema discovery
    this.tools.set('tools', {
      name: 'tools',
      description: 'Get detailed schema for any tool. Use when you need exact parameters.',
      tags: ['meta', 'schema', 'help'],
      parameters: [
        { name: 'action', type: 'string', description: 'Action: describe', required: true },
        {
          name: 'name',
          type: 'string',
          description: 'Tool name to get schema for',
          required: true,
        },
      ],
      execute: (args) => {
        const action = args['action'] as string;

        if (action !== 'describe') {
          return Promise.resolve({
            success: false,
            action,
            error: `Unknown action: ${action}. Use "describe".`,
          });
        }

        const toolName = args['name'] as string | undefined;
        if (!toolName) {
          return Promise.resolve({
            success: false,
            action: 'describe',
            error: 'Missing required parameter: name',
          });
        }

        const schema = this.getToolSchema(toolName as ToolName);
        if (!schema) {
          return Promise.resolve({
            success: false,
            action: 'describe',
            error: `Tool not found: ${toolName}`,
            availableTools: this.getToolNames(),
          });
        }

        return Promise.resolve({
          success: true,
          action: 'describe',
          schema,
        });
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
