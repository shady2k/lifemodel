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

### Registered Scripts

**`test.echo.run`** — Phase 1 echo test (uses `lifemodel-motor` image, no browser).

**`news.telegram_group.fetch`** — Fetch messages from private Telegram groups:

```typescript
{
  id: 'news.telegram_group.fetch',
  image: BROWSER_IMAGE,                 // lifemodel-browser:latest
  entrypoint: ['node', '/scripts/telegram-group-fetch.js'],
  domains: ['web.telegram.org', 'telegram.org'],
  maxTimeoutMs: 120_000,
  lock: {
    keyTemplate: 'browserProfile:${inputs.profile}',
    exclusive: true,
    waitPolicy: 'fail_fast',
    leaseMs: 120_000,
  },
  profileVolume: {
    volumeNamePrefix: 'lifemodel-browser-profile',
    containerPath: '/profile',
    mode: 'rw',
  },
  inputSchema: z.object({
    profile: z.string(),
    groupUrl: z.url(),
    lastSeenId: z.string().optional(),
    maxMessages: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    messages: z.array(z.object({
      id: z.string(), text: z.string(), date: z.string(), from: z.string(),
    })),
    latestId: z.string().nullable(),
  }),
}
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
// src/types/plugin.ts
interface ScriptRunnerPrimitive {
  runScript(request: {
    scriptId: string;
    inputs?: Record<string, unknown> | undefined;
    timeoutMs?: number | undefined;
  }): Promise<PluginScriptRunResult>;
}

// Added to PluginPrimitives (optional — only present when plugin declares allowedScripts)
interface PluginPrimitives {
  // ...existing...
  scriptRunner?: ScriptRunnerPrimitive | undefined;
}

// Added to PluginManifestV2
interface PluginManifestV2 {
  // ...existing...
  allowedScripts?: string[] | undefined;
}
```

### Security: Per-Plugin Script Allowlist

Each plugin declares which scriptIds it may call in its manifest's `allowedScripts` array. The `ScopedScriptRunner` (`src/core/scoped-script-runner.ts`) enforces this — returning `SCRIPT_NOT_FOUND` for unlisted scripts.

```typescript
// Wiring in container.ts (automatic via pluginLoader)
if (motorCortex) {
  pluginLoader.setScriptRunnerFactory((pluginId) =>
    createScopedScriptRunner(motorCortex, pluginId, {
      getAllowedScripts: (pid) => pluginLoader.getPlugin(pid)?.manifest.allowedScripts ?? [],
    })
  );
}
```

Plugins with no `allowedScripts` (or empty array) get `scriptRunner: undefined` in their primitives. A plugin cannot call scripts outside its allowlist.

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

`npm run browser:auth <profile> <url>` (or `npx tsx cli/browser-auth.ts <profile> <url>`)

### Flow

```
1. Validate profile name (alphanumeric + hyphens) and URL
2. Ensure browser Docker image exists (build if needed)
3. Create/reuse named Docker volume: lifemodel-browser-profile-<profile>
4. Start container:
   - Mount profile volume at /profile:rw
   - entrypoint-auth.sh → Xvfb + x11vnc + noVNC + Chromium
   - Port 127.0.0.1:6080 → noVNC web interface
   - AUTH_URL env var → browser navigates to target URL
5. CLI prints: http://localhost:6080/vnc.html
6. User opens URL in their browser, sees Chromium via noVNC
7. User logs in manually
8. User presses Enter in CLI when done
9. Container stopped (--rm auto-removes), profile volume persisted
```

### Example

```bash
npm run browser:auth telegram https://web.telegram.org
# Opens noVNC at http://localhost:6080/vnc.html
# Log in to Telegram, press Enter when done
# Profile "telegram" is now ready for telegram-group sources
```

---

## Docker Images

| Image | Contents | Size (est.) | Used By |
|-------|----------|-------------|---------|
| `lifemodel-motor:latest` | Node 24 Alpine (existing) | ~150MB | oneshot, agentic |
| `lifemodel-browser:latest` | Playwright base + Chromium + Xvfb + x11vnc + noVNC | ~1.5GB | script (browser), auth CLI |

### `lifemodel-browser` Image

Built by `src/runtime/container/browser-image.ts` using an inline Dockerfile (same pattern as `container-image.ts`):

