# ADR-002: Persistent Skill Dependency Packs

**Date:** 2026-02-13 (updated 2026-02-23: unified single Dockerfile per skill deps set)
**Status:** Superseded — unified image approach replaces prep containers + volumes
**Affects:** `src/runtime/dependencies/`, `src/runtime/container/`, `src/runtime/motor-cortex/`

## Problem

Motor Cortex runs are ephemeral — each agentic run gets a fresh container and temp workspace. When a skill needs npm/pip packages (e.g., Stripe SDK for payment skills, cheerio for scraping) or system binaries (e.g., ffmpeg, yt-dlp, pandoc), the agent tries `npm install` or `apt-get install` at runtime, but:

1. **Registries are unreachable** — containers run with `--network none` and only declared domains are accessible. npm/pip registries are not in the allowlist.
2. **Nothing persists** — even if registries were reachable, installed packages would be lost after the run completes.
3. **Wasted iterations** — the agent spends 2-3 iterations discovering that `npm install` fails, then falls back to `curl`-based workarounds or gives up.

Opening registry access permanently is a security risk (supply chain attacks, post-install scripts executing arbitrary code).

## Decision

Use **persistent skill dependency packs** with a two-tier cache and short-lived prep containers (npm/pip) or derived Docker images (apt).

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Skill policy.json declares dependencies (exact pins)    │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────▼──────────────┐
         │  dependency-manager.ts     │
         │  prepareForRun(skill) →    │
         │    { packId, mounts, env } │
         └──────┬───────────┬─────────┘
                │           │
    Cache hit?  │           │ Cache miss?
    (pack exists)           │
                │           ▼
                │  ┌────────────────────┐
                │  │ Prep container     │  ← npm/pip only
                │  │ (short-lived)      │
                │  │ Network: registries│
                │  │ --ignore-scripts   │
                │  │ --only-binary :all:│
                │  └────────┬───────────┘
                │           │
                │           ▼
                │  ┌────────────────────┐
                │  │ Publish pack       │
                │  │ (atomic rename)    │
                │  └────────┬───────────┘
                │           │
                ▼           ▼
         ┌──────────────────────────┐
         │ Runtime container        │
         │ --network none           │
         │ Pack mounted :ro         │  ← npm/pip volumes
         │ Derived apt image        │  ← apt packages baked in
         │ NODE_PATH / PYTHONPATH   │
         │ Agent loop runs normally │
         └──────────────────────────┘
```

### Schema: `policy.json` (schemaVersion 2)

```json
{
  "schemaVersion": 2,
  "trust": "approved",
  "allowedDomains": ["api.stripe.com"],
  "requiredCredentials": ["stripe_key"],
  "dependencies": {
    "npm": {
      "packages": [
        { "name": "stripe", "version": "14.21.0", "integrity": "sha512-..." }
      ]
    },
    "pip": {
      "packages": [
        { "name": "requests", "version": "2.32.3", "hashes": ["sha256:..."] }
      ]
    },
    "apt": {
      "packages": [
        { "name": "ffmpeg", "version": "7:6.1.1-1" },
        { "name": "pandoc", "version": "latest" }
      ]
    }
  }
}
```

Rules:
- Versions must be **exact pins** — no `^`, `~`, `*`, ranges
- npm: `integrity` field (subresource integrity hash) — optional initially, required once tooling matures
- pip: `hashes` field for `--require-hashes` — optional initially
- apt: version format allows Debian conventions (epochs like `2:`, tildes, hyphens); `latest` is allowed
- Unknown ecosystems rejected at load time
- Package names validated against ecosystem-specific patterns (npm: scoped `@org/pkg` or plain; apt: `[a-z0-9][a-z0-9.+-]+`; no URLs, git refs, or local paths)

### Host Cache Layout

```
data/dependency-cache/
  npm-<hash>.lock               # Lock files for concurrency control
  npm-<hash>.ready              # Ready markers (install completed)
  pip-<hash>.lock
  pip-<hash>.ready
  apt-image-<hash>.lock         # Lock files for apt image builds
