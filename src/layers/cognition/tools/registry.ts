/**
 * Tool Registry
 *
 * Manages tool registration and execution.
 * Tools are defined in separate files under core/ and plugins/.
 */

import type { Logger } from '../../../types/logger.js';
import type { ToolName, ToolResult } from '../../../types/cognition.js';
import type { Tool, ToolRequest, ToolParameter } from './types.js';
import { createToolResult } from './types.js';
import type { OpenAIChatTool, MinimalOpenAIChatTool } from '../../../llm/tool-schema.js';
import { toolToOpenAIFormat, toolToMinimalFormat } from '../../../llm/tool-schema.js';

// Import core tool factories
import {
  createMemoryTool,
  createTimeTool,
  createStateTool,
  createToolsMetaTool,
  createThoughtTool,
  createAgentTool,
  createScheduleTool,
  createRememberTool,
  createInterestTool,
  createSoulTool,
  createEscalateTool,
  createDeferTool,
  createSayTool,
} from './core/index.js';
import type { SoulProvider } from '../../../storage/soul-provider.js';

// Import and re-export types for convenience
import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchOptions,
  SearchResult,
  RecentByTypeOptions,
  ConversationProvider,
  AgentStateProvider,
  UserModelProvider,
  ToolSchema,
} from './core/index.js';

export type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchOptions,
  SearchResult,
  RecentByTypeOptions,
  ConversationProvider,
  AgentStateProvider,
  UserModelProvider,
  ToolSchema,
};

/**
 * Dependencies for tool registry.
 */
export interface ToolRegistryDeps {
  memoryProvider?: MemoryProvider | undefined;
  agentStateProvider?: AgentStateProvider | undefined;
  userModelProvider?: UserModelProvider | undefined;
  conversationProvider?: ConversationProvider | undefined;
  soulProvider?: SoulProvider | undefined;
}

/**
 * Tool Registry - manages tool execution.
 */
export class ToolRegistry {
  private readonly tools = new Map<ToolName, Tool>();
  private readonly logger: Logger;
  private deps: ToolRegistryDeps;

  constructor(logger: Logger, deps: ToolRegistryDeps = {}) {
    this.logger = logger.child({ component: 'tool-registry' });
    this.deps = deps;
    this.registerCoreTools();
  }

  /**
   * Update dependencies (for late binding).
   */
  setDependencies(deps: Partial<ToolRegistryDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  /**
   * Execute a tool request.
   */
  async execute(request: ToolRequest): Promise<ToolResult> {
    const tool = this.tools.get(request.name);

    if (!tool) {
      this.logger.warn({ toolName: request.name }, 'Unknown tool requested');
      return createToolResult(
        request.toolCallId,
        request.name,
        false,
        undefined,
        `Unknown tool: ${request.name}`
      );
    }

    const startTime = Date.now();

    try {
      this.logger.debug(
        { tool: request.name, args: request.args, toolCallId: request.toolCallId },
        'Executing tool'
      );

      const result = await tool.execute(request.args, request.context);
      const duration = Date.now() - startTime;

      this.logger.debug(
        { tool: request.name, duration, toolCallId: request.toolCallId },
        'Tool executed successfully'
      );

      return createToolResult(request.toolCallId, request.name, true, result);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        { tool: request.name, error: errorMessage, duration, toolCallId: request.toolCallId },
        'Tool execution failed'
      );

      return createToolResult(request.toolCallId, request.name, false, undefined, errorMessage);
    }
  }

  /**
   * Check if a tool exists.
   */
  hasTool(name: ToolName): boolean {
    return this.tools.has(name);
  }

  /**
   * Check if a tool has side effects.
   */
  hasToolSideEffects(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.hasSideEffects ?? true;
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): ToolName[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all registered tools.
   */
  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool cards for prompt (brief descriptions + capability tags).
   */
  getToolCards(): string[] {
    const cards: string[] = [];
    const sortedTools = Array.from(this.tools.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, tool] of sortedTools) {
      if (name === 'core.tools') continue; // Skip meta-tool from card list

      const firstLine = tool.description.split('\n')[0] ?? '';
      const firstSentence = firstLine.split('.')[0] ?? '';
      const briefDesc = firstSentence.length > 0 ? firstSentence : tool.description;
      const tags = tool.tags && tool.tags.length > 0 ? ` [${tool.tags.join(', ')}]` : '';
      cards.push(`- ${name}: ${briefDesc}${tags}`);
    }
    return cards;
  }

  /**
   * Get full schema for a specific tool.
   * Includes rawParameterSchema when available for complex nested parameters.
   */
  getToolSchema(name: ToolName): {
    name: string;
    description: string;
    parameters: ToolParameter[];
    tags: string[];
    rawParameterSchema?: Record<string, unknown>;
  } | null {
    const tool = this.tools.get(name);
    if (!tool) return null;

    const schema: {
      name: string;
      description: string;
      parameters: ToolParameter[];
      tags: string[];
      rawParameterSchema?: Record<string, unknown>;
    } = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      tags: tool.tags ?? [],
    };

    // Include rawParameterSchema if available (for complex nested parameters)
    if (tool.rawParameterSchema) {
      schema.rawParameterSchema = tool.rawParameterSchema;
    }

