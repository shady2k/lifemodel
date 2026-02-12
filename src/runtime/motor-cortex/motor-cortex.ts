/**
 * Motor Cortex Service
 *
 * Top-level service for Motor Cortex functionality.
 * Manages runs, energy gating, async dispatch, and signal emission.
 *
 * A run contains one or more attempts. Each retry creates a new attempt
 * with clean message history but recovery context from the previous failure.
 */

import type { Logger } from '../../types/index.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { Storage } from '../../storage/storage.js';
import type { Signal } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { EnergyModel } from '../../core/energy.js';
import type { MotorRun, MotorTool, RunStatus, MotorAttempt } from './motor-protocol.js';
import { DEFAULT_MAX_ATTEMPTS } from './motor-protocol.js';
import type { MotorFetchFn } from './motor-tools.js';
import { type MotorStateManager, createMotorStateManager } from './motor-state.js';
import { runMotorLoop, buildInitialMessages } from './motor-loop.js';
import { runSandbox } from '../sandbox/sandbox-runner.js';
import { createWorkspace } from './motor-tools.js';
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerManager, ContainerHandle } from '../container/types.js';
import { generateBaseline } from './skill-extraction.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { CredentialStore } from '../vault/credential-store.js';
import { loadSkill } from '../skills/skill-loader.js';
import { mergeDomains } from '../container/network-policy.js';

/**
 * Default max iterations per attempt.
 */
const DEFAULT_MAX_ITERATIONS = 20;

/**
 * Default max iterations for retry attempts (slightly reduced budget).
 */
const RETRY_MAX_ITERATIONS = 15;

/**
 * Dependencies for Motor Cortex service.
 */
export interface MotorCortexDeps {
  /** LLM provider for sub-agent */
  llm: LLMProvider;

  /** Storage for persistence */
  storage: Storage;

  /** Logger */
  logger: Logger;

  /** Energy model for energy gating */
  energyModel: EnergyModel;

  /** Credential store for resolving <credential:name> placeholders (optional) */
  credentialStore?: CredentialStore;

  /** Skills directory absolute path (optional, default: data/skills) */
  skillsDir?: string;

  /** Base directory for persisting run artifacts (optional, default: data/motor-runs) */
  artifactsBaseDir?: string;

  /** Container manager for Docker isolation (optional) */
  containerManager?: ContainerManager;

  /** DI callback for web fetch (provided by web-fetch plugin) */
  fetchFn?: MotorFetchFn;
}

/**
 * Motor Cortex Service
 *
 * Top-level service that manages Motor Cortex runs.
 * Key features:
 * - Mutex: Only one agentic run at a time
 * - Energy gating: Check energy before creating runs
 * - Async dispatch: startRun() returns immediately, results via signal
 * - Oneshot: Direct sandbox execution without sub-agent loop
 * - Retry: Failed runs can be retried with recovery guidance from Cognition
 */
export class MotorCortex {
  private readonly llm: LLMProvider;
  private readonly logger: Logger;
  private readonly energyModel: EnergyModel;
  private readonly stateManager: MotorStateManager;
  private readonly credentialStore: CredentialStore | undefined;
  private readonly skillsDir: string | undefined;
  private readonly artifactsBaseDir: string | undefined;
  private readonly containerManager: ContainerManager | undefined;
  private readonly fetchFn: MotorFetchFn | undefined;

  /** Whether Docker isolation is available */
  private dockerAvailable: boolean | null = null;

  /** Signal callback (wired by container) */
  private signalCallback: ((signal: Signal) => void) | null = null;

  /** Awaiting input timeout timer */
  private awaitingInputTimer: ReturnType<typeof setTimeout> | null = null;

  /** Abort controllers for in-flight runs (keyed by runId) */
  private readonly runAbortControllers = new Map<string, AbortController>();

  /** Active container handles for paused runs (keyed by runId) */
  private readonly activeContainers = new Map<string, ContainerHandle>();

  constructor(deps: MotorCortexDeps) {
    this.llm = deps.llm;
    this.logger = deps.logger.child({ component: 'motor-cortex' });
    this.energyModel = deps.energyModel;
    this.stateManager = createMotorStateManager(deps.storage, this.logger);
    this.credentialStore = deps.credentialStore;
    this.skillsDir = deps.skillsDir;
    this.artifactsBaseDir = deps.artifactsBaseDir;
    this.containerManager = deps.containerManager;
    this.fetchFn = deps.fetchFn;

    this.logger.info('Motor Cortex service initialized');
  }