```

Docker named volumes hold npm/pip package data:
- `lifemodel-deps-npm-<hash>` — node_modules (mounted at `/opt/skill-deps/npm`)
- `lifemodel-deps-pip-<hash>` — site-packages (mounted at `/opt/skill-deps/pip`)

Apt packages are baked into derived Docker images:
- `lifemodel-motor-apt-<hash>:latest` — derived from base image with `apt-get install`
- Labels: `com.lifemodel.component=apt-deps`, `com.lifemodel.apt-hash=<hash>`, `com.lifemodel.schema-version=<N>`

Host-side `data/dependency-cache/` holds only lock files and ready markers — no package data on host (avoids macOS `com.apple.provenance` xattr issues).

Two skills with identical dependencies share the same cache entry (content-addressed by sorted package specs + image ID + platform).

### Dependency Hash

```
SHA256(canonical_json({
  schemaVersion: 1,
  ecosystem: "npm" | "pip" | "apt",
  packages: sorted_packages,
  imageId: docker_image_id,
  platform: "darwin-arm64" | "linux-x64" | ...
}))
```

Computed per-ecosystem (not per-skill). Two skills with the same npm packages share one volume. The hash is truncated to 16 hex chars for volume/image naming.

**ABI coupling:** When both apt and pip dependencies are present, the pip hash includes a deterministic apt hash in its `imageId` parameter. This ensures pip caches invalidate when apt deps change (e.g., apt upgrades the Python version).

### Install Workflow

1. `core.act` calls `installSkillDependencies(deps, skillName, logger)` before `startRun()`
2. For each ecosystem with packages, compute content-addressed hash
3. **npm/pip:** Cache check via host-side `.ready` marker + `docker volume inspect`
4. On cache miss → spawn short-lived prep container:
   - Same base image as runtime (node:24-slim)
   - Network: bridge (needs to reach registries)
   - Security: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 512m`
   - **npm:** `npm install --ignore-scripts --no-audit --no-fund` into named volume
   - **pip:** `pip install --no-user --target /workspace/site-packages` into named volume
   - Prep container is named (`prep-{ecosystem}-{random}`) and removed in finally block
5. Mark volume ready (host-side `.ready` file)
6. **apt:** Packages are passed through as `aptPackages` to the container manager, which builds a derived Docker image:
   - `ensureAptImage()` in container-manager.ts
   - Cache check: `docker image inspect` + label verification
   - On miss: `docker build` with Dockerfile that runs `apt-get install -y --no-install-recommends -t unstable`
   - Pin priority 100 prevents unstable from upgrading base system packages
   - `ARG DEBIAN_FRONTEND=noninteractive` (not `ENV`) avoids persisting into runtime
   - Timeout: 10 minutes; lock file prevents concurrent builds
7. Runtime container:
   - npm: volume mounted at `/opt/skill-deps/npm:ro` + `NODE_PATH=/opt/skill-deps/npm/node_modules`
   - pip: volume mounted at `/opt/skill-deps/pip:ro` + `PYTHONPATH=/opt/skill-deps/pip/site-packages`
   - apt: derived image used instead of base image — packages in standard OS paths, no `LD_LIBRARY_PATH` needed

### Modules

```
src/runtime/dependencies/
  dependency-manager.ts     # Public API: installSkillDependencies() → PreparedDeps
                            # Contains: computeDepsHash(), installNpm(), installPip(),
                            # verifyNpmInstall(), verifyPipInstall(), volume management, lock files
                            # apt packages returned as aptPackages (no Docker commands)

src/runtime/container/
  container-manager.ts      # ensureAptImage(): builds derived Docker images for apt packages
                            # Uses content-addressed hashing and label-based cache checks
```

### Integration Points

| File | Change |
|------|--------|
| `src/runtime/skills/skill-types.ts` | Add `SkillDependencies` type to `SkillPolicy` |
| `src/runtime/skills/skill-loader.ts` | Validate dependency pins/hashes; schema v1→v2 migration; export `APT_PACKAGE_NAME_REGEX`, `APT_VERSION_REGEX` |
| `src/runtime/motor-cortex/motor-protocol.ts` | Add `dependencyPackId?`, `dependencyPackStatus?` to `MotorRun` |
| `src/runtime/motor-cortex/motor-cortex.ts` | Call dependency manager before container creation; pass `aptPackages` to container config |
| `src/runtime/container/types.ts` | Add `extraMounts`, `env`, `aptPackages` to `ContainerConfig` |
| `src/runtime/container/container-manager.ts` | Apply extra mounts and env in `docker create` args; `ensureAptImage()` for derived images |
| `src/runtime/motor-cortex/skill-extraction.ts` | Preserve `dependencies` when updating policy.json |
| `src/runtime/motor-cortex/motor-loop.ts` | Update system prompt: "packages are pre-installed" |

