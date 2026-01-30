/**
 * Core Tools Meta-Tool
 *
 * Schema discovery tool - allows LLM to get detailed info about any tool.
 */

import type { Tool, ToolParameter } from '../types.js';

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
 * Schema provider interface (implemented by ToolRegistry).
 */
export interface SchemaProvider {
  getToolSchema(name: string): ToolSchema | null;
  getToolNames(): string[];
}

/**
 * Dependencies for tools meta-tool.
 */
export interface ToolsMetaToolDeps {
  schemaProvider: SchemaProvider;
}

/**
 * Create the core.tools meta-tool.
 */
export function createToolsMetaTool(deps: ToolsMetaToolDeps): Tool {
  return {
    name: 'core.tools',
    description: 'Get detailed schema for any tool. Use when you need exact parameters.',
    tags: ['meta', 'schema', 'help'],
    hasSideEffects: false,
    parameters: [
      { name: 'action', type: 'string', description: 'Action: describe', required: true },
      { name: 'name', type: 'string', description: 'Tool name to get schema for', required: true },
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

      const schema = deps.schemaProvider.getToolSchema(toolName);
      if (!schema) {
        return Promise.resolve({
          success: false,
          action: 'describe',
          error: `Tool not found: ${toolName}`,
          availableTools: deps.schemaProvider.getToolNames(),
        });
      }

      return Promise.resolve({
        success: true,
        action: 'describe',
        schema,
      });
    },
  };
}
