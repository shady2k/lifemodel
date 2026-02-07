# Code Execution (Motor Cortex)

The agent can write and execute code in a sandboxed environment — giving it "hands" to act on the world beyond sending messages.

## Biological Inspiration

Based on the **motor cortex** — the brain region that plans and executes voluntary movements. Just as the motor cortex translates cognitive intent into physical action, code execution translates the agent's goals into executable procedures.

Key biological properties:
- **Metabolically expensive** — motor actions cost energy, so the brain is selective about when to act
- **Gated by arousal** — a fatigued human can't perform complex motor tasks; same for the agent
- **Neuroplasticity** — repeated successful actions consolidate into automatic skills (like learning to ride a bike)

## Phased Rollout

This feature ships in three phases. Each phase validates whether the next is worth building.

| Phase | Name | What | Gate to Next |
|-------|------|------|-------------|
| 1 | **Hands** | `core.execute` tool, `isolated` tier only, synchronous within agentic loop | Does the agent actually use it? Is it useful for a digital human? |
| 2 | **Network Hands** | Add `network` tier with URL allowlist | Usage patterns show need for external data |
| 3 | **Neuroplasticity** | Consolidation pipeline, custom neurons, self-development | Agent repeatedly writes similar scripts → should be permanent |

Build only what's needed. Don't invest in self-development infrastructure until basic execution proves valuable.

---

## Phase 1: Hands

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENTIC LOOP (Cognition)                 │
│                                                             │
│  LLM calls core.execute({ code, purpose, timeout })        │
│      ↓                                                      │
│  Tool handler awaits sandbox result (synchronous)           │
│      ↓                                                      │
│  ┌───────────────────────────────────┐                      │
│  │     SANDBOX (Forked Process)      │                      │
│  │  • child_process.fork()           │                      │
│  │  • Globals stripped (no fetch,    │                      │
│  │    no require, no process.env)    │                      │
│  │  • Hard SIGKILL on timeout        │                      │
│  │  • Result via IPC                 │                      │
│  └───────────────┬───────────────────┘                      │
│                  ↓                                           │
│  Tool result returned to LLM (same turn)                    │
│      ↓                                                      │
│  LLM decides what to do with result                         │
│  (core.say, core.remember, etc.)                            │
└─────────────────────────────────────────────────────────────┘
```

**Key design decision:** `core.execute` is **synchronous within the agentic loop** — the tool handler awaits the sandbox result and returns it directly, just like `fetch` (web-fetch tool). The LLM sees the result in the same turn and can act on it.

This does NOT block the CoreLoop heartbeat because cognition already runs as an async operation within its own context.

### Intent: RUN_CODE

```typescript
// Added to src/types/intent.ts

export type IntentType = /* existing */ | 'RUN_CODE';

interface RunCodeIntent {
  type: 'RUN_CODE';
  payload: {
    /** What the code should accomplish (for logging/auditing) */
    purpose: string;
    /** The code to execute */
    code: string;
    /** Execution language */
    language: 'javascript';
    /** Sandbox capability tier */
    tier: 'isolated' | 'network';
    /** Maximum execution time in ms */
    timeout: number;
    /** Expected output shape description (for validation) */
    expectedOutput?: string;
  };
  trace?: IntentTrace;
}
```

### Cognition Tool: `core.execute`

```typescript
{
  name: 'core.execute',
  description: 'Execute short JavaScript in a sandbox for computation, parsing, or data transformation. Use when no existing tool can handle the task. No filesystem, no network (Phase 1).',
  parameters: {
    purpose: { type: 'string', description: 'Why this code is being run' },
    code: { type: 'string', description: 'JavaScript to execute. Must return a value.' },
    timeout: { type: 'number', description: 'Max execution time in ms (max: 5000)' },
  },
  maxCallsPerTurn: 1,  // Start conservative — increase to 2 after validation
}
```

Phase 1 omits the `tier` parameter — always `isolated`. Added in Phase 2.

**Timeout validation:** The tool handler clamps `timeout` to `[100, 5000]` range. Values outside this range are clamped, not rejected.

**Tool result on error/timeout/blocked:**
The tool always returns a result (never throws). This lets the LLM handle failures gracefully.
```typescript
// Success
{ output: "<result as JSON string>" }

// Timeout
{ output: "EXECUTION_TIMEOUT: Code exceeded 5000ms limit." }

