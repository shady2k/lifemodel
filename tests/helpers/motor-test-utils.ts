/**
 * Motor Cortex Test Utilities
 *
 * Reusable factories for motor loop tests, building on existing patterns.
 * Provides in-memory mocks for state management and complete test setup.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  MotorRun,
  MotorAttempt,
  MotorTool,
  RunTrace,
  StepTrace,
} from '../../src/runtime/motor-cortex/motor-protocol.js';
import type { MotorStateManager } from '../../src/runtime/motor-cortex/motor-state.js';
import type { MotorLoopParams } from '../../src/runtime/motor-cortex/motor-loop.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Logger } from '../../src/types/index.js';
import type { Signal } from '../../src/types/signal.js';
import { buildMotorSystemPrompt } from '../../src/runtime/motor-cortex/motor-prompt.js';
import { createMockLogger } from './factories.js';

/**
 * History entry for state manager write tracking.
 */
export type StateHistoryEntry = {
  action: 'create' | 'update';
  run: MotorRun;
  timestamp: number;
};

/**
 * In-memory state manager for testing.
 */
export interface MockMotorStateManager extends MotorStateManager {
  /** All runs stored in memory */
  runs: MotorRun[];

  /** History of all writes with timestamps */
  history: StateHistoryEntry[];

  /** Find a run by ID */
  findRun(id: string): MotorRun | undefined;
}

/**
 * Create a test MotorAttempt with defaults.
 */
