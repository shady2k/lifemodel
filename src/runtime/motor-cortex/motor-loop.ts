/**
 * Motor Cortex Loop
 *
 * The sub-agent iteration loop for Motor Cortex runs.
 * Handles LLM interaction, tool execution, state persistence, and result emission.
 *
 * Operates on a single MotorAttempt — the run-level lifecycle is managed by motor-cortex.ts.
 */

import type { Logger } from '../../types/index.js';
import type { LLMProvider, Message } from '../../llm/provider.js';
import type { Signal } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type {
  MotorRun,
  MotorAttempt,
  MotorTool,
  StepTrace,
  TaskResult,
  FailureSummary,
  FailureCategory,
  SyntheticTool,
} from './motor-protocol.js';
import type { MotorStateManager } from './motor-state.js';
import {
  getToolDefinitions,
  executeTool,
  createWorkspace,
  SYNTHETIC_TOOL_DEFINITIONS,
} from './motor-tools.js';
import type { ContainerHandle } from '../container/types.js';
import { credentialToRuntimeKey } from '../vault/credential-store.js';
import { createTaskLogger, redactCredentials } from './task-logger.js';
import { validateToolArgs } from '../../utils/tool-validation.js';
import { truncateToolOutput } from './tool-truncation.js';
import { join } from 'node:path';
import type { PreparedDeps } from '../dependencies/dependency-manager.js';

/**
 * Parameters for running the motor loop.
 *
 * Motor Cortex is a pure runtime - all context must be passed explicitly.
 * The caller (core.act) resolves credentials, prepares workspaces, builds prompts, and installs deps.
 */
export interface MotorLoopParams {
  /** The run (for run-level metadata like id, task, tools) */
  run: MotorRun;

  /** The specific attempt to execute */
  attempt: MotorAttempt;

  /** LLM provider for the sub-agent */
  llm: LLMProvider;

  /** State manager for persistence */
  stateManager: MotorStateManager;

  /** Callback to push signals */
  pushSignal: (signal: Signal) => void;

  /** Logger */
  logger: Logger;

  /** Which synthetic tools to inject (required, controlled by caller) */
  syntheticTools: SyntheticTool[];

  /** Base directory for persisting run artifacts (optional) */
  artifactsBaseDir?: string;

  /** Container handle for Docker-isolated execution (optional) */
  containerHandle?: ContainerHandle;

  /** Pre-created workspace directory (optional — if not provided, one is created) */
  workspace?: string;

  /** DI callback for web fetch (optional) */
  fetchFn?: (
    url: string,
    opts?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    }
  ) => Promise<{ ok: boolean; status: number; content: string; contentType: string }>;

  /** Abort signal for cancellation (optional) */
  abortSignal?: AbortSignal;

  // === Explicit context (passed by caller, Motor doesn't know what it means) ===
  /** Resolved credential name → value map */
  credentials?: Record<string, string>;
  /** Credential names (for save_credential scope check) */
  credentialNames?: string[];

  // === Dependencies (pre-installed by caller) ===
  /** Pre-installed deps mounts (volume names + env) */
  preparedDeps?: PreparedDeps;
}

/**
 * Consecutive failure threshold (same tool, same error).
 */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Max tokens for failure hint generation.
 */
const FAILURE_HINT_MAX_TOKENS = 256;

/**
 * Run the Motor Cortex loop for a single attempt.
 *
 * This is the core sub-agent execution loop. It:
 * 1. Builds system prompt with task and tools (+ recovery context if retrying)
 * 2. Enters iteration loop (starting from stepCursor)
 * 3. Calls LLM, executes tools, records results
 * 4. Persists state after each tool execution
 * 5. Handles ask_user by pausing and emitting signal
 * 6. Detects consecutive failures and auto-fails
 * 7. Completes when LLM stops calling tools
 *
 * @param params - Loop parameters
 */
/**
 * Ensures every tool_call in assistant messages has exactly one matching tool result.
 * Strips orphaned tool_calls (those without a corresponding tool message) to prevent
 * LLM API rejections like "Tool results are missing."
 */
function sanitizeToolCallResultPairs(messages: Message[]): void {
  const toolResultIds = new Set(
    messages
      .filter((m): m is Message & { tool_call_id: string } => m.role === 'tool' && !!m.tool_call_id)
      .map((m) => m.tool_call_id)
  );

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const matched = msg.tool_calls.filter((tc) => toolResultIds.has(tc.id));
      if (matched.length < msg.tool_calls.length) {
        if (matched.length > 0) {
          msg.tool_calls = matched;
        } else {
          delete msg.tool_calls;
        }
      }
    }
  }
}

