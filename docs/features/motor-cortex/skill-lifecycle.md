# Skill Lifecycle — Complete Workflow

Covers every scenario from skill creation through execution, failure recovery, and updates.

## Architecture Boundaries

```
Cognition (brain)     — decides WHAT to do, reviews results, manages status
Motor Cortex (hands)  — pure runtime: executes tasks with explicitly provided params
Extraction (install)  — copies validated skill dirs from workspace → data/skills/
User (authority)      — approves skills before they become executable
```

**Key constraint:** Motor Cortex is a pure runtime — it has zero skill/policy knowledge. Everything is passed explicitly by the caller (core.act). Workspace is prepared by core.act before startRun. If the skill declares dependencies in `policy.json`, they are pre-installed by core.act before startRun. Credentials are resolved by core.act before startRun. Motor reads and modifies skill files in place. Post-run extraction (in motor-cortex.ts middleware) compares against the baseline, extracts only changed files to `data/skills/`, and forces `pending_review` status.

## Security Model

The safety boundary for Motor Cortex is **infrastructure-level, not honor-system**.

**Network enforcement:** When Cognition starts a Motor run, it provides a list of allowed domains. In Docker mode, these are enforced via iptables rules on the container's network. Motor cannot reach any domain not in the allowlist — regardless of what a skill or fetched document says.

**Implications for self-healing (Scenario 4):** If Motor fixes a broken skill and the fix requires a NEW domain (e.g., API moved from `api.agentmail.to` to `api-v2.agentmail.to`), the iptables rules block the request. Motor must use the `ask_user` tool to request the new domain. Cognition relays this to the user for approval, then retries the run with the expanded domain list.

**Write isolation:** Motor writes to workspace only (`/workspace`). The live `data/skills/` directory is never directly writable by Motor. Skill files are copied INTO the workspace at run start; extraction is the only path from workspace back to live skills, and it forces `pending_review` status.

## Status States

| State | Meaning | Can execute via core.act? |
|-------|---------|--------------------------|
| `pending_review` | Motor created/modified this skill, user hasn't reviewed yet | No — requires explicit tools param |
| `reviewed` | Security review completed, awaiting user approval | No — requires explicit tools param |
| `approved` | User confirmed policy after reviewing | Yes — policy defaults apply |
| `needs_reapproval` | Content hash mismatch detected at load time, or no policy exists | No — requires explicit tools or onboarding |

**Distinction:** `pending_review` means "Motor produced this, it's new to the user." `needs_reapproval` means "this was previously approved but something changed (content hash mismatch) or policy is missing." Both block implicit execution — the difference is provenance and what Cognition tells the user.

### Content Hash Scope

The content hash covers **all files in the skill directory** (SKILL.md, scripts/, REFERENCE.md, etc.), not just SKILL.md. This means any change — a modified helper script, an updated reference doc — triggers status invalidation. The hash is computed as a sorted, deterministic digest of all file paths and their contents. `policy.json` is excluded from the hash since it's managed by the system, not the skill author.

### Status State Transitions

```
(new skill extracted)           → pending_review
pending_review + security review → reviewed
reviewed + user approves        → approved
reviewed + user rejects         → pending_review (stays, Cognition notes rejection)
approved + content hash match   → approved (no change)
approved + content hash mismatch → needs_reapproval (detected at load time)
approved + Motor updates skill  → pending_review (extraction forces reset)
needs_reapproval + user re-approves      → approved
needs_reapproval + onboarding completes  → approved
Content changes                 → needs_reapproval → reviewed → approved
```

## Scenario 1: User Discovers a New Service

**Trigger:** User tells agent about a service they found.

```
User: "I came across AgentMail, learn how to work with it"
```

### Flow

