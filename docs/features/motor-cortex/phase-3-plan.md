# Motor Cortex Phase 3 — Security Hardening (Docker Isolation)

Phase 3 wraps Motor Cortex tool execution in Docker containers with read-only root, no network, dropped capabilities, and resource limits. The host process becomes an untrusted-code-free controller.

## Architecture

```
HOST (trusted controller)                DOCKER CONTAINER (untrusted worker)
 motor-cortex.ts                          tool-server (long-lived process)
    ├── ContainerManager                     ├── code execution (execFile)
    │     create/destroy per run             ├── shell execution (allowlisted)
    │                                        └── filesystem ops (/workspace only)
    └── executeTool() ──stdin/framed-JSON──► tool-server receives request
         ◄──stdout/framed-JSON──             tool-server returns MotorToolResult
```

## New Components

### Container Types (`src/runtime/container/types.ts`)
- IPC protocol: `ToolServerRequest`, `ToolServerResponse` (execute, credential, shutdown)
- `encodeFrame()` / `FrameDecoder` — length-prefixed JSON (4-byte uint32 BE header + payload)
- `ContainerConfig`, `ContainerHandle`, `ContainerManager` interfaces

### Tool Server (`src/runtime/container/tool-server.ts`)
- Long-lived process inside the container, reads/writes length-prefixed JSON on stdin/stdout
- Console output redirected to stderr (only framed JSON on stdout)
- In-memory credential store (`Map`), delivered via special request type
- 5-minute idle watchdog (self-exits)
- Implements all motor tools: code, shell, filesystem, grep, patch, ask_user, fetch
- Shell validation: rejects dangerous metacharacters and validates all pipeline segments against allowlist

### Container Image (`src/runtime/container/container-image.ts`)
- Lazy build on first use via `docker build -f - <context>`
- Alpine + Node 24 + shell tools (curl, jq, grep, coreutils)
- Non-root user `motor` (UID 1000), ~50MB
- Build context assembled in temp dir: tool-server + sandbox-worker
- Workspace directory created for writable output

### Container Manager (`src/runtime/container/container-manager.ts`)
- Docker CLI wrapper (zero deps)
- `create()` → `docker create` with security flags → `docker start -ai` for bidirectional IPC
- `destroy()` → `docker rm -f` + cleanup from active map
- `prune()` → list containers by label, remove stale ones
- Container naming: `motor-<runId>-<random>` (crypto randomness)

## Container Security Flags

| Flag | Purpose |
|------|---------|
| `--read-only` | Immutable root filesystem |
| `--network none` | No network access |
| `--cap-drop ALL` | Drop all Linux capabilities |
| `--security-opt no-new-privileges` | Prevent privilege escalation |
| `--pids-limit 64` | Prevent fork bombs |
| `--memory 512m` | Memory cap |
| `--cpus 1.0` | CPU quota |
| `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | Writable temp, no exec |
| `-v <workspace>:/workspace:rw` | Only writable mount |

## Workspace-Root Skill Model

Skills are copied to the workspace root on initialization:
- `.motor-baseline.json` records file hashes for change detection
- On resume, existing workspace is reused (preserves agent edits)
- Extraction uses baseline-diff: only extracts changed files to data/skills/
- Agent can modify skill files directly in the workspace

## Modified Components

### motor-protocol.ts
- `MotorRun.containerId?: string` — tracks Docker container ID
- `MotorTool` union: removed `search` tool

### motor-tools.ts
- `ToolContext.containerHandle?: ContainerHandle` — optional container dispatch
- `executeTool()` — container path serializes request as IPC, direct path unchanged
- `search` tool removed — cognition layer searches first, then dispatches with URL
- `HOST_ONLY_TOOLS` = `['fetch']` only (fetch still runs on host)

### motor-loop.ts
- `MotorLoopParams.containerHandle` + `MotorLoopParams.workspace` — threaded from cortex
- `buildMotorSystemPrompt()` — updated for workspace-root skill paths
- `allowedRoots` = `[workspace]` only (no skillsDir mount)
- Skill files at root: `read({path: "SKILL.md"})`, `list({path: "."})`
- Agent can modify skill files directly (no read-only restriction)

### motor-cortex.ts
- `MotorCortexDeps.containerManager` — Docker manager (required)
- `startRun()` — requires Docker, throws if unavailable (no UNSAFE mode)
- `runLoopInBackground()` — creates workspace, copies skill files to root, generates baseline
- `extractSingleSkill()` — baseline-diff extraction, unchanged skill skip
- Removed implicit domain widening (package registry domains no longer auto-added)

### sandbox-runner.ts
- Refactored from `fork()` to `execFile('node', [workerPath, '--eval', code])`
- Parses JSON from stdout even on non-zero exit codes

### sandbox-worker.ts
- Added `--eval` CLI mode with stdout JSON output
- Console redirected to stderr (prevents stdout corruption)
- Legacy IPC mode preserved for backward compatibility

### task-logger.ts
- `logContainerEvent()` — container create/destroy logging
- `logSecurityEvent()` — path traversal, blocked commands

### skill-types.ts / skill-loader.ts
- `SkillDefinition.domains?: string[]` — accepted, validated, and enforced via iptables
- `discoverSkills()` — auto-discovery mode, always scans directory (no index.json)
- `getSkillNames()` — uses `discoverSkills()` directly

### container.ts (DI)
- Creates `ContainerManager`, passes to Motor Cortex deps

## Test Coverage

- IPC framing: encodeFrame, FrameDecoder (partial frames, multi-frame, byte-by-byte, errors)
- Container constants and configuration
- Sandbox refactor: expression evaluation, error handling, timeouts, guard
- Baseline-diff extraction: unchanged skill skip, rm fix, workspace-root model
- All tests updated for workspace-root model, tool simplification, auto-discovery
