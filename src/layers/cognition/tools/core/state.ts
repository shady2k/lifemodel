/**
 * Core State Tool
 *
 * Read-only access to agent state and user model.
 */

import type { Tool } from '../types.js';

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
  getModel(recipientId?: string): Record<string, unknown>;
}

/**
 * Dependencies for state tool.
 */
export interface StateToolDeps {
  agentStateProvider?: AgentStateProvider | undefined;
  userModelProvider?: UserModelProvider | undefined;
}

/**
 * Create the core.state tool.
 */
export function createStateTool(deps: StateToolDeps): Tool {
  return {
    name: 'core.state',
    description: 'Get current state. Actions: agent (energy, mood), user (beliefs about user).',
    tags: ['agent-state', 'user-model'],
    hasSideEffects: false,
    parameters: [
      { name: 'action', type: 'string', description: 'Action: agent or user', required: true },
      { name: 'chatId', type: 'string', description: 'Chat ID (for user action)', required: false },
    ],
    execute: (args) => {
      const action = args['action'] as string;

      switch (action) {
        case 'agent': {
          if (!deps.agentStateProvider) {
            return Promise.resolve({
              success: false,
              action: 'agent',
              error: 'Agent state provider not available',
            });
          }
          return Promise.resolve({
            success: true,
            action: 'agent',
            ...deps.agentStateProvider.getState(),
          });
        }

        case 'user': {
          if (!deps.userModelProvider) {
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
            ...deps.userModelProvider.getModel(chatId),
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
  };
}