```
1. COGNITION receives user message
   - Recognizes: user wants agent to learn a new skill
   - Calls core.act({
       mode: "agentic",
       task: "Research AgentMail. Fetch their documentation and create a skill.
              Write SKILL.md with setup instructions, API usage, examples.
              Write policy.json with appropriate tools and domains.
              If there are helper scripts or reference docs, include them.",
       tools: ["bash", "read", "write", "fetch"],
       domains: ["agentmail.dev", "docs.agentmail.dev", "api.agentmail.to"]
     })
   - core.act prepares workspace via prepareSkillWorkspace()
   - core.act pre-installs dependencies if declared
   - core.act resolves credentials before startRun

2. MOTOR CORTEX executes (sandbox, multiple iterations)
   - Motor is a pure runtime — receives all params explicitly, has no skill/policy knowledge
   - curl https://agentmail.dev/docs → fetch documentation
   - Analyze API structure, endpoints, auth requirements
   - Write to workspace root:
       SKILL.md                         (instructions)
       references/api-docs.md           (full API reference)
       scripts/                         (helper scripts if needed)
   - Note: Motor does NOT create policy.json — it's host-side only,
     generated during extraction with status: "pending_review"
   - Complete with summary of what was created

3. POST-RUN EXTRACTION (automatic, baseline-diff, in motor-cortex.ts middleware)
   - Read .motor-baseline.json from workspace (generated at init)
   - Scan workspace for current skill files (SKILL.md, references/**, scripts/**)
     (policy.json is excluded — it's host-side only)
   - Three-way diff against baseline:
     a. CHANGED: file in baseline with different hash → extract
     b. ADDED: file in current but not in baseline → extract
     c. DELETED: file in baseline but not in current → remove from installed skill
   - If no changes → skip (prevents status churn)
   - For changed/new skills:
     a. Validate SKILL.md: parse frontmatter, check name+description exist
     b. Validate policy.json if present: check schema
     c. Sanitize skill name: lowercase, no path traversal
     d. Generate policy.json with status: "pending_review" (Motor never creates it)
     e. Preserve existing credentialValues from prior policy (if updating)
     f. Merge any pendingCredentials saved during the run (from save_credential)
     g. Atomic copy to data/skills/<name>/
     h. Compute and store content hash in policy.json
   - Include created/updated skill names in result
   - Note: pendingCredentials reconciliation happens here (motor-cortex.ts middleware)

4. COGNITION receives motor_result signal
   - Result includes created skill names
   - Calls core.skill(action:"review", name:"agentmail")
   - Review returns: description, status, file inventory
     (domains in policy, credentials saved)
   - Presents review to user for approval:
     "I learned AgentMail — it's an API for giving AI agents email inboxes.
      Credentials saved: agentmail_api_key
      Files: SKILL.md (2.1KB), references/api-docs.md (8.4KB)
      Want me to activate this skill?"
   - NOTE: core.skill(action:"approve") is consent-gated — Cognition cannot
     call it on this motor_result turn. It must wait for the user's response.

5. USER approves
   - Cognition calls core.skill(action:"approve", name:"agentmail")
     (now on a user_message trigger — consent gate passes)
   - Skill is now executable via core.act(skill: "agentmail")
```

### If User Rejects

```
5b. USER: "No, that looks wrong"
    - Skill stays at status: "pending_review"
    - Cognition can ask what's wrong, re-run Motor with corrections
```

## Scenario 2: Using an Existing Skill

**Trigger:** User asks agent to do something that matches an existing approved skill.

```
User: "Send an email to john@example.com via AgentMail"
```

### Flow

```
1. COGNITION receives user message
   - Sees "agentmail" in <available_skills> with status: "approved"
   - Calls core.act({
       skill: "agentmail",
       task: "Send an email to john@example.com with subject 'Hello'",
       inputs: { to: "john@example.com", subject: "Hello" }
     })
   - core.act resolves policy → provides tools + domains automatically
   - core.act prepares workspace via prepareSkillWorkspace()
   - core.act pre-installs dependencies
   - core.act resolves credentials before startRun

2. MOTOR CORTEX executes (pure runtime, no policy knowledge)
   - System prompt built by buildMotorSystemPrompt() with skill body
   - Follows skill instructions to send email
   - No skill files written to workspace (just task execution)
   - Completes with summary

3. COGNITION receives motor_result
   - Reports to user: "Email sent to john@example.com"
```

## Scenario 3: Skill Execution Fails (Transient Error)

**Trigger:** API is temporarily down, rate limited, network timeout.

