# Motor Cortex Phase 2 — Toolmaker

Phase 2 enables self-learning: the agent discovers new APIs, reads docs via fetch, tests APIs via Motor Cortex, and creates reusable SKILL.md files.

## New Components

### Motor Tools (Step 1)
- **shell**: Run allowlisted commands (curl, jq, grep, etc.) via existing `shell-runner.ts`
- **grep**: Pure Node.js recursive file search with regex, capped at 50 matches
- **patch**: Find-and-replace in files (exact match, must be unique)
- **Expanded filesystem**: `resolveSafePath()` accepts multiple allowed roots (workspace + `data/skills/`)
- **Symlink protection**: `fs.realpath()` check before path validation

### Skill System (Step 2)
- `src/runtime/skills/skill-types.ts` — `SkillDefinition`, `SkillInput`, `LoadedSkill`
- `src/runtime/skills/skill-loader.ts` — YAML frontmatter parser (strict subset, no deps), validation, discovery
- Skills stored as `data/skills/<name>/SKILL.md`
- Injected into motor sub-agent prompt via `<skill>` XML tags with prompt injection warning

### Credential Store (Step 3)
- `src/runtime/vault/credential-store.ts` — env-var based (`VAULT_<NAME>`)
- `<credential:name>` placeholders resolved at tool execution time only
- Never stored in conversation history (safety: resolution happens AFTER state persistence)

### Approval Gates (Step 5)
- `awaiting_approval` status with 15-min auto-cancel
- `request_approval` internal tool (like ask_user but with timeout)
- Reuses `respondToRun()` pattern via `respondToApproval()` method
- Added when shell tool is granted (network access = needs approval option)

### Artifact Persistence (Step 6)
- On completion, workspace files copied to `data/motor-runs/<runId>/artifacts/`
- Listed in `TaskResult.artifacts`

## File Summary

| Action | Path |
|--------|------|
| Modified | `src/runtime/motor-cortex/motor-protocol.ts` |
| Modified | `src/runtime/motor-cortex/motor-tools.ts` |
| Modified | `src/runtime/motor-cortex/motor-loop.ts` |
| Modified | `src/runtime/motor-cortex/motor-cortex.ts` |
| Modified | `src/layers/cognition/tools/core/act.ts` |
| Modified | `src/layers/cognition/tools/core/task.ts` |
| Modified | `src/types/signal.ts` |
| Modified | `src/core/container.ts` |
| Created | `src/runtime/skills/skill-types.ts` |
| Created | `src/runtime/skills/skill-loader.ts` |
| Created | `src/runtime/vault/credential-store.ts` |
| Created | `tests/unit/motor-cortex/motor-tools.test.ts` |
| Created | `tests/unit/motor-cortex/skill-loader.test.ts` |
| Created | `tests/unit/motor-cortex/credential-store.test.ts` |
| Created | `tests/unit/motor-cortex/motor-loop-phase2.test.ts` |
| Created | `docs/features/motor-cortex/phase-2-plan.md` |

## Deferred to Phase 3

- Browser automation (Playwright embedded)
- ProcessReaper / zombie process handling
- Sandbox hardening (isolated-vm)
- Skill harvesting from successful runs ("Muscle Memory")
- OpenCode integration as optional coding escalation
- Encrypted credential store with keychain
- History compaction (needs LLM-based summary)
- Two-phase checkpointing
- Variable energy per-iteration
