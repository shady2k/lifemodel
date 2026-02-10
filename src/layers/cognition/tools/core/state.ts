/**
 * Core State Tool
 *
 * Read-only access to agent state and user model.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

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
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      description: 'Required. One of: agent, user',
      required: true,
    },
  ];

  return {
    name: 'core.state',
    maxCallsPerTurn: 1,
    description: 'Get agent state (energy, mood) or user model. Example: {"action": "agent"}',
    tags: ['agent-state', 'user-model'],
    hasSideEffects: false,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args, context) => {
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
          // Use context.recipientId - system knows the current conversation
          return Promise.resolve({
            success: true,
            action: 'user',
            ...deps.userModelProvider.getModel(context?.recipientId),
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