```
1. MOTOR CORTEX executes skill → API returns 503
   - Motor has multiple iterations — retries within the run
   - If succeeds on retry → normal completion
   - If all retries fail → run fails

2. COGNITION receives motor_result_failed
   - Checks: retryable: true
   - Retries run with guidance: "API may be temporarily down, wait and retry"
   - Motor retries with new attempt

3. If still failing after max attempts:
   - Cognition reports to user: "AgentMail API seems to be down. Try again later?"
   - Skill is NOT modified (it's not the skill's fault)
```

## Scenario 4: Skill is Broken (Outdated Instructions)

**Trigger:** API changed, endpoints moved, auth method updated.

```
User: "Send an email via AgentMail"
```

### Case A: Fix Stays Within Approved Domains

```
1. MOTOR CORTEX executes skill → API returns 404 (endpoint moved)
   - Motor recognizes: "endpoint /v1/send doesn't exist anymore"
   - Motor has skill files at workspace root (copied at init)
   - Motor self-heals within the same run:
     a. Reads SKILL.md from workspace root (copied there at init)
     b. Fetches fresh docs: curl https://agentmail.dev/docs
        (agentmail.dev is already in the approved domain list)
     c. Identifies change: endpoint moved from /v1/send to /v2/messages
        (still on api.agentmail.to — same approved domain)
     d. Writes CORRECTED skill in-place at workspace root:
        SKILL.md (updated instructions)
     e. Retries task with corrected approach → succeeds

2. POST-RUN EXTRACTION (baseline-diff, in motor-cortex.ts middleware)
   - Compares workspace SKILL.md hash against .motor-baseline.json
   - Validates updated SKILL.md
   - Overwrites data/skills/agentmail/ with updated version
   - Resets status to "pending_review" (content changed = re-review needed)

3. COGNITION receives motor_result
   - Result includes: updated skills list
   - Reports to user: "Task completed. I also updated the AgentMail skill —
     the API endpoint changed from /v1 to /v2. Re-approve?"
   - The task itself succeeded (Motor fixed it on the fly)
   - But the skill is now pending_review for future use

4. USER approves updated skill
   - Status restored to "approved"
```

### Case B: Fix Needs a New Domain

```
1. MOTOR CORTEX executes skill → API returns 301 redirect to api-v2.agentmail.to
   - Motor tries to follow redirect
   - iptables BLOCKS the request (api-v2.agentmail.to not in allowed domains)
   - Motor uses ask_user tool: "The API moved to api-v2.agentmail.to.
     I need access to this domain to continue."

2. COGNITION receives motor_awaiting_input signal
   - Relays to user: "AgentMail API moved to a new domain (api-v2.agentmail.to).
     Allow access?"

3. USER approves
   - Cognition retries the run with expanded domain list
   - Motor can now reach api-v2.agentmail.to
   - Continues with self-heal flow (same as Case A from here)
```

### If Motor Can't Self-Heal

```
1. MOTOR tries to fetch fresh docs but can't figure out the fix
   - Run fails with failure details

2. COGNITION receives motor_result_failed
   - Cognition can launch a SEPARATE research run:
     core.act({
       mode: "agentic",
       task: "The agentmail skill is broken — endpoint /v1/send returns 404.
              Research the current AgentMail API and write an updated skill.",
       tools: ["bash", "read", "write", "fetch"],
       domains: ["agentmail.dev", "docs.agentmail.dev"]
     })
   - This is a dedicated research run, not a task execution
   - Same extraction flow: updated skill → pending_review → user approves
```

## Scenario 5: Skill is for Another Agent

**Trigger:** User wants the agent to learn a skill that another agent (or future instance) will use.

```
User: "Learn how AgentMail works — my other agent will need this"
```

### Flow

```
1-4. Same as Scenario 1 (research, create, extract, approve)

5. Skill is stored in data/skills/agentmail/
   - Any agent instance using the same data/ directory sees it
   - Skill is self-contained: SKILL.md + policy.json + scripts/
   - Another agent's discoverSkills() scans data/skills/ and finds it
```

**Current limitation:** Skills are local to this `data/` directory. Cross-agent sharing requires shared filesystem (same `data/skills/` mount). Status decisions are per-agent — another agent must independently approve the skill's policy. Future: skill registry/marketplace (out of scope for now).

## Scenario 6: User Provides a Skill File Directly

**Trigger:** User pastes or shares a SKILL.md they got from somewhere.

```
User: "Here's a skill file for AgentMail: [paste SKILL.md content]"
```

