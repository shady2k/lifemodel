# Script Mode — Deterministic Containerized Jobs

A third `core.act` mode for running fixed scripts in Docker-isolated containers without an LLM loop. Bridges the gap between oneshot (fork sandbox, no Docker) and agentic (Docker + LLM loop).

## Motivation

Some tasks need Docker isolation (network restriction, filesystem confinement) but don't need LLM reasoning — they're deterministic scripts that run the same way every time. The first use case: fetching messages from a closed Telegram group via Playwright inside a network-restricted container.

| Mode | Runtime | LLM | Use Case |
|------|---------|-----|----------|
| `oneshot` | Fork sandbox | No | Quick JS computation |
| `agentic` | Docker + LLM | Yes | Multi-step tasks with reasoning |
| **`script`** | **Docker, no LLM** | **No** | **Deterministic containerized jobs** |

Biological analogy: `agentic` = conscious voluntary movement (motor cortex). `script` = autonomic reflexes (breathing, digestion) — deterministic, no conscious thought, but still executed by the body's muscles (Docker infrastructure).

---

## core.act Extension

### Request

```typescript
interface CoreActScriptRequest {
  mode: 'script';
  task: string;                       // human-readable label for logs/audit
  scriptId: string;                   // registered script ID (from registry)
  inputs?: Record<string, unknown>;   // validated against script's input schema
  timeoutMs?: number;                 // default 120_000, max 600_000
}
```

Domains, image, lock, and profile volume all come from the **script registry**, not the caller. The caller never controls security policy.

### Result (synchronous)

```typescript
interface ScriptRunResult {
  ok: boolean;
  runId: string;
  output?: unknown;                   // validated against script's zod output schema
  error?: { code: string; message: string; retryable: boolean };
  stats: { durationMs: number; exitCode?: number };
}
```

`script` mode is always synchronous — the caller awaits the result. No `runId`-based async signal pattern. Timeout caps the wait.

---

## Script Registry

Scripts are registered in code (Phase 1). Each entry defines the script's identity, security boundary, and I/O contract.

```typescript
interface ScriptRegistryEntry {
  id: string;                         // e.g. 'telegram.group.fetch'
  image: string;                      // e.g. 'lifemodel-browser'
  entrypoint: string;                 // script path inside the image
  domains: string[];                  // iptables allowlist — vetted, not caller-overridable
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  lock?: {
    keyTemplate: string;              // e.g. 'browserProfile:${profile}'
    mode: 'exclusive';
    waitPolicy: 'block' | 'fail_fast';
    waitTimeoutMs: number;
  };
  profileVolume?: {
    volumePrefix: string;             // e.g. 'lifemodel-browser-profile'
    mountPath: string;                // e.g. '/profile'
    mode: 'ro' | 'rw';
  };
  inputSchema: ZodSchema;             // validates caller-provided inputs
  outputSchema: ZodSchema;            // validates script's stdout JSON
}
```

### First Registered Script

```typescript
const TELEGRAM_GROUP_FETCH: ScriptRegistryEntry = {
  id: 'telegram.group.fetch',
  image: 'lifemodel-browser',
  entrypoint: '/scripts/telegram-group-fetch.js',
  domains: ['web.telegram.org'],      // empirically expanded during development
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 120_000,
  lock: {
    keyTemplate: 'browserProfile:${inputs.profile}',
    mode: 'exclusive',
    waitPolicy: 'block',
    waitTimeoutMs: 10_000,            // short wait then fail — prevents cron pileup
  },
  profileVolume: {
    volumePrefix: 'lifemodel-browser-profile',
    mountPath: '/profile',
    mode: 'rw',                       // Chrome needs to update cookies
  },
  inputSchema: z.object({
    profile: z.string(),
    groupId: z.string().optional(),
    chatTitle: z.string().optional(),
    lastSeenId: z.string().optional(),
  }),
  outputSchema: z.object({
    messages: z.array(telegramParsedMessageSchema),
    nextCursor: z.string().optional(),
  }),
};
```