    return schema;
  }

  /**
   * Get tools grouped by category (core vs plugin).
   */
  getToolsByCategory(): { core: Tool[]; plugins: Tool[] } {
    const core: Tool[] = [];
    const plugins: Tool[] = [];

    for (const tool of this.tools.values()) {
      if (tool.name.startsWith('core.')) {
        core.push(tool);
      } else {
        plugins.push(tool);
      }
    }

    return { core, plugins };
  }

  /**
   * Get all tools in OpenAI Chat Completions format (full schemas).
   * Used for native tool calling via the `tools` parameter.
   * Note: This sends ~3000 tokens per request - consider using getToolsWithLazySchema() instead.
   */
  getToolsAsOpenAIFormat(): OpenAIChatTool[] {
    return Array.from(this.tools.values()).map(
      (tool) => toolToOpenAIFormat(tool) as OpenAIChatTool
    );
  }

  /**
   * Get tools with lazy schema loading (MCP-style).
   * Only core.tools has full schema - all other tools have name + description only.
   * This reduces token usage by ~90% (from ~3000 to ~300 tokens).
   *
   * LLM must call core.tools({ action: "describe", name: "tool_name" }) before
   * calling any other tool to get its full schema.
   */
  getToolsWithLazySchema(): (OpenAIChatTool | MinimalOpenAIChatTool)[] {
    const result: (OpenAIChatTool | MinimalOpenAIChatTool)[] = [];

    for (const tool of this.tools.values()) {
      if (tool.name === 'core.tools') {
        // Meta-tool gets full schema so LLM knows how to call it
        result.push(toolToOpenAIFormat(tool) as OpenAIChatTool);
      } else {
        // All other tools: name + description only, NO parameters
        result.push(toolToMinimalFormat(tool));
      }
    }

    return result;
  }

  /**
   * Generate documentation for a tool including parameters.
   */
  getToolDocumentation(tool: Tool): string {
    const lines: string[] = [];
    lines.push(`### ${tool.name}`);
    lines.push(tool.description);

    if (tool.parameters.length > 0) {
      lines.push('Parameters:');
      for (const param of tool.parameters) {
        const reqMarker = param.required ? '(required)' : '(optional)';
        lines.push(`  - ${param.name}: ${param.type} ${reqMarker} - ${param.description}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate example tool call JSON for a tool.
   * Note: This is for documentation purposes. Native tool calling uses OpenAI format.
   */
  getToolExample(tool: Tool, toolCallId: string): string {
    const exampleArgs: Record<string, unknown> = {};

    for (const param of tool.parameters) {
      if (param.required) {
        // Generate example value based on type and name
        if (param.name === 'action') {
          // Use first word from description as action
          const match = /Action: (\w+)/.exec(param.description);
          exampleArgs[param.name] = match?.[1] ?? 'action';
        } else if (param.type === 'string') {
          exampleArgs[param.name] = `<${param.name}>`;
        } else if (param.type === 'number') {
          exampleArgs[param.name] = param.name === 'confidence' ? 0.8 : 0;
        } else if (param.type === 'object') {
          exampleArgs[param.name] = {};
        } else if (param.type === 'array') {
          exampleArgs[param.name] = [];
        } else {
          // param.type === 'boolean' (TypeScript narrowing)
          exampleArgs[param.name] = true;
        }
      }
    }

    // Native OpenAI tool call format
    const example = {
      id: toolCallId,
      type: 'function',
      function: {
        name: tool.name,
        arguments: JSON.stringify(exampleArgs),
      },
    };

    return JSON.stringify(example, null, 2);
  }

  /**
   * Register a new tool dynamically (for plugins).
   */
  registerTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn({ toolName: tool.name }, 'Tool already registered, replacing');
    }
    this.tools.set(tool.name, tool);
    this.logger.info({ toolName: tool.name }, 'Tool registered');
  }

  /**
   * Unregister a tool (for plugins).
   */
  unregisterTool(name: ToolName): boolean {
    const existed = this.tools.has(name);
    if (existed) {
      this.tools.delete(name);
      this.logger.info({ toolName: name }, 'Tool unregistered');
    }
    return existed;
  }

  /**
   * Register all core tools.
   */
  private registerCoreTools(): void {
    // Memory tool
    this.tools.set(
      'core.memory',
      createMemoryTool({
        memoryProvider: this.deps.memoryProvider,
      })
    );

    // Time tool
    this.tools.set(
      'core.time',
      createTimeTool({
        conversationProvider: this.deps.conversationProvider,
      })
    );

    // State tool
    this.tools.set(
      'core.state',
      createStateTool({
        agentStateProvider: this.deps.agentStateProvider,
        userModelProvider: this.deps.userModelProvider,
      })
    );

    // Meta-tool (needs reference to registry for schema lookup)
    this.tools.set(
      'core.tools',
      createToolsMetaTool({
        schemaProvider: this,
      })
    );

    // Thought tool
    this.tools.set('core.thought', createThoughtTool());

    // Agent tool
    this.tools.set('core.agent', createAgentTool());

    // Schedule tool
    this.tools.set('core.schedule', createScheduleTool());

    // Remember tool (unified fact storage - replaces core.user)
    this.tools.set('core.remember', createRememberTool());

    // Interest tool (dedicated topic interest tracking)
    this.tools.set('core.setInterest', createInterestTool());

    // Escalate tool (fast model only - requests smart model escalation)
    this.tools.set('core.escalate', createEscalateTool());

    // Defer tool (defer proactive contact - terminal)
    this.tools.set('core.defer', createDeferTool());

    // Say tool (intermediate messages - intercepted by agentic loop)
    this.tools.set('core.say', createSayTool());

    // Soul tool (identity introspection - only if soulProvider available)
    if (this.deps.soulProvider) {
      this.tools.set(
        'core.soul',
        createSoulTool({
          soulProvider: this.deps.soulProvider,
        })
      );
    }
  }
}

/**
 * Create a tool registry.
 */
export function createToolRegistry(logger: Logger, deps?: ToolRegistryDeps): ToolRegistry {
  return new ToolRegistry(logger, deps);
}
