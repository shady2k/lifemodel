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
import { resolveCredentials, credentialToRuntimeKey } from '../vault/credential-store.js';
import { readdir, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTaskLogger, redactCredentials } from './task-logger.js';
import { validateToolArgs } from '../../utils/tool-validation.js';

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

  // Always inject ask_user — the model needs it to request missing domains, credentials, etc.
  // Without it in the tool schema, the system prompt's "call ask_user" instruction is impossible.
  toolDefinitions.push(SYNTHETIC_TOOL_DEFINITIONS.ask_user);

  // Inject save_credential when a credential store is available — lets agents
  // persist credentials obtained during execution (e.g. signup API keys).
  if (params.credentialStore) {
    toolDefinitions.push(SYNTHETIC_TOOL_DEFINITIONS.save_credential);
  }

  // Add request_approval tool if shell is granted (network access = needs approval gate)
  if (run.tools.includes('bash')) {
    toolDefinitions.push(SYNTHETIC_TOOL_DEFINITIONS.request_approval);
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
  // If skill has requiredCredentials, filter delivery to only those names.
  // Priority: skill.policy.credentialValues (skill-stored) → credentialStore (user env vars)
  // Container env vars use plain NAME (no VAULT_ prefix) for ergonomic script access.
  if (params.containerHandle && params.credentialStore) {
    const skillRequiredCreds = params.skill?.policy?.requiredCredentials;

    if (skillRequiredCreds && skillRequiredCreds.length > 0) {
      // Filtered delivery: only required credentials
      for (const name of skillRequiredCreds) {
        // Check skill-stored credentials first, then user env vars
        const skillValue = params.skill?.policy?.credentialValues?.[name];
        const value = skillValue ?? params.credentialStore.get(name);
        if (value) {
          await params.containerHandle.deliverCredential(credentialToRuntimeKey(name), value);
          // Add to redaction array for output masking
          if (value.length >= 8) {
            credentialValues.push(value);
          }
        }
      }
    } else {
      // Backward compat: deliver all credentials from CredentialStore
      for (const name of params.credentialStore.list()) {
        const value = params.credentialStore.get(name);
        if (value) {
          await params.containerHandle.deliverCredential(credentialToRuntimeKey(name), value);
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
      ? redactCredentials(llmResponse.content.slice(0, 2000)).replace(/\n/g, ' ')
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
            childLogger,
            run.pendingCredentials
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

      // Validate tool is in granted tools (skip synthetic tools: ask_user, request_approval, save_credential)
      const syntheticTools = ['ask_user', 'request_approval', 'save_credential'];
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

        // Scope enforcement: skill runs must declare requiredCredentials
        const requiredCreds = params.skill?.policy?.requiredCredentials;
        if (params.skill && (!requiredCreds || requiredCreds.length === 0)) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output:
                'Skill must declare requiredCredentials in policy.json to save credentials. Add the credential name to requiredCredentials first.',
              error: 'permission_denied',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: 'save_credential',
            args: toolArgs,
            result: {
              ok: false,
              output: 'Skill must declare requiredCredentials in policy.json to save credentials.',
              errorCode: 'permission_denied',
              retryable: false,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          });
          continue;
        }

        // Scope enforcement: only allow names in requiredCredentials list
        if (params.skill && requiredCreds && !requiredCreds.includes(credName)) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: `Credential "${credName}" not in skill's requiredCredentials. Allowed: ${requiredCreds.join(', ')}`,
              error: 'permission_denied',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: 'save_credential',
            args: toolArgs,
            result: {
              ok: false,
              output: `Credential "${credName}" not in skill's requiredCredentials. Allowed: ${requiredCreds.join(', ')}`,
              errorCode: 'permission_denied',
              retryable: false,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          });
          continue;
        }

        // Persist to policy.json for existing skills, or pendingCredentials for new skills
        let persistError: string | null = null;
        const runtimeKey = credentialToRuntimeKey(credName);

        if (params.skill?.path) {
          // Existing skill: persist to policy.json
          const policyPath = join(params.skill.path, 'policy.json');
          try {
            let existingPolicy: Record<string, unknown> = {};
            try {
              const raw = await readFile(policyPath, 'utf-8');
              existingPolicy = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              // No existing policy — will create one
            }

            const credentialValues: Record<string, string> =
              (existingPolicy['credentialValues'] as Record<string, string> | undefined) ?? {};
            credentialValues[credName] = credValue;

            const updatedPolicy = { ...existingPolicy, credentialValues };
            const tmpPath = join(params.skill.path, `.policy.json.tmp-${run.id}`);
            await writeFile(tmpPath, JSON.stringify(updatedPolicy, null, 2), {
              mode: 0o600, // Secure: only owner can read/write
            });
            // Atomic rename
            const { rename } = await import('node:fs/promises');
            await rename(tmpPath, policyPath);

            childLogger.info(
              { name: credName, skillPath: params.skill.path },
              'Credential persisted to skill policy.json'
            );
          } catch (err) {
            persistError = `Failed to persist credential: ${err instanceof Error ? err.message : String(err)}`;
            childLogger.warn(
              { name: credName, error: persistError },
              'Failed to persist credential to policy.json'
            );
          }
        } else {
          // New skill (no skill dir yet): store in pendingCredentials on run
          run.pendingCredentials = run.pendingCredentials ?? {};
          run.pendingCredentials[credName] = credValue;
          childLogger.info(
            { name: credName },
            'Credential stored in pendingCredentials for new skill'
          );
        }

        if (persistError) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              ok: false,
              output: persistError,
              error: 'execution_error',
            }),
            tool_call_id: toolCall.id,
          });
          step.toolCalls.push({
            tool: 'save_credential',
            args: toolArgs,
            result: {
              ok: false,
              output: persistError,
              errorCode: 'execution_error',
              retryable: true,
              provenance: 'internal',
              durationMs: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          });
          continue;
        }

        // Best-effort delivery to container (fire-and-forget)
        if (params.containerHandle) {
          try {
            await params.containerHandle.deliverCredential(runtimeKey, credValue);
          } catch {
            // Ignore delivery errors — credential is persisted for future runs
          }
        }

        // Add to redaction array for output masking
        if (credValue.length >= 8) {
          credentialValues.push(credValue);
        }

        // Also save to in-memory credentialStore for this run
        if (params.credentialStore) {
          params.credentialStore.set(credName, credValue);
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
  maxIterationsOverride?: number
): string {
  const tools = run.tools;
  const toolDescriptions: Record<string, string> = {
    read: '- read: Read a file (line numbers, offset/limit for pagination, max 2000 lines)',
    write: '- write: Write content to a file (auto-creates directories)',
    list: '- list: List files and directories (optional recursive mode)',
    glob: '- glob: Find files by glob pattern (e.g., "**/*.ts")',
    ask_user: '- ask_user: Ask the user a question (pauses execution)',
    save_credential:
      '- save_credential: Save a credential (e.g. API key from signup) for future runs',
    bash: '- bash: Run commands (node, npm, npx, python, pip, curl, jq, grep, git, etc.). Full async Node.js via "node script.js". Supports pipes.',
    grep: '- grep: Search patterns across files (regex, max 100 matches)',
    patch: '- patch: Find-and-replace text in a file (whitespace-flexible matching)',
    fetch: '- fetch: Fetch a URL (GET/POST). Returns page content. Prefer over curl.',
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
- Use read to inspect files (supports offset/limit for large files)
- Use write to create or overwrite files (workspace only)
- Use list/glob to discover workspace structure
- Use grep to find content across files
- Use patch for precise edits (prefer over full file rewrites)
- Use fetch for HTTP requests (preferred over bash+curl — handles credentials, domain checks, HTML→markdown)
- Use bash for runtime execution (node scripts, npm install, python, pip) and text processing with pipes
- Be concise and direct in your responses
- Report what you did and the result
- If something is blocked, denied, or fails repeatedly (2+ times), call ask_user to report the problem and ask for guidance. Do NOT silently work around blockers by guessing or fabricating content.
- File paths: use RELATIVE paths for workspace files (e.g. "output.txt", "SKILL.md"). Skill files are at workspace root and can be modified directly.
- Credentials are environment variables. Use process.env.NAME in Node scripts, os.environ["NAME"] in Python, $NAME in bash commands and fetch headers. The system resolves $NAME in all tool arguments automatically.
${
  run.domains && run.domains.length > 0
    ? `
Allowed network domains:
${run.domains.map((d) => `- ${d}`).join('\n')}
Requests to any other domain will be BLOCKED.
CRITICAL: When a domain is blocked, you MUST immediately call ask_user to request access. Do NOT try alternative URLs, do NOT try different domains, do NOT fabricate or guess content. Stop and ask_user FIRST.
Do NOT run npm install or pip install — registries are not reachable. Pre-installed packages (if any) are already available via require() or import.
For API calls, prefer the fetch tool. In bash/node scripts, use Node's built-in global fetch() (no import needed) or curl.`
    : `
Network access is disabled. All tasks must be completed using local tools only.
Do NOT run npm install or pip install — there is no network access. Pre-installed packages (if any) are already available via require() or import.`
}

Maximum iterations: ${String(maxIterationsOverride ?? run.attempts[run.currentAttemptIndex]?.maxIterations ?? 20)}

Begin by analyzing the task and planning your approach. Then execute step by step.${
    hasTool('write', tools)
      ? `

You create and maintain Agent Skills — modular, filesystem-based capabilities. A Skill packages instructions, metadata, and optional resources (scripts, templates, reference docs) so the agent can reuse them automatically.

Skill directory structure:
  SKILL.md           — required: frontmatter metadata + step-by-step instructions
  references/        — optional: API docs, schemas, examples
  scripts/           — optional: helper scripts the instructions reference

SKILL.md format:
---
name: skill-name
description: What this skill does and when to use it (max 1024 chars). Include BOTH what the skill does AND when the agent should trigger it.
---
# Skill Name

## Quick start
[Minimal working example]

## Instructions
[Step-by-step procedures, organized by task type]

## Examples
[Concrete usage examples with expected inputs/outputs]

## Edge cases
[Error handling, fallbacks, known limitations]

The frontmatter (name + description) is always loaded at startup so the agent knows the skill exists.
The body is only loaded when the skill is triggered, so keep it focused and actionable.
Reference files (references/, scripts/) are loaded on demand — link to them from the instructions.

If an official SDK (npm or pip package) exists for the API, ALWAYS prefer it over raw HTTP calls.
Mention the SDK in SKILL.md with installation instructions: "npm install package-name@x.y.z" or "pip install package-name==x.y.z".
SKILL.md examples should use the SDK, not raw curl/fetch. Find the latest package version from the API documentation.

Trust is always "needs_review" for new skills — the user reviews and approves before first use.

Save files at the workspace root (e.g. write({path: "SKILL.md", content: "..."})).
Reference files go in subdirectories: write({path: "references/api-docs.md", content: "..."}).
These files will be automatically extracted and installed after your run completes.
Name rules: must start with letter, lowercase a-z, numbers, hyphens. No leading/trailing/consecutive hyphens. Max 64 chars.`
      : ''
  }${
    skill
      ? `

A skill is available for this task. Read its files before starting work.
Skill: ${skill.frontmatter.name} — ${skill.frontmatter.description}
Start by reading SKILL.md: read({path: "SKILL.md"}). Check for reference files too: list({path: "."}).
${
  skill.policy?.dependencies
    ? `IMPORTANT: SKILL.md contains tested, working code examples. Use them EXACTLY as written — copy constructors, method names, and argument shapes from the examples. Do NOT guess or invent API usage. If something fails, re-read SKILL.md and compare your code against the examples before trying alternatives.
Pre-installed packages are available — use require() or import directly.`
    : `No SDK packages are pre-installed for this skill. SKILL.md examples may use SDK calls — do NOT copy them directly. Instead, use the fetch tool or Node's built-in global fetch() for raw HTTP API calls. Check the API documentation or reference files for the correct HTTP endpoints, methods, and request formats. Do NOT guess URL paths from SDK method names.`
}
You can modify skill files directly in the workspace using write or patch. Changes are automatically extracted and installed after your run completes.
Do NOT run npm install or pip install — package registries are not reachable at runtime.
${
  skill.policy?.requiredCredentials && skill.policy.requiredCredentials.length > 0
    ? `\nAvailable credentials (as env vars):\n${skill.policy.requiredCredentials.map((c) => `- ${c}`).join('\n')}\nUsage:\n  Node script: const apiKey = process.env.${String(skill.policy.requiredCredentials[0])};\n  Python:      api_key = os.environ["${String(skill.policy.requiredCredentials[0])}"]\n  bash:        curl -H "Authorization: Bearer $${String(skill.policy.requiredCredentials[0])}"\n  fetch tool:  {"Authorization": "Bearer $${String(skill.policy.requiredCredentials[0])}"}`
    : ''
}

If you encounter errors while following the skill instructions (wrong endpoints, incorrect parameters, deprecated methods, missing steps, etc.):
1. Figure out what went wrong and how to fix it
2. Complete the task using the corrected approach
3. ALSO update the skill files directly in the workspace (e.g. SKILL.md, reference docs, scripts — whatever needs fixing)
This way the skill stays accurate for future use. The updated files will be reviewed before they replace the current version.
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
  maxIterations?: number
): Message[] {
  return [
    {
      role: 'system',
      content: buildMotorSystemPrompt(run, skill, recoveryContext, maxIterations),
    },
  ];
}
