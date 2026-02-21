# ADR-002: Persistent Skill Dependency Packs

**Date:** 2026-02-13 (updated 2026-02-21: apt ecosystem support added)
**Status:** Accepted (Phase 1 — prep container + content-addressed cache — implemented; Phase 2 — apt system packages — implemented)
**Affects:** `src/runtime/container/`, `src/runtime/motor-cortex/`, `src/runtime/skills/`

## Problem

Motor Cortex runs are ephemeral — each agentic run gets a fresh container and temp workspace. When a skill needs npm/pip packages (e.g., Stripe SDK for payment skills, cheerio for scraping) or system binaries (e.g., ffmpeg, yt-dlp, pandoc), the agent tries `npm install` or `apt-get install` at runtime, but:

1. **Registries are unreachable** — containers run with `--network none` and only declared domains are accessible. npm/pip registries are not in the allowlist.
2. **Nothing persists** — even if registries were reachable, installed packages would be lost after the run completes.
3. **Wasted iterations** — the agent spends 2-3 iterations discovering that `npm install` fails, then falls back to `curl`-based workarounds or gives up.

Opening registry access permanently is a security risk (supply chain attacks, post-install scripts executing arbitrary code).

## Decision

Use **persistent skill dependency packs** with a two-tier cache and short-lived prep containers.

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
                │  │ Prep container     │
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
         │ Pack mounted :ro         │
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
  apt-<hash>.lock
  apt-<hash>.ready
```

Docker named volumes hold the actual package data:
- `lifemodel-deps-npm-<hash>` — node_modules (mounted at `/opt/skill-deps/npm`)
- `lifemodel-deps-pip-<hash>` — site-packages (mounted at `/opt/skill-deps/pip`)
- `lifemodel-deps-apt-<hash>` — sysroot with extracted .deb contents (mounted at `/opt/skill-deps/apt`)

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

Computed per-ecosystem (not per-skill). Two skills with the same npm packages share one volume. The hash is truncated to 16 hex chars for volume naming.

### Install Workflow

1. `core.act` calls `installSkillDependencies(deps, cacheDir, skillName, logger)` before `startRun()`
2. For each ecosystem with packages, compute content-addressed hash
3. Cache check: host-side `.ready` marker + `docker volume inspect` — prevents empty volume false cache hits
4. On cache miss → spawn short-lived prep container:
   - Same base image as runtime (node:24-slim)
   - Network: bridge (needs to reach registries / Debian repos)
   - Security: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 512m`
   - **npm:** `npm install --ignore-scripts --no-audit --no-fund` into named volume
   - **pip:** `pip install --no-user --target /workspace/site-packages` into named volume
   - **apt:** `apt-get install --download-only` → `dpkg -x` each .deb into `/workspace/sysroot` (runs as `--user 0:0` with `-o APT::Sandbox::User=root`)
   - Prep container is named (`prep-{ecosystem}-{random}`) and removed in finally block
5. Mark volume ready (host-side `.ready` file)
6. Runtime container mounts volumes read-only:
   - npm: `lifemodel-deps-npm-<hash>` → `/opt/skill-deps/npm:ro` + `NODE_PATH=/opt/skill-deps/npm/node_modules`
   - pip: `lifemodel-deps-pip-<hash>` → `/opt/skill-deps/pip:ro` + `PYTHONPATH=/opt/skill-deps/pip/site-packages`
   - apt: `lifemodel-deps-apt-<hash>` → `/opt/skill-deps/apt:ro` + `PATH=/opt/skill-deps/apt/usr/bin:...` + `LD_LIBRARY_PATH=/opt/skill-deps/apt/usr/lib/...`

### Modules

```
src/runtime/dependencies/
  dependency-manager.ts     # Public API: installSkillDependencies() → PreparedDeps
                            # Contains: computeDepsHash(), installNpm(), installPip(),
                            # installApt(), verifyNpmInstall(), verifyPipInstall(),
                            # verifyAptInstall(), volume management, lock files
```

### Integration Points

| File | Change |
|------|--------|
| `src/runtime/skills/skill-types.ts` | Add `SkillDependencies` type to `SkillPolicy` |
| `src/runtime/skills/skill-loader.ts` | Validate dependency pins/hashes; schema v1→v2 migration |
| `src/runtime/motor-cortex/motor-protocol.ts` | Add `dependencyPackId?`, `dependencyPackStatus?` to `MotorRun` |
| `src/runtime/motor-cortex/motor-cortex.ts` | Call dependency manager before container creation |
| `src/runtime/container/types.ts` | Add `extraMounts`, `env` to `ContainerConfig` |
| `src/runtime/container/container-manager.ts` | Apply extra mounts and env in `docker create` args |
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

Rejected because:
- Requires Docker image rebuild for each skill's dependencies
- Slow iteration (image builds take minutes)
- Image proliferation (one per skill × version combo)
- Users can't add packages without Docker build tooling

### D. System prompt warning only
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

Our approach is closest to **Lambda Layers** — pre-built dependency packs mounted read-only into ephemeral execution environments.

## Security Controls

1. **Exact version pins** — no ranges, no git refs (npm/pip: digits+dots only; apt: Debian version format; `latest` allowed for all)
2. **npm `--ignore-scripts`** — blocks `postinstall` code execution
3. **pip `--target`** — installs to a specific directory, no system modification
4. **apt `--download-only` + `dpkg -x`** — downloads .deb archives then extracts without running postinst scripts. Best-effort: packages needing postinst (alternatives registration etc.) may not work. Primary targets (ffmpeg, yt-dlp, pandoc, imagemagick) are self-contained binaries.
5. **Prep container security** — `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 512m`, `--pids-limit 64`; apt prep runs as `--user 0:0` with `-o APT::Sandbox::User=root`
6. **Runtime mounts read-only** — agent can't modify installed packages
7. **No symlink escapes** — validate workspace contents before extraction
8. **Content-addressed cache** — deterministic hash of packages + image + platform ensures reproducibility
9. **Ecosystem-specific name validation** — npm: `(@scope/)?[a-z0-9._-]+`; apt: `[a-z0-9][a-z0-9.+-]+` — rejects URLs, paths, git refs
10. **Pruning** — stale volumes without ready markers are removed before re-install

## Consequences

- Skills can declare npm, pip, and apt dependencies that are automatically available at runtime
- No changes to the ephemeral container model — runs remain reproducible
- First run of a new dependency set incurs a prep step (5-30s); subsequent runs are instant
- Content-addressed Docker named volumes avoid macOS xattr issues and enable cross-skill sharing
- Base image switched from Alpine (node:24-alpine) to Debian slim (node:24-slim) for glibc compatibility and apt support
- apt packages are "best-effort isolated binaries" — self-contained tools work well, packages needing postinst scripts may not
- Both x86_64 and aarch64 library paths included in LD_LIBRARY_PATH (harmless if one doesn't exist)
- PYTHONPATH is merged when both pip and apt provide Python packages (pip takes priority)
- Prep containers need temporary network access — a new container creation path