---

## Concurrency

`script` mode **bypasses the agentic mutex**. They are independent execution paths.

| Resource | Limit (Phase 1) |
|----------|-----------------|
| Agentic runs | Max 1 (existing mutex) |
| Script runs | Max 2 concurrent |
| Per-profile | Max 1 (enforced by lock service) |

An agentic run and a script run can execute simultaneously. Two script runs with different lock keys can also run in parallel. Two operations on the same browser profile cannot.

---

## Container Lifecycle

```
1. Validate request
2. Resolve script from registry by scriptId
3. Validate inputs against script's inputSchema (zod)
4. Acquire lock (if script defines one)
5. Create container:
   - Image: from registry entry
   - Network: registry domains → iptables (existing network-policy.ts)
   - Mounts: profile volume (named Docker volume, rw or ro per registry)
   - Hardening: --cap-drop ALL, no-new-privileges, read-only rootfs,
     writable /tmp + profile mount only, non-root user
6. Execute entrypoint (single process, no IPC tool-server, no LLM)
7. Collect stdout (max 1MB, enforced)
8. Parse as JSON, validate against outputSchema
9. Destroy container
10. Release lock
11. Return ScriptRunResult
```

Key differences from `agentic`:

| Aspect | `agentic` | `script` |
|--------|-----------|----------|
| LLM loop | Yes (sub-agent conversation) | No |
| IPC | Tool-server (length-prefixed JSON) | None (stdout JSON) |
| ask_user | Supported (pause/resume) | Not supported |
| Concurrency | Mutex (max 1) | Separate limit (max 2) |
| Result delivery | Async signal | Synchronous return |

---

## Plugin Primitive

Plugins access script mode via a new primitive, preserving plugin isolation.

```typescript
interface ScriptRunnerPrimitive {
  runScript(request: {
    scriptId: string;
    inputs?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<ScriptRunResult>;
}

// Added to PluginPrimitives
interface PluginPrimitives {
  // ...existing...
  scriptRunner: ScriptRunnerPrimitive;
}
```

### Security: Per-Plugin Script Allowlist

Each plugin declares which scriptIds it may call. The `scriptRunner` wrapper enforces this.

```typescript
// Wiring in container.ts
const newsScriptRunner = createScopedScriptRunner(motorCortex, ['telegram.group.fetch']);
newsPlugin.activate({ ...primitives, scriptRunner: newsScriptRunner });
```

A plugin cannot call scripts outside its allowlist. The caller never controls domains, image, or lock policy — only `scriptId`, `inputs`, and `timeoutMs`.

---

## Lock Service

### Phase 1: In-Memory

```typescript
interface LockService {
  acquire(key: string, opts: { waitPolicy: 'block' | 'fail_fast'; waitTimeoutMs: number; leaseMs: number }): Promise<LockHandle>;
  release(handle: LockHandle): void;
}

interface LockHandle {
  key: string;
  acquiredAt: number;
  leaseMs: number;
}
```

- In-memory in motor cortex service
- Interface designed for future persistence (swap to file-based or Redis without changing callers)
- Lease with TTL — if holder crashes, lock auto-expires
- On boot: prune stale containers, reset all locks

### Lock Policies by Consumer

| Consumer | Wait Policy | Wait Timeout | Rationale |
|----------|-------------|-------------|-----------|
| News poll (telegram-group) | `block` | 10s | Short wait then fail — prevents cron pileup |
| Auth CLI | `fail_fast` | — | Tell user immediately if profile is busy |

---

## Browser Auth CLI

`lifemodel browser auth <profile> <url>`

### Flow

