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
import { type MotorStateManager, createMotorStateManager } from './motor-state.js';
import { runMotorLoop, buildInitialMessages } from './motor-loop.js';
import { runSandbox } from '../sandbox/sandbox-runner.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { CredentialStore } from '../vault/credential-store.js';
import { loadSkill } from '../skills/skill-loader.js';

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

  /** Signal callback (wired by container) */
  private signalCallback: ((signal: Signal) => void) | null = null;

  /** Awaiting input timeout timer */
  private awaitingInputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: MotorCortexDeps) {
    this.llm = deps.llm;
    this.logger = deps.logger.child({ component: 'motor-cortex' });
    this.energyModel = deps.energyModel;
    this.stateManager = createMotorStateManager(deps.storage, this.logger);
    this.credentialStore = deps.credentialStore;
    this.skillsDir = deps.skillsDir;
    this.artifactsBaseDir = deps.artifactsBaseDir;

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
  }): Promise<{ runId: string; status: 'created' }> {
    // Check mutex - only one agentic run at a time
    const activeRun = await this.stateManager.getActiveRun();
    if (activeRun) {
      throw new Error(
        `Cannot start new run: active run exists (${activeRun.id}, status: ${activeRun.status})`
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
    };

    // Set skill name on the run if one was provided
    if (params.skill) {
      run.skill = params.skill.definition.name;
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
   * @returns Run ID and new attempt index
   */
  async retryRun(
    runId: string,
    guidance: string,
    constraints?: string[]
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

    // Check mutex: no other active run
    const activeRun = await this.stateManager.getActiveRun();
    if (activeRun) {
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
    try {
      // Transition to running
      run.status = 'running';
      attempt.status = 'running';
      await this.stateManager.updateRun(run);

      // Run the loop
      await runMotorLoop({
        run,
        attempt,
        llm: this.llm,
        stateManager: this.stateManager,
        pushSignal: (signal) => {
          this.pushSignal(signal);
        },
        logger: this.logger,
        ...(this.skillsDir && { skillsDir: this.skillsDir }),
        ...(this.credentialStore && { credentialStore: this.credentialStore }),
        ...(this.artifactsBaseDir && { artifactsBaseDir: this.artifactsBaseDir }),
      });
    } catch (error) {
      // Motor loop threw an unhandled error (e.g. LLM provider failure, storage failure).
      // Mark attempt and run as failed, emit signal so cognition layer gets feedback.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { runId: run.id, attemptId: attempt.id, error: message },
        'Motor loop crashed'
      );

      attempt.status = 'failed';
      attempt.completedAt = new Date().toISOString();
      attempt.failure = {
        category: 'model_failure',
        retryable: true,
        suggestedAction: 'retry_with_guidance',
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

    // Emit canceled signal
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
            attemptIndex: run.currentAttemptIndex,
            error: { message: 'Run canceled by user' },
          },
        }
      )
    );

    this.logger.info({ runId, previousStatus }, 'Motor Cortex run canceled');

    return { runId, previousStatus, newStatus: 'failed' };
  }

  /**
   * Respond to a run that's awaiting input.
   */
  async respondToRun(
    runId: string,
    answer: string
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

    // Inject tool result for the ask_user call (Lesson Learned #2: tool_call/result atomicity)
    if (attempt.pendingToolCallId) {
      attempt.messages.push({
        role: 'tool',
        content: JSON.stringify({ ok: true, output: `User answered: ${answer}` }),
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
 * Factory function for creating Motor Cortex service.
 */
export function createMotorCortex(deps: MotorCortexDeps): MotorCortex {
  return new MotorCortex(deps);
}