// Runtime error
{ output: "EXECUTION_ERROR: <error message>" }

// Guard blocked
{ output: "EXECUTION_BLOCKED: Code contains disallowed pattern: <pattern>" }

// Energy denied
{ output: "EXECUTION_DENIED: Insufficient energy for code execution." }
```

### Sandbox Runtime

**Technology: `child_process.fork()`** — a separate Node.js process.

Why not `vm`? The Node.js `vm` module is not a security boundary. Why not WASM? Bad ergonomics when the agent writes JS. A forked process gives crash isolation and a clean cancellation boundary (`SIGKILL`).

**Host side:**

```typescript
// src/runtime/sandbox/sandbox-runner.ts
import { fork } from 'node:child_process';

export class SandboxRunner {
  async run(code: string, timeout: number): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const child = fork(
        new URL('./sandbox-worker.js', import.meta.url),
        [],
        { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
      );

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, type: 'timeout', durationMs: timeout });
      }, timeout);

      child.on('message', (msg: ExecutionResult) => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(msg);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, type: 'error', error: err.message, durationMs: 0 });
      });

      child.send({ code });
    });
  }
}
```

**Worker side:**

```typescript
// src/runtime/sandbox/sandbox-worker.ts

// Strip dangerous globals BEFORE executing any user code
// Use Object.defineProperty to make them non-writable and non-configurable
// so user code cannot re-attach them.
const BLOCKED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket',       // network
  'require', 'module', 'exports',                // module system
  'child_process', 'cluster', 'worker_threads',  // process spawning
  'fs', 'path', 'os', 'net', 'http', 'https',   // node builtins
];

for (const name of BLOCKED_GLOBALS) {
  try {
    Object.defineProperty(globalThis, name, {
      value: undefined, writable: false, configurable: false,
    });
  } catch {}
}

// Hide process details (keep process.send for IPC)
const send = process.send!.bind(process);
Object.defineProperty(globalThis, 'process', {
  value: Object.freeze({ env: {} }),
  writable: false, configurable: false,
});

process.on('message', async (msg: { code: string }) => {
  const start = Date.now();
  try {
    // Static guard: reject code with obvious escape attempts
    guard(msg.code);

    const fn = new Function(`'use strict';\nreturn (async () => {\n${msg.code}\n})()`);
    const result = await fn();

    send({ ok: true, type: 'result', result, durationMs: Date.now() - start });
  } catch (err: any) {
    send({ ok: false, type: 'error', error: err.message, durationMs: Date.now() - start });
  }
});
```

**Static guard (concrete rules):**

```typescript
// src/runtime/sandbox/sandbox-guard.ts