- **Base:** `mcr.microsoft.com/playwright:v1.52.0-noble` — Node.js + Chromium + matching Playwright (avoids version mismatch)
- **Added:** xvfb, x11vnc, python3-websockify, noVNC (from git)
- **Scripts:** copied from `docker/browser/scripts/` into `/scripts/`
- **Profile dir:** `/profile` owned by `pwuser` (Playwright's default non-root user)
- **Source hash label:** `com.lifemodel.source-hash` for staleness detection

First build downloads ~1.5GB base image. Subsequent builds use Docker cache.

---

## News Plugin Integration

### New Source Type

`'telegram-group'` alongside existing `'rss'` and `'telegram'`.

```typescript
type NewsSourceType = 'rss' | 'telegram' | 'telegram-group';

interface NewsSource {
  // ...existing fields...
  profile?: string | undefined;    // browser profile name (telegram-group only)
  groupUrl?: string | undefined;   // full Telegram Web URL (telegram-group only)
}
```

### Manifest

```typescript
// News plugin manifest declares allowed scripts
allowedScripts: ['news.telegram_group.fetch']
```

### Fetcher

`src/plugins/news/fetchers/telegram-group.ts` — calls `scriptRunner.runScript()` with the script ID, profile, group URL, and last seen ID. Converts script output messages to `FetchedArticle[]`.

### Polling Integration

`handlePollFeeds()` in `index.ts` fetches all three source types in parallel:

```typescript
const [rssResult, telegramResult, groupResult] = await Promise.all([
  fetchAllRssSources(storage, logger),
  fetchAllTelegramSources(storage, logger),
  fetchAllTelegramGroupSources(storage, logger, scriptRunner, intentEmitter),
]);
```

### Error Handling

Reuses existing source health infrastructure with one special case:

| Error | Behavior |
|-------|----------|
| General failures | Standard backoff (3 fails → 1h disable, 5 → 6h, 10 → alert) |
| `NOT_AUTHENTICATED` | Immediate pending intention with re-auth command, no backoff |

### Adding a Source

Via the news tool's `add_source` action:

```json
{
  "action": "add_source",
  "type": "telegram-group",
  "name": "My Private Group",
  "profile": "telegram",
  "group_url": "https://web.telegram.org/a/#-1001234567890"
}
```

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

During `npm run browser:auth`:

- noVNC bound to `127.0.0.1:6080` only (not reachable from network)
- Container runs with `--rm` flag (auto-removed on stop)
- User manually stops via Enter key in CLI

---

## Phasing

| Phase | What | Status |
|-------|------|--------|
| **1** | Script mode foundation: types, lock service, script runner, registry, container-manager `runScript()`, `core.act` script dispatch, echo test | Done |
| **2** | Browser Docker image (`lifemodel-browser`), auth CLI (`browser:auth`), browser scripts | Done |
| **3** | Telegram group fetcher, `ScriptRunnerPrimitive`, scoped runner, news plugin integration | Done |
| **4** | Motor cortex agentic mode gains browser tool, reuses `lifemodel-browser` image + profile volumes | Future |
| **5** | Script registry becomes user-extensible (custom deterministic jobs via config) | Future |

---

## File Structure

```
src/
  core/
    scoped-script-runner.ts     # Per-plugin script gating (allowlist enforcement)
    plugin-loader.ts            # Extended — setScriptRunnerFactory(), scriptRunner in primitives
    container.ts                # Extended — wires scoped script runner factory
  runtime/
    motor-cortex/
      motor-cortex.ts           # Extended — executeScript() dispatch
      script-runner.ts          # Script lifecycle (validate, lock, container, collect)
      script-registry.ts        # Registered scripts with schemas
      script-types.ts           # Script types (result, registry entry, lock, container config)
    container/
      browser-image.ts          # Browser Docker image builder (source-hash pattern)
      container-manager.ts      # Extended — runScript() with BROWSER_IMAGE support
      types.ts                  # Extended — BROWSER_IMAGE constant
    lock/
      lock-service.ts           # In-memory lease-based locks
  types/
    plugin.ts                   # Extended — ScriptRunnerPrimitive, allowedScripts
  plugins/
    news/
      fetchers/
        telegram-group.ts       # Fetcher using scriptRunner primitive
      index.ts                  # Extended — telegram-group polling, allowedScripts
      tools/news-tool.ts        # Extended — telegram-group in add_source
      types.ts                  # Extended — 'telegram-group' source type

docker/
  browser/
    scripts/
      entrypoint-auth.sh        # Xvfb + x11vnc + noVNC + Chromium launcher
      launch-browser.js          # Playwright persistent context (headful, for auth)
      telegram-group-fetch.js    # Playwright headless group message extraction

cli/
  browser-auth.ts               # npm run browser:auth <profile> <url>
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
