# ADR-003: Replace Workspace Bind Mounts with Docker Volumes + docker cp

## Status

Accepted

## Context

The Motor Cortex container used a bind mount (`-v hostPath:/workspace:rw`) to share the workspace directory between the host and container. This created a direct filesystem connection that:

1. **Violates isolation principles** - The container could read/write any file in the host path, potentially escaping the workspace boundary via symlinks or path traversal
2. **Causes macOS TCC failures** - Docker Desktop needs TCC (Transparency, Consent, Control) permission to access `~/Documents`. When running skills under `~/Documents`, the bind mount fails with EPERM, causing complete run failures (e.g., security review run 611c14ff: 17 iterations, 15 errors, zero files read)
3. **Creates ownership issues** - Files written by the container have root ownership, requiring cleanup on the host

The bind mount approach worked for simple cases but became a blocking issue for users who keep their projects under `~/Documents` on macOS.

## Decision

Replace the workspace bind mount with:

1. **Named Docker volume** (`motor-ws-<runId>`) mounted at `/workspace`
2. **tar pipe + docker cp** to copy workspace files IN before the run
3. **docker cp** to copy workspace files OUT after the run
4. **Output validation** to reject symlinks, special files, and enforce size limits

```
BEFORE (bind mount):
  host workspace ←──bind mount──→ container /workspace
  (shared filesystem, live sync, host path exposed)

AFTER (named volume + docker cp):
  host staging ──tar|docker cp -a──→ named volume /workspace
  fresh output ←──docker cp──── named volume /workspace
  (explicit copy, zero host connection, volume cleaned up)
```

### Container Lifecycle

```
1. docker volume create motor-ws-<runId>
2. docker create --mount type=volume,src=motor-ws-<runId>,dst=/workspace --user 1000:1000 ...
3. COPYFILE_DISABLE=1 tar -C stagingDir -cf - --owner=1000 --group=1000 . | docker cp -a - container:/workspace/
4. docker start -ai  (IPC via stdin/stdout)
5. ... motor loop runs ...
6. docker cp container:/workspace/. outputDir/  (container stopped)
7. Validate output (reject symlinks, special files, enforce limits)
8. docker rm -f container
   docker volume rm motor-ws-<runId>
```

### Key Implementation Details

- `tar --owner=1000 --group=1000` sets correct ownership for `node` user inside container
- `docker cp -a` preserves ownership from tar archive
- `COPYFILE_DISABLE=1` prevents macOS `._` metadata artifacts
- `--user 1000:1000` explicit on container for deterministic behavior
- Docker pre-populates `/workspace` from image (owned by `node:node`), giving correct directory ownership
- Tar and docker cp exit codes both verified (race-free dual close handler)

### Security Hardening

- **Volume name validation** - Regex (`/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/`) before passing to Docker mount spec
- **extraMounts validation** - `hostPath` must be a Docker volume name (same regex); absolute/relative paths rejected to prevent host bind mounts
- **Output validation** - `lstat` walk rejects symlinks, block devices, fifos, sockets; enforces max file count (500) and total size (50MB)
- **Volume cleanup on all failure paths** - `docker create` failure, network policy failure, tar pipe failure all clean up the volume
- **Orphan volume sweep** - `motor-ws-*` volumes pruned on startup (checks ref count)

### Truncation Spillover

With bind mounts, `truncateToolOutput()` wrote `.motor-output/` files to the host workspace and they were instantly visible in the container. With named volumes, the two filesystems are separate.

Solution: after truncation saves a spillover file on the host, the content is written into the container via IPC write tool call (reuses the existing stdin/stdout pipe). No new methods or `docker cp` calls needed — the container's own `write` tool handles it.

## Consequences

### Positive

- **Full isolation** - Container has zero access to host filesystem
- **No macOS TCC issues** - Named volumes don't require host path access
- **Deterministic cleanup** - Volumes can be pruned by name prefix (`motor-ws-*`)
- **Correct ownership** - Files are owned by `node` user, not root

### Negative

- **Copy overhead** - ~100ms to copy files in/out (negligible for typical skill workspaces)
- **Slight complexity** - More moving parts (volume create, tar pipe, copy out, IPC spillover bridge)

### Neutral

- **Same semantics for callers** - `workspacePath` still points to staging dir on host
- **Dependency volumes unchanged** - Named volumes for npm/pip deps work the same way

## Implementation

- `src/runtime/container/types.ts` - Added `volumeName` to `ContainerConfig`, `copyWorkspaceOut()` to `ContainerHandle`
- `src/runtime/container/container-manager.ts` - Volume creation, tar pipe copy-in, copyWorkspaceOut, volume cleanup, mount validation
- `src/runtime/motor-cortex/motor-cortex.ts` - Generate volume name, call copyWorkspaceOut, validate output, persist artifacts
- `src/runtime/motor-cortex/motor-loop.ts` - IPC write for truncation spillover, artifact persistence moved to motor-cortex.ts
- `src/runtime/container/container-image.ts` - Updated stale Dockerfile comment
