/**
 * Tool Schema Converter
 *
 * Converts internal Tool definitions to OpenAI Chat Completions API format.
 * This enables native tool calling instead of markdown-based tool documentation.
 *
 * IMPORTANT: Tool names are sanitized for API compatibility.
 * Internal names use dots (core.memory) but some APIs only accept [a-zA-Z0-9_-].
 * We convert dots to underscores for the API and convert back when executing.
 */

import type { Tool, ToolParameter } from '../layers/cognition/tools/types.js';

/**
 * Sanitize tool name for API compatibility.
 * Converts dots to underscores: "core.memory" → "core_memory"
 *
 * Some LLM providers (e.g., Amazon Bedrock) only accept tool names
 * matching ^[a-zA-Z0-9_-]{1,128}$.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/\./g, '_');
}

/**
 * Unsanitize tool name back to internal format.
 * Converts underscores to dots for known prefixes: "core_memory" → "core.memory"
 *
 * Only converts the first underscore for known prefixes (core_, plugin_)
 * to avoid breaking tool names that legitimately contain underscores.
 */
export function unsanitizeToolName(name: string): string {
  // Known namespace prefixes that use dot notation internally
  const knownPrefixes = ['core_', 'plugin_'];

  for (const prefix of knownPrefixes) {
    if (name.startsWith(prefix)) {
      // Replace only the first underscore (the namespace separator)
      return name.replace('_', '.');
    }
  }

  return name;
}

/**
 * OpenAI Chat Completions tool format.
 * Used with the `tools` parameter in chat completions API.
 *
 * Note: `strict: true` is placed on the tool object (not inside function)
 * for OpenRouter compatibility. Some providers may strip this field.
 */
export interface OpenAIChatTool {
  type: 'function';
  /** Strict mode for schema adherence. Provider-dependent support. */
  strict?: boolean;
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, OpenAIPropertySchema>;
      /** Required parameters. Omitted when empty for provider compatibility. */
      required?: string[];
      /** Disallow additional properties (required for strict mode). */
      additionalProperties?: boolean;
    };
  };
}

/**
 * JSON Schema property definition for OpenAI tools.
 */
export interface OpenAIPropertySchema {
  /** JSON Schema type (string, number, boolean, object, array, or array for nullable) */
  type?: string | string[];
  description?: string;
  /** Enum constraint for string types */
  enum?: readonly string[];
  /** Items schema for array types */
  items?: OpenAIPropertySchema;
  /** Properties for object types */
  properties?: Record<string, OpenAIPropertySchema>;
}

/**
 * Map our parameter types to JSON Schema types.
 * For strict mode compliance, optional parameters use ["type", "null"].
 */
function mapParameterType(param: ToolParameter): OpenAIPropertySchema {
  // For strict mode: optional fields must be nullable (type becomes ["type", "null"])
  // All fields will be marked as required, but nullable fields can receive null
  const schema: OpenAIPropertySchema = {
    type: param.required ? param.type : [param.type, 'null'],
  };

  if (param.description) {
    schema.description = param.description;
  }

  // Handle enum constraint for string types
  if (param.enum && param.enum.length > 0) {
    schema.enum = param.enum;
  }

  // Handle array type - use empty object for items to allow any type
  // This is more flexible than assuming string items
  if (param.type === 'array') {
    schema.items = {};
  }

  return schema;
}

/**
 * Minimal tool format for MCP-style lazy schema loading.
 * Only includes name and description - no parameters.
 * LLM must call core.tools to get full schema before calling.
 */
export interface MinimalOpenAIChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
  };
}

/**
 * Convert a Tool to minimal format (name + description only).
 * Used for MCP-style lazy schema loading to reduce token usage.
 *
 * @param tool - Internal tool definition
 * @returns Minimal tool definition (no parameters)
 */
export function toolToMinimalFormat(tool: Tool): MinimalOpenAIChatTool {
  return {
    type: 'function',
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description.split('\n')[0] ?? tool.description, // First line only
    },
  };
}

/**
 * Convert a Tool to OpenAI Chat Completions tool format.
 *
 * @param tool - Internal tool definition
 * @param minimal - If true, only include name and description (no parameters)
 * @returns OpenAI-compatible tool definition (with sanitized name)
 */
export function toolToOpenAIFormat(
  tool: Tool,
  minimal = false
): OpenAIChatTool | MinimalOpenAIChatTool {
  if (minimal) {
    return toolToMinimalFormat(tool);
  }
  // If tool provides raw JSON Schema, use it directly (for complex schemas like discriminated unions)
  if (tool.rawParameterSchema) {
    return {
      type: 'function',
      strict: true,
      function: {
        name: sanitizeToolName(tool.name),
        description: tool.description,
        parameters: tool.rawParameterSchema as OpenAIChatTool['function']['parameters'],
      },
    };
  }

  // Otherwise, convert from ToolParameter[] format
  const properties: Record<string, OpenAIPropertySchema> = {};

  for (const param of tool.parameters) {
    properties[param.name] = mapParameterType(param);
  }

  // For strict mode: ALL fields must be in required array
  // Optional fields are handled by making their type nullable (["type", "null"])
  const allFieldNames = tool.parameters.map((p) => p.name);

  // Build the tool definition with sanitized name for API compatibility
  // Include strict: true and additionalProperties: false for schema adherence
  const result: OpenAIChatTool = {
    type: 'function',
    strict: true, // Enable strict mode for better schema adherence (provider-dependent)
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        additionalProperties: false, // Required for strict mode
      },
    },
  };

  // Include all fields in required (strict mode requirement)
  // Optional fields are nullable, so they can receive null values
  if (allFieldNames.length > 0) {
    result.function.parameters.required = allFieldNames;
  }

  return result;
}

/**
 * Convert multiple tools to OpenAI format (full schema).
 *
 * @param tools - Array of internal tool definitions
 * @returns Array of OpenAI-compatible tool definitions
 */
export function toolsToOpenAIFormat(tools: Tool[]): OpenAIChatTool[] {
  return tools.map((tool) => toolToOpenAIFormat(tool) as OpenAIChatTool);
}