### Flow

```
1. COGNITION receives the skill content
   - Parses and validates the SKILL.md content (frontmatter + body)
   - Runs the SAME validation checks as extraction:
     a. Name validation: lowercase, no traversal, max 64 chars
     b. Required frontmatter: name + description
     c. Size limits: 1MB per file, 10MB total
     d. No symlinks
   - Writes to data/skills/<name>/SKILL.md
   - Computes content hash over all skill files
   - Sets status to "pending_review"
   - No Motor involvement — this is a direct file write

2. COGNITION infers policy from skill body
   - Reads the skill content, identifies needed tools/domains/credentials
   - Presents EXPLICIT list to user for confirmation (not silent inference):
     "This skill mentions api.agentmail.to and uses curl commands.
      It needs: shell tool, network access to api.agentmail.to.
      Approve these permissions?"

3. USER approves
   - Cognition calls core.skill(action:"approve") — saves policy.json with status: "approved"
```

**Why no Motor?** The user provided the content directly. There's nothing to research or execute. Cognition can validate and write the file. Routing through Motor would risk the LLM rewriting the user's provided content.

## Scenario 7: Existing Skill Found Online

**Trigger:** User points agent to a skill repository or URL.

```
User: "Check out https://skills.sh/agentmail — add that skill"
```

### Flow

```
1. COGNITION calls core.act to fetch and adapt:
     core.act({
       mode: "agentic",
       task: "Fetch the skill from https://skills.sh/agentmail
              Download SKILL.md and any supporting files.
              Create policy.json with appropriate security settings.
              Record provenance: source URL and fetch timestamp.",
       tools: ["bash", "read", "write", "fetch"],
       domains: ["skills.sh"]
     })

2. MOTOR fetches the skill (pure runtime, no policy knowledge)
   - fetch https://skills.sh/agentmail/SKILL.md
   - Downloads supporting files if referenced
   - Creates policy.json with provenance.source = URL
   - Writes everything to workspace root (SKILL.md, policy.json, references/)

3. EXTRACTION installs with status: "pending_review"
   - provenance.source preserved for audit trail

4. COGNITION receives motor_result
   - Calls core.skill(action:"review", name:"agentmail") for security review
   - Presents review with provenance: "This skill was fetched from skills.sh"
   - Includes: domains in policy, credentials saved, file inventory
   - Waits for user response (consent-gated — cannot approve on this turn)

5. USER approves
   - Cognition calls core.skill(action:"approve") on user_message trigger
   - Status set to "approved"
```

## Scenario 8: Updating a Skill's Policy

**Trigger:** User wants to modify domains, credentials, tools, or dependencies without changing SKILL.md.

```
User: "Add cdn.agentmail.to to the AgentMail skill's allowed domains"
```

### Flow

```
1. COGNITION receives user message
   - Calls core.skill(action:"update", name:"agentmail", domains:["api.agentmail.to", "cdn.agentmail.to"])
   - The update action modifies policy fields (domains, credentials, tools, dependencies)
   - Content hash is unaffected (policy.json is excluded from hash)
   - Status stays "approved" (policy-only changes don't require re-review)

2. COGNITION confirms to user: "Updated AgentMail domains to include cdn.agentmail.to"
```

## Post-Run Extraction — Detailed Spec

### Location

After `runMotorLoop` completes successfully, in motor-cortex.ts middleware (runLoopInBackground), before container teardown.

### Algorithm

