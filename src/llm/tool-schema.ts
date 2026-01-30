/**
 * Tool Schema Converter
 *
 * Converts internal Tool definitions to OpenAI Chat Completions API format.
 * This enables native tool calling instead of markdown-based tool documentation.
 */

import type { Tool, ToolParameter } from '../layers/cognition/tools/types.js';

/**
 * OpenAI Chat Completions tool format.
 * Used with the `tools` parameter in chat completions API.
 */
export interface OpenAIChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, OpenAIPropertySchema>;
      /** Required parameters. Omitted when empty for provider compatibility. */
      required?: string[];
    };
  };
}

/**
 * JSON Schema property definition for OpenAI tools.
 */
export interface OpenAIPropertySchema {
  /** JSON Schema type (string, number, boolean, object, array) */
  type?: string;
  description?: string;
  /** Items schema for array types */
  items?: OpenAIPropertySchema;
  /** Properties for object types */
  properties?: Record<string, OpenAIPropertySchema>;
}

/**
 * Map our parameter types to JSON Schema types.
 */
function mapParameterType(param: ToolParameter): OpenAIPropertySchema {
  const schema: OpenAIPropertySchema = {
    type: param.type,
  };

  if (param.description) {
    schema.description = param.description;
  }

  // Handle array type - use empty object for items to allow any type
  // This is more flexible than assuming string items
  if (param.type === 'array') {
    schema.items = {};
  }

  return schema;
}

/**
 * Convert a Tool to OpenAI Chat Completions tool format.
 *
 * @param tool - Internal tool definition
 * @returns OpenAI-compatible tool definition
 */
export function toolToOpenAIFormat(tool: Tool): OpenAIChatTool {
  const properties: Record<string, OpenAIPropertySchema> = {};
  const required: string[] = [];

  for (const param of tool.parameters) {
    properties[param.name] = mapParameterType(param);

    if (param.required) {
      required.push(param.name);
    }
  }

  // Build the tool definition
  const result: OpenAIChatTool = {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
      },
    },
  };

  // Only include required array if non-empty (some providers reject empty required)
  if (required.length > 0) {
    result.function.parameters.required = required;
  }

  return result;
}

/**
 * Convert multiple tools to OpenAI format.
 *
 * @param tools - Array of internal tool definitions
 * @returns Array of OpenAI-compatible tool definitions
 */
export function toolsToOpenAIFormat(tools: Tool[]): OpenAIChatTool[] {
  return tools.map(toolToOpenAIFormat);
}
