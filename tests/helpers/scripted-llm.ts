/**
 * Scripted LLM Provider for Testing
 *
 * A mock LLMProvider that replays a script of predetermined responses.
 * Enables testing motor loop scenarios without real LLM calls.
 */

import type { LLMProvider, CompletionRequest, CompletionResponse, ToolCall } from '../../src/llm/provider.js';

/**
 * Scripted response definition.
 */
export interface ScriptedResponse {
  /** Response content (optional - can be null for tool-only responses) */
  content?: string | null;

  /** Tool calls to return (optional) */
  toolCalls?: { name: string; args: Record<string, unknown> }[];

  /** Finish reason (defaults to 'stop' or 'tool_calls' based on content/toolCalls) */
  finishReason?: CompletionResponse['finishReason'];
}

/**
 * Scripted LLM Provider implementation.
 */
export class ScriptedLLMProvider implements LLMProvider {
  readonly name = 'scripted-test';

  /** Script of responses to replay */
  private script: ScriptedResponse[];

  /** Requests received for assertions */
  public requests: CompletionRequest[] = [];

  /** Number of complete() calls made */
  public callCount = 0;

  /** Current position in script */
  private index = 0;

  constructor(script: ScriptedResponse[]) {
    this.script = [...script];
  }

  isAvailable(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Record request for assertions
    this.requests.push(request);
    this.callCount++;

    // Check if script is exhausted
    if (this.index >= this.script.length) {
      throw new Error(
        `ScriptedLLM: Script exhausted (got ${this.callCount} calls, script has ${this.script.length} responses). Did you forget to add a response to the script?`
      );
    }

    const scripted = this.script[this.index++]!;

    // Build tool calls with auto-generated IDs
    const toolCalls: ToolCall[] | undefined = scripted.toolCalls?.map((tc, idx) => ({
      id: `call_${this.callCount - 1}_${idx}`,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      },
    }));

    // Determine finish reason
    let finishReason: CompletionResponse['finishReason'] = scripted.finishReason;
    if (!finishReason) {
      if (toolCalls && toolCalls.length > 0) {
        finishReason = 'tool_calls';
      } else {
        finishReason = 'stop';
      }
    }

    return {
      content: scripted.content ?? null,
      model: 'scripted-test-model',
      toolCalls,
      finishReason,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    };
  }

  /**
   * Reset the script to replay from the beginning.
   */
  reset(): void {
    this.index = 0;
    this.requests = [];
    this.callCount = 0;
  }

  /**
   * Get the next response without consuming it (peek).
   */
  peek(): ScriptedResponse | undefined {
    return this.script[this.index];
  }

  /**
   * Check if script is exhausted.
   */
  get isExhausted(): boolean {
    return this.index >= this.script.length;
  }

  /**
   * Get remaining response count.
   */
  get remaining(): number {
    return this.script.length - this.index;
  }
}

/**
 * Create a scripted LLM provider.
 */
export function createScriptedLLM(script: ScriptedResponse[]): ScriptedLLMProvider {
  return new ScriptedLLMProvider(script);
}

/**
 * Helper to create a content-only response.
 */
export function textResponse(content: string): ScriptedResponse {
  return { content };
}

/**
 * Helper to create a tool call response.
 */
export function toolCallResponse(
  name: string,
  args: Record<string, unknown>
): ScriptedResponse {
  return { toolCalls: [{ name, args }] };
}

/**
 * Helper to create multiple tool calls in one response.
 */
export function toolCallsResponse(
  toolCalls: { name: string; args: Record<string, unknown> }[]
): ScriptedResponse {
  return { toolCalls };
}

/**
 * Helper to create a completion with both content and tool calls.
 */
export function mixedResponse(
  content: string,
  toolCalls: { name: string; args: Record<string, unknown> }[]
): ScriptedResponse {
  return { content, toolCalls };
}