export async function runMotorLoop(params: MotorLoopParams): Promise<void> {
  const { run, attempt, llm, stateManager, pushSignal, logger } = params;
  const childLogger = logger.child({ runId: run.id, attemptId: attempt.id });

  childLogger.info(
    { task: run.task, tools: run.tools, attemptIndex: attempt.index },
    'Starting Motor Cortex loop'
  );

  // Use pre-created workspace or create one
  const workspace = params.workspace ?? (await createWorkspace());
  childLogger.debug({ workspace }, 'Workspace ready');

  // Create per-run task log
  const taskLog = createTaskLogger(params.artifactsBaseDir, run.id);
  await taskLog?.log(`RUN ${run.id} attempt ${String(attempt.index)} started`);
  await taskLog?.log(`  Task: ${run.task}`);
  await taskLog?.log(`  Tools: ${run.tools.join(', ')}`);
  if (run.domains && run.domains.length > 0) {
    await taskLog?.log(`  Domains: ${run.domains.join(', ')}`);
  }
  await taskLog?.log(`  Max iterations: ${String(attempt.maxIterations)}`);
  await taskLog?.log(`  Workspace: ${workspace}`);
  if (attempt.recoveryContext) {
    await taskLog?.log(`  Recovery guidance: ${attempt.recoveryContext.guidance.slice(0, 5000)}`);
  }

  // Collect resolved credential values for redaction.
  // Any credential value that appears in tool results or LLM output will be masked.
  // Credentials are now passed explicitly via params.credentials (no credentialStore access).
  const credentialValues: string[] = [];
  if (params.credentials) {
    for (const value of Object.values(params.credentials)) {
      if (value && value.length >= 8) {
        // Only redact values long enough to be meaningful (avoid masking short strings)
        credentialValues.push(value);
      }
    }
  }

  /** Redact resolved credential values from text (prevents key leakage in output/summaries). */
  const redactValues = (text: string): string => {
    let result = text;
    for (const value of credentialValues) {
      if (result.includes(value)) {
        result = result.replaceAll(value, '[REDACTED]');
      }
    }
    return result;
  };

  // Build tool context with allowed roots (workspace only - skills copied to root)
  const allowedRoots = [workspace];
  const writeRoots = [workspace]; // Writes only allowed to workspace
  const toolContext = {
    workspace,
    allowedRoots,
    writeRoots,
    ...(params.containerHandle && { containerHandle: params.containerHandle }),
    ...(params.run.domains && { allowedDomains: params.run.domains }),
    ...(params.fetchFn && { fetchFn: params.fetchFn }),
  };

  // Get tool definitions
  const toolDefinitions = getToolDefinitions(run.tools);

  // Inject synthetic tools explicitly from params.syntheticTools
  // No fallback logic — caller always specifies what's allowed.
  for (const st of params.syntheticTools) {
    // Enforce: request_approval requires bash in tools
    if (st === 'request_approval' && !run.tools.includes('bash')) continue;
    toolDefinitions.push(SYNTHETIC_TOOL_DEFINITIONS[st]);
  }

  // Build schema map for validation
  const toolSchemaMap = new Map<string, Record<string, unknown>>();
  for (const def of toolDefinitions) {
    toolSchemaMap.set(def.function.name, def.function.parameters as Record<string, unknown>);
  }

  // Use attempt's messages (already built by caller)
  const messages = attempt.messages;

  // Log system prompt for debugging
  const systemMsg = messages.find((m) => m.role === 'system');
  if (systemMsg?.content) {
    await taskLog?.log(`\nSYSTEM PROMPT:\n${systemMsg.content}\n`);
  }

  // Deliver credentials to the container upfront.
  // Scripts use process.env.NAME, so credentials must be in the shell env
  // from the start — not lazily when placeholders are detected.
  //
  // Credentials are pre-resolved by core.act and passed via params.credentials.
  // Container env vars use plain NAME (no VAULT_ prefix) for ergonomic script access.
  if (params.containerHandle && params.credentials) {
    for (const [name, value] of Object.entries(params.credentials)) {
      if (value) {
        await params.containerHandle.deliverCredential(credentialToRuntimeKey(name), value);
        // Add to redaction array for output masking
        if (value.length >= 8) {
          credentialValues.push(value);
        }
      }
    }
  }

  // Enter iteration loop
  let consecutiveFailures: {
    tool: string;
    errorCode: string;
    argsKey: string;
    count: number;
  } | null = null;

  for (let i = attempt.stepCursor; i < attempt.maxIterations; i++) {
    // Check for cancellation before each iteration
    if (params.abortSignal?.aborted) {
      childLogger.info({ iteration: i }, 'Run canceled — aborting loop');
      await taskLog?.log(`\nCANCELED at iteration ${String(i)}`);
      attempt.status = 'failed';
      attempt.completedAt = new Date().toISOString();
      await params.stateManager.updateRun(params.run);
      return;
    }

    // Estimate cumulative message size for debugging context bloat
    const totalMsgBytes = messages.reduce(
      (sum, m) =>
        sum +
        Buffer.byteLength(
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          'utf-8'
        ),
      0
    );
    childLogger.debug(
      { iteration: i, messageCount: messages.length, totalMsgBytes },
      'Loop iteration'
    );
    await taskLog?.log(
      `\nITERATION ${String(i)} (${String(messages.length)} messages, ~${String(Math.round(totalMsgBytes / 1024))}KB in context)`
    );

    // Safety net: ensure every tool_call has a matching tool result before calling LLM
    sanitizeToolCallResultPairs(messages);

    // Call LLM (with retry on transient provider errors)
    let llmResponse: Awaited<ReturnType<typeof llm.complete>> | undefined;
    const LLM_MAX_RETRIES = 2;
    for (let retryIdx = 0; retryIdx <= LLM_MAX_RETRIES; retryIdx++) {
      try {
        llmResponse = await llm.complete({
          messages,
          tools: toolDefinitions,
          toolChoice: 'auto',
          maxTokens: 16384,
          role: 'motor',
          parallelToolCalls: false,
        });
        break; // Success
      } catch (llmError) {
        const errMsg = llmError instanceof Error ? llmError.message : String(llmError);
        childLogger.warn({ attempt: retryIdx, error: errMsg }, 'LLM call failed in motor loop');
        await taskLog?.log(
          `  LLM ERROR (attempt ${String(retryIdx + 1)}/${String(LLM_MAX_RETRIES + 1)}): ${errMsg.slice(0, 150)}`
        );

        if (retryIdx === LLM_MAX_RETRIES) {
          // Exhausted retries — fail the run gracefully instead of crashing
          throw llmError;
        }
        // Brief backoff before retry
        await new Promise((resolve) => setTimeout(resolve, 2000 * (retryIdx + 1)));
      }
    }

    // llmResponse is guaranteed defined here (break on success, throw on exhausted retries)
    if (!llmResponse) {
      throw new Error('LLM response is undefined after retries');
    }
    // Server-side enforcement: even if the provider ignores parallelToolCalls,
    // only execute one tool call per iteration to prevent orphaned tool_calls on pause.
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 1) {
      childLogger.info(
        { returned: llmResponse.toolCalls.length },
        'Truncating parallel tool calls to 1 (server-side enforcement)'
      );
      const first = llmResponse.toolCalls[0];
      if (first) llmResponse.toolCalls = [first];
    }

    const contentPreview = llmResponse.content
      ? redactCredentials(llmResponse.content.slice(0, 2000)).replace(/\n/g, ' ')
      : '(none)';
    const usage = llmResponse.usage;
    childLogger.debug(
      {
        iteration: i,
        model: llmResponse.model,
        generationId: llmResponse.generationId,
        toolCallCount: llmResponse.toolCalls?.length ?? 0,
        finishReason: llmResponse.finishReason,
        contentLength: llmResponse.content?.length ?? 0,
        contentPreview,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        cachedTokens: usage?.cacheReadTokens,
      },
      'LLM response received'
    );
    // Build token summary for task log: "tokens=1234/56 cached=1100" (prompt/completion cached=N)
    const tokenSummary = usage
      ? ` tokens=${String(usage.promptTokens)}/${String(usage.completionTokens)}${usage.cacheReadTokens ? ` cached=${String(usage.cacheReadTokens)}` : ''}`
      : '';
    const genId = llmResponse.generationId ? ` gen:${llmResponse.generationId}` : '';
    await taskLog?.log(
      `  LLM [${llmResponse.model}] → ${String(llmResponse.toolCalls?.length ?? 0)} tool calls, finish=${llmResponse.finishReason ?? 'unknown'}, content=${String(llmResponse.content?.length ?? 0)} chars${tokenSummary}${genId}`
    );
    if (llmResponse.content) {
      await taskLog?.log(`  Content: ${contentPreview}`);
    }
    const assistantMessage: Message = {
      role: 'assistant',
      content: llmResponse.content ?? null,
      ...(llmResponse.toolCalls && { tool_calls: llmResponse.toolCalls }),
    };
    messages.push(assistantMessage);

    // Create step trace
    const step: StepTrace = {
      iteration: i,
      timestamp: new Date().toISOString(),
      llmModel: llmResponse.model,
      toolCalls: [],
    };

    // Check if model made tool calls
    if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
      const summaryText = llmResponse.content ?? '';

      // Detect model outputting tool-call XML as text (tried to call tools without API support)
      const looksLikeXmlToolCall =
        /<invoke\s|<tool_call>|<\w+_call>/.test(summaryText) ||
        (/^<\w+[\s>]/m.test(summaryText) && /<\/\w+>/m.test(summaryText));

      // If there were errors in this attempt and the "summary" is empty or looks like
      // failed tool-call XML, this is a failure, not a successful completion
      if (attempt.trace.errors > 0 && (summaryText.trim().length === 0 || looksLikeXmlToolCall)) {
        childLogger.warn(
          { iteration: i, errors: attempt.trace.errors, hasXml: looksLikeXmlToolCall },
          'Model stopped with errors and no valid summary — treating as failure'
        );
        await taskLog?.log(`\nFAILED: Model stopped after errors with no valid output`);

        attempt.trace.steps.push(step);

        const failure = buildFailureSummary(attempt.trace, 0, undefined, 'model_failure');
        failure.hint = looksLikeXmlToolCall
          ? 'Model attempted tool calls via XML text instead of the tool API. The requested tools may not be available.'
          : 'Model stopped producing output after encountering errors.';

        attempt.status = 'failed';
        attempt.completedAt = new Date().toISOString();
        attempt.stepCursor = i;
        attempt.messages = messages;
        attempt.trace.totalIterations = i + 1;
        attempt.trace.totalDurationMs = Date.now() - new Date(attempt.startedAt).getTime();
        attempt.failure = failure;

        // Don't emit signal or mark run as failed if this is retryable
        // runLoopInBackground will handle auto-retry
        await stateManager.updateRun(run);

        await taskLog?.log(`  Category: ${failure.category}`);
        return;
      }

      // Genuine completion — model finished the task
      childLogger.info(
        {
          iteration: i,
          summaryLength: summaryText.length,
          errorsInAttempt: attempt.trace.errors,
        },
        'No tool calls - task complete'
      );

      // Note: Artifact persistence moved to motor-cortex.ts (after copyWorkspaceOut)
      // This allows artifacts to be copied from the container's workspace

      const result: TaskResult = {
        ok: true,
        summary: redactValues(llmResponse.content ?? 'Task completed without summary'),
        runId: run.id,
        // artifacts and installedSkills populated by motor-cortex.ts after loop completes
        stats: {
          iterations: i + 1,
          durationMs: Date.now() - new Date(attempt.startedAt).getTime(),
          energyCost: run.energyConsumed,
          errors: attempt.trace.errors,
        },
      };

      // Update attempt
      attempt.status = 'completed';
      attempt.completedAt = new Date().toISOString();
      attempt.stepCursor = i + 1;
      attempt.trace.steps.push(step);
      attempt.trace.totalIterations = i + 1;
      attempt.trace.totalDurationMs = result.stats.durationMs;
      attempt.trace.totalEnergyCost = result.stats.energyCost;

      // Update run
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      run.result = result;

      await stateManager.updateRun(run);

      // Completion signal emitted by motor-cortex.ts middleware (after extraction enriches result)
      childLogger.info({ summary: result.summary }, 'Motor Cortex run completed');
      await taskLog?.log(
        `\nCOMPLETED (${(result.stats.durationMs / 1000).toFixed(1)}s, ${String(result.stats.iterations)} iterations, ${String(result.stats.errors)} errors)`
      );
      await taskLog?.log(`  Summary: ${result.summary.slice(0, 2000)}`);
      return;
    }

    // Execute tool calls
    let awaitingInput = false;
    let awaitingApproval = false;

    for (const toolCall of llmResponse.toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown>;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        // Return specific error — don't validate { raw } against schema
        childLogger.warn(
          { tool: toolName, rawArgs: toolCall.function.arguments.slice(0, 200) },
          'Failed to parse tool arguments as JSON'
        );
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            ok: false,
            output: 'Invalid JSON in tool arguments. Provide valid JSON.',
            error: 'invalid_args',
          }),
          tool_call_id: toolCall.id,
        });
        step.toolCalls.push({
          tool: toolName,
          args: { raw: toolCall.function.arguments },
          result: {
            ok: false,
            output: 'Invalid JSON in tool arguments. Provide valid JSON.',
            errorCode: 'invalid_args',
            retryable: true,
            provenance: 'internal',
            durationMs: 0,
          },
          durationMs: 0,
        });
        await taskLog?.log(`    → FAIL (0ms): Invalid JSON arguments`);
        continue;
      }

      // Normalize ask_user alias: message → question (before validation)
      if (toolName === 'ask_user' && toolArgs['message'] && !toolArgs['question']) {
        toolArgs['question'] = toolArgs['message'];
        delete toolArgs['message'];
      }

      childLogger.debug({ tool: toolName, args: toolArgs }, 'Executing tool');
      const argsSummary = redactCredentials(JSON.stringify(toolArgs)).slice(0, 2000);
      await taskLog?.log(`  TOOL ${toolName}(${argsSummary})`);

      // Validate tool arguments against schema
      const toolSchema = toolSchemaMap.get(toolName);
      if (toolSchema) {
        const validation = validateToolArgs(toolArgs, toolSchema);
        if (!validation.success) {
          childLogger.warn(
            { tool: toolName, error: validation.error },
            'Tool argument validation failed'
          );
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: validation.error,
              error: 'invalid_args',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: toolName,
            args: toolArgs,
            result: {
              ok: false,
              output: validation.error,
              errorCode: 'invalid_args',
              retryable: true,
              provenance: 'internal',
              durationMs: 0,
            },
            durationMs: 0,
          });
          await taskLog?.log(`    → FAIL (0ms): ${validation.error}`);

          // Track consecutive failures so auto-fail guard triggers
          const argsKey = JSON.stringify(toolArgs);
          if (
            consecutiveFailures !== null &&
            consecutiveFailures.tool === toolName &&
            consecutiveFailures.errorCode === 'invalid_args' &&
            consecutiveFailures.argsKey === argsKey
          ) {
            consecutiveFailures.count++;
          } else {
            consecutiveFailures = { tool: toolName, errorCode: 'invalid_args', argsKey, count: 1 };
          }

          if (consecutiveFailures.count >= CONSECUTIVE_FAILURE_THRESHOLD) {
            childLogger.warn(
              { tool: toolName, errorCode: 'invalid_args', count: consecutiveFailures.count },
              'Consecutive validation failures detected - auto-failing'
            );
            await taskLog?.log(
              `\nFAILED: ${toolName} failed ${String(consecutiveFailures.count)}x with invalid_args`
            );

            attempt.trace.steps.push(step);
            const failure = buildFailureSummary(attempt.trace, consecutiveFailures.count, {
              tool: toolName,
              errorCode: 'invalid_args',
            });
            const hint = await getFailureHint(
              llm,
              messages,
              `Tool ${toolName} failed ${String(consecutiveFailures.count)} times with invalid_args`,
              childLogger
            );
            if (hint) failure.hint = hint;

            attempt.status = 'failed';
            attempt.completedAt = new Date().toISOString();
            attempt.stepCursor = i;
            attempt.messages = messages;
            attempt.trace.totalIterations = i;
            attempt.trace.totalDurationMs = Date.now() - new Date(attempt.startedAt).getTime();
            attempt.trace.errors += step.toolCalls.filter((t) => !t.result.ok).length;
            attempt.failure = failure;
            await stateManager.updateRun(run);
            return;
          }

          continue;
        }
        toolArgs = validation.data; // Use coerced args
      }

      // Validate tool is in granted tools or configured synthetic tools
      const allowedSyntheticTools = new Set<string>(params.syntheticTools);
      if (!allowedSyntheticTools.has(toolName) && !run.tools.includes(toolName as MotorTool)) {
        const toolMessage: Message = {
          role: 'tool',
          content: JSON.stringify({
            ok: false,
            output: `Tool "${toolName}" is not available. Granted tools: ${run.tools.join(', ')}. Use only the tools listed above.`,
            error: 'tool_not_available',
          }),
          tool_call_id: toolCall.id,
        };
        messages.push(toolMessage);
        step.toolCalls.push({
          tool: toolName,
          args: toolArgs,
          result: {
            ok: false,
            output: `Tool "${toolName}" not in granted tools: ${run.tools.join(', ')}`,
            errorCode: 'tool_not_available',
            retryable: false,
            provenance: 'internal',
            durationMs: 0,
          },
          durationMs: 0,
        });
        await taskLog?.log(
          `    → FAIL (0ms): Tool "${toolName}" not available. Granted: ${run.tools.join(', ')}`
        );
        continue;
      }

      // Check for request_approval (internal tool, like ask_user with timeout)
      if (toolName === 'request_approval') {
        const action = (toolArgs['action'] as string | undefined) ?? 'Unknown action';
        childLogger.info({ action }, 'Awaiting approval');

        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

        attempt.status = 'awaiting_approval';
        attempt.pendingApproval = {
          action,
          stepCursor: i,
          expiresAt,
        };
        attempt.pendingToolCallId = toolCall.id;
        attempt.stepCursor = i;
        attempt.messages = messages;
        attempt.trace.steps.push(step);
        attempt.trace.totalIterations = i;

        run.status = 'awaiting_approval';
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
                status: 'awaiting_approval',
                attemptIndex: attempt.index,
                approval: { action, expiresAt },
              },
            }
          )
        );

        awaitingApproval = true;
        break;
      }

      // Check for ask_user
      if (toolName === 'ask_user') {
        const rawQ = toolArgs['question'];
        const question = typeof rawQ === 'string' ? rawQ : '';
        childLogger.info({ question }, 'Awaiting user input');

        // Update attempt state
        attempt.status = 'awaiting_input';
        attempt.pendingQuestion = question;
        attempt.pendingToolCallId = toolCall.id;
        attempt.stepCursor = i;
        attempt.messages = messages;
        attempt.trace.steps.push(step);
        attempt.trace.totalIterations = i;

        run.status = 'awaiting_input';
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
                attemptIndex: attempt.index,
                question,
              },
            }
          )
        );

        awaitingInput = true;
        break; // Stop processing tools
      }

      // Handle save_credential — persist a credential obtained during the run (e.g. signup API key)
      if (toolName === 'save_credential') {
        const credName = typeof toolArgs['name'] === 'string' ? toolArgs['name'] : '';
        const credValue = typeof toolArgs['value'] === 'string' ? toolArgs['value'] : '';
        const startTime = Date.now();

        if (!credName || !credValue) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: 'Missing required fields: name and value.',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: 'save_credential',
            args: toolArgs,
            result: {
              ok: false,
              output: 'Missing required fields: name and value.',
              errorCode: 'invalid_args',
              retryable: true,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          });
          continue;
        }
        if (!/^[a-zA-Z0-9_]+$/.test(credName)) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: 'Invalid name format. Use alphanumeric characters and underscores only.',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: 'save_credential',
            args: toolArgs,
            result: {
              ok: false,
              output: 'Invalid name format. Use alphanumeric characters and underscores only.',
              errorCode: 'invalid_args',
              retryable: true,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          });
          continue;
        }

        // Scope enforcement: if credentialNames is declared, only allow names in that list.
        // If absent, allow any name (the caller will handle persistence).
        if (
          params.credentialNames &&
          params.credentialNames.length > 0 &&
          !params.credentialNames.includes(credName)
        ) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: `Credential "${credName}" not in allowed list. Allowed: ${params.credentialNames.join(', ')}`,
              error: 'permission_denied',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: 'save_credential',
            args: toolArgs,
            result: {
              ok: false,
              output: `Credential "${credName}" not in allowed list. Allowed: ${params.credentialNames.join(', ')}`,
              errorCode: 'permission_denied',
              retryable: false,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          });
          continue;
        }

        // Store in pendingCredentials on run (Cognition will persist after the run)
        const runtimeKey = credentialToRuntimeKey(credName);
        run.pendingCredentials = run.pendingCredentials ?? {};
        run.pendingCredentials[credName] = credValue;
        childLogger.info({ name: credName }, 'Credential stored in pendingCredentials');

        // Best-effort delivery to container (fire-and-forget)
        if (params.containerHandle) {
          try {
            await params.containerHandle.deliverCredential(runtimeKey, credValue);
          } catch {
            // Ignore delivery errors — credential is stored for future runs
          }
        }

        // Add to redaction array for output masking
        if (credValue.length >= 8) {
          credentialValues.push(credValue);
        }

        // Also save to passed credentials for this run's duration
        if (params.credentials) {
          params.credentials[credName] = credValue;
        }

        const successMsg = `Credential "${credName}" saved. Available as $${runtimeKey} in this and future runs.`;
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            ok: true,
            output: successMsg,
          }),
          tool_call_id: toolCall.id,
        });
        step.toolCalls.push({
          tool: 'save_credential',
          args: toolArgs,
          result: {
            ok: true,
            output: successMsg,
            retryable: false,
            provenance: 'internal',
            durationMs: Date.now() - startTime,
          },
          durationMs: Date.now() - startTime,
        });
        await taskLog?.log(`    → Credential "${credName}" saved`);
        continue;
      }

      // Resolve credential placeholders in tool args (AFTER state persistence, BEFORE execution)
      // Always resolve on the host side — both container and direct execution paths need resolved args
      // Recurses into nested objects (e.g. headers: {"Authorization": "Bearer <credential:key>"})
      // IMPORTANT: Skip resolution for file content fields (write.content, patch.new_text) to prevent
      // credential values from being persisted to disk. Placeholders stay as-is in files.
      const SKIP_CREDENTIAL_RESOLUTION: Record<string, Set<string>> = {
        write: new Set(['content']),
        patch: new Set(['new_text', 'replacement']),
      };
      const skipFields = SKIP_CREDENTIAL_RESOLUTION[toolName];

      let resolvedArgs = toolArgs;
      // Credential placeholder resolution: resolve <credential:name> placeholders using explicit credentials.
      // Motor Cortex is now a pure runtime — no credentialStore access.
      // Placeholders in tool args are resolved to actual values from params.credentials.
      if (params.credentials) {
        const allMissing: string[] = [];
        // Create a minimal credential resolver from explicit credentials map
        const credMap = params.credentials;
        const resolveValue = (val: unknown): unknown => {
          if (typeof val === 'string') {
            // Simple regex-based placeholder resolution (no store needed)
            // Matches: <credential:NAME>, $NAME, ${NAME}
            const { resolved, missing } = resolvePlaceholders(val, credMap);
            allMissing.push(...missing);
            return resolved;
          }
          if (Array.isArray(val)) return val.map(resolveValue);
          if (val !== null && typeof val === 'object') {
            return Object.fromEntries(
              Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, resolveValue(v)])
            );
          }
          return val;
        };
        resolvedArgs = Object.fromEntries(
          Object.entries(toolArgs).map(([k, v]) => [k, skipFields?.has(k) ? v : resolveValue(v)])
        );
        if (allMissing.length > 0) {
          // Return error for missing credentials — don't crash
          const toolMessage: Message = {
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: `Missing credentials: ${allMissing.join(', ')}. Set them via VAULT_<NAME> env vars.`,
              error: 'auth_failed',
            }),
            tool_call_id: toolCall.id,
          };
          messages.push(toolMessage);
          step.toolCalls.push({
            tool: toolName,
            args: toolArgs, // Log original args with placeholders, not resolved
            result: {
              ok: false,
              output: `Missing credentials: ${allMissing.join(', ')}`,
              errorCode: 'auth_failed',
              retryable: false,
              provenance: 'internal',
              durationMs: 0,
            },
            durationMs: 0,
          });
          continue;
        }
      }

      // Placeholder resolution helper: resolve <credential:NAME>, $NAME, ${NAME} using explicit credentials
      function resolvePlaceholders(
        text: string,
        credentials: Record<string, string>
      ): { resolved: string; missing: string[] } {
        const missing: string[] = [];
        let result = text;

        // 1. Resolve <credential:NAME> placeholders (our convention, case-sensitive)
        result = result.replace(
          /<credential:([a-zA-Z0-9_]+)>/gi,
          (_match: string, name: string) => {
            const value = credentials[name];
            if (value !== undefined) {
              return value; // Replace with actual value
            }
            missing.push(name);
            return _match; // Keep placeholder if missing
          }
        );

        // 2. Resolve ${NAME} placeholders (shell-style, typically uppercase)
        result = result.replace(/\$\{([A-ZA-Z0-9_]+)\}/gi, (_match: string, name: string) => {
          const value = credentials[name];
          if (value !== undefined) {
            return value; // Replace with actual value
          }
          missing.push(name);
          return _match; // Keep placeholder if missing
        });

        // 3. Resolve process.env.NAME placeholders (JavaScript-style)
        result = result.replace(
          /process\.env\.([A-ZA-Z0-9_]+)/gi,
          (_match: string, name: string) => {
            const value = credentials[name];
            if (value !== undefined) {
              return value; // Replace with actual value
            }
            missing.push(name);
            return _match; // Keep placeholder if missing
          }
        );

        return { resolved: result, missing };
      }

      // Log shell description if provided
      if (toolName === 'bash' && toolArgs['description']) {
        await taskLog?.log(`    [${toolArgs['description'] as string}]`);
      }

      // Execute other tools
      const toolResult = await executeTool(toolName, resolvedArgs, toolContext);

      // Enrich domain-related errors with allowed domains list.
      // Skip if the error already contains the allowed domains (e.g. from the domain-block check).
      if (
        !toolResult.ok &&
        toolResult.output &&
        (toolResult.output.toLowerCase().includes('domain') ||
          toolResult.output.toLowerCase().includes('allowed')) &&
        !toolResult.output.includes('Allowed domains:') &&
        run.domains &&
        run.domains.length > 0
      ) {
        toolResult.output += `\nAllowed domains: ${run.domains.join(', ')}. You MUST call ask_user to request access — do not work around this.`;
      }

      // Apply universal truncation to prevent massive tool outputs from bloating context.
      // This runs AFTER domain error enrichment (so hints are preserved) but BEFORE
      // step trace and message storage (so both use truncated content).
      const redactedOutput = redactValues(toolResult.output);
      const outputBytes = Buffer.byteLength(redactedOutput, 'utf-8');

      // Skip re-truncation when reading .motor-output/ files — content was already
      // truncated when saved, and read's offset/limit already constrains output size.
      // Re-truncating causes cascading read-stacking (read → save → read → save → ...).
      const readingMotorOutput =
        toolName === 'read' &&
        typeof toolArgs['path'] === 'string' &&
        toolArgs['path'].startsWith('.motor-output/');

      if (readingMotorOutput) {
        toolResult.output = redactedOutput;
        childLogger.debug(
          { tool: toolName, outputBytes },
          'Skipped re-truncation for .motor-output/ read'
        );
      } else {
        const truncation = await truncateToolOutput(
          redactedOutput,
          toolName,
          toolCall.id,
          workspace,
          { toolOk: toolResult.ok }
        );
        toolResult.output = truncation.content; // Mutate before trace and message storage

        if (truncation.truncated) {
          childLogger.info(
            {
              tool: toolName,
              callId: toolCall.id,
              originalBytes: truncation.originalBytes,
              truncatedBytes: Buffer.byteLength(truncation.content, 'utf-8'),
              savedPath: truncation.savedPath,
            },
            'Tool output truncated'
          );
          await taskLog?.log(
            `    [truncated: ${String(truncation.originalBytes)} → ${String(Buffer.byteLength(truncation.content, 'utf-8'))} bytes, saved to ${String(truncation.savedPath)}]`
          );

          // Write spillover file into container via IPC so read/bash tools can access it.
          // truncateToolOutput saves to the HOST staging dir, but tools execute INSIDE
          // the container (named volume). Use the container's own write tool via IPC.
          if (params.containerHandle && truncation.savedPath) {
            const hostFilePath = join(workspace, truncation.savedPath);
            try {
              const { readFile: readSpillover } = await import('node:fs/promises');
              const spilloverContent = await readSpillover(hostFilePath, 'utf-8');
              await params.containerHandle.execute({
                type: 'execute',
                id: crypto.randomUUID(),
                tool: 'write',
                args: { path: truncation.savedPath, content: spilloverContent },
                timeoutMs: 15_000,
              });
            } catch (err) {
              // Non-fatal: model can still see the truncated pointer
              childLogger.debug(
                {
                  savedPath: truncation.savedPath,
                  error: err instanceof Error ? err.message : String(err),
                },
                'Failed to write spillover file into container (non-fatal)'
              );
            }
          }
        } else {
          childLogger.debug({ tool: toolName, outputBytes }, 'Tool output within limits');
        }
      }

      // Record in step trace
      step.toolCalls.push({
        tool: toolName,
        args: toolArgs,
        result: toolResult,
        durationMs: toolResult.durationMs,
      });

      // Check for consecutive failures
      if (!toolResult.ok && toolResult.errorCode) {
        const argsKey = JSON.stringify(toolArgs);
        if (
          consecutiveFailures !== null &&
          consecutiveFailures.tool === toolName &&
          consecutiveFailures.errorCode === toolResult.errorCode &&
          consecutiveFailures.argsKey === argsKey
        ) {
          consecutiveFailures.count++;
        } else {
          consecutiveFailures = {
            tool: toolName,
            errorCode: toolResult.errorCode,
            argsKey,
            count: 1,
          };
        }

        childLogger.debug(
          {
            tool: toolName,
            errorCode: toolResult.errorCode,
            consecutiveCount: consecutiveFailures.count,
            threshold: CONSECUTIVE_FAILURE_THRESHOLD,
          },
          'Tool failure recorded'
        );

        // Auto-fail on consecutive failures
        if (consecutiveFailures.count >= CONSECUTIVE_FAILURE_THRESHOLD) {
          childLogger.warn(
            { tool: toolName, errorCode: toolResult.errorCode, count: consecutiveFailures.count },
            'Consecutive failures detected - auto-failing'
          );
          await taskLog?.log(
            `\nFAILED: ${toolName} failed ${String(consecutiveFailures.count)}x with ${toolResult.errorCode}`
          );

          // Push step to trace BEFORE buildFailureSummary so lastToolResults includes the failing call
          attempt.trace.steps.push(step);

          // Build structured failure summary
          const failure = buildFailureSummary(attempt.trace, consecutiveFailures.count, {
            tool: toolName,
            errorCode: toolResult.errorCode,
          });

          // Try to get a hint from the LLM (best-effort)
          const hint = await getFailureHint(
            llm,
            messages,
            `Tool ${toolName} failed ${String(consecutiveFailures.count)} times with ${toolResult.errorCode}`,
            childLogger
          );
          if (hint) {
            failure.hint = hint;
          }

          attempt.status = 'failed';
          attempt.completedAt = new Date().toISOString();
          attempt.stepCursor = i;
          attempt.messages = messages;
          attempt.trace.totalIterations = i;
          attempt.trace.totalDurationMs = Date.now() - new Date(attempt.startedAt).getTime();
          attempt.trace.errors += step.toolCalls.filter((t) => !t.result.ok).length;
          attempt.failure = failure;

          // Don't emit signal or mark run as failed if retryable
          // runLoopInBackground will handle auto-retry
          await stateManager.updateRun(run);

          return;
        }
      } else {
        // Reset consecutive failures on success
        consecutiveFailures = null;
      }

      // Append tool result message (redact credential values to prevent leakage via LLM echoing)
      const toolMessage: Message = {
        role: 'tool',
        content: JSON.stringify({
          ok: toolResult.ok,
          output: redactValues(toolResult.output),
          error: toolResult.errorCode,
        }),
        tool_call_id: toolCall.id,
      };
      messages.push(toolMessage);

      const resultPreview = redactCredentials(toolResult.output.slice(0, 2000)).replace(/\n/g, ' ');
      await taskLog?.log(
        `    → ${toolResult.ok ? 'OK' : 'FAIL'} (${String(toolResult.durationMs)}ms): ${resultPreview}`
      );

      // Auto-pause on domain blocks — don't rely on weak models to call ask_user.
      // Extract blocked domain from the error and auto-trigger ask_user.
      if (
        !toolResult.ok &&
        toolResult.errorCode === 'permission_denied' &&
        toolResult.output.startsWith('BLOCKED: Domain ')
      ) {
        const domainMatch = /^BLOCKED: Domain (\S+)/.exec(toolResult.output);
        const blockedDomain = domainMatch?.[1] ?? 'unknown';
        const question = `The task needs access to domain "${blockedDomain}" which is not in the allowed list. Grant access?`;

        childLogger.info({ blockedDomain }, 'Auto-pausing for domain access request');
        await taskLog?.log(`    → AUTO ask_user: ${question}`);

        attempt.status = 'awaiting_input';
        attempt.pendingQuestion = question;
        attempt.pendingToolCallId = toolCall.id;
        attempt.stepCursor = i;
        attempt.messages = messages;
        attempt.trace.steps.push(step);
        attempt.trace.totalIterations = i;

        run.status = 'awaiting_input';
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
                status: 'awaiting_input',
                attemptIndex: attempt.index,
                question,
              },
            }
          )
        );

        awaitingInput = true;
        break;
      }

      childLogger.debug(
        { tool: toolName, ok: toolResult.ok, durationMs: toolResult.durationMs },
        'Tool executed'
      );
    }

    // If awaiting input or approval, exit loop (already persisted above)
    if (awaitingInput) {
      childLogger.info('Paused awaiting user input');
      return;
    }
    if (awaitingApproval) {
      childLogger.info('Paused awaiting approval');
      return;
    }

    // Persist state after tool execution
    const stepErrors = step.toolCalls.filter((t) => !t.result.ok).length;
    attempt.stepCursor = i + 1;
    attempt.messages = messages;
    attempt.trace.steps.push(step);
    attempt.trace.totalIterations = i + 1;
    attempt.trace.llmCalls += 1;
    attempt.trace.toolCalls += step.toolCalls.length;
    attempt.trace.errors = attempt.trace.errors + stepErrors;

    childLogger.debug(
      {
        iteration: i,
        stepToolCalls: step.toolCalls.length,
        stepErrors,
        totalErrors: attempt.trace.errors,
        totalToolCalls: attempt.trace.toolCalls,
      },
      'Iteration complete — state persisted'
    );

    await stateManager.updateRun(run);
  }

  // Max iterations reached - fail with structured summary
  childLogger.warn({ maxIterations: attempt.maxIterations }, 'Max iterations reached');
  await taskLog?.log(`\nFAILED: Max iterations (${String(attempt.maxIterations)}) reached`);

  const failure = buildFailureSummary(attempt.trace, 0, undefined, 'budget_exhausted');

  attempt.status = 'failed';
  attempt.completedAt = new Date().toISOString();
  attempt.trace.totalDurationMs = Date.now() - new Date(attempt.startedAt).getTime();
  attempt.failure = failure;

  run.status = 'failed';
  run.completedAt = new Date().toISOString();

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
          attemptIndex: attempt.index,
          failure,
          error: {
            message: `Max iterations (${String(attempt.maxIterations)}) reached without completion`,
            lastStep: `Iteration ${String(attempt.maxIterations)}`,
          },
        },
      }
    )
  );
}