export function createTestAttempt(
  overrides?: Partial<MotorAttempt>
): MotorAttempt {
  const trace: RunTrace = {
    runId: 'test-run',
    task: 'Test task',
    status: 'running',
    steps: [],
    totalIterations: 0,
    totalDurationMs: 0,
    totalEnergyCost: 0,
    llmCalls: 0,
    toolCalls: 0,
    errors: 0,
  };

  return {
    id: 'att_0',
    index: 0,
    status: 'running',
    messages: [],
    stepCursor: 0,
    maxIterations: 20,
    trace,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a test MotorRun with defaults.
 */
export function createTestMotorRun(overrides?: Partial<MotorRun>): MotorRun {
  const attempt = createTestAttempt();

  return {
    id: 'test-run',
    status: 'running',
    task: 'Test task',
    tools: ['bash', 'read', 'write', 'list'],
    attempts: [attempt],
    currentAttemptIndex: 0,
    maxAttempts: 3,
    startedAt: new Date().toISOString(),
    energyConsumed: 0,
    config: {
      syntheticTools: ['ask_user', 'save_credential', 'request_approval'],
    },
    ...overrides,
  };
}

/**
 * Create an in-memory mock state manager.
 *
 * Tracks all writes in history for pause/resume correctness assertions.
 */
export function createMockStateManager(): MockMotorStateManager {
  const runs: MotorRun[] = [];
  const history: StateHistoryEntry[] = [];

  return {
    runs,

    history,

    findRun(id: string): MotorRun | undefined {
      return runs.find((r) => r.id === id);
    },

    async createRun(run: MotorRun): Promise<void> {
      runs.push(run);
      history.push({ action: 'create', run: { ...run }, timestamp: Date.now() });
    },

    async updateRun(run: MotorRun): Promise<void> {
      const index = runs.findIndex((r) => r.id === run.id);
      if (index === -1) {
        throw new Error(`Run not found: ${run.id}`);
      }
      runs[index] = run;
      history.push({ action: 'update', run: { ...run }, timestamp: Date.now() });
    },

    async getRun(runId: string): Promise<MotorRun | null> {
      return runs.find((r) => r.id === runId) ?? null;
    },

    async listRuns(filter?: { status?: string }): Promise<MotorRun[]> {
      let result = [...runs];
      if (filter?.status) {
        result = result.filter((r) => r.status === filter.status);
      }
      return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    async getActiveRun(): Promise<MotorRun | null> {
      return (
        runs.find(
          (r) =>
            r.status === 'running' ||
            r.status === 'created' ||
            r.status === 'awaiting_input' ||
            r.status === 'awaiting_approval'
        ) ?? null
      );
    },
  };
}

/**
 * Create a mock pushSignal function that captures all signals.
 */
export function createMockPushSignal() {
  const signals: Signal[] = [];

  const pushSignal = (signal: Signal) => {
    signals.push(signal);
  };

  return {
    pushSignal,
    signals,
    getLastSignal: () => signals[signals.length - 1],
    getSignalsByType: (type: string) => signals.filter((s) => s.type === type),
    clear: () => {
      signals.length = 0;
    },
    count: () => signals.length,
  };
}

/**
 * Test loop params options.
 */
export interface TestLoopParamsOptions {
  /** LLM provider to use (required) */
  llm: LLMProvider;

  /** Override the run (optional) */
  run?: MotorRun;

  /** Override the attempt (optional) */
  attempt?: MotorAttempt;

  /** Tools to grant (default: ['read', 'write', 'list']) */
  tools?: MotorTool[];

  /** Logger (default: createMockLogger()) */
  logger?: Logger;

  /** Task description (default: 'Test task') */
  task?: string;

  /** Credentials map (optional) */
  credentialStore?: Record<string, string>;

  /** Artifacts base directory (optional) */
  artifactsBaseDir?: string;

  /** External state manager (optional, for sharing between tests) */
  stateManager?: MockMotorStateManager;

  /** External workspace (optional, for reusing existing workspace) */
  workspace?: string;
}

/**
 * Create complete test loop params with temp workspace.
 *
 * Creates:
 * - Real temp workspace (via mkdtemp)
 * - Mock logger, mock pushSignal, mock state manager
 * - Scripted LLM (caller provides)
 * - Default tools: ['read', 'write', 'list']
 *
 * IMPORTANT: Caller must clean up the workspace using cleanupTestLoopParams().
 */
export async function createTestLoopParams(
  options: TestLoopParamsOptions
): Promise<{
  params: MotorLoopParams;
  cleanup: () => Promise<void>;
  stateManager: MockMotorStateManager;
  pushSignal: ReturnType<typeof createMockPushSignal>;
  logger: ReturnType<typeof createMockLogger>;
  workspace: string;
}> {
  // Create or reuse temp workspace
  const workspace = options.workspace ?? await mkdtemp(join(tmpdir(), 'motor-test-'));

  // Create mocks
  const logger = options.logger ?? createMockLogger();
  const stateManager = options.stateManager ?? createMockStateManager();
  const pushSignal = createMockPushSignal();

  // Create run and attempt
  const tools = options.tools ?? ['read', 'write', 'list'];
  const task = options.task ?? 'Test task';

  const run =
    options.run ??
    createTestMotorRun({
      task,
      tools,
      workspacePath: workspace,
    });

  // Build initial messages for the attempt (system prompt + "Begin the task.")
  const systemPrompt = buildMotorSystemPrompt({
    task: run.task,
    tools: run.tools,
    syntheticTools: run.config.syntheticTools,
  });
  const attempt =
    options.attempt ??
    createTestAttempt({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Begin the task.' },
      ],
    });

  // Add attempt to run if not already there
  if (!run.attempts.includes(attempt)) {
    run.attempts.push(attempt);
    run.currentAttemptIndex = run.attempts.length - 1;
  }

  // Create run in state manager (required for updateRun to work)
  await stateManager.createRun(run);

  const params: MotorLoopParams = {
    run,
    attempt,
    llm: options.llm,
    stateManager,
    pushSignal: pushSignal.pushSignal.bind(pushSignal),
    logger,
    artifactsBaseDir: options.artifactsBaseDir ?? workspace,
    workspace,
    syntheticTools: run.config.syntheticTools,
    ...(options.credentialStore !== undefined && { credentials: options.credentialStore }),
  };

  const cleanup = async () => {
    // Only clean up workspace if we created it (not externally provided)
    if (!options.workspace) {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  return { params, cleanup, stateManager, pushSignal, logger, workspace };
}

/**
 * Create a minimal StepTrace for testing.
 */
export function createTestStep(
  overrides?: Partial<StepTrace>
): StepTrace {
  return {
    iteration: 0,
    timestamp: new Date().toISOString(),
    llmModel: 'test-model',
    toolCalls: [],
    ...overrides,
  };
}
