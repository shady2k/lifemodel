/**
 * Tool Definitions
 *
 * Defines the schema for all available COGNITION tools.
 * Used for prompt building to tell LLM what tools are available.
 *
 * Consolidated tools:
 * - memory: search/save memories and facts
 * - time: get current time or time since event
 * - state: get agent state or user model
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
    name: 'memory',
    description: `Manage long-term memory. Actions:
- "search": Search past conversations, thoughts, and facts
- "save": Save important information worth remembering`,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: "search" or "save"',
        required: true,
      },
      {
        name: 'query',
        type: 'string',
        description: 'Search query (required for search)',
        required: false,
      },
      {
        name: 'content',
        type: 'string',
        description: 'Content to save (required for save)',
        required: false,
      },
      {
        name: 'type',
        type: 'string',
        description: 'Type of memory: "fact" or "observation" (for save)',
        required: false,
        default: 'fact',
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum results (for search, default: 5)',
        required: false,
        default: 5,
      },
      {
        name: 'types',
        type: 'array',
        description: 'Filter by type: "message", "thought", "fact" (for search)',
        required: false,
      },
      {
        name: 'tags',
        type: 'array',
        description: 'Tags for categorization (for save)',
        required: false,
        default: [],
      },
      {
        name: 'confidence',
        type: 'number',
        description: 'Confidence in this information 0-1 (for save)',
        required: false,
        default: 0.8,
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
    name: 'time',
    description: `Get time information. Actions:
- "now": Get current time (optionally in specific timezone)
- "since": Calculate time elapsed since an event`,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: "now" or "since"',
        required: true,
      },
      {
        name: 'timezone',
        type: 'string',
        description: 'IANA timezone e.g. "Europe/Moscow" (for now)',
        required: false,
      },
      {
        name: 'event',
        type: 'string',
        description: 'Event: "lastMessage", "lastContact", or ISO timestamp (for since)',
        required: false,
      },
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID for chat-specific events (for since)',
        required: false,
      },
    ],
  },
  {
    name: 'state',
    description: `Get current state information. Actions:
- "agent": Get agent internal state (energy, socialDebt, alertness, etc.)
- "user": Get beliefs about the user (name, mood, preferences, etc.)`,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: "agent" or "user"',
        required: true,
      },
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID for user model (for user action)',
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