  /**
   * Set signal callback (wired by container).
   */
  setSignalCallback(cb: (signal: Signal) => void): void {
    this.signalCallback = cb;
  }

  /**
   * Push a signal (uses callback if set, otherwise logs).
   */
  private pushSignal(signal: Signal): void {
    if (this.signalCallback) {
      this.signalCallback(signal);
    } else {
      this.logger.warn({ signalType: signal.type }, 'No signal callback set, signal not pushed');
    }
  }

  /**
   * Check if Docker isolation is available.
   * Caches result after first check.
   */
  private async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    if (!this.containerManager) {
      this.dockerAvailable = false;
      return false;
    }
    this.dockerAvailable = await this.containerManager.isAvailable();
    return this.dockerAvailable;
  }

  /**
   * Execute oneshot code (synchronous sandbox execution).
   *
   * No mutex, no runId, no sub-agent loop.
   * Direct sandbox call with 5s timeout.
   *
   * @param code - JavaScript code to execute
   * @param timeoutMs - Optional timeout (default: 5000)
   * @returns Execution result
   */
  async executeOneshot(
    code: string,
    timeoutMs?: number
  ): Promise<{
    ok: boolean;
    result: unknown;
    durationMs: number;
  }> {
    // Check energy
    const energyBefore = this.energyModel.getEnergy();
    this.energyModel.drain('motor_oneshot');
    const energyAfter = this.energyModel.getEnergy();

    this.logger.debug(
      { energyBefore, energyAfter, cost: energyBefore - energyAfter },
      'Energy drained for oneshot execution'
    );

    const startTime = Date.now();
    const toolResult = await runSandbox(code, timeoutMs ?? 5_000);

    return {
      ok: toolResult.ok,
      result: toolResult.output,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a fresh MotorAttempt.
   */
  private createAttempt(
    index: number,
    run: MotorRun,
    maxIterations: number,
    skill?: LoadedSkill,
    recoveryContext?: MotorAttempt['recoveryContext']
  ): MotorAttempt {
    const attemptId = `att_${String(index)}`;
    const messages = buildInitialMessages(run, skill, recoveryContext, maxIterations);

    return {
      id: attemptId,
      index,
      status: 'running',
      messages,
      stepCursor: 0,
      maxIterations,
      trace: {
        runId: run.id,
        task: run.task,
        status: 'running',
        steps: [],
        totalIterations: 0,
        totalDurationMs: 0,
        totalEnergyCost: 0,
        llmCalls: 0,
        toolCalls: 0,
        errors: 0,
      },
      ...(recoveryContext && { recoveryContext }),
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Start an agentic run (async sub-agent loop).
   *
   * Returns immediately with runId. Result comes back via signal.
   * Enforces mutex - only one agentic run at a time.
   *
   * @param params - Run parameters
   * @returns Run ID and status
   */
  async startRun(params: {
    task: string;
    tools: MotorTool[];
    maxIterations?: number;
    timeout?: number;
    skill?: LoadedSkill;
    domains?: string[];
  }): Promise<{ runId: string; status: 'created' }> {
    // Check mutex - only one agentic run at a time
    const activeRun = await this.stateManager.getActiveRun();
    if (activeRun) {
      throw new Error(
        `Cannot start new run: active run exists (${activeRun.id}, status: ${activeRun.status})`
      );
    }

    // Check Docker availability for agentic runs (Docker is required)
    const dockerReady = await this.isDockerAvailable();
    if (!dockerReady) {
      throw new Error(
        'Docker required for Motor Cortex isolation. Install Docker to use agentic mode.'
      );
    }

    // Check energy
    const energyBefore = this.energyModel.getEnergy();
    if (energyBefore < 0.1) {
      throw new Error('Insufficient energy for agentic run');
    }
    this.energyModel.drain('motor_agentic');

    // Create run
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Merge skill policy domains with explicit domains
    const skillDomains = params.skill?.policy?.allowedDomains;
    const explicitDomains = params.domains;
    const mergedDomains = mergeDomains(skillDomains, explicitDomains);

    const run: MotorRun = {
      id: runId,
      status: 'created',
      task: params.task,
      tools: params.tools,
      attempts: [], // Will be populated below
      currentAttemptIndex: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      startedAt: now,
      energyConsumed: energyBefore - this.energyModel.getEnergy(),
      ...(mergedDomains.length > 0 && { domains: mergedDomains }),
    };

    // Set skill name on the run if one was provided
    if (params.skill) {
      run.skill = params.skill.frontmatter.name;
    }

    // Create initial attempt (index 0, no recovery context)
    const attempt0 = this.createAttempt(0, run, maxIterations, params.skill);
    run.attempts.push(attempt0);

    // Persist run
    await this.stateManager.createRun(run);

    this.logger.info({ runId, task: params.task, tools: params.tools }, 'Motor Cortex run created');

    // Kick off loop in background (fire and forget)
    this.runLoopInBackground(run, attempt0).catch((error: unknown) => {
      this.logger.error({ runId, error }, 'Motor loop execution failed');
    });

    return { runId, status: 'created' };
  }

  /**
   * Retry a failed run with recovery guidance from Cognition.
   *
   * Creates a new attempt with clean message history but recovery context.
   * Cognition provides corrective instructions; Motor handles execution.
   *
   * @param runId - Run to retry
   * @param guidance - Corrective instructions from Cognition
   * @param constraints - Optional constraints for the retry
   * @param domains - Optional additional domains to allow (merged with existing)
   * @returns Run ID and new attempt index
   */
  async retryRun(
    runId: string,
    guidance: string,
    constraints?: string[],
    domains?: string[]
  ): Promise<{ runId: string; attemptIndex: number; status: 'running' }> {
    const run = await this.stateManager.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    // Validate: last attempt must be failed
    const lastAttempt = run.attempts[run.currentAttemptIndex];
    if (lastAttempt?.status !== 'failed') {
      throw new Error(
        `Cannot retry run ${runId}: last attempt is not failed (status: ${lastAttempt?.status ?? 'none'})`
      );
    }

    // Validate: haven't exceeded max attempts
    if (run.attempts.length >= run.maxAttempts) {
      throw new Error(
        `Cannot retry run ${runId}: max attempts (${String(run.maxAttempts)}) reached`
      );
    }

    // Check mutex: no other active run (allow self-retry for auto-retry path)
    const activeRun = await this.stateManager.getActiveRun();
    if (activeRun && activeRun.id !== runId) {
      throw new Error(
        `Cannot retry: active run exists (${activeRun.id}, status: ${activeRun.status})`
      );
    }

    // Build recovery context
    const recoveryContext: MotorAttempt['recoveryContext'] = {
      source: 'cognition',
      previousAttemptId: lastAttempt.id,
      guidance,
      ...(constraints && constraints.length > 0 && { constraints }),
    };

    // Re-load skill if the run had one (so retry attempt gets skill instructions)
    let skill: LoadedSkill | undefined;
    if (run.skill && this.skillsDir) {
      const skillResult = await loadSkill(run.skill, this.skillsDir);
      if (!('error' in skillResult)) {
        skill = skillResult;
      }
    }

    // Set currentAttemptIndex BEFORE createAttempt (buildMotorSystemPrompt reads it for maxIterations)
    const newIndex = run.attempts.length;
    run.currentAttemptIndex = newIndex;

    // Merge new domains with existing run domains (union, deduped)
    if (domains && domains.length > 0) {
      const existingDomains = run.domains ?? [];
      const allDomains = [...existingDomains, ...domains];
      run.domains = Array.from(new Set(allDomains));
    }

    // Create new attempt with fresh messages but recovery context
    const newAttempt = this.createAttempt(
      newIndex,
      run,
      RETRY_MAX_ITERATIONS,
      skill,
      recoveryContext
    );
    run.attempts.push(newAttempt);

    // Transition run back to running
    run.status = 'running';
    delete run.completedAt;

    await this.stateManager.updateRun(run);

    this.logger.info(
      { runId, attemptIndex: newIndex, guidance: guidance.slice(0, 100) },
      'Motor Cortex run retrying with guidance'
    );

    // Kick off loop in background
    this.runLoopInBackground(run, newAttempt).catch((error: unknown) => {
      this.logger.error({ runId, error }, 'Motor loop retry execution failed');
    });

    return { runId, attemptIndex: newIndex, status: 'running' };
  }

  /**
   * Run the motor loop in background for a specific attempt.
   *
   * This is fire-and-forget - result comes back via signal.
   */
  private async runLoopInBackground(run: MotorRun, attempt: MotorAttempt): Promise<void> {
    let containerHandle: ContainerHandle | undefined;

    // Create abort controller for this run (allows cancelRun to interrupt the loop)
    const abortController = new AbortController();
    this.runAbortControllers.set(run.id, abortController);

    try {
      // Transition to running
      run.status = 'running';
      attempt.status = 'running';
      await this.stateManager.updateRun(run);

      // Reuse existing workspace on resume (preserves files from prior iterations).
      let workspace: string;
      if (run.workspacePath && existsSync(run.workspacePath)) {
        workspace = run.workspacePath;
        this.logger.info({ runId: run.id, workspace }, 'Reusing existing workspace (resume)');
      } else {
        // Fresh workspace - create it
        workspace = await createWorkspace();
        run.workspacePath = workspace;

        // Copy skill files to workspace root on fresh init (only on first init, not on resume)
        // The baseline existence check prevents re-copying on resume (workspace is reused)
        const baselinePath = join(workspace, '.motor-baseline.json');
        if (run.skill && this.skillsDir && !existsSync(baselinePath)) {
          const skillSourceDir = join(this.skillsDir, run.skill);
          try {
            await cp(skillSourceDir, workspace, { recursive: true });
            const baseline = await generateBaseline(workspace);
            const { writeFile } = await import('node:fs/promises');
            await writeFile(baselinePath, JSON.stringify(baseline, null, 2));
            this.logger.info(
              { runId: run.id, skill: run.skill, filesCount: Object.keys(baseline.files).length },
              'Skill files copied to workspace root, baseline generated'
            );
          } catch (error) {
            this.logger.warn(
              { runId: run.id, skill: run.skill, error },
              'Failed to copy skill files to workspace, continuing without them'
            );
          }
        }

        await this.stateManager.updateRun(run);
      }

      // Reuse existing container (kept alive during pause) or create a new one
      containerHandle = this.activeContainers.get(run.id);
      if (containerHandle) {
        this.logger.info(
          { runId: run.id, containerId: containerHandle.containerId.slice(0, 12) },
          'Reusing existing container for resumed run'
        );
      } else if (this.containerManager && (await this.isDockerAvailable())) {
        containerHandle = await this.containerManager.create(run.id, {
          workspacePath: workspace,
          ...(run.domains && run.domains.length > 0 && { allowedDomains: run.domains }),
        });
        run.containerId = containerHandle.containerId;
        this.activeContainers.set(run.id, containerHandle);
        await this.stateManager.updateRun(run);
        this.logger.info(
          { runId: run.id, containerId: containerHandle.containerId.slice(0, 12) },
          'Container created for run'
        );
      }

      // Run the loop — pass the same workspace used by the container
      await runMotorLoop({
        run,
        attempt,
        llm: this.llm,
        stateManager: this.stateManager,
        pushSignal: (signal) => {
          this.pushSignal(signal);
        },
        logger: this.logger,
        workspace,
        abortSignal: abortController.signal,
        ...(this.skillsDir && { skillsDir: this.skillsDir }),
        ...(this.credentialStore && { credentialStore: this.credentialStore }),
        ...(this.artifactsBaseDir && { artifactsBaseDir: this.artifactsBaseDir }),
        ...(containerHandle && { containerHandle }),
        ...(this.fetchFn && { fetchFn: this.fetchFn }),
      });

      // Auto-retry for retryable failures: if loop returned without signal but attempt failed,
      // check if we should auto-retry before emitting failure signal
      // runMotorLoop mutates run.status and attempt.status by reference,
      // but TS narrows both to 'running' from the assignments above.
      // Cast to string for the post-loop status check.
      if ((attempt.status as string) === 'failed' && (run.status as string) === 'running') {
        const canRetry = run.attempts.length < run.maxAttempts;
        const isRetryable = attempt.failure?.retryable === true;
        if (canRetry && isRetryable) {
          // Generate appropriate auto-guidance based on failure category
          let autoGuidance: string;
          if (attempt.failure?.category === 'model_failure') {
            autoGuidance =
              'Previous attempt failed: model produced XML text instead of tool calls. Use the tool API to call tools.';
          } else if (attempt.failure?.category === 'tool_failure') {
            const lastError = attempt.failure.lastErrorCode ?? 'unknown';
            autoGuidance = `Previous attempt failed: tool error "${lastError}". Try a different approach.`;
          } else {
            autoGuidance = 'Previous attempt failed. Try again with a different approach.';
          }

          this.logger.info(
            {
              runId: run.id,
              attemptIndex: attempt.index,
              failureCategory: attempt.failure?.category,
            },
            'Auto-retrying retryable failure'
          );

          // Clean up container before retry
          if (containerHandle && this.containerManager) {
            try {
              await this.containerManager.destroy(run.id);
              this.logger.info({ runId: run.id }, 'Container destroyed before auto-retry');
            } catch (destroyError) {
              this.logger.warn(
                { runId: run.id, error: destroyError },
                'Failed to destroy container'
              );
            }
          }

          // Retry via retryRun (creates new attempt, re-creates container)
          await this.retryRun(run.id, autoGuidance);
          return; // Exit this function — retryRun handles the rest
        }

        // Not retryable or max attempts reached — emit failure signal
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        await this.stateManager.updateRun(run);

        this.pushSignal(
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
                ...(attempt.failure && { failure: attempt.failure }),
                error: {
                  message: attempt.failure?.hint ?? 'Model execution failed',
                  lastStep: `Iteration ${String(attempt.stepCursor)}`,
                },
              },
            }
          )
        );
      }
    } catch (error) {
      // Motor loop threw an unhandled error (e.g. LLM provider failure, container failure, storage failure).
      // Mark attempt and run as failed, emit signal so cognition layer gets feedback.
      const message = error instanceof Error ? error.message : String(error);

      // Classify: infrastructure errors (container, Docker, storage) vs model errors
      const isInfraError = /container|docker|image|network policy|storage/i.test(message);
      const category = isInfraError ? 'infra_failure' : 'model_failure';

      this.logger.error(
        { runId: run.id, attemptId: attempt.id, error: message, category },
        'Motor loop crashed'
      );

      attempt.status = 'failed';
      attempt.completedAt = new Date().toISOString();
      attempt.failure = {
        category,
        retryable: !isInfraError, // Infra errors won't fix themselves with guidance
        suggestedAction: isInfraError ? 'stop' : 'retry_with_guidance',
        lastToolResults: [],
        hint: message,
      };
      delete attempt.pendingQuestion;
      delete attempt.pendingApproval;
      delete attempt.pendingToolCallId;

      run.status = 'failed';
      run.completedAt = new Date().toISOString();

      try {
        await this.stateManager.updateRun(run);
      } catch {
        this.logger.error({ runId: run.id }, 'Failed to persist failed run state');
      }

      this.pushSignal(
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
              failure: attempt.failure,
              error: { message },
            },
          }
        )
      );
    } finally {
      this.runAbortControllers.delete(run.id);

      // Keep container alive when paused (awaiting_input / awaiting_approval) —
      // respondToRun / respondToApproval will call runLoopInBackground again,
      // which reuses the container. Only destroy on terminal states.
      const paused = run.status === 'awaiting_input' || run.status === 'awaiting_approval';
      if (containerHandle && this.containerManager && !paused) {
        this.activeContainers.delete(run.id);
        try {
          await this.containerManager.destroy(run.id);
          this.logger.info({ runId: run.id }, 'Container destroyed');
        } catch (destroyError) {
          this.logger.warn({ runId: run.id, error: destroyError }, 'Failed to destroy container');
        }
      }
    }
  }

  /**
   * List runs with optional filtering.
   */
  async listRuns(filter?: { status?: string; limit?: number }): Promise<{
    runs: MotorRun[];
    total: number;
  }> {
    let runs = await this.stateManager.listRuns(
      filter?.status ? { status: filter.status as RunStatus } : undefined
    );

    // Apply limit
    if (filter?.limit) {
      runs = runs.slice(0, filter.limit);
    }

    return { runs, total: runs.length };
  }

  /**
   * Get run status by ID.
   */
  async getRunStatus(runId: string): Promise<MotorRun | null> {
    return this.stateManager.getRun(runId);
  }

  /**
   * Cancel a run.
   */
  async cancelRun(runId: string): Promise<{
    runId: string;
    previousStatus: RunStatus;
    newStatus: 'failed';
  }> {
    const run = await this.stateManager.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const previousStatus = run.status;

    // Mark current attempt as failed
    const currentAttempt = run.attempts[run.currentAttemptIndex];
    if (
      currentAttempt &&
      currentAttempt.status !== 'completed' &&
      currentAttempt.status !== 'failed'
    ) {
      currentAttempt.status = 'failed';
      currentAttempt.completedAt = new Date().toISOString();
    }

    run.status = 'failed';
    run.completedAt = new Date().toISOString();

    await this.stateManager.updateRun(run);

    // Abort the in-flight motor loop (if running)
    const abortController = this.runAbortControllers.get(runId);
    if (abortController) {
      abortController.abort();
      this.runAbortControllers.delete(runId);
    }

    // Destroy container if kept alive from a paused state
    if (this.activeContainers.has(runId) && this.containerManager) {
      this.activeContainers.delete(runId);
      try {
        await this.containerManager.destroy(runId);
        this.logger.info({ runId }, 'Container destroyed on cancel');
      } catch (destroyError) {
        this.logger.warn({ runId, error: destroyError }, 'Failed to destroy container on cancel');
      }
    }

    // No signal emitted here — the cognition layer already knows (it called core.task.cancel
    // and got the tool result). Emitting a signal would trigger a redundant tick and duplicate message.
    // The aborted motor loop also won't emit a signal because run.status is already 'failed'.

    this.logger.info({ runId, previousStatus }, 'Motor Cortex run canceled');

    return { runId, previousStatus, newStatus: 'failed' };
  }

  /**
   * Respond to a run that's awaiting input.
   *
   * @param runId - Run ID
   * @param answer - User's answer text
   * @param domains - Optional additional domains to allow (merged with existing)
   */
  async respondToRun(
    runId: string,
    answer: string,
    domains?: string[]
  ): Promise<{
    runId: string;
    previousStatus: 'awaiting_input';
    newStatus: 'running';
  }> {
    const run = await this.stateManager.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== 'awaiting_input') {
      throw new Error(`Run ${runId} is not awaiting input (status: ${run.status})`);
    }

    // Clear awaiting input timeout
    if (this.awaitingInputTimer) {
      clearTimeout(this.awaitingInputTimer);
      this.awaitingInputTimer = null;
    }

    // Get current attempt
    const attempt = run.attempts[run.currentAttemptIndex];
    if (!attempt) {
      throw new Error(`Run ${runId} has no current attempt`);
    }

    // Auto-extract domains from the pending question if no explicit domains provided.
    // The sub-agent often asks "I need access to github.com, api.example.com" —
    // parse those out so the user/Cognition doesn't have to repeat them.
    let effectiveDomains = domains;
    if ((!effectiveDomains || effectiveDomains.length === 0) && attempt.pendingQuestion) {
      const extracted = extractDomainsFromText(attempt.pendingQuestion);
      if (extracted.length > 0) {
        effectiveDomains = extracted;
        this.logger.info(
          { runId, extractedDomains: extracted },
          'Auto-extracted domains from pending question'
        );
      }
    }

    // Merge domains with existing run domains (union, deduped)
    if (effectiveDomains && effectiveDomains.length > 0) {
      const existingDomains = run.domains ?? [];
      run.domains = Array.from(new Set([...existingDomains, ...effectiveDomains]));
      this.logger.info(
        { runId, newDomains: effectiveDomains, mergedDomains: run.domains },
        'Domains expanded on respond'
      );
    }

    // Inject tool result for the ask_user call (Lesson Learned #2: tool_call/result atomicity)
    if (attempt.pendingToolCallId) {
      const domainNote =
        effectiveDomains && effectiveDomains.length > 0
          ? ` Network access granted for: ${effectiveDomains.join(', ')}.`
          : '';
      attempt.messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: true, output: `User answered: ${answer}${domainNote}` }),
        tool_call_id: attempt.pendingToolCallId,
      });
    }

    // Update status
    attempt.status = 'running';
    attempt.pendingQuestion = '';
    delete attempt.pendingToolCallId;

    run.status = 'running';
    await this.stateManager.updateRun(run);

    this.logger.info({ runId }, 'User response received, resuming Motor Cortex loop');

    // Resume loop in background
    this.runLoopInBackground(run, attempt).catch((error: unknown) => {
      this.logger.error({ runId, error }, 'Motor loop resumption failed');
    });

    return { runId, previousStatus: 'awaiting_input', newStatus: 'running' };
  }

  /**
   * Respond to a run that's awaiting approval.
   *
   * @param runId - Run ID
   * @param approved - Whether the action is approved
   */
  async respondToApproval(
    runId: string,
    approved: boolean
  ): Promise<{
    runId: string;
    previousStatus: 'awaiting_approval';
    newStatus: 'running' | 'failed';
  }> {
    const run = await this.stateManager.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== 'awaiting_approval') {
      throw new Error(`Run ${runId} is not awaiting approval (status: ${run.status})`);
    }

    // Get current attempt
    const attempt = run.attempts[run.currentAttemptIndex];
    if (!attempt) {
      throw new Error(`Run ${runId} has no current attempt`);
    }

    // Inject tool result for the request_approval call
    if (attempt.pendingToolCallId) {
      attempt.messages.push({
        role: 'tool',
        content: JSON.stringify({
          ok: approved,
          output: approved ? 'Approved. Proceed.' : 'Denied. Do not proceed with this action.',
        }),
        tool_call_id: attempt.pendingToolCallId,
      });
    }

    if (approved) {
      attempt.status = 'running';
      delete attempt.pendingApproval;
      delete attempt.pendingToolCallId;

      run.status = 'running';
      await this.stateManager.updateRun(run);

      this.logger.info({ runId }, 'Approval granted, resuming Motor Cortex loop');
      this.runLoopInBackground(run, attempt).catch((error: unknown) => {
        this.logger.error({ runId, error }, 'Motor loop resumption failed');
      });

      return { runId, previousStatus: 'awaiting_approval', newStatus: 'running' };
    } else {
      attempt.status = 'failed';
      attempt.completedAt = new Date().toISOString();
      delete attempt.pendingApproval;
      delete attempt.pendingToolCallId;

      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      await this.stateManager.updateRun(run);

      this.pushSignal(
        createSignal(
          'motor_result',
          'motor.cortex',
          { value: 1, confidence: 1 },
          {
            data: {
              kind: 'motor_result',
              runId,
              status: 'failed',
              attemptIndex: attempt.index,
              error: { message: 'Approval denied by user' },
            },
          }
        )
      );

      this.logger.info({ runId }, 'Approval denied, run failed');
      return { runId, previousStatus: 'awaiting_approval', newStatus: 'failed' };
    }
  }

  /**
   * Recover runs on restart.
   *
   * - running → resume from stepCursor
   * - awaiting_input → re-emit signal
   * - created → transition to running and start
   */
  async recoverOnRestart(): Promise<void> {
    this.logger.info('Recovering Motor Cortex runs from state...');

    // Prune stale containers from previous runs
    if (this.containerManager) {
      try {
        const pruned = await this.containerManager.prune(5 * 60 * 1000); // 5 min
        if (pruned > 0) {
          this.logger.info({ pruned }, 'Pruned stale Motor Cortex containers');
        }
      } catch (error) {
        this.logger.warn({ error }, 'Failed to prune stale containers');
      }
    }

    const activeRuns = await this.stateManager.listRuns();
    let resumed = 0;
    let reEmitted = 0;

    for (const run of activeRuns) {
      const attempt = run.attempts[run.currentAttemptIndex];
      if (!attempt) continue;

      switch (run.status) {
        case 'running': {
          // Stale check: if no progress was made (stepCursor 0) and run is older than 5 min,
          // the LLM likely crashed before producing any output — fail rather than retry.
          const ageMs = Date.now() - new Date(run.startedAt).getTime();
          const STALE_THRESHOLD_MS = 5 * 60 * 1000;
          if (attempt.stepCursor === 0 && ageMs > STALE_THRESHOLD_MS) {
            this.logger.info(
              { runId: run.id, ageMs },
              'Failing stale run (no progress, older than 5 min)'
            );
            attempt.status = 'failed';
            attempt.completedAt = new Date().toISOString();
            run.status = 'failed';
            run.completedAt = new Date().toISOString();
            await this.stateManager.updateRun(run);
            this.pushSignal(
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
                    error: { message: 'Run stale on restart (no progress before crash)' },
                  },
                }
              )
            );
            break;
          }

          // Resume from stepCursor
          this.logger.info(
            { runId: run.id, stepCursor: attempt.stepCursor, attemptIndex: attempt.index },
            'Resuming Motor Cortex run'
          );
          this.runLoopInBackground(run, attempt).catch((error: unknown) => {
            this.logger.error({ runId: run.id, error }, 'Motor loop resumption failed');
          });
          resumed++;
          break;
        }

        case 'awaiting_input':
          // Re-emit signal
          this.logger.info({ runId: run.id }, 'Re-emitting awaiting_input signal');
          if (attempt.pendingQuestion) {
            this.pushSignal(
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
                    question: attempt.pendingQuestion,
                  },
                }
              )
            );
          }
          reEmitted++;
          break;

        case 'awaiting_approval':
          // Check timeout, auto-cancel if expired
          if (attempt.pendingApproval) {
            const expiresAt = new Date(attempt.pendingApproval.expiresAt);
            if (new Date() > expiresAt) {
              this.logger.info({ runId: run.id }, 'Approval timed out, auto-canceling');
              attempt.status = 'failed';
              attempt.completedAt = new Date().toISOString();
              delete attempt.pendingApproval;
              delete attempt.pendingToolCallId;
              run.status = 'failed';
              run.completedAt = new Date().toISOString();
              await this.stateManager.updateRun(run);
              this.pushSignal(
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
                      error: { message: 'Approval timed out (15 min)' },
                    },
                  }
                )
              );
            } else {
              // Re-emit approval signal
              this.logger.info({ runId: run.id }, 'Re-emitting awaiting_approval signal');
              this.pushSignal(
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
                      approval: {
                        action: attempt.pendingApproval.action,
                        expiresAt: attempt.pendingApproval.expiresAt,
                      },
                    },
                  }
                )
              );
              reEmitted++;
            }
          }
          break;

        case 'created':
          // Transition to running and start
          this.logger.info({ runId: run.id }, 'Starting created run');
          run.status = 'running';
          attempt.status = 'running';
          await this.stateManager.updateRun(run);
          this.runLoopInBackground(run, attempt).catch((error: unknown) => {
            this.logger.error({ runId: run.id, error }, 'Motor loop start failed');
          });
          resumed++;
          break;
      }
    }

    this.logger.info({ resumed, reEmitted }, 'Motor Cortex recovery complete');
  }
}

