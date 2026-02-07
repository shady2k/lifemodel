# Motor Cortex — Phase 1 Implementation Plan

Phase 1 ("Hands") delivers the async sub-agent loop with code sandbox. This document breaks the work into 8 ordered steps with explicit dependencies.

Reference: [design.md](design.md) for full architecture and rationale.

---

## Implementation Status: COMPLETE

Phase 1 is implemented with these deviations from the original plan:

| Change | Reason |
|--------|--------|
| Shell tool disabled (deferred to Phase 2) | Insufficient isolation: no folder jailing, shell argument injection via `exec()`, `rm -rf /` passes allowlist |
| `core.tasks` merged into `core.task` | Single tool with `action: list\|status\|cancel\|respond` — avoids LLM confusion between near-identical names |
| `tasks.ts` deleted, `task.ts` rewritten | Follows the `filesystem` tool pattern (one tool, action parameter) |
| Path traversal protection added | `resolveSafePath()` using `resolve()` + `relative()` rejects `../../etc/passwd` |
| `pendingToolCallId` added to `MotorRun` | Preserves tool_call/tool_result atomicity for `ask_user` (Lesson Learned #2) |
| `getActiveRun()` includes `awaiting_input` | Enforces single-run mutex even when paused for user input |
| Sandbox runner `settled` guard | Prevents double-resolve race between timeout/message/error/exit handlers |
| `MotorTool` type is `'code' \| 'filesystem' \| 'ask_user'` | Shell removed from union; shell runner files kept for Phase 2 |

---

## Step 1 — Protocol types

**Creates:** `src/runtime/motor-cortex/motor-protocol.ts`

**Dependencies:** none

Pure type definitions — no runtime code, no imports from the project (except `Message` from `src/llm/provider.ts`).

```typescript
// All types the Motor Cortex system shares

type RunStatus = 'created' | 'running' | 'awaiting_input' | 'completed' | 'failed';

type MotorTool = 'code' | 'shell' | 'filesystem' | 'ask_user';

interface MotorToolResult {
  ok: boolean;
  output: string;           // Always string (JSON.stringify for structured data)
  errorCode?: string;       // 'timeout' | 'not_found' | 'auth_failed' | ...
  retryable: boolean;
  provenance: 'user' | 'web' | 'internal';
  durationMs: number;
  cost?: number;
}

interface TaskResult {
  ok: boolean;
  summary: string;
  runId: string;
  stats: {
    iterations: number;
    durationMs: number;
    energyCost: number;
    errors: number;
  };
}

interface StepTrace {
  iteration: number;
  timestamp: string;
  llmModel: string;
  toolCalls: {
    tool: string;
    args: Record<string, unknown>;
    result: MotorToolResult;
    durationMs: number;
  }[];
  reasoning?: string;
  evidence?: string;
}

interface RunTrace {
  runId: string;
  task: string;
  skill?: string;
  status: RunStatus;
  steps: StepTrace[];
  totalIterations: number;
  totalDurationMs: number;
  totalEnergyCost: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
}

interface MotorRun {
  id: string;
  status: RunStatus;
  task: string;
  skill?: string;
  tools: MotorTool[];
  stepCursor: number;
  maxIterations: number;
  messages: Message[];          // Sub-agent conversation (from src/llm/provider.ts)
  pendingQuestion?: string;     // Set when status = 'awaiting_input'
  result?: TaskResult;
  startedAt: string;
  completedAt?: string;
  energyConsumed: number;
  trace: RunTrace;
}
```

**Pattern to follow:** Type-only files like `src/layers/cognition/agentic-loop-types.ts` — export types, no runtime deps.

---

## Step 2 — Integration point edits

**Modifies:** 6 existing files (surgical additions only)

**Dependencies:** none (can be done in parallel with Step 1)

### 2a. `src/types/signal.ts`

Add to `SignalType` union:
```typescript
  // === MOTOR CORTEX (from runtime service) ===
  | 'motor_result'     // Motor Cortex run completed, failed, or needs input
```

Add to `SignalSource` union:
```typescript
  // === MOTOR CORTEX ===
  | 'motor.cortex'     // From Motor Cortex runtime service
```

Add `MotorResultData` interface and include it in `SignalData` union:
```typescript
export interface MotorResultData {
  kind: 'motor_result';
  runId: string;
  status: 'completed' | 'failed' | 'awaiting_input';
  result?: {
    ok: boolean;
    summary: string;
    stats: { iterations: number; durationMs: number; energyCost: number; errors: number };
  };
  error?: { message: string; lastStep?: string };
  question?: string;
}
```

Add to `SIGNAL_TTL`:
```typescript
  motor_result: 5 * 60_000,   // 5 minutes — results are important
```

### 2b. `src/core/energy.ts`

Extend `DrainType`:
```typescript
export type DrainType = 'tick' | 'event' | 'llm' | 'message' | 'motor_oneshot' | 'motor_agentic';
```

Add to `EnergyConfig`:
```typescript
  /** Drain for Motor Cortex oneshot execution (default: 0.05) */
  motorOneshotDrain: number;
  /** Drain for Motor Cortex agentic run (default: 0.15) */
  motorAgenticDrain: number;
```

Add defaults to `DEFAULT_ENERGY_CONFIG`:
```typescript
  motorOneshotDrain: 0.05,
  motorAgenticDrain: 0.15,
```

Add cases to `getDrainAmount()`:
```typescript
  case 'motor_oneshot':
    return this.config.motorOneshotDrain;
  case 'motor_agentic':
    return this.config.motorAgenticDrain;
```

### 2c. `src/llm/provider.ts`

Extend `ModelRole`:
```typescript
export type ModelRole = 'fast' | 'smart' | 'motor';
```

### 2d. `src/llm/multi-provider.ts`

Add motor slot to `MultiProviderConfig`:
```typescript
  /** Provider for Motor Cortex sub-agent tasks */
  motor?: LLMProvider | undefined;
```

Add motor case to `getProvider()`:
```typescript
  case 'motor':
    return this.providers.motor ?? this.providers.fast ?? this.providers.default;
```

### 2e. `src/config/config-schema.ts` + `src/config/config-loader.ts`

In `AgentConfigFile.llm`:
```typescript
    /** Motor Cortex model */
    motorModel?: string;
```

In `MergedConfig.llm`:
```typescript
    motorModel: string;
```

In `DEFAULT_CONFIG.llm`:
```typescript
    motorModel: 'anthropic/claude-haiku-4.5',
```

In `config-loader.ts` — `mergeConfigFile`:
```typescript
  if (file.llm?.motorModel) {
    config.llm.motorModel = file.llm.motorModel;
  }
```

In `config-loader.ts` — `mergeEnvironment`:
```typescript
  const motorModel = process.env['LLM_MOTOR_MODEL'];
  if (motorModel) {
    config.llm.motorModel = motorModel;
  }
```

### 2f. `src/layers/aggregation/threshold-engine.ts`

In `evaluate()`, add a check for `motor_result` signals right after the `user_message` / `message_reaction` checks (before the energy gate):

```typescript
    // Motor Cortex results — always wake immediately (user is waiting)
    const motorResults = signals.filter((s) => s.type === 'motor_result');
    if (motorResults.length > 0) {
      return {
        shouldWake: true,
        trigger: 'scheduled',   // closest existing WakeTrigger
        reason: 'Motor Cortex run result',
        triggerSignals: motorResults,
      };
    }
```

---

## Step 3 — Sandbox

**Creates:** `src/runtime/sandbox/`

**Dependencies:** Step 1 (uses `MotorToolResult`)

### `sandbox-guard.ts`

Static code safety checks — best-effort regex:
- Reject `require(`, `import(`, `process.`, `child_process`, `fs.`, `eval(`, `Function(`
- Accept: `Math.*`, `JSON.*`, `Date.*`, `console.log`
- Export: `function guardCode(code: string): { safe: boolean; reason?: string }`

### `sandbox-worker.ts`

Child process entry point:
- Strip dangerous globals (`process.env`, `require`, `__dirname`, `__filename`)
- Receive code via IPC message
- Execute with `new Function()` (NOT eval — Function has no closure access)
- Send result back via IPC
- Result size limit: 32KB

### `sandbox-runner.ts`

Fork orchestrator:
- `child_process.fork('./sandbox-worker.ts')` with stripped env
- Set SIGKILL timer (default 5s for oneshot, 30s for agentic code steps)
- IPC protocol: `{ type: 'execute', code: string }` → `{ type: 'result', ok, output, error }`
- Return `MotorToolResult` envelope
- Export: `function runSandbox(code: string, timeoutMs: number): Promise<MotorToolResult>`

**Pattern to follow:** Existing `child_process` usage in the project (if any), otherwise standard Node.js fork pattern.

---

## Step 4 — Shell

**Creates:** `src/runtime/shell/`

**Dependencies:** Step 1 (uses `MotorToolResult`)

### `shell-allowlist.ts`

Strict command allowlist:
```typescript
const DEFAULT_ALLOWLIST = new Set([
  'curl', 'jq', 'grep', 'sort', 'uniq', 'wc',
  'head', 'tail', 'cat', 'echo', 'date', 'ls', 'pwd', 'mkdir', 'cp', 'mv', 'rm',
]);

// Also: network-capable commands (for provenance tagging)
const NETWORK_COMMANDS = new Set(['curl', 'wget']);
```

- Validate pipe chains: each command in `|` pipeline must be allowlisted
- `node` and `npx` intentionally excluded (use code tool instead)
- Export: `function validateCommand(command: string, allowlist?: Set<string>): { valid: boolean; reason?: string }`
- Export: `function isNetworkCommand(command: string): boolean`

### `shell-runner.ts`

Controlled execution:
- Use `child_process.execFile` (NOT `exec` — no shell interpretation)
- For pipes: split into chain, validate each, execute via `sh -c` with escaped args
- Working directory: restricted to a temporary workspace directory
- Timeout: 60s default
- Output truncated to 10KB
- Environment variables stripped (only PATH passed through)
- Return `MotorToolResult` with `provenance: 'web'` if network command detected
- Export: `function runShell(command: string, opts: ShellOptions): Promise<MotorToolResult>`

---

## Step 5 — Motor state

**Creates:** `src/runtime/motor-cortex/motor-state.ts`

**Dependencies:** Step 1 (uses `MotorRun`, `RunStatus`)

`MotorStateManager` — CRUD over DeferredStorage:

```typescript
class MotorStateManager {
  constructor(storage: Storage, logger: Logger);

  async createRun(run: MotorRun): Promise<void>;     // Persist + flush
  async updateRun(run: MotorRun): Promise<void>;      // Persist + flush
  async getRun(runId: string): Promise<MotorRun | null>;
  async listRuns(filter?: { status?: RunStatus }): Promise<MotorRun[]>;
  async getActiveRun(): Promise<MotorRun | null>;     // Status = 'running' | 'created'

  // Explicit flush after critical state transitions
  async flush(): Promise<void>;
}
```

Storage key: `motor-runs` (all runs in one object, consistent with existing state storage).

**Pattern to follow:** `createStateManager` in `src/storage/state-manager.ts` — uses DeferredStorage with explicit flush.

**On restart recovery:**
- Runs with `status: 'running'` → resume from `stepCursor`
- Runs with `status: 'awaiting_input'` → re-emit `motor_result` signal
- Runs with `status: 'created'` → transition to `running` and start

---

## Step 6 — Motor tools + loop

**Creates:** `src/runtime/motor-cortex/motor-tools.ts`, `src/runtime/motor-cortex/motor-loop.ts`

**Dependencies:** Steps 1, 3, 4, 5

### `motor-tools.ts`

Tool definitions for the Motor Cortex sub-agent LLM. These are NOT cognition tools — they're the tools the motor sub-agent can call.

```typescript
// Tool definitions in OpenAI function calling format
const MOTOR_TOOL_DEFINITIONS = {
  code: {
    name: 'code',
    description: 'Execute JavaScript code in a sandboxed environment.',
    parameters: { code: { type: 'string', description: 'JavaScript code to execute' } },
  },
  shell: {
    name: 'shell',
    description: 'Run a shell command (allowlisted commands only).',
    parameters: { command: { type: 'string', description: 'Shell command to run' } },
  },
  filesystem: {
    name: 'filesystem',
    description: 'Read/write/list files in the workspace directory.',
    parameters: {
      action: { type: 'string', enum: ['read', 'write', 'list'] },
      path: { type: 'string' },
      content: { type: 'string', description: 'File content (for write)' },
    },
  },
  ask_user: {
    name: 'ask_user',
    description: 'Ask the user a question. Pauses execution until they respond.',
    parameters: { question: { type: 'string' } },
  },
};
```

- Map tool name → executor function (sandbox-runner, shell-runner, fs ops)
- Export: `function getToolDefinitions(granted: MotorTool[]): OpenAIChatTool[]`
- Export: `function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<MotorToolResult>`

### `motor-loop.ts`

The sub-agent iteration loop:

```typescript
async function runMotorLoop(params: {
  run: MotorRun;
  llm: LLMProvider;
  stateManager: MotorStateManager;
  pushSignal: (signal: Signal) => void;
  logger: Logger;
}): Promise<void>;
```

Loop mechanics (from design doc):
1. Build system prompt (task + available tools + safety rules)
2. Enter iteration loop (max N iterations, starting from `stepCursor`):
   a. Call LLM with `run.messages` + tool definitions
   b. If `ask_user` → persist question, transition to `awaiting_input`, emit signal, return (loop paused)
   c. If other tool calls → execute each, record structured results, append to messages
   d. Persist run state + flush after tool execution
   e. If no tool calls → task complete, extract result from LLM content
   f. If tool error → append error to messages, let LLM reason about recovery
   g. Consecutive failure bailout: same tool fails 3x with same `errorCode` → auto-fail
3. On completion: transition to `completed`, persist, emit `motor_result` signal
4. On max iterations: transition to `failed`, emit signal with partial result

**Resumption:** When called after `awaiting_input` → answer is already injected into `run.messages` by `core.task` handler. Loop continues from `stepCursor`.

---

## Step 7 — Motor Cortex service

**Creates:** `src/runtime/motor-cortex/motor-cortex.ts`

**Dependencies:** Steps 1, 5, 6

The top-level service class:

```typescript
class MotorCortex {
  constructor(deps: {
    llm: LLMProvider;
    storage: Storage;
    logger: Logger;
    energyModel: EnergyModel;
  });

  // Signal callback (wired by container)
  setSignalCallback(cb: (signal: Signal) => void): void;

  // Oneshot: synchronous sandbox execution (no sub-agent loop)
  async executeOneshot(code: string, timeoutMs?: number): Promise<{ ok: boolean; result: unknown; durationMs: number }>;

  // Agentic: start async run (returns immediately with runId)
  async startRun(params: {
    task: string;
    tools: MotorTool[];
    maxIterations?: number;
    timeout?: number;
  }): Promise<{ runId: string; status: 'created' }>;

  // Query
  async listRuns(filter?: { status?: string; limit?: number }): Promise<{ runs: MotorRun[]; total: number }>;
  async getRunStatus(runId: string): Promise<MotorRun | null>;

  // Control
  async cancelRun(runId: string): Promise<{ runId: string; previousStatus: RunStatus; newStatus: 'failed' }>;
  async respondToRun(runId: string, answer: string): Promise<{ runId: string; previousStatus: 'awaiting_input'; newStatus: 'running' }>;

  // Restart recovery (called during container init)
  async recoverOnRestart(): Promise<void>;
}
```

Key behaviors:
- **Mutex:** Only one agentic run at a time. `startRun()` rejects if one is active (including `awaiting_input`).
- **Energy gating:** Check energy before creating run. Drain on successful creation only.
- **Oneshot passthrough:** No mutex, no runId, no sub-agent loop. Direct sandbox call.
- **Async dispatch:** `startRun()` creates the run, persists it, then kicks off `runMotorLoop()` in a fire-and-forget `Promise` (not awaited). The result comes back via signal.
- **`awaiting_input` timeout:** 30-minute auto-cancel. Timer set when entering `awaiting_input`, cleared on `respondToRun()`.
- **Restart recovery:** Load runs from state, resume `running` ones, re-emit signals for `awaiting_input` ones.

---

## Step 8 — Cognition tools + container wiring

**Creates:** 3 tool files. **Modifies:** `src/core/container.ts`

**Dependencies:** Steps 1–7

### `src/layers/cognition/tools/core/act.ts` — `core.act`

```typescript
// Tool definition (follows pattern of existing core/*.ts tools)
{
  name: 'core.act',
  description: 'Execute a task via Motor Cortex. "oneshot" runs JS code synchronously. "agentic" starts an async sub-agent task.',
  parameters: {
    mode: { type: 'string', enum: ['oneshot', 'agentic'] },
    task: { type: 'string', description: 'JS code (oneshot) or natural language task (agentic)' },
    tools: { type: 'array', items: { type: 'string', enum: ['code', 'shell', 'filesystem'] } },
    maxIterations: { type: 'number' },
    timeout: { type: 'number' },
  },
  execute: async (args, ctx) => {
    // Validate, check energy, delegate to MotorCortex service
  },
}
```

**Pattern to follow:** `src/layers/cognition/tools/core/schedule.ts` — tool definition + handler in same file, receives service via closure/context.

### `src/layers/cognition/tools/core/tasks.ts` — `core.tasks`

List runs. Parameters: `status`, `limit`. Delegates to `motorCortex.listRuns()`.

### `src/layers/cognition/tools/core/task.ts` — `core.task`

Control a run. Parameters: `runId`, `action` (status/cancel/respond), `answer`. Delegates to `motorCortex.getRunStatus()`, `.cancelRun()`, `.respondToRun()`.

### Container wiring (`src/core/container.ts`)

Add after plugin system initialization:

```typescript
// Motor Cortex service
const motorCortex = new MotorCortex({
  llm: llmProvider,
  storage,
  logger,
  energyModel: agent.getEnergyModel(),
});

// Wire signal callback
motorCortex.setSignalCallback((signal) => {
  coreLoop.pushSignal(signal);
});

// Recover any in-progress runs from before restart
await motorCortex.recoverOnRestart();

// Register core.act, core.tasks, core.task tools
layers.cognition.getToolRegistry().registerTool(createActTool(motorCortex));
layers.cognition.getToolRegistry().registerTool(createTasksTool(motorCortex));
layers.cognition.getToolRegistry().registerTool(createTaskTool(motorCortex));
```

Also add motor provider to MultiProvider config:
```typescript
// When creating MultiProvider, add motor slot:
motor: useLocalForFast ? localProvider : openRouterProvider,
// Or use a dedicated motor provider if LLM_MOTOR_MODEL is set
```

Add `motorCortex` to `Container` interface and return value.

---

## File summary

| Step | Action | Path |
|------|--------|------|
| 1 | Create | `src/runtime/motor-cortex/motor-protocol.ts` |
| 2a | Modify | `src/types/signal.ts` |
| 2b | Modify | `src/core/energy.ts` |
| 2c | Modify | `src/llm/provider.ts` |
| 2d | Modify | `src/llm/multi-provider.ts` |
| 2e | Modify | `src/config/config-schema.ts` |
| 2e | Modify | `src/config/config-loader.ts` |
| 2f | Modify | `src/layers/aggregation/threshold-engine.ts` |
| 3 | Create | `src/runtime/sandbox/sandbox-guard.ts` |
| 3 | Create | `src/runtime/sandbox/sandbox-worker.ts` |
| 3 | Create | `src/runtime/sandbox/sandbox-runner.ts` |
| 4 | Create | `src/runtime/shell/shell-allowlist.ts` |
| 4 | Create | `src/runtime/shell/shell-runner.ts` |
| 5 | Create | `src/runtime/motor-cortex/motor-state.ts` |
| 6 | Create | `src/runtime/motor-cortex/motor-tools.ts` |
| 6 | Create | `src/runtime/motor-cortex/motor-loop.ts` |
| 7 | Create | `src/runtime/motor-cortex/motor-cortex.ts` |
| 8 | Create | `src/layers/cognition/tools/core/act.ts` |
| 8 | Create | `src/layers/cognition/tools/core/tasks.ts` |
| 8 | Create | `src/layers/cognition/tools/core/task.ts` |
| 8 | Modify | `src/core/container.ts` |

**Total:** 13 new files, 8 modified files.

---

## Dependency graph

```
Step 1 (protocol types) ──┐
                          ├──► Step 3 (sandbox) ──┐
Step 2 (integration edits)│                       ├──► Step 6 (tools + loop) ──► Step 7 (service) ──► Step 8 (wiring)
                          ├──► Step 4 (shell) ────┘         ▲
                          └──► Step 5 (state) ──────────────┘
```

Steps 1 and 2 can run in parallel. Steps 3, 4, 5 can run in parallel (all depend only on 1). Step 6 depends on 3, 4, 5. Step 7 depends on 5, 6. Step 8 depends on 7.

---

## What Phase 1 does NOT include

Explicitly deferred to Phase 2 (see design.md § Phased Rollout):
- Browser automation (Playwright)
- Skill file loading (SKILL.md)
- Credential store (vault)
- Approval gates (`awaiting_approval` state)
- History compaction (20-iteration cap is sufficient)
- Artifact persistence
- Two-phase checkpointing
- Variable energy costs (flat cost per mode)
- ProcessReaper / zombie process handling
- `isolated-vm` sandbox hardening
