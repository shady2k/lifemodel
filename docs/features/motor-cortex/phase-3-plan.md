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
- Implements all motor tools: code, shell, filesystem, grep, patch, ask_user
- Shell validation: rejects dangerous metacharacters and validates all pipeline segments against allowlist

### Container Image (`src/runtime/container/container-image.ts`)
- Lazy build on first use via `docker build -f - <context>`
- Alpine + Node 24 + shell tools (curl, jq, grep, coreutils)
- Non-root user `motor` (UID 1000), ~50MB
- Build context assembled in temp dir: tool-server + sandbox-worker

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
| `-v <skills>:/skills:ro` | Read-only skills access |

## Modified Components

### motor-protocol.ts
- `MotorRun.containerId?: string` — tracks Docker container ID

### motor-tools.ts
- `ToolContext.containerHandle?: ContainerHandle` — optional container dispatch
- `executeTool()` — container path serializes request as IPC, direct path unchanged

### motor-loop.ts
- `MotorLoopParams.containerHandle` + `MotorLoopParams.workspace` — threaded from cortex
- Credentials delivered to container AND resolved on host (dual path)

### motor-cortex.ts
- `MotorCortexDeps.containerManager` — optional Docker manager
- `startRun()` — checks Docker availability, blocks if unavailable (unless `MOTOR_CORTEX_UNSAFE=true`)
- `runLoopInBackground()` — creates workspace once, creates/destroys container in try/finally
- `recoverOnRestart()` — prunes stale containers on startup

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
- `SkillDefinition.domains?: string[]` — accepted, validated, and enforced via iptables (Phase 4)

### container.ts (DI)
- Creates `ContainerManager`, passes to Motor Cortex deps

## Unsafe Mode

- Docker unavailable → agentic runs blocked with clear error
- Oneshot mode (pure computation) still works without Docker
- `MOTOR_CORTEX_UNSAFE=true` env var enables direct execution with WARN on every call
- This is NOT a dev convenience — it's an explicit security bypass

## Test Coverage

- IPC framing: encodeFrame, FrameDecoder (partial frames, multi-frame, byte-by-byte, errors)
- Container constants and configuration
- Sandbox refactor: expression evaluation, error handling, timeouts, guard
- All 835 existing tests pass with zero regressions