const BLOCKED_PATTERNS = [
  /\bimport\s*\(/,          // dynamic import()
  /\brequire\s*\(/,         // require()
  /\beval\s*\(/,            // eval()
  /\bFunction\s*\(/,        // new Function()
  /\bchild_process\b/,      // child_process references
  /\bprocess\.exit\b/,      // process.exit
  /\bprocess\.kill\b/,      // process.kill
  /\bglobalThis\b/,         // globalThis manipulation
  /\b__proto__\b/,          // prototype pollution
  /\bconstructor\b\s*\[/,   // constructor bracket access
];

export function guard(code: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Blocked pattern: ${pattern.source}`);
    }
  }
}

// IMPORTANT: Regex guards are best-effort, NOT a security boundary.
// They are trivially bypassable in JS (string concatenation, bracket
// notation, Unicode escapes, etc.). The real security boundary is
// process isolation + stripped globals + SIGKILL timeout.
// The guard catches obvious/accidental misuse, not adversarial attacks.
```

### Energy Model (Phase 1: Simple)

Fixed cost per execution. No formula, no measurement. Tune later with real data.

```typescript
const EXECUTION_ENERGY_COST = 0.05;
```

**Energy gating:**
- Energy < 0.15 → `core.execute` denied ("too tired to act")
- Otherwise → allowed

That's it for Phase 1. No complex cost model.

### Execution Result Size Limits

To prevent memory blowups from large results:

```typescript
const MAX_RESULT_SIZE = 32 * 1024; // 32 KB after JSON serialization
```

Enforced in two places:
1. **Worker side** — truncate before `process.send()` (prevents IPC bloat)
2. **Host side** — truncate after deserialization (defense in depth)

### File Structure (Phase 1)

```
src/
  runtime/sandbox/
    sandbox-runner.ts      # Fork + IPC + timeout management
    sandbox-worker.ts      # Child process entry point
    sandbox-guard.ts       # Static code safety checks
    sandbox-protocol.ts    # ExecutionResult, RunCodeJob types
  layers/cognition/tools/
    core-execute.ts        # Tool definition + handler
  types/
    intent.ts              # Add RUN_CODE to Intent union
```

~4 new files. Minimal surface area.

### Testing Requirements (Phase 1)

Before shipping, these tests must exist:
- **Guard bypass tests** — verify known bypass techniques are caught or harmless
- **Timeout tests** — verify SIGKILL fires and the host recovers cleanly
- **Result size limit tests** — verify truncation at 32KB
- **Error propagation tests** — verify all error shapes reach the LLM correctly
- **Energy gating tests** — verify denial when energy < 0.15
- **Crash isolation tests** — verify worker crash doesn't affect host process

### Example Flow

```
User: "Can you calculate compound interest on $10k at 5% for 10 years?"

Cognition:
  → core.execute({
      purpose: "Calculate compound interest",
      code: "const p=10000, r=0.05, n=10; return p * Math.pow(1+r, n);",
      timeout: 1000,
    })

Sandbox worker:
  → Executes in forked process
  → Returns: { ok: true, result: 16288.946..., durationMs: 3 }

Cognition (same turn, sees tool result):
  → core.say("$10,000 at 5% for 10 years = $16,288.95")
  → SEND_MESSAGE
```

---

## Phase 2: Network Hands

Added when Phase 1 proves useful and the agent needs external data.

### Changes from Phase 1

1. **`tier` parameter exposed** in `core.execute` tool: `'isolated' | 'network'`
2. **Network tier sandbox:**
   - `fetch()` re-enabled in worker, but restricted to URL allowlist
   - Node `--experimental-permission` flag for filesystem deny
   - Max timeout: 30s (vs 5s for isolated)
3. **Energy cost:** `{ isolated: 0.05, network: 0.15 }`
4. **Energy gating:** Energy < 0.3 → only `isolated` allowed
5. **URL allowlist** stored in config:

```typescript
// Config
sandbox: {
  networkAllowlist: [
    'api.coingecko.com',
    'api.openweathermap.org',
    'api.open-meteo.com',
    // Owner can add more
  ]
}
```

### Network Worker Sketch

```typescript
// sandbox-worker.ts (network tier variant)
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!ALLOWLIST.includes(url.hostname)) {
    throw new Error(`Network blocked: ${url.hostname} not in allowlist`);
  }
  return originalFetch(input, init);
};
```

### Example Flow (Phase 2)

```
User: "What's Bitcoin trading at right now?"

Cognition:
  → core.execute({
      purpose: "Fetch current Bitcoin price",
      code: `
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        const data = await res.json();
        return data.bitcoin.usd;
      `,
      tier: 'network',
      timeout: 10000,
    })

Sandbox:
  → fetch allowed (coingecko.com in allowlist)
  → Returns: { ok: true, result: 97500, durationMs: 850 }

Cognition (same turn):
  → core.say("Bitcoin is at $97,500")
```

---

## Phase 3: Neuroplasticity

Added when Phase 1+2 prove transformative AND the agent repeatedly writes similar scripts that should be permanent.

### Custom Neurons as Data

Custom neurons are stored as **JSON data via DeferredStorage** — not as `.ts` files. This preserves the unified storage path invariant (CLAUDE.md Lesson #4) and avoids plugin isolation issues (core never imports plugin types).

```typescript
interface CustomNeuron {
  id: string;
  name: string;
  /** The neuron's tick logic as a code string */
  code: string;
  /** What signal types this neuron listens to */
  inputSignals: string[];
  /** What signal types this neuron can emit */
  outputSignals: string[];
  /** Energy budget per tick */
  energyBudget: number;
  /** Metadata for auditing */
  metadata: {
    author: 'agent';
    createdAt: string;
    codeHash: string;
    purpose: string;
    approvedBy?: 'owner' | 'auto';
    approvedAt?: string;
  };
  /** Current lifecycle state */
  status: 'quarantine' | 'trial' | 'active' | 'disabled';
}
```

### Consolidation Pipeline

```
1. DRAFT
   Agent writes candidate neuron code via core.execute (Phase 2)
   Agent proposes consolidation via a new core.consolidate tool

2. QUARANTINE (automated, ~minutes)
   Neuron runs in isolated sandbox with 3+ simulated signal scenarios
   - Must not crash or timeout
   - Must emit signals matching declared outputSignals
   - Must stay within declared energyBudget

3. VALIDATION (automated, immediate)
   Static analysis with sandbox-guard rules
   Capability audit: verify declared inputs/outputs match actual behavior
   Reject if accessing undeclared signals or state

4. OWNER APPROVAL (manual gate)
   Owner notified via channel: "Agent wants to learn: CryptoPrice neuron"
   Owner can review code, approve, reject, or modify
   Pipeline pauses here until approval

5. TRIAL (automated, 24+ hours)
   Neuron runs in autonomic layer with monitoring
   Auto-disable on: runtime errors, energy overconsumption, signal spam
   Minimum: 24 hours AND 50+ signal events processed

6. CONSOLIDATION (automated after successful trial)
   Status set to 'active'
   Persisted via DeferredStorage to data/state/neurons/
   Logged as learned skill in agent memory
   Loaded on next restart
```

### Storage

All neuron persistence goes through DeferredStorage (never direct file I/O):

```typescript
// src/storage/neuron-store.ts
export class NeuronStore {
  constructor(private storage: DeferredStorage) {}

  async persist(neuron: CustomNeuron): Promise<void> {
    await this.storage.write(`neurons/${neuron.id}`, neuron);
  }

  async loadAll(): Promise<CustomNeuron[]> {
    return this.storage.readAll('neurons/');
  }

  async disable(id: string): Promise<void> {
    const neuron = await this.storage.read(`neurons/${id}`);
    if (neuron) {
      neuron.status = 'disabled';
      await this.storage.write(`neurons/${id}`, neuron);
    }
  }
}
```

### Runtime Loading

On boot, active custom neurons are compiled and registered:

```typescript
// In CoreLoop initialization
const customNeurons = await neuronStore.loadAll();
for (const neuron of customNeurons.filter(n => n.status === 'active')) {
  const compiled = compileNeuron(neuron); // new Function() in isolated scope
  autonomicLayer.registerCustomNeuron(compiled);
}
```

### Guardrails

- Owner approval required before trial (manual gate)
- No self-mutation of core systems (CoreLoop, layers, intent processing)
- No modification of existing neurons (only create new ones)
- Maximum 5 custom neurons active at any time
- All custom neurons can be disabled with a single kill switch
- Versioning: code hash + creation timestamp for rollback

### Example Flow (Phase 3)

```
Week 1-3: Agent uses core.execute to check Bitcoin price 8 times
          (via Phase 2 network tier)

Agent reflection:
  "I keep writing the same fetch-and-parse code for crypto prices.
   I should consolidate this into a permanent sensor."

Agent calls core.consolidate({
  name: "CryptoPriceNeuron",
  code: "...",
  inputSignals: ["tick"],
  outputSignals: ["crypto_price_change"],
  energyBudget: 0.02,
})

Pipeline:
  → Quarantine: 3 scenarios pass
  → Validation: static analysis clean
  → Owner notified: "Agent wants to learn: CryptoPriceNeuron"
  → Owner approves
  → Trial: 24h monitoring, no issues
  → Consolidated as active neuron

Result: Agent now has a permanent crypto price sensor
  in its autonomic layer. It emits signals on significant
  price changes without any LLM cost.
```

---

## What This Does NOT Include (All Phases)

- **No package installation** — sandbox has no npm/package manager
- **No persistent processes** — code runs and exits, no daemons
- **No file system access** — sandbox cannot read or write files
- **No direct channel access** — code returns data, Cognition sends messages
- **No self-replication** — code cannot spawn new code execution
- **No chaining** — `RUN_CODE` cannot emit another `RUN_CODE`; all execution is mediated by Cognition

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Sandbox escape / code injection | High | Forked process, stripped globals, static guard, SIGKILL |
| LLM generates harmful code | Medium | Static guard, no network (Phase 1), URL allowlist (Phase 2) |
| Resource exhaustion | Medium | Hard timeout, max result size, energy gating |
| Custom neuron regressions (Phase 3) | Medium | Owner approval gate, 24h trial, auto-disable, max 5 neurons |
| Cost spiral (LLM generates expensive code) | Low | Fixed energy cost, maxCallsPerTurn: 2, energy gating |
| Storage corruption (Phase 3) | Low | DeferredStorage (never direct FS) |
