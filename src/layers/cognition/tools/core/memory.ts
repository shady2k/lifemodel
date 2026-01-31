/**
 * Core Memory Tool
 *
 * Manages long-term memory: search, save, and saveFact operations.
 */

import type { StructuredFact } from '../../../../types/cognition.js';
import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Memory search options.
 */
export interface MemorySearchOptions {
  limit?: number | undefined;
  types?: ('message' | 'thought' | 'fact' | 'intention')[] | undefined;
  recipientId?: string | undefined;
  /** Filter by status (for intentions) */
  status?: 'pending' | 'completed' | undefined;
}

/**
 * Trigger condition for intentions (prospective memory).
 */
export interface IntentionTrigger {
  /** When should this intention surface? */
  condition: 'next_conversation' | 'idle_moment' | 'topic_match';
  /** Surface when discussing these topics (for topic_match) */
  keywords?: string[] | undefined;
}

/**
 * Memory entry structure.
 */
export interface MemoryEntry {
  id: string;
  type: 'message' | 'thought' | 'fact' | 'intention';
  content: string;
  timestamp: Date;
  recipientId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Tick ID for batch grouping in logs (NOT causal - use parentSignalId for that) */
  tickId?: string | undefined;
  /** Parent signal ID that led to this memory being created (causal chain) */
  parentSignalId?: string | undefined;
  /** Trigger condition for intentions (when should this surface?) */
  trigger?: IntentionTrigger | undefined;
  /** Status for intentions */
  status?: 'pending' | 'completed' | undefined;
}

/**
 * Memory provider interface.
 */
export interface MemoryProvider {
  search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  save(entry: MemoryEntry): Promise<void>;
  getRecent(recipientId: string, limit: number): Promise<MemoryEntry[]>;
}

/**
 * Dependencies for memory tool.
 */
export interface MemoryToolDeps {
  memoryProvider?: MemoryProvider | undefined;
}

/**
 * Create the core.memory tool.
 */
