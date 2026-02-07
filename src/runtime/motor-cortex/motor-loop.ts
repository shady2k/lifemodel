/**
 * Motor Cortex Loop
 *
 * The sub-agent iteration loop for Motor Cortex runs.
 * Handles LLM interaction, tool execution, state persistence, and result emission.
 */

import type { Logger } from '../../types/index.js';
import type { LLMProvider, Message } from '../../llm/provider.js';
import type { Signal } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { MotorRun, StepTrace, TaskResult } from './motor-protocol.js';
import type { MotorStateManager } from './motor-state.js';
import { getToolDefinitions, executeTool, createWorkspace } from './motor-tools.js';

/**
 * Parameters for running the motor loop.
 */
export interface MotorLoopParams {
  /** The run to execute */
  run: MotorRun;

  /** LLM provider for the sub-agent */
  llm: LLMProvider;

  /** State manager for persistence */
  stateManager: MotorStateManager;

  /** Callback to push signals */
  pushSignal: (signal: Signal) => void;

  /** Logger */
  logger: Logger;
}

/**
 * Consecutive failure threshold (same tool, same error).
 */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Run the Motor Cortex loop.
 *
 * This is the core sub-agent execution loop. It:
 * 1. Builds system prompt with task and tools
 * 2. Enters iteration loop (starting from stepCursor)
 * 3. Calls LLM, executes tools, records results
 * 4. Persists state after each tool execution
 * 5. Handles ask_user by pausing and emitting signal
 * 6. Detects consecutive failures and auto-fails
 * 7. Completes when LLM stops calling tools
 *
 * @param params - Loop parameters
 */