```
extractSkillsFromWorkspace(workspace, skillsDir, runId):
  1. Read .motor-baseline.json from workspace
     - If missing → treat as fresh workspace (all files are new)

  2. Scan workspace for skill files matching allowlist:
     SKILL.md, references/**, scripts/**
     (policy.json excluded — host-side only, managed by cognition layer)
     Hard denylist: node_modules/**, .cache/**, .local/**, *.log, .git/**

  3. Check SKILL.md exists — skip if missing

  4. Parse SKILL.md frontmatter:
     - Must have 'name' and 'description'
     - name must pass validation: /^[a-z][a-z0-9-]*[a-z0-9]$/, max 64 chars
     - If invalid → log warning, skip

  5. Three-way diff against baseline:
     - CHANGED: file in baseline with different hash → extract
     - ADDED: file in current but not in baseline → extract
     - DELETED: file in baseline but not in current → remove from installed skill
     - If no changes → skip (prevents status churn on unchanged skill runs)

  6. Copy ALL current skill files to temp dir, then atomic install:
     a. Recursive symlink check on workspace
     b. Size limits: 1MB per file, 10MB total
     c. Read existing policy.json BEFORE atomic rename (to preserve credentialValues)
     d. Atomic rename: temp → target (with backup/rollback)
     e. Build policy.json:
        - Set status: "pending_review"
        - Compute contentHash over all skill files
        - Preserve provenance if Motor wrote it or from existing policy
        - Preserve credentialValues from existing policy
        - Merge pendingCredentials from run (from save_credential calls)
        - Add extractedFrom: { runId, timestamp, changedFiles, deletedFiles }

  7. Return { created: string[], updated: string[] }
```

### Concurrency

Motor Cortex enforces a mutex — only one agentic run at a time. Extraction runs synchronously after the loop completes. No concurrent extraction is possible. If this constraint changes in the future, extraction will need per-run staging directories and a lock.

### Security Checks

| Check | Reason |
|-------|--------|
| Sanitize skill name | Prevent path traversal |
| Reject symlinks | Prevent escape from workspace sandbox |
| Size limit per file (1MB) | Prevent storage abuse |
| Total skill dir size limit (10MB) | Prevent storage abuse |
| Force status to pending_review | Motor cannot self-approve |
| Recompute content hash (full directory) | Ensure integrity on future loads — any file change invalidates status |

### What Extraction Does NOT Do

- Does NOT execute any scripts found in the skill directory
- Does NOT auto-approve skills (always pending_review)
- Does NOT delete existing skills (only create/update)
- Does NOT modify the original workspace files

## Motor Prompt Changes

### For Skill Creation/Research Runs

Motor prompt (built by `buildMotorSystemPrompt()` in `src/runtime/motor-cortex/motor-prompt.ts`) teaches the sub-agent the Agent Skills standard:
```
Skill files go at the workspace root:
  SKILL.md           — required: frontmatter (name, description) + instructions
  references/        — optional: API docs, schemas, examples
  scripts/           — optional: helper scripts

Note: policy.json is NOT created by Motor — it's managed by the host/cognition layer.
Status is always "pending_review" for new skills — the user reviews and approves before first use.

SKILL.md uses YAML frontmatter for metadata, then markdown for instructions.
The description should explain both what the skill does and when to trigger it.
```

### For Skill Execution Runs

Skill files are copied to workspace root at init via `prepareSkillWorkspace()` (in `src/runtime/skills/skill-workspace.ts`). Motor prompt tells sub-agent:
```
A skill is available for this task. Read its files before starting work.
Start by reading SKILL.md: read({path: "SKILL.md"}).
Check for reference files: list({path: "."}).
You can modify skill files directly. Changes are extracted after completion.

If instructions fail due to outdated info (changed endpoints, deprecated methods):
1. Figure out what went wrong
2. Complete the task with the corrected approach
3. Update the skill files in-place (SKILL.md, references, scripts)
The updated files will be reviewed before replacing the current version.
```

### allowedRoots

```
Read roots:  [workspace]  — skill files are copied here at init
Write roots: [workspace]  — Motor reads and writes in the same place
```

## Result Handoff to Cognition

When a Motor run creates or updates skills, the result signal includes the skill names and whether they're new or updated. Cognition's trigger section instructs it to:

1. Report the task result to the user
2. For each new/updated skill, call `core.skill(action:"review")` to get a deterministic security review
3. Present the review findings to the user (see below)
4. Wait for the user to respond before calling `core.skill(action:"approve")`

Skills remain at `pending_review` until explicitly approved. Cognition (via core.skill tool) handles all user-initiated mutations: review, update, approve, reject, delete.

## Post-Extraction Security Review

After extraction, Cognition must review each new/updated skill before presenting it for approval. This is a **second security layer** — the Docker sandbox is the primary boundary, the review provides **visibility for informed user consent**.

### Two-Layer Review Approach

1. **Regex extraction (host-side, deterministic):** Extract env var names and URL domains from all skill files. These are observed references — hard facts even the fast model can work with. No prompt injection risk. Accessed via `core.skill(action:"review")`.