## Alternatives Considered

### A. Allow npm/pip registries permanently
Rejected — breaks `--network none` security model. Supply chain attack surface. Post-install scripts can execute arbitrary code.

### B. Long-lived containers (OpenClaw approach)
OpenClaw reuses containers across runs with host-mounted workspaces. Dependencies persist naturally in the container filesystem.

Rejected because:
- Changes our ephemeral container model fundamentally
- Container state becomes mutable and hard to reason about
- Stale packages accumulate without explicit lifecycle management
- Harder to reproduce issues (container state differs between runs)

### C. Bake packages into Docker image
Build custom images per skill with dependencies pre-installed.

Originally rejected (slow builds, image proliferation), but **reversed for apt packages only** due to a glibc showstopper:

The `dpkg -x` approach (Alternative D, previously implemented) extracts ALL transitive .deb dependencies including `libc6` from Debian unstable into a sysroot. When `LD_LIBRARY_PATH` points to these extracted libraries, Node.js crashes with `symbol lookup error: __tunable_is_initialization, version GLIBC_PRIVATE` — two different glibc versions in the same process. This is a fundamental flaw in the extraction approach.

**Now adopted for apt packages:** `ensureAptImage()` builds a derived Docker image with `apt-get install` which handles dependency resolution correctly. Libraries are placed in standard OS paths where the system linker finds them naturally — no `LD_LIBRARY_PATH` needed. Build time is comparable to the prep container approach, and caching uses the same content-hash strategy. Image proliferation is manageable because apt dependency sets have low cardinality (skills rarely have more than 2-3 unique apt sets).

npm/pip continue to use prep containers + volumes (no glibc issues).

### D. dpkg -x extraction into volume (previously implemented, replaced)
Download .deb packages, extract via `dpkg -x` into a Docker named volume, mount at `/opt/skill-deps/apt:ro` with `LD_LIBRARY_PATH`.

Replaced because of the glibc conflict described in Alternative C above. Self-contained single-binary tools (like statically-linked builds) worked, but packages with shared library dependencies (like yt-dlp pulling in Python + SSL) triggered the glibc version conflict.

### E. System prompt warning only
Tell the model "don't use npm install" in the system prompt.

Accepted as **interim measure** (shipped separately). Not sufficient long-term:
- No enforcement — model may still try
- Skills that genuinely need packages can't function
- Wastes iterations when model ignores the warning

## Industry Research

| System | Approach |
|--------|----------|
| OpenClaw | Long-lived containers + host-mounted workspace + `setupCommand` |
| GitHub Codespaces | Pre-built dev containers with `devcontainer.json` features |
| Replit | Nix-based package declarations, installed at workspace creation |
| Docker | Multi-stage builds: install in builder stage, copy artifacts to runtime |
| AWS Lambda Layers | Pre-packaged dependency archives mounted read-only at runtime |

Our approach is closest to **Lambda Layers** (npm/pip volumes) combined with **Docker multi-stage builds** (apt derived images).

## Security Controls

