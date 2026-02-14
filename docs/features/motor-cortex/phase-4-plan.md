# Motor Cortex Phase 4 — Skill Dependency Packs

**Status:** Phase 1 (Prep Container + Cache) implemented

## Problem

Skills like `agentmail` reference npm packages (`npm install agentmail`), but the runtime container runs with `--network none`, so `npm install` times out. The agent wastes iterations trying to reverse-engineer REST endpoints instead of using the SDK.

## Architecture

```
┌──────────────────────────────────┐
│ 1. Read policy.json dependencies │
└──────────────┬───────────────────┘
               │
   Cache hit?  │
       ┌───────┴────────┐
       │ YES             │ NO
       ▼                 ▼
  Mount cache dir    ┌───────────────────────────┐
  into runtime       │ Prep container             │
       │             │ image: lifemodel-motor     │
       │             │ entrypoint: npm install    │
       │             │ network: bridge + add-host │
       │             │ --ignore-scripts           │
       │             │ mount: cache temp dir      │
       │             └──────────┬────────────────┘
       │                        │
       │             Atomic rename → cache
       │                        │
       ▼                        ▼
  ┌──────────────────────────────────────────┐
  │ Runtime container (--network none)       │
  │ /workspace — skill files (rw)            │
  │ /workspace/node_modules (ro, bind mount) │
  │ /workspace/.local (ro, bind mount)       │
  │ NODE_PATH=/workspace/node_modules        │
  │ PYTHONPATH=<dynamic site-packages path>  │
  └──────────────────────────────────────────┘
```

## Policy Schema

Dependencies are declared in `policy.json` alongside existing fields:

```json
{
  "schemaVersion": 1,
  "trust": "approved",
  "dependencies": {
    "npm": {
      "packages": [
        { "name": "agentmail", "version": "0.2.13" }
      ]
    },
    "pip": {
      "packages": [
        { "name": "requests", "version": "2.32.3" }
      ]
    }
  }
}
```

**Rules:**
- Versions must be exact pins (no `^`, `~`, `*`, `>=`, `latest`)
- Package names validated: `/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/`
- No URL deps, git refs, or local paths
- Only `npm` and `pip` ecosystems supported

## Cache Layout

Content-addressed, global (cross-skill dedup):

```
data/dependency-cache/
  npm/
    <hash>/
      node_modules/
      manifest.json
  pip/
    <hash>/
      site-packages/
      manifest.json
```

### Hash Strategy

Cache key includes:
- Sorted package specs (canonical JSON)
- Ecosystem (`npm` or `pip`)
- Image digest (`docker inspect lifemodel-motor:latest`)
- Platform/arch (`process.platform`-`process.arch`)
- Schema version (bump invalidates cache when install flags change)

## Security Model

### Prep Container
- Same base image as runtime (`lifemodel-motor:latest`)
- `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 512m`, `--pids-limit 64`
- `--network bridge` with DNS pre-resolved host-side via `--add-host`
- npm: `--ignore-scripts --no-audit --no-fund --no-optional`
- pip: `--only-binary :all:` (no source builds)

### Runtime Container
- Dependency mounts are read-only (`:ro`)
- Agent cannot modify installed packages
- No network access to registries at runtime

## Implementation

### Key Files
- `src/runtime/dependencies/dependency-manager.ts` — Core logic
- `src/runtime/skills/skill-types.ts` — `SkillPolicy.dependencies` type
- `src/runtime/skills/skill-loader.ts` — `validateDependencies()` function
- `src/runtime/container/types.ts` — `ContainerConfig.extraMounts/extraEnv`
- `src/runtime/container/container-manager.ts` — Applies extra mounts/env in `docker create`
- `src/runtime/container/tool-server.ts` — Inherits `PYTHONPATH` env var
- `src/runtime/motor-cortex/motor-cortex.ts` — Installs deps before container creation
- `src/runtime/motor-cortex/motor-loop.ts` — System prompt tells model packages are pre-installed

## Follow-up Items

- **iptables-based prep networking** — Currently uses `--network bridge` with `--add-host`. Could use the netpolicy helper for tighter control.
- **Integrity hashes** — npm `integrity` field (SRI), pip `--require-hashes`. Accept but don't enforce in Phase 1.
- **Pack size limits** — Cap total dependency size per ecosystem.
- **Cache pruning** — Remove packs for deleted skills or when image changes.
- **`allowedTools` removed** — Container isolation is the security boundary; all sandboxed tools are always granted.