2. **Motor review task (sandboxed, advisory):** Cognition dispatches a Motor run with `skill_review: true` to read ALL skill files (SKILL.md, scripts/, references/) and report file-by-file analysis. This run has:
   - Read-only tools: `read`, `list`, `glob`, `grep`
   - No network access (empty domains)
   - No synthetic tools (no `ask_user`, `save_credential`, `request_approval`)
   - Limited iterations (max 10)
   - Single attempt (no auto-retry)

3. **Motor runtime as safety net:** If both layers miss something, Motor fails at runtime and reports back via `ask_user`.

### Review Flow

```
1. COGNITION receives motor_result with installed skills
2. For each skill, calls core.skill(action:"review", name:"<skill-name>")
3. Review returns deterministic facts:
   - Description and status
   - Policy domains (runtime permissions)
   - Policy credentials
   - Referenced credentials (env vars observed in all skill files)
   - Referenced domains (URLs observed in all skill files)
   - File inventory (path, size, truncated SHA-256 hash)
   - Whether bash was used
   - Provenance (source URL, fetch timestamp)
4. Cognition tells user: "Analyzing skill files for security review..."
5. Cognition dispatches Motor review: core.act(mode:"agentic", skill:"skill-name", skill_review:true, task:"Read all files...")
6. Motor review reads SKILL.md, scripts/, references/ and reports:
   - Each file's purpose and contents
   - Credentials referenced in each file
   - Domains referenced in each file
   - Any security concerns or suspicious patterns
7. When motor_result arrives (second signal), Cognition combines:
   - Deterministic facts from step 3 (authoritative)
   - Motor analysis from step 6 (advisory, may be incomplete)
8. Cognition presents everything at once to user
9. User approves → Cognition calls core.skill(action:"approve")
```

### Content Reference Extraction

The `reviewSkill()` function extracts observed references from all allowlisted skill files (SKILL.md, `scripts/**`, `references/**`). The file inventory scan already reads these files for hashing — extraction piggybacks on the same I/O with zero additional disk reads.

