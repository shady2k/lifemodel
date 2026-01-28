/**
 * Tool Definitions
 *
 * Defines the schema for all available COGNITION tools.
 * Used for prompt building to tell LLM what tools are available.
 */

import type { ToolParameter } from './types.js';

/**
 * Tool definition for prompt building.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

/**
 * All available tool definitions.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'searchMemory',
    description:
      'Search past conversations, thoughts, and facts. Returns relevant memories sorted by relevance.',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query',
        required: true,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum results to return (default: 5)',
        required: false,
        default: 5,
      },
      {
        name: 'types',
        type: 'array',
        description: 'Filter by type: "message", "thought", "fact"',
        required: false,
      },
      {
        name: 'chatId',
        type: 'string',
        description: 'Filter by specific conversation',
        required: false,
      },
    ],
  },
  {
    name: 'saveToMemory',
    description:
      'Save a fact or observation to long-term memory. Use for important information worth remembering.',
    parameters: [
      {
        name: 'type',
        type: 'string',
        description: 'Type of memory: "fact" or "observation"',
        required: true,
      },
      {
        name: 'content',
        type: 'string',
        description: 'The content to save',
        required: true,
      },
      {
        name: 'tags',
        type: 'array',
        description: 'Tags for categorization and search',
        required: false,
        default: [],
      },
      {
        name: 'confidence',
        type: 'number',
        description: 'Confidence in this information (0-1)',
        required: false,
        default: 0.8,
      },
      {
        name: 'ttl',
        type: 'number',
        description: 'Time-to-live in milliseconds (null = permanent)',
        required: false,
        default: null,
      },
    ],
  },
  {
    name: 'getCurrentTime',
    description: 'Get the current time, optionally in a specific timezone.',
    parameters: [
      {
        name: 'timezone',
        type: 'string',
        description: 'IANA timezone (e.g., "Europe/Moscow"). Default: system timezone.',
        required: false,
      },
    ],
  },
  {
    name: 'getTimeSince',
    description: 'Calculate how much time has passed since an event.',
    parameters: [
      {
        name: 'event',
        type: 'string',
        description: 'Event identifier: "lastMessage", "lastContact", or ISO timestamp',
        required: true,
      },
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID for chat-specific events',
        required: false,
      },
    ],
  },
  {
    name: 'getAgentState',
    description: 'Get current agent internal state (energy, socialDebt, alertness, etc.).',
    parameters: [],
  },
  {
    name: 'getUserModel',
    description: 'Get current beliefs about the user (name, mood, preferences, etc.).',
    parameters: [
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID to get user model for',
        required: false,
      },
    ],
  },
];

/**
 * Format tool definitions for LLM prompt.
 */
export function formatToolsForPrompt(): string {
  const lines: string[] = ['Available tools:'];

  for (const tool of TOOL_DEFINITIONS) {
    lines.push('');
    lines.push(`## ${tool.name}`);
    lines.push(tool.description);

    if (tool.parameters.length > 0) {
      lines.push('Parameters:');
      for (const param of tool.parameters) {
        const required = param.required ? '(required)' : '(optional)';
        const defaultVal =
          param.default !== undefined ? ` Default: ${JSON.stringify(param.default)}` : '';
        lines.push(
          `  - ${param.name}: ${param.type} ${required} - ${param.description}${defaultVal}`
        );
      }
    } else {
      lines.push('Parameters: none');
    }
  }

  return lines.join('\n');
}