export function createMemoryTool(deps: MemoryToolDeps): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      description: 'Action: search, save, or saveFact',
      required: true,
    },
    { name: 'query', type: 'string', description: 'Search query (for search)', required: false },
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
      description: 'Filter by type: message, thought, fact, intention (for search)',
      required: false,
    },
    {
      name: 'status',
      type: 'string',
      description: 'Filter by status: pending, completed (for searching intentions)',
      required: false,
    },
    // chatId removed - system uses context.recipientId automatically
    {
      name: 'type',
      type: 'string',
      description:
        'Memory type: fact, thought, or intention (for save, default: fact). Use intention for things to do/ask later.',
      required: false,
    },
    {
      name: 'trigger',
      type: 'string',
      description:
        'Trigger condition for intentions: next_conversation, idle_moment, or topic_match (for save with type=intention)',
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
    {
      name: 'fact',
      type: 'object',
      description:
        'Structured fact object (for saveFact): { subject, predicate, object, source, evidence?, confidence, ttl?, tags }',
      required: false,
    },
  ];

  return {
    name: 'core.memory',
    description:
      'Manage long-term memory. Actions: search (find past info), save (store text), saveFact (store structured fact).',
    tags: ['search', 'save', 'facts', 'history'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args, context) => {
      const action = args['action'] as string;

      switch (action) {
        case 'search': {
          if (!deps.memoryProvider) {
            return { success: false, action: 'search', message: 'Memory provider not available' };
          }

          const query = args['query'] as string | undefined;
          if (!query) {
            return { success: false, action: 'search', error: 'Missing required parameter: query' };
          }

          const limit = (args['limit'] as number | undefined) ?? 5;
          const types = args['types'] as
            | ('message' | 'thought' | 'fact' | 'intention')[]
            | undefined;
          const status = args['status'] as 'pending' | 'completed' | undefined;

          const options: MemorySearchOptions = { limit };
          if (types) options.types = types;
          if (status) options.status = status;
          // Use context.recipientId - system knows the current conversation
          if (context?.recipientId) options.recipientId = context.recipientId;

          const results = await deps.memoryProvider.search(query, options);
          return {
            success: true,
            action: 'search',
            results: results.map((r) => ({
              type: r.type,
              content: r.content,
              timestamp: r.timestamp.toISOString(),
              tags: r.tags,
              status: r.status,
              trigger: r.trigger,
            })),
            count: results.length,
          };
        }

        case 'save': {
          if (!deps.memoryProvider) {
            return { success: false, action: 'save', message: 'Memory provider not available' };
          }

          const content = args['content'] as string | undefined;
          if (!content) {
            return { success: false, action: 'save', error: 'Missing required parameter: content' };
          }

          const entryType = (args['type'] as string | undefined) ?? 'fact';
          const tags = (args['tags'] as string[] | undefined) ?? [];
          const confidence = (args['confidence'] as number | undefined) ?? 0.8;
          const triggerStr = args['trigger'] as string | undefined;

          // Determine memory type
          let memoryType: 'fact' | 'thought' | 'intention' = 'fact';
          if (entryType === 'thought') memoryType = 'thought';
          if (entryType === 'intention') memoryType = 'intention';

          const entry: MemoryEntry = {
            id: `mem-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
            type: memoryType,
            content,
            timestamp: new Date(),
            // Use context.recipientId - system knows the current conversation
            recipientId: context?.recipientId,
            tags,
            confidence,
          };

          // Add intention-specific fields
          if (memoryType === 'intention') {
            entry.status = 'pending';
            if (triggerStr) {
              entry.trigger = {
                condition: triggerStr as 'next_conversation' | 'idle_moment' | 'topic_match',
              };
            } else {
              entry.trigger = { condition: 'next_conversation' };
            }
          }

          await deps.memoryProvider.save(entry);
          return { success: true, action: 'save', id: entry.id };
        }

        case 'saveFact': {
          const factRaw = args['fact'] as Record<string, unknown> | undefined;
          if (!factRaw) {
            return {
              success: false,
              action: 'saveFact',
              error: 'Missing required parameter: fact',
            };
          }

          // Validate fact structure (runtime validation of potentially malformed LLM output)
          if (!factRaw['subject'] || typeof factRaw['subject'] !== 'string') {
            return {
              success: false,
              action: 'saveFact',
              error: 'Invalid fact: missing or invalid subject (string)',
            };
          }
          if (!factRaw['predicate'] || typeof factRaw['predicate'] !== 'string') {
            return {
              success: false,
              action: 'saveFact',
              error: 'Invalid fact: missing or invalid predicate (string)',
            };
          }
          if (!factRaw['object'] || typeof factRaw['object'] !== 'string') {
            return {
              success: false,
              action: 'saveFact',
              error: 'Invalid fact: missing or invalid object (string)',
            };
          }
          if (!factRaw['source'] || typeof factRaw['source'] !== 'string') {
            return {
              success: false,
              action: 'saveFact',
              error: 'Invalid fact: missing or invalid source (string)',
            };
          }
          if (
            typeof factRaw['confidence'] !== 'number' ||
            factRaw['confidence'] < 0 ||
            factRaw['confidence'] > 1
          ) {
            return {
              success: false,
              action: 'saveFact',
              error: 'Invalid fact: missing or invalid confidence (number 0-1)',
            };
          }
          if (!Array.isArray(factRaw['tags'])) {
            return {
              success: false,
              action: 'saveFact',
              error: 'Invalid fact: missing or invalid tags (array)',
            };
          }

          // After validation, we know it's a valid StructuredFact
          const fact = factRaw as unknown as StructuredFact;
          return { success: true, action: 'saveFact', fact };
        }

        default:
          return {
            success: false,
            action,
            error: `Unknown action: ${action}. Use "search", "save", or "saveFact".`,
          };
      }
    },
  };
}