export async function runMotorLoop(params: MotorLoopParams): Promise<void> {
  const { run, llm, stateManager, pushSignal, logger } = params;
  const childLogger = logger.child({ runId: run.id });

  childLogger.info({ task: run.task, tools: run.tools }, 'Starting Motor Cortex loop');

  // Create workspace for this run
  const workspace = await createWorkspace();
  childLogger.debug({ workspace }, 'Workspace created');

  // Build tool context
  const toolContext = { workspace };

  // Get tool definitions
  const toolDefinitions = getToolDefinitions(run.tools);

  // Build initial messages if needed (for resumption)
  const messages = run.messages;

  // If resuming (stepCursor > 0), we need to rebuild messages up to cursor
  // For now, we trust that messages are already built correctly

  // Enter iteration loop
  let consecutiveFailures: { tool: string; errorCode: string; count: number } | null = null;

  for (let i = run.stepCursor; i < run.maxIterations; i++) {
    childLogger.debug({ iteration: i, messageCount: messages.length }, 'Loop iteration');

    // Call LLM
    const response = await llm.complete({
      messages,
      tools: toolDefinitions,
      toolChoice: 'auto',
      maxTokens: 4096,
      role: 'motor',
    });

    // Append assistant message
    const assistantMessage: Message = {
      role: 'assistant',
      content: response.content ?? null,
      ...(response.toolCalls && { tool_calls: response.toolCalls }),
    };
    messages.push(assistantMessage);

    // Create step trace
    const step: StepTrace = {
      iteration: i,
      timestamp: new Date().toISOString(),
      llmModel: response.model,
      toolCalls: [],
    };

    // Check if model made tool calls
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // No tool calls - task complete
      childLogger.info({ iteration: i }, 'No tool calls - task complete');

      const result: TaskResult = {
        ok: true,
        summary: response.content ?? 'Task completed without summary',
        runId: run.id,
        stats: {
          iterations: i + 1,
          durationMs: Date.now() - new Date(run.startedAt).getTime(),
          energyCost: run.energyConsumed,
          errors: run.trace.errors,
        },
      };

      // Update run and persist
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      run.result = result;
      run.stepCursor = i + 1;
      run.trace.steps.push(step);
      run.trace.totalIterations = i + 1;
      run.trace.totalDurationMs = result.stats.durationMs;
      run.trace.totalEnergyCost = result.stats.energyCost;

      await stateManager.updateRun(run);

      // Emit completion signal
      pushSignal(
        createSignal(
          'motor_result',
          'motor.cortex',
          { value: 1, confidence: 1 },
          {
            data: {
              kind: 'motor_result',
              runId: run.id,
              status: 'completed',
              result: {
                ok: result.ok,
                summary: result.summary,
                stats: result.stats,
              },
            },
          }
        )
      );

      childLogger.info({ summary: result.summary }, 'Motor Cortex run completed');
      return;
    }

    // Execute tool calls
    let awaitingInput = false;

    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown>;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        toolArgs = { raw: toolCall.function.arguments };
      }

      childLogger.debug({ tool: toolName, args: toolArgs }, 'Executing tool');

      // Check for ask_user
      if (toolName === 'ask_user') {
        const question = toolArgs['question'] as string;
        childLogger.info({ question }, 'Awaiting user input');

        // Update run state (store tool_call_id for atomicity on resume)
        run.status = 'awaiting_input';
        run.pendingQuestion = question;
        run.pendingToolCallId = toolCall.id;
        run.stepCursor = i;
        run.messages = messages;
        run.trace.steps.push(step);
        run.trace.totalIterations = i;

        await stateManager.updateRun(run);

        // Emit awaiting_input signal
        pushSignal(
          createSignal(
            'motor_result',
            'motor.cortex',
            { value: 1, confidence: 1 },
            {
              data: {
                kind: 'motor_result',
                runId: run.id,
                status: 'awaiting_input',
                question,
              },
            }
          )
        );

        awaitingInput = true;
        break; // Stop processing tools
      }

      // Execute other tools
      const toolResult = await executeTool(toolName, toolArgs, toolContext);

      // Record in step trace
      step.toolCalls.push({
        tool: toolName,
        args: toolArgs,
        result: toolResult,
        durationMs: toolResult.durationMs,
      });

      // Check for consecutive failures
      if (!toolResult.ok && toolResult.errorCode) {
        if (
          consecutiveFailures !== null &&
          consecutiveFailures.tool === toolName &&
          consecutiveFailures.errorCode === toolResult.errorCode
        ) {
          consecutiveFailures.count++;
        } else {
          consecutiveFailures = { tool: toolName, errorCode: toolResult.errorCode, count: 1 };
        }

        // Auto-fail on consecutive failures
        if (consecutiveFailures.count >= CONSECUTIVE_FAILURE_THRESHOLD) {
          childLogger.warn(
            { tool: toolName, errorCode: toolResult.errorCode, count: consecutiveFailures.count },
            'Consecutive failures detected - auto-failing'
          );

          run.status = 'failed';
          run.completedAt = new Date().toISOString();
          run.stepCursor = i;
          run.messages = messages;
          run.trace.steps.push(step);
          run.trace.totalIterations = i;
          run.trace.totalDurationMs = Date.now() - new Date(run.startedAt).getTime();
          run.trace.errors += consecutiveFailures.count;

          await stateManager.updateRun(run);

          // Emit failed signal
          pushSignal(
            createSignal(
              'motor_result',
              'motor.cortex',
              { value: 1, confidence: 1 },
              {
                data: {
                  kind: 'motor_result',
                  runId: run.id,
                  status: 'failed',
                  error: {
                    message: `Tool ${toolName} failed ${String(consecutiveFailures.count)} times with error: ${toolResult.errorCode}`,
                    lastStep: `Iteration ${String(i)}`,
                  },
                },
              }
            )
          );

          return;
        }
      } else {
        // Reset consecutive failures on success
        consecutiveFailures = null;
      }

      // Append tool result message
      const toolMessage: Message = {
        role: 'tool',
        content: JSON.stringify({
          ok: toolResult.ok,
          output: toolResult.output,
          error: toolResult.errorCode,
        }),
        tool_call_id: toolCall.id,
      };
      messages.push(toolMessage);

      childLogger.debug(
        { tool: toolName, ok: toolResult.ok, durationMs: toolResult.durationMs },
        'Tool executed'
      );
    }

    // If awaiting input, exit loop (already persisted in the ask_user handler above)
    if (awaitingInput) {
      childLogger.info('Paused awaiting user input');
      return;
    }

    // Persist state after tool execution
    run.stepCursor = i + 1;
    run.messages = messages;
    run.trace.steps.push(step);
    run.trace.totalIterations = i + 1;
    run.trace.llmCalls += 1;
    run.trace.toolCalls += step.toolCalls.length;
    run.trace.errors = run.trace.errors + step.toolCalls.filter((t) => !t.result.ok).length;

    await stateManager.updateRun(run);
  }

  // Max iterations reached - fail with partial result
  childLogger.warn({ maxIterations: run.maxIterations }, 'Max iterations reached');

  run.status = 'failed';
  run.completedAt = new Date().toISOString();
  run.trace.totalDurationMs = Date.now() - new Date(run.startedAt).getTime();

  await stateManager.updateRun(run);

  pushSignal(
    createSignal(
      'motor_result',
      'motor.cortex',
      { value: 1, confidence: 1 },
      {
        data: {
          kind: 'motor_result',
          runId: run.id,
          status: 'failed',
          error: {
            message: `Max iterations (${String(run.maxIterations)}) reached without completion`,
            lastStep: `Iteration ${String(run.maxIterations)}`,
          },
        },
      }
    )
  );
}

/**
 * Build system prompt for the motor sub-agent.
 */
export function buildMotorSystemPrompt(run: MotorRun): string {
  const toolsDesc = run.tools
    .map((t) => {
      switch (t) {
        case 'code':
          return '- code: Execute JavaScript code';
        case 'filesystem':
          return '- filesystem: Read/write/list files';
        case 'ask_user':
          return '- ask_user: Ask the user a question';
      }
    })
    .join('\n');

  return `You are a task execution assistant. Your job is to complete the following task using the available tools.

Task: ${run.task}

Available tools:
${toolsDesc}

Guidelines:
- Break down complex tasks into steps
- Use code for calculations and data processing
- Use filesystem to manage intermediate data
- Ask the user if you need clarification or approval
- Be concise and direct in your responses
- Report what you did and the result

Maximum iterations: ${String(run.maxIterations)}

Begin by analyzing the task and planning your approach. Then execute step by step.`;
}

/**
 * Build initial messages for a new run.
 */
export function buildInitialMessages(run: MotorRun): Message[] {
  return [
    {
      role: 'system',
      content: buildMotorSystemPrompt(run),
    },
  ];
}
