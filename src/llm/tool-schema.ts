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
  enum?: (string | null)[];
  /** Items schema for array types */
  items?: OpenAIPropertySchema;
  /** Properties for object types */
  properties?: Record<string, OpenAIPropertySchema>;
  /** Required fields for object types */
  required?: string[];
  /** Disallow additional properties */
  additionalProperties?: boolean;
}

/**
 * Convert a canonical (non-strict) JSON Schema to OpenAI strict mode format.
 *
 * Transform rules:
 * - ALL property keys are added to `required` array
 * - Non-required field types become nullable: `type: 'string'` → `type: ['string', 'null']`
 * - `null` is added to enum arrays for non-required fields
 * - Recurses into nested `properties` and `items` objects
 *
 * @param schema - Canonical JSON Schema with explicit `required` array
 * @returns Strict mode schema where all fields are required but nullable
 */
export function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };

  // Get the original required array to distinguish truly required vs optional
  const originalRequired = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : []
  );

  // Get all property names
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;

  if (properties && typeof properties === 'object') {
    const newProperties: Record<string, Record<string, unknown>> = {};
    const allFieldNames = Object.keys(properties);

    for (const [key, prop] of Object.entries(properties)) {
      newProperties[key] = toStrictProperty(prop, originalRequired.has(key));
    }

    result['properties'] = newProperties;

    // In strict mode, ALL fields are in required
    if (allFieldNames.length > 0) {
      result['required'] = allFieldNames;
    }
  }

  // Handle array items
  const items = schema['items'] as Record<string, unknown> | undefined;
  if (items && typeof items === 'object') {
    result['items'] = toStrictSchema(items);
  }

  return result;
}

/**
 * Transform a single property for strict mode.
 */
function toStrictProperty(
  prop: Record<string, unknown>,
  isOriginallyRequired: boolean
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...prop };

  // If not originally required, make the type nullable
  if (!isOriginallyRequired) {
    const currentType = prop['type'];
    if (typeof currentType === 'string') {
      result['type'] = [currentType, 'null'];
    } else if (Array.isArray(currentType)) {
      // Already an array - ensure 'null' is included
      if (!currentType.includes('null')) {
        result['type'] = [...(currentType as string[]), 'null'];
      }
    }

    // Add null to enum if present
    const enumValues = prop['enum'] as (string | null)[] | undefined;
    if (Array.isArray(enumValues) && !enumValues.includes(null)) {
      result['enum'] = [...enumValues, null];
    }
  }

  // Recurse into nested object properties
  const nestedProps = prop['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (nestedProps && typeof nestedProps === 'object') {
    const nestedRequired = new Set(
      Array.isArray(prop['required']) ? (prop['required'] as string[]) : []
    );
    const newNestedProps: Record<string, Record<string, unknown>> = {};
    const allNestedFields = Object.keys(nestedProps);

    for (const [key, nestedProp] of Object.entries(nestedProps)) {
      newNestedProps[key] = toStrictProperty(nestedProp, nestedRequired.has(key));
    }

    result['properties'] = newNestedProps;

    // In strict mode, ALL nested fields are required
    if (allNestedFields.length > 0) {
      result['required'] = allNestedFields;
    }
  }

  // Handle nested array items
  const items = prop['items'] as Record<string, unknown> | undefined;
  if (items && typeof items === 'object') {
    result['items'] = toStrictSchema(items);
  }

  return result;
}

/**
 * Map our parameter types to JSON Schema types.
 * Generates canonical (non-strict) format — plain types only.
 * Strict mode nullable wrapping is handled by `toStrictSchema()`.
 */
function mapParameterType(param: ToolParameter): OpenAIPropertySchema {
  const schema: OpenAIPropertySchema = {
    type: param.type,
  };

  if (param.description) {
    schema.description = param.description;
  }

  // Handle enum constraint for string types
  if (param.enum && param.enum.length > 0) {
    schema.enum = [...param.enum];
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
 * Options for converting a Tool to OpenAI format.
 */
export interface ToolToOpenAIFormatOptions {
  /** If true, only include name and description (no parameters) */
  minimal?: boolean;
  /**
   * If true, apply OpenAI strict mode transformation.
   * - Strict mode: ALL fields in required, optional fields use nullable types
   * - Non-strict: Only truly required fields in required, plain types
   * Default: false (safer for non-OpenAI models)
   */
  strict?: boolean;
}

/**
 * Convert a Tool to OpenAI Chat Completions tool format.
 *
 * @param tool - Internal tool definition
 * @param optionsOrMinimal - Options object, or boolean for backward compatibility (minimal mode)
 * @returns OpenAI-compatible tool definition (with sanitized name)
 */
export function toolToOpenAIFormat(
  tool: Tool,
  optionsOrMinimal: boolean | ToolToOpenAIFormatOptions = {}
): OpenAIChatTool | MinimalOpenAIChatTool {
  // Handle backward-compatible boolean parameter
  const options: ToolToOpenAIFormatOptions =
    typeof optionsOrMinimal === 'boolean' ? { minimal: optionsOrMinimal } : optionsOrMinimal;

  if (options.minimal) {
    return toolToMinimalFormat(tool);
  }

  const strict = options.strict ?? false;

  // If tool provides raw JSON Schema
  if (tool.rawParameterSchema) {
    const parameters = strict
      ? (toStrictSchema(tool.rawParameterSchema) as OpenAIChatTool['function']['parameters'])
      : (tool.rawParameterSchema as OpenAIChatTool['function']['parameters']);

    const result: OpenAIChatTool = {
      type: 'function',
      function: {
        name: sanitizeToolName(tool.name),
        description: tool.description,
        parameters,
      },
    };

    // Only set strict flag when in strict mode
    if (strict) {
      result.strict = true;
    }

    return result;
  }

  // Otherwise, convert from ToolParameter[] format
  const properties: Record<string, OpenAIPropertySchema> = {};

  for (const param of tool.parameters) {
    properties[param.name] = mapParameterType(param);
  }

  // In strict mode: ALL fields must be in required array
  // In non-strict mode: only truly required fields
  const fieldNames = strict
    ? tool.parameters.map((p) => p.name)
    : tool.parameters.filter((p) => p.required).map((p) => p.name);

  const result: OpenAIChatTool = {
    type: 'function',
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        additionalProperties: false,
      },
    },
  };

  // Only set strict flag when in strict mode
  if (strict) {
    result.strict = true;
  }

  if (fieldNames.length > 0) {
    result.function.parameters.required = fieldNames;
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