```
1. Resolve/create named Docker volume: lifemodel-browser-profile-<profile>
2. Acquire exclusive lock: browserProfile:<profile> (fail_fast)
3. Start container from lifemodel-browser image:
   - Mount profile volume at /profile:rw
   - Chromium with --user-data-dir=/profile
   - Xvfb (virtual display) + noVNC (web-based VNC)
   - Network: allowedDomains for the target site
4. CLI prints: http://127.0.0.1:6080/?token=<one-time-token>
   - Localhost-bound only
   - One-time token, short TTL
   - Auto-shutdown on 10 min inactivity
5. User opens URL in their browser, sees Chromium via noVNC
6. User navigates to <url> and logs in manually
7. Auth detection (bounded 5 min timeout):
   - Primary: auto-detect auth success (cookies, page state, group accessibility)
   - Fallback: user presses Enter in CLI if auto-detect is ambiguous
   - Differentiate: "not logged in" vs "logged in but group inaccessible" vs "auth confirmed"
8. Persist profile metadata:
   - lastAuthAt, chromiumMajor, domains used
   - Stored in the named volume alongside the Chrome profile
9. Graceful browser shutdown, container stop
10. Release lock
```

### Profile Version Compatibility

Auth stores `chromiumMajor` in profile metadata. On fetch, the script compares with the current image's Chromium version:

| Mismatch | Action |
|----------|--------|
| Same major | Proceed |
| 1 major behind | Warn in logs |
| 2+ majors behind | Block fetch, emit alert requesting re-auth |

Chrome profile schema upgrades are one-way — a newer Chromium can read an older profile, but not vice versa. Always auth with the same or newer image version than fetch.

---

## Docker Images

| Image | Contents | Size (est.) | Used By |
|-------|----------|-------------|---------|
| `lifemodel-motor` | Node.js (existing) | ~150MB | oneshot, agentic |
| `lifemodel-browser` | Chromium + Playwright + Xvfb + noVNC + Node.js | ~500MB | script (browser), auth CLI |

### `lifemodel-browser` Image

```dockerfile
FROM debian:bookworm-slim

# Chromium + display server + noVNC
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# Node.js for script runner
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node

# Playwright (chromium path override to system chromium)
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Script runner + registered scripts
COPY scripts/ /scripts/

# Non-root user
RUN useradd -m -u 1000 browser
USER browser

EXPOSE 6080
```

Pin Chromium + Playwright versions together. Shared base stage with `lifemodel-motor` where possible to reduce layer duplication.

---

## News Plugin Integration

### New Source Type

`'telegram-group'` alongside existing `'rss'` and `'telegram'`.

```typescript
// In NewsSource type
type NewsSourceType = 'rss' | 'telegram' | 'telegram-group';
```

### Fetcher

```typescript
// src/plugins/news/fetchers/telegram-group.ts

import type { ScriptRunnerPrimitive } from '../../types/plugin.js';
import { parseTelegramHtml } from '../../web-shared/telegram.js';

export async function fetchTelegramGroup(
  source: NewsSource,
  lastSeenId: string | undefined,
  scriptRunner: ScriptRunnerPrimitive,
): Promise<TelegramFetchResult> {
  const result = await scriptRunner.runScript({
    scriptId: 'telegram.group.fetch',
    inputs: {
      profile: source.profile,       // e.g. 'telegram'
      groupId: source.groupId,
      chatTitle: source.name,
      lastSeenId,
    },
    timeoutMs: 60_000,
  });

  if (!result.ok) {
    throw new FetchError(result.error?.message ?? 'Script failed', {
      retryable: result.error?.retryable ?? false,
    });
  }

  // Output already validated by script registry's outputSchema
  const { messages } = result.output as TelegramGroupFetchOutput;
  return {
    articles: messages.map(telegramMsgToArticle),
    newLastSeenId: messages[0]?.id,
  };
}
```

### Retry Policy

Reuses existing news plugin source health infrastructure:

| Consecutive Failures | Action |
|---------------------|--------|
| 1-2 | Retry next cycle (2h) |
| 3 | Disable 1 hour |
| 5 | Disable 6 hours |
| 10 | Emit intention to alert user |

