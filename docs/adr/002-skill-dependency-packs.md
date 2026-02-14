# ADR-002: Persistent Skill Dependency Packs

**Date:** 2026-02-13
**Status:** Accepted (Phase 1 — prep container + content-addressed cache — implemented)
**Affects:** `src/runtime/container/`, `src/runtime/motor-cortex/`, `src/runtime/skills/`

## Problem

Motor Cortex runs are ephemeral — each agentic run gets a fresh container and temp workspace. When a skill needs npm/pip packages (e.g., Stripe SDK for payment skills, cheerio for scraping), the agent tries `npm install` at runtime, but:

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
    }
  }
}
```

Rules:
- Versions must be **exact pins** — no `^`, `~`, `*`, ranges
- npm: `integrity` field (subresource integrity hash) — optional initially, required once tooling matures
- pip: `hashes` field for `--require-hashes` — optional initially
- Unknown ecosystems rejected at load time
- Package names validated against allowlist pattern (no URLs, git refs, or local paths)

### Host Cache Layout

```
data/dependency-cache/
  npm/                          # Tier A: shared tarball cache (npm cache dir)
  pip/                          # Tier A: shared wheel cache (pip cache dir)
data/dependency-packs/
  <skill-name>/
    <packHash>/                 # Tier B: skill-scoped installed pack
      node_modules/             # Ready to mount
      site-packages/            # Ready to mount
      manifest.json             # Pack metadata (policy hash, versions, timestamps)
```

- **Tier A** (shared artifact cache): Downloaded tarballs/wheels reused across skills. Deduplicates when multiple skills need the same package.
- **Tier B** (skill-scoped packs): Fully installed `node_modules`/`site-packages` keyed by deterministic hash of `dependencies + base image + runtime ABI`. Isolated per skill to avoid version conflicts.

### Pack Hash

```
SHA256(canonical_json({
  skill: skill.name,
  npm: sorted_packages,
  pip: sorted_packages,
  baseImage: image_hash,
  nodeVersion: "22.x",
  pythonVersion: "3.x"
}))
```

Deterministic — same deps always produce the same hash, enabling cache hits across container recreations.

### Install Workflow

1. `motor-cortex.ts` calls `dependencyManager.prepareForRun(skill, policy)` before `containerManager.create()`
2. Compute pack hash from policy dependencies
3. If pack exists and manifest verifies → return mounts immediately (cache hit)
4. If missing → spawn short-lived prep container:
   - Same base image as runtime
   - Network restricted to registry domains only (`registry.npmjs.org`, `pypi.org`)
   - Run `npm install --ignore-scripts --no-audit --no-fund` with shared cache mount
   - Run `pip install --only-binary :all:` with shared cache mount
   - No post-install scripts, no source builds
5. Atomically publish pack (`tmp-<random>` → `rename` to `<packHash>`)
6. Write `manifest.json` with provenance (policy hash, resolved versions, timestamps)
7. Runtime container mounts pack read-only:
   - `data/dependency-packs/<skill>/<hash>/node_modules → /workspace/node_modules:ro`
   - `data/dependency-packs/<skill>/<hash>/site-packages → /opt/skill-python:ro`
   - `NODE_PATH=/workspace/node_modules`
   - `PYTHONPATH=/opt/skill-python`

### New Modules

```
src/runtime/dependencies/
  dependency-types.ts       # Policy dependency schema, pack manifest types
  dependency-hash.ts        # Canonical hash computation
  dependency-cache.ts       # Host cache layout, lockfiles, atomic publish, prune
  dependency-installer.ts   # Prep container: install with restricted egress
  dependency-manager.ts     # Public API: prepareForRun(skill, policy) → PreparedDeps
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

1. **Exact version pins** — no ranges, no `latest`, no git refs
2. **npm `--ignore-scripts`** — blocks `postinstall` code execution
3. **pip `--only-binary :all:`** — blocks source builds (no arbitrary compilation)
4. **pip `--require-hashes`** — verifies package integrity (when hashes provided)
5. **Prep container egress** — only registry domains, not skill domains
6. **Runtime mounts read-only** — agent can't modify installed packages
7. **No symlink escapes** — validate pack contents before publishing
8. **Provenance recording** — manifest tracks policy hash, registry URLs, timestamps
9. **Pack size limits** — cap total dependency size (e.g., 256MB per pack)
10. **Pruning** — remove packs for deleted skills or stale hashes

## Consequences

- Skills can declare dependencies that are automatically available at runtime
- No changes to the ephemeral container model — runs remain reproducible
- First run of a new dependency set incurs a prep step (5-30s); subsequent runs are instant
- Shared artifact cache reduces download time across skills
- Policy schema version bump (v1→v2) requires migration handling in skill-loader
- New `data/dependency-packs/` directory needs disk space management
- Prep containers need temporary network access — a new container creation path