/**
 * Build a FailureSummary from trace data and the last error.
 *
 * Deterministic classification — no LLM needed.
 */
export function buildFailureSummary(
  trace: { steps: StepTrace[]; errors: number },
  _consecutiveFailures: number,
  lastError?: { tool: string; errorCode: string },
  categoryOverride?: FailureCategory
): FailureSummary {
  // Collect last tool results from the last 2 steps
  const recentSteps = trace.steps.slice(-2);
  const lastToolResults = recentSteps.flatMap((step) =>
    step.toolCalls.map((tc) => ({
      tool: tc.tool,
      ok: tc.result.ok,
      ...(tc.result.errorCode && { errorCode: tc.result.errorCode }),
      output: tc.result.output.slice(0, 200),
    }))
  );

  const category: FailureCategory = categoryOverride ?? (lastError ? 'tool_failure' : 'unknown');
  const retryable =
    category !== 'budget_exhausted' && category !== 'invalid_task' && category !== 'infra_failure';

  let suggestedAction: FailureSummary['suggestedAction'];
  if (!retryable) {
    suggestedAction = 'stop';
  } else if (lastError?.errorCode === 'auth_failed') {
    suggestedAction = 'ask_user';
  } else {
    suggestedAction = 'retry_with_guidance';
  }

  return {
    category,
    ...(lastError && { lastErrorCode: lastError.errorCode }),
    retryable,
    suggestedAction,
    lastToolResults,
  };
}

/**
 * Get an optional failure hint from the motor LLM.
 *
 * Best-effort: try/catch, graceful undefined on failure.
 * Only called if failure is not budget_exhausted (no point asking LLM to diagnose "out of iterations").
 */
export async function getFailureHint(
  llm: LLMProvider,
  messages: Message[],
  failureReason: string,
  logger: Logger
): Promise<string | undefined> {
  try {
    const hintMessages: Message[] = [
      ...messages,
      {
        role: 'user',
        content: `The task failed: ${failureReason}\n\nIn 1-2 sentences, what went wrong and what should be tried differently? Be specific about the root cause.`,
      },
    ];

    const response = await llm.complete({
      messages: hintMessages,
      maxTokens: FAILURE_HINT_MAX_TOKENS,
      role: 'motor',
    });

    const hint = response.content?.trim();
    if (hint && hint.length > 10) {
      return hint;
    }
  } catch (error) {
    logger.debug({ error }, 'Failed to get failure hint from LLM (non-critical)');
  }

  return undefined;
}