Auth-specific failures ("session expired") skip the backoff and immediately emit an alert requesting re-auth.

---

## Security Model

### Defense in Depth

| Layer | Protection |
|-------|-----------|
| Script registry | Domains, image, lock — hardcoded, not caller-controlled |
| Plugin allowlist | Each plugin can only call approved scriptIds |
| Docker network | iptables DROP all except allowed domains (kernel-level) |
| Docker filesystem | Read-only rootfs, minimal writable mounts |
| Docker process | `--cap-drop ALL`, `no-new-privileges`, non-root, `--pids-limit` |
| Output validation | Zod schema on stdout JSON — reject unexpected shapes |
| Profile isolation | Named volumes, one profile per purpose, never shared across sites |
| Lock service | Prevents concurrent profile access (auth vs fetch) |

### Profile Volume Security

The browser profile volume contains auth tokens for the target site. Mitigations:

- **Dedicated profiles** — one profile per site/purpose, never reused across domains
- **Network restriction** — even if the profile contains tokens for other sites, the container can't reach them
- **Read-only rootfs** — script can't modify the container image or install malware
- **Non-root** — no privilege escalation inside the container

### noVNC Auth Surface

During `lifemodel browser auth`:

- noVNC bound to `127.0.0.1` only (not reachable from network)
- One-time token required in URL query parameter
- Short TTL — auto-shutdown on 10 min inactivity
- Container destroyed after auth completes

---

## Phasing

| Phase | What | Gate |
|-------|------|------|
| **1 (this)** | `script` mode + `lifemodel-browser` image + auth CLI + telegram group fetcher + lock service + plugin primitive | Can we reliably fetch closed group messages on a schedule? |
| **2** | Motor cortex agentic mode gains browser tool, reuses `lifemodel-browser` image + profile volumes | Converges browser infra between script and agentic |
| **3** | Script registry becomes user-extensible (custom deterministic jobs via config) | Pattern proven across multiple script types |

---

## File Structure

```
src/
  runtime/
    motor-cortex/
      motor-cortex.ts          # Existing — add script mode dispatch
      script-runner.ts          # NEW — script mode lifecycle (validate, lock, container, collect)
      script-registry.ts        # NEW — registered scripts with schemas
    container/
      container-manager.ts      # Existing — add runScript() method (no IPC, stdout collection)
      network-policy.ts         # Existing — reused for script containers
    lock/
      lock-service.ts           # NEW — in-memory lease-based locks
  plugins/
    news/
      fetchers/
        telegram-group.ts       # NEW — uses scriptRunner primitive
      index.ts                  # Extended — new source type 'telegram-group'
    web-shared/
      telegram.ts               # Existing — shared parser, reused by telegram-group script

docker/
  browser/
    Dockerfile                  # NEW — lifemodel-browser image
    scripts/
      telegram-group-fetch.js   # NEW — Playwright script: navigate to group, extract HTML
      entrypoint.sh             # NEW — Xvfb + noVNC + Chromium launcher (auth mode)

cli/
  browser.ts                    # NEW — `lifemodel browser auth` command
```

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Telegram Web UI changes break scraping | Medium | Shared parser (`parseTelegramHtml`) isolates breakage; monitoring via source health alerts |
| Chrome profile corruption from unclean shutdown | Medium | Graceful shutdown protocol; copy-on-write snapshot per run (Phase 2 enhancement) |
| Session expiry during fetch | Low | Detect auth failure (login redirect), emit alert, skip cycle |
| noVNC exposed during auth | Low | Localhost-only, one-time token, short TTL, auto-shutdown |
| Chromium CVE in container | Medium | Pin + regularly rebuild image; container has no outbound except allowed domains |
| Telegram domain allowlist too narrow | Medium | Empirically capture required hosts during development; log blocked connections for debugging |
| Profile volume grows unbounded | Low | Chrome profile is typically <100MB; add size monitoring in Phase 2 |
