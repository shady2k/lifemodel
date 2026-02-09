/**
 * Core Tools Meta-Tool
 *
 * Schema discovery tool - allows LLM to get detailed info about any tool.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import { unsanitizeToolName } from '../../../../llm/tool-schema.js';

/**
 * Tool schema for on-demand retrieval.
 * Includes rawParameterSchema when available for tools with complex nested parameters.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParameter[];
  tags: string[];
  /** Raw JSON Schema for complex parameters (nested objects, arrays with items, etc.) */
  rawParameterSchema?: Record<string, unknown>;
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
  const parameters: ToolParameter[] = [
    { name: 'action', type: 'string', description: 'Action: describe', required: true },
    { name: 'name', type: 'string', description: 'Tool name to get schema for', required: true },
  ];

  return {
    name: 'core.tools',
    description: 'Get detailed schema for any tool. Use when you need exact parameters.',
    tags: ['meta', 'schema', 'help'],
    hasSideEffects: false,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args) => {
      const action = args['action'] as string;

      if (action !== 'describe') {
        return Promise.resolve({
          success: false,
          action,
          error: `Unknown action: ${action}. Use "describe".`,
        });
      }

      const rawToolName = args['name'] as string | undefined;
      if (!rawToolName) {
        return Promise.resolve({
          success: false,
          action: 'describe',
          error: 'Missing required parameter: name',
        });
      }

      // Accept both sanitized (plugin_calories) and internal (plugin.calories) forms
      const toolName = unsanitizeToolName(rawToolName);
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
