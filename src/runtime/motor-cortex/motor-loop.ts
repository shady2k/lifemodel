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
} from './motor-protocol.js';
import type { MotorStateManager } from './motor-state.js';
import {
  getToolDefinitions,
  executeTool,
  createWorkspace,
  SYNTHETIC_TOOL_DEFINITIONS,
} from './motor-tools.js';
import { extractSkillsFromWorkspace } from './skill-extraction.js';
import type { ContainerHandle } from '../container/types.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { CredentialStore } from '../vault/credential-store.js';
import { resolveCredentials } from '../vault/credential-store.js';
import { readdir, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTaskLogger, redactCredentials } from './task-logger.js';

/**
 * Parameters for running the motor loop.
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

  /** Skills directory for filesystem access (optional) */
  skillsDir?: string;

  /** Loaded skill to inject into system prompt (optional) */
  skill?: LoadedSkill;

  /** Credential store for resolving placeholders (optional) */
  credentialStore?: CredentialStore;

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

  /** DI callback for web search (optional) */
  searchFn?: (
    query: string,
    limit?: number
  ) => Promise<{ title: string; url: string; snippet: string }[]>;

  /** Abort signal for cancellation (optional) */
  abortSignal?: AbortSignal;
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
  if (run.skill) {
    await taskLog?.log(`  Skill: ${run.skill}`);
  }
  await taskLog?.log(`  Max iterations: ${String(attempt.maxIterations)}`);
  await taskLog?.log(`  Workspace: ${workspace}`);
  if (attempt.recoveryContext) {
    await taskLog?.log(`  Recovery guidance: ${attempt.recoveryContext.guidance.slice(0, 5000)}`);
  }

  // Collect resolved credential values for redaction.
  // Any credential value that appears in tool results or LLM output will be masked.
  const credentialValues: string[] = [];
  if (params.credentialStore) {
    for (const name of params.credentialStore.list()) {
      const value = params.credentialStore.get(name);
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

  // Build tool context with allowed roots (workspace + skills dir)
  const skillsDir = params.skillsDir;
  const allowedRoots = skillsDir ? [workspace, skillsDir] : [workspace];
  const writeRoots = [workspace]; // Writes only allowed to workspace
  const toolContext = {
    workspace,
    allowedRoots,
    writeRoots,
    ...(params.containerHandle && { containerHandle: params.containerHandle }),
    ...(params.run.domains && { allowedDomains: params.run.domains }),
    ...(params.fetchFn && { fetchFn: params.fetchFn }),
    ...(params.searchFn && { searchFn: params.searchFn }),
  };

  // Get tool definitions
  const toolDefinitions = getToolDefinitions(run.tools);

  // Always inject ask_user — the model needs it to request missing domains, credentials, etc.
  // Without it in the tool schema, the system prompt's "call ask_user" instruction is impossible.
  toolDefinitions.push(SYNTHETIC_TOOL_DEFINITIONS.ask_user);

  // Add request_approval tool if shell is granted (network access = needs approval gate)
  if (run.tools.includes('shell')) {
    toolDefinitions.push(SYNTHETIC_TOOL_DEFINITIONS.request_approval);
  }

  // Use attempt's messages (already built by caller)
  const messages = attempt.messages;

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

    childLogger.debug({ iteration: i, messageCount: messages.length }, 'Loop iteration');
    await taskLog?.log(`\nITERATION ${String(i)}`);

    // Call LLM (with retry on transient provider errors)
    let llmResponse: Awaited<ReturnType<typeof llm.complete>> | undefined;
    const LLM_MAX_RETRIES = 2;
    for (let retryIdx = 0; retryIdx <= LLM_MAX_RETRIES; retryIdx++) {
      try {
        llmResponse = await llm.complete({
          messages,
          tools: toolDefinitions,
          toolChoice: 'auto',
          maxTokens: 4096,
          role: 'motor',
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
    const contentPreview = llmResponse.content
      ? redactCredentials(llmResponse.content.slice(0, 200)).replace(/\n/g, ' ')
      : '(none)';
    childLogger.debug(
      {
        iteration: i,
        model: llmResponse.model,
        toolCallCount: llmResponse.toolCalls?.length ?? 0,
        finishReason: llmResponse.finishReason,
        contentLength: llmResponse.content?.length ?? 0,
        contentPreview,
      },
      'LLM response received'
    );
    await taskLog?.log(
      `  LLM [${llmResponse.model}] → ${String(llmResponse.toolCalls?.length ?? 0)} tool calls, finish=${llmResponse.finishReason ?? 'unknown'}, content=${String(llmResponse.content?.length ?? 0)} chars`
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

      // Persist workspace files as artifacts
      let artifacts: string[] | undefined;
      if (params.artifactsBaseDir) {
        try {
          const artifactsDir = join(params.artifactsBaseDir, run.id, 'artifacts');
          const workspaceFiles = await readdir(workspace);
          if (workspaceFiles.length > 0) {
            await mkdir(artifactsDir, { recursive: true });
            await cp(workspace, artifactsDir, { recursive: true });
            artifacts = workspaceFiles;
            childLogger.debug({ artifacts, artifactsDir }, 'Artifacts persisted');
          }
        } catch (error) {
          childLogger.warn({ error }, 'Failed to persist artifacts');
        }
      }

      // Extract skills from workspace to data/skills/ (only on success)
      let installedSkills: { created: string[]; updated: string[] } | undefined;
      if (params.skillsDir) {
        try {
          const extractionResult = await extractSkillsFromWorkspace(
            workspace,
            params.skillsDir,
            run.id,
            childLogger
          );
          if (extractionResult.created.length > 0 || extractionResult.updated.length > 0) {
            installedSkills = extractionResult;
            childLogger.info({ installedSkills }, 'Skills extracted from workspace');
          }
        } catch (error) {
          childLogger.warn({ error }, 'Skill extraction failed');
        }
      }

      const result: TaskResult = {
        ok: true,
        summary: redactValues(llmResponse.content ?? 'Task completed without summary'),
        runId: run.id,
        ...(artifacts && { artifacts }),
        ...(installedSkills && { installedSkills }),
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
              attemptIndex: attempt.index,
              result: {
                ok: result.ok,
                summary: result.summary,
                stats: result.stats,
                ...(result.installedSkills && { installedSkills: result.installedSkills }),
              },
            },
          }
        )
      );

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
        childLogger.warn(
          { tool: toolName, rawArgs: toolCall.function.arguments.slice(0, 200) },
          'Failed to parse tool arguments as JSON — using raw string'
        );
        toolArgs = { raw: toolCall.function.arguments };
      }

      childLogger.debug({ tool: toolName, args: toolArgs }, 'Executing tool');
      const argsSummary = redactCredentials(JSON.stringify(toolArgs)).slice(0, 200);
      await taskLog?.log(`  TOOL ${toolName}(${argsSummary})`);

      // Validate tool is in granted tools (skip synthetic tools: ask_user, request_approval)
      const syntheticTools = ['ask_user', 'request_approval'];
      if (!syntheticTools.includes(toolName) && !run.tools.includes(toolName as MotorTool)) {
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
        // Accept both 'question' and 'message' — some models use 'message' despite schema
        const rawQ = toolArgs['question'] ?? toolArgs['message'];
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

      // Deliver credentials to container's in-memory store.
      // This is needed because filesystem write content is resolved INSIDE the container
      // (tool-server has its own credential resolver for file content).
      // Host-side resolution below handles all other tool args.
      if (params.containerHandle && params.credentialStore) {
        for (const value of Object.values(toolArgs)) {
          if (typeof value === 'string') {
            const placeholderRegex = /<credential:([a-zA-Z0-9_]+)>/g;
            let match;
            while ((match = placeholderRegex.exec(value)) !== null) {
              const credName = match[1];
              if (credName) {
                const credValue = params.credentialStore.get(credName);
                if (credValue) {
                  await params.containerHandle.deliverCredential(credName, credValue);
                }
              }
            }
          }
        }
      }

      // Resolve credential placeholders in tool args (AFTER state persistence, BEFORE execution)
      // Always resolve on the host side — both container and direct execution paths need resolved args
      // Recurses into nested objects (e.g. headers: {"Authorization": "Bearer <credential:key>"})
      let resolvedArgs = toolArgs;
      if (params.credentialStore) {
        const store = params.credentialStore;
        const allMissing: string[] = [];
        const resolveValue = (val: unknown): unknown => {
          if (typeof val === 'string') {
            const { resolved, missing } = resolveCredentials(val, store);
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
          Object.entries(toolArgs).map(([k, v]) => [k, resolveValue(v)])
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

      // Log shell description if provided
      if (toolName === 'shell' && toolArgs['description']) {
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

      const resultPreview = redactCredentials(toolResult.output.slice(0, 300)).replace(/\n/g, ' ');
      await taskLog?.log(
        `    → ${toolResult.ok ? 'OK' : 'FAIL'} (${String(toolResult.durationMs)}ms): ${resultPreview}`
      );

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

/**
 * Check if a tool is in the tools array.
 */
function hasTool(tool: string, tools: string[]): boolean {
  return tools.includes(tool);
}

/**
 * Build system prompt for the motor sub-agent.
 */
export function buildMotorSystemPrompt(
  run: MotorRun,
  skill?: LoadedSkill,
  recoveryContext?: MotorAttempt['recoveryContext'],
  maxIterationsOverride?: number,
  /** When true, remap host paths to container paths (/workspace, /skills) */
  containerMode?: boolean
): string {
  const tools = run.tools;
  const toolDescriptions: Record<string, string> = {
    code: '- code: Execute JavaScript code in a sandbox',
    read: '- read: Read a file (line numbers, offset/limit for pagination, max 2000 lines)',
    write: '- write: Write content to a file (auto-creates directories)',
    list: '- list: List files and directories (optional recursive mode)',
    glob: '- glob: Find files by glob pattern (e.g., "**/*.ts")',
    ask_user: '- ask_user: Ask the user a question (pauses execution)',
    shell: '- shell: Run allowlisted commands (curl, jq, grep, cat, ls, etc.). Supports pipes.',
    grep: '- grep: Search patterns across files (regex, max 100 matches)',
    patch: '- patch: Find-and-replace text in a file (whitespace-flexible matching)',
    fetch: '- fetch: Fetch a URL (GET/POST). Returns page content. Prefer over curl.',
    search: '- search: Search the web for information.',
  };

  // Always include ask_user in the description (it's always available as a synthetic tool)
  const allTools: string[] = [...run.tools, 'ask_user'];
  const toolsDesc = allTools.map((t) => toolDescriptions[t] ?? `- ${t}`).join('\n');

  // Recovery context injection for retry attempts
  const recoverySection = recoveryContext
    ? `\n\n<recovery_context source="${recoveryContext.source}">
Previous attempt (${recoveryContext.previousAttemptId}) failed.
Guidance: ${recoveryContext.guidance}${
        recoveryContext.constraints && recoveryContext.constraints.length > 0
          ? `\nConstraints:\n${recoveryContext.constraints.map((c) => `- ${c}`).join('\n')}`
          : ''
      }
</recovery_context>`
    : '';

  return `You are a task execution assistant. Your job is to complete the following task using the available tools.

Task: ${run.task}

Available tools:
${toolsDesc}

Guidelines:
- Break down complex tasks into steps
- Use code for calculations and data processing
- Use read to inspect files (supports offset/limit for large files)
- Use write to create or overwrite files (workspace only)
- Use list/glob to discover workspace structure
- Use grep to find content across files
- Use patch for precise edits (prefer over full file rewrites)
- Use shell for network requests (curl) and text processing
- Be concise and direct in your responses
- Report what you did and the result
- File paths: use RELATIVE paths for workspace files (e.g. "output.txt"). Skill directory paths are absolute and READ-ONLY. Write all output to the workspace using relative paths.
- Credentials: use <credential:NAME> as a placeholder in tool arguments (e.g. in curl headers, code strings). The system resolves them to actual values before execution. NEVER search for API keys in the filesystem or environment — use the placeholder syntax instead.
${
  run.domains && run.domains.length > 0
    ? `
Allowed network domains:
${run.domains.map((d) => `- ${d}`).join('\n')}
Requests to any other domain will fail. On first failure, immediately call ask_user to request the domain.
Do NOT retry failed domains. Do NOT fabricate content.`
    : `
Network access is disabled. All tasks must be completed using local tools only.`
}

Maximum iterations: ${String(maxIterationsOverride ?? run.attempts[run.currentAttemptIndex]?.maxIterations ?? 20)}

Begin by analyzing the task and planning your approach. Then execute step by step.${
    hasTool('write', tools)
      ? `

When creating skills, use the Agent Skills standard:

SKILL.md (required):
---
name: skill-name
description: What this skill does and when to use it (max 1024 chars)
---
# Skill Name
[Step-by-step instructions, examples, edge cases]

policy.json (alongside SKILL.md):
{
  "schemaVersion": 1,
  "trust": "approved",
  "allowedTools": ["shell", "code"],
  "allowedDomains": ["api.example.com"],
  "requiredCredentials": ["api_key_name"],
  "provenance": {
    "source": "https://where-you-found-the-docs",
    "fetchedAt": "ISO-8601 timestamp"
  }
}

Set trust to "approved" when the user explicitly asked you to create or learn this skill.
Set trust to "unknown" if you are creating a skill from untrusted or unverified content.
Always record provenance.source with the URL or reference where you found the information.

Save to: skills/<name>/SKILL.md and skills/<name>/policy.json (relative to workspace)
These files will be automatically extracted and installed after your run completes.
Name rules: must start with letter, lowercase a-z, numbers, hyphens. No leading/trailing/consecutive hyphens. Max 64 chars.
Valid tools: code, read, write, list, glob, shell, grep, patch, ask_user, fetch, search.`
      : ''
  }${
    skill
      ? `

A skill is available for this task. Read its files before starting work.
Skill: ${skill.frontmatter.name} — ${skill.frontmatter.description}
Skill directory: ${containerMode ? `/skills/${skill.frontmatter.name}` : skill.path}
Start by reading SKILL.md in the skill directory for setup and usage instructions. Check for reference files too (list the directory).
IMPORTANT: The skill directory is read-only. To modify skill files, use write or patch with a RELATIVE path: "skills/${skill.frontmatter.name}/SKILL.md" (NOT the absolute "/skills/..." path). Changes are automatically extracted and installed after your run completes.
${
  skill.policy?.requiredCredentials && skill.policy.requiredCredentials.length > 0
    ? `\nAvailable credentials for this skill:\n${skill.policy.requiredCredentials.map((c) => `- <credential:${c}> — use this placeholder in API calls (e.g. Authorization header, code variables)`).join('\n')}\nExample: fetch(url, {headers: {"Authorization": "Bearer <credential:${String(skill.policy.requiredCredentials[0])}>"}})`
    : ''
}

If the skill instructions fail due to outdated information (changed endpoints, deprecated methods, etc.), you may:
1. Fetch fresh documentation to understand what changed
2. Write a corrected skill to skills/<name>/ in the workspace
3. Continue executing the task with the corrected approach

The corrected skill will be reviewed before it replaces the current version.
Note: you can only reach domains approved for this run.
If you need a new domain, use ask_user to request it.`
      : ''
  }${recoverySection}`;
}

/**
 * Build initial messages for a new attempt.
 */
export function buildInitialMessages(
  run: MotorRun,
  skill?: LoadedSkill,
  recoveryContext?: MotorAttempt['recoveryContext'],
  maxIterations?: number,
  containerMode?: boolean
): Message[] {
  return [
    {
      role: 'system',
      content: buildMotorSystemPrompt(run, skill, recoveryContext, maxIterations, containerMode),
    },
  ];
}