**Credential patterns detected:**
- `process.env.VAR_NAME` (JS/TS dot notation)
- `process.env["VAR_NAME"]` / `process.env['VAR_NAME']` (JS/TS bracket notation)
- `os.environ["VAR_NAME"]` / `os.environ.get("VAR_NAME")` / `os.environ['VAR_NAME']` (Python)
- `${VAR_NAME}` and `$VAR_NAME` inside fenced shell blocks (````bash`/`sh`/`zsh`/`shell`)
- `VAULT_VAR_NAME` anywhere (our convention)

**Domain patterns detected:**
- HTTPS/HTTP URLs parsed via `new URL()` for robust hostname extraction

**Exclusions:**
- Shell specials (`$1`-`$9`, `$?`, `$!`, etc.)
- Well-known non-credential vars (`NODE_ENV`, `HOME`, `PATH`, etc.)
- Placeholder domains (`localhost`, `example.com`, `your-server.com`, etc.)

### v1 Limitations

- **HTTPS/HTTP URLs only:** Bare hostnames and `ws://`/`wss://` schemes are not detected
- **Binary files skipped:** Files containing null bytes are excluded from text extraction

### Consent Gating

Mutation actions (`approve`, `reject`, `delete`, `update` on `core.skill`; `respond`, `approve` on `core.task`) are **consent-gated** — they can only be called on `user_message` triggers. This prevents Cognition from auto-approving skills or auto-responding to Motor questions on non-user triggers (e.g., `motor_result`).

Two layers of defense:
1. **Tool filtering:** `core.task` is removed from the LLM toolset when the trigger is `awaiting_input` or `awaiting_approval`
2. **Runtime consent gate:** Each mutating action checks `triggerType === 'user_message'` and returns an error if not

### Domain Separation

Domains needed during skill **creation** (docs sites, skills.sh, github.com) are different from domains needed during skill **usage** (api.agentmail.to). These are handled separately:

- `policy.domains` = runtime execution permissions only. **NOT auto-populated from creation domains.**
- New skills have no `domains` — the user sets them during approval
- Updated skills preserve existing `domains` (previously user-approved)
- On first usage, if the skill needs domains not in policy, Motor requests them via `ask_user` (just-in-time flow)

## Policy Ownership Split

Motor Cortex and Cognition have distinct, non-overlapping responsibilities for policy management:

- **Motor Cortex middleware (motor-cortex.ts runLoopInBackground):** Post-run extraction + pendingCredentials reconciliation ONLY
- **Cognition (core.skill tool):** All user-initiated mutations — review, update, approve, reject, delete
- **Motor loop (motor-loop.ts):** NEVER writes policy.json. Zero policy knowledge.

## Motor Run Lifecycle

Each Motor run receives all configuration explicitly from core.act:

1. **core.act** resolves skill policy, prepares workspace (`prepareSkillWorkspace()`), pre-installs dependencies, resolves credentials
2. **Motor Cortex** receives explicit params: task, tools, domains, credentials, workspace path
3. **Motor loop** executes with `buildMotorSystemPrompt()` — zero policy awareness
4. **Post-run middleware** handles extraction and pendingCredentials reconciliation

### Synthetic Tools

Synthetic tools are host-side tools that don't run in the container:
- `ask_user`: Pause execution and ask user a question
- `save_credential`: Persist a credential for future runs
- `request_approval`: Request user approval for an action (requires bash tool)

## skill_review Parameter

The `core.act` tool accepts a `skill_review` boolean parameter for security review mode:

```typescript
core.act({
  mode: "agentic",
  skill: "skill-name",
  skill_review: true,
  task: "Read all files and report findings"
})
```

**Constraints:**
- Only callable from `motor_result` trigger (enforced at runtime)
- Requires `skill` parameter
- Forces read-only tools: `read`, `list`, `glob`, `grep`
- Forces empty domains (no network access)
- Forces `maxIterations: 10`, `maxAttempts: 1`
- Bypasses status gating (can review `pending_review` and `needs_reapproval` skills)

## Open Questions

1. **Approval mechanism**: ~~Should Cognition use `savePolicy()` directly to set status, or do we need a dedicated `core.approveSkill` tool?~~ **Resolved.** Cognition uses `core.skill(action:"approve")` — all user-initiated mutations go through the core.skill tool.

2. **Partial failure**: If extraction finds 3 skills but 1 fails validation, should it install the valid 2 and report the failure? (Proposed: yes, install valid ones, report failures in result.)

3. **Skill versioning**: Should we keep the previous version when overwriting? (Proposed: not now — artifacts archive has a copy of every run's workspace. Add explicit versioning in Phase 3 harvesting.)

4. **Auto-approval for self-fixes**: When Motor fixes a skill during execution (Scenario 4), should Cognition auto-approve if the fix is minor (same tools, same domains, just endpoint change)? Or always require user approval? (Proposed: always require — safer. The iptables enforcement is the real-time safety net; status approval is for persistent policy.)

5. **Credential handling during creation**: Two credential sources:
   - **User credentials**: Stored in `.env` as `VAULT_*` env vars, managed via `core.credential` tool
   - **Skill-acquired credentials**: Stored in the skill's `policy.json` under `credentialValues` field. Motor's `save_credential` tool persists to policy.json for existing skills, or to `pendingCredentials` (merged at extraction) for new skills. Credentials are scoped to `requiredCredentials` — Motor can only save names declared in the skill policy. At container delivery time, `credentialValues` takes priority over `CredentialStore` (user env vars). `sanitizePolicyForDisplay()` redacts values in all read paths.

6. **Skill deletion**: Handled via `core.skill(action:"delete")`.

7. **Rollback mechanism**: If a skill update causes regressions, how does the system revert? (Proposed: artifacts archive preserves every run's workspace. Manual rollback by copying from `data/motor-runs/<runId>/artifacts/`. Automated rollback out of scope for now.)

8. **Policy-only updates**: How does the user change allowed tools/domains without modifying SKILL.md? Use `core.skill(action:"update")` to modify domains, credentials, tools, or dependencies. Content hash won't change, so status stays `approved`. Policy changes don't affect content hash since policy.json is excluded from hash.

9. **Credential expiry**: When a skill fails because credentials expired or are invalid, should this trigger a specific recovery flow? (Proposed: treat as transient error — Cognition reports failure and prompts user to update credentials via `core.credential`.)