/**
 * Extract domain names from free-text (e.g. "I need access to github.com and api.example.com").
 *
 * Matches patterns like: github.com, api.github.com, raw.githubusercontent.com
 * Also expands github.com → includes raw.githubusercontent.com and api.github.com.
 */
export function extractDomainsFromText(text: string): string[] {
  // Match domain-like patterns (2+ labels, TLD 2-10 chars)
  const domainRegex = /\b([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,10}\b/gi;
  const matches = text.match(domainRegex) ?? [];

  // Deduplicate and lowercase
  const domains = new Set(matches.map((d) => d.toLowerCase()));

  // Filter out common false positives
  const blocklist = new Set([
    'e.g',
    'i.e',
    'etc.com',
    'example.com',
    'example.org',
    'domain1.com',
    'domain2.com',
    'their.answer',
  ]);
  for (const blocked of blocklist) {
    domains.delete(blocked);
  }

  // Auto-expand github.com to include common subdomains
  if (domains.has('github.com')) {
    domains.add('raw.githubusercontent.com');
    domains.add('api.github.com');
    domains.add('codeload.github.com');
  }

  return Array.from(domains);
}

/**
 * Factory function for creating Motor Cortex service.
 */
export function createMotorCortex(deps: MotorCortexDeps): MotorCortex {
  return new MotorCortex(deps);
}