1. **Exact version pins** — no ranges, no git refs (npm/pip: digits+dots only; apt: Debian version format; `latest` allowed for all)
2. **npm `--ignore-scripts`** — blocks `postinstall` code execution
3. **pip `--target`** — installs to a specific directory, no system modification
4. **apt `apt-get install` in Docker build** — full package installation (including postinst scripts) runs in the Docker build context with network access. We trust Debian's official repos — same trust boundary as the `node:24-slim` base image itself. Pin priority 100 prevents unstable from upgrading base system packages (libc, openssl, etc.).
5. **Prep container security** — `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 512m`, `--pids-limit 64`
6. **Runtime mounts read-only** — agent can't modify installed packages (npm/pip volumes mounted `:ro`; apt packages in read-only rootfs)
7. **No symlink escapes** — validate workspace contents before extraction
8. **Content-addressed cache** — deterministic hash of packages + image + platform ensures reproducibility
9. **Ecosystem-specific name validation** — npm: `(@scope/)?[a-z0-9._-]+`; apt: `[a-z0-9][a-z0-9.+-]+` — rejects URLs, paths, git refs. Validation regexes shared between skill-loader (policy validation) and container-manager (build-time re-validation).
10. **Pruning** — stale volumes without ready markers are removed before re-install; only dangling (untagged) derived apt images are pruned during periodic cleanup (tagged cached images are retained for performance)

## Consequences

- Skills can declare npm, pip, and apt dependencies that are automatically available at runtime
- No changes to the ephemeral container model — runs remain reproducible
- First run of a new dependency set incurs a prep step (5-30s for npm/pip, 30-120s for apt image build); subsequent runs are instant
- Content-addressed Docker named volumes (npm/pip) avoid macOS xattr issues and enable cross-skill sharing
- Content-addressed Docker images (apt) avoid glibc conflicts and enable natural library resolution
- Base image switched from Alpine (node:24-alpine) to Debian slim (node:24-slim) for glibc compatibility and apt support
- apt packages are fully installed via `apt-get install` — all packages work correctly (including those needing postinst scripts)
- No `LD_LIBRARY_PATH` needed for apt packages — libraries in standard OS paths
- pip cache key includes apt hash when both are present (ABI coupling: apt Python version change invalidates pip cache)
- Prep containers (npm/pip) need temporary network access — a new container creation path
- Script containers are out of scope — they don't currently use apt deps

## Superseded: Unified Skill Dependency Image (2026-02-23)

The three-mechanism approach above (prep container→volume for npm/pip, docker build for apt) has been replaced with a **single `docker build` per skill deps set**.

### Motivation

The original architecture had recurring issues:
- **ABI mismatch**: pip C extensions compiled in prep containers against different Python than the apt-derived runtime image
- **Volume mount fragility**: Docker volume mounts appearing as FILE instead of DIR in edge cases
- **Read-only FS + noexec tmpfs**: blocked tools that execute from /tmp
- **Complex caching**: 3 hashes, `.ready` markers, lock files, ABI coupling hash — hard to debug
- **Host OS dependency**: lock files, temp dirs, ready markers on host FS

### New Architecture

All three ecosystems are baked into a single Dockerfile with conditional layers:

```dockerfile
FROM <baseImage>
USER root
RUN apt-get install ...      # Layer 1: apt (conditional)
RUN pip install --target ...  # Layer 2: pip (conditional)
RUN npm install ...           # Layer 3: npm (conditional)
ENV NODE_PATH=... PYTHONPATH=...
USER node
```

Key properties:
- **One hash**: `SHA256({schemaVersion, apt[], pip[], npm[], baseImageId, platform})` — all ecosystems in one content-addressed key
- **No host FS state**: No lock files, no ready markers, no temp dirs. Docker image labels = cache. `docker image inspect` = cache check.
- **Concurrent-safe without locks**: Identical builds produce identical content. Docker image tagging is atomic. Worst case = redundant build.
- **No ABI mismatch**: pip install runs in the same image as apt, so C extensions compile against the correct Python ABI
- **Dockerfile piped via stdin**: `docker build -f - -` — zero host filesystem operations

### Migration

- `PreparedDeps` type changed from `{npmDir, pipDir, pipPythonPath, aptPackages}` to `{version: 2, skillImage}`
- `ContainerConfig` simplified: removed `extraMounts`, `extraEnv`, `aptPackages`; added `image`
- `ensureAptImage()` removed from container-manager.ts
- `installNpm()`, `installPip()`, volume/lock management removed from dependency-manager.ts
- Runtime guard detects old persisted `PreparedDeps` shape and fails with clear error
- Old artifacts to clean up: `docker volume ls --filter name=lifemodel-deps -q`, `docker image ls --filter reference='lifemodel-motor-apt-*' -q`, `rm -rf data/dependency-cache/`
