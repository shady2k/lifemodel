# Skill Lifecycle — Complete Workflow

Covers every scenario from skill creation through execution, failure recovery, and updates.

## Architecture Boundaries

```
Cognition (brain)     — decides WHAT to do, reviews results, manages trust
Motor Cortex (hands)  — executes tasks, researches docs, writes skill files
Extraction (install)  — copies validated skill dirs from workspace → data/skills/
User (authority)      — approves skills before they become executable
```

**Key constraint:** Motor Cortex runs in a Docker sandbox. Skill files are copied to the workspace root on init (with a baseline manifest for change detection). Motor reads and modifies them in place. Post-run extraction compares against the baseline, extracts only changed files to `data/skills/`, and forces `pending_review` trust.

## Security Model

The safety boundary for Motor Cortex is **infrastructure-level, not honor-system**.

**Network enforcement:** When Cognition starts a Motor run, it provides a list of allowed domains. In Docker mode, these are enforced via iptables rules on the container's network. Motor cannot reach any domain not in the allowlist — regardless of what a skill or fetched document says.

**Implications for self-healing (Scenario 4):** If Motor fixes a broken skill and the fix requires a NEW domain (e.g., API moved from `api.agentmail.to` to `api-v2.agentmail.to`), the iptables rules block the request. Motor must use the `ask_user` tool to request the new domain. Cognition relays this to the user for approval, then retries the run with the expanded domain list.

**Write isolation:** Motor writes to workspace only (`/workspace`). The live `data/skills/` directory is never directly writable by Motor. Skill files are copied INTO the workspace at run start; extraction is the only path from workspace back to live skills, and it forces `pending_review` trust.

## Trust States

| State | Meaning | Can execute via core.act? |
|-------|---------|--------------------------|
| `pending_review` | Motor created/modified this skill, user hasn't reviewed yet | No — requires explicit tools param |
| `approved` | User confirmed policy after reviewing | Yes — policy defaults apply |
| `needs_reapproval` | Content hash mismatch detected at load time, or no policy exists | No — requires explicit tools or onboarding |

**Distinction:** `pending_review` means "Motor produced this, it's new to the user." `needs_reapproval` means "this was previously approved but something changed (content hash mismatch) or policy is missing." Both block implicit execution — the difference is provenance and what Cognition tells the user.

### Content Hash Scope

The content hash covers **all files in the skill directory** (SKILL.md, scripts/, REFERENCE.md, etc.), not just SKILL.md. This means any change — a modified helper script, an updated reference doc — triggers trust invalidation. The hash is computed as a sorted, deterministic digest of all file paths and their contents. `policy.json` is excluded from the hash since it's managed by the system, not the skill author.

### Trust State Transitions

```
(new skill extracted)           → pending_review
pending_review + user approves  → approved
pending_review + user rejects   → pending_review (stays, Cognition notes rejection)
approved + content hash match   → approved (no change)
approved + content hash mismatch → needs_reapproval (detected at load time)
approved + Motor updates skill  → pending_review (extraction forces reset)
needs_reapproval + user re-approves      → approved
needs_reapproval + onboarding completes  → approved
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

2. MOTOR CORTEX executes (sandbox, multiple iterations)
   - curl https://agentmail.dev/docs → fetch documentation
   - Analyze API structure, endpoints, auth requirements
   - Write to workspace root:
       SKILL.md                         (instructions)
       policy.json                      (tools: bash+read+write+fetch, domains: api.agentmail.to)
       references/api-docs.md           (full API reference)
       scripts/                         (helper scripts if needed)
   - Complete with summary of what was created

3. POST-RUN EXTRACTION (automatic, baseline-diff)
   - Read .motor-baseline.json from workspace (generated at init)
   - Scan workspace for current skill files (SKILL.md, policy.json, references/**, scripts/**)
   - Three-way diff against baseline:
     a. CHANGED: file in baseline with different hash → extract
     b. ADDED: file in current but not in baseline → extract
     c. DELETED: file in baseline but not in current → remove from installed skill
   - If no changes → skip (prevents trust churn)
   - For changed/new skills:
     a. Validate SKILL.md: parse frontmatter, check name+description exist
     b. Validate policy.json if present: check schema
     c. Sanitize skill name: lowercase, no path traversal
     d. FORCE trust to "pending_review" (ignore what Motor wrote)
     e. Atomic copy to data/skills/<name>/
     f. Compute and store content hash in policy.json
   - Include created/updated skill names in result

4. COGNITION receives motor_result signal
   - Result includes created skill names
   - Loads skill metadata: name, description, requestedTools, requestedDomains
   - Presents to user for approval:
     "I learned AgentMail — it's an API for giving AI agents email inboxes.
      To use it, I'll need:
      - Tools: shell, code
      - Network access to: api.agentmail.to
      - Credentials: agentmail_api_key
      Want me to activate this skill?"

5. USER approves
   - Cognition updates policy with trust: "approved", approvedBy: "user"
   - Skill is now executable via core.act(skill: "agentmail")
```

### If User Rejects

```
5b. USER: "No, that looks wrong"
    - Skill stays at trust: "pending_review"
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
   - Sees "agentmail" in <available_skills> with trust: "approved"
   - Calls core.act({
       skill: "agentmail",
       task: "Send an email to john@example.com with subject 'Hello'",
       inputs: { to: "john@example.com", subject: "Hello" }
     })
   - Policy provides tools + domains automatically

2. MOTOR CORTEX executes
   - Skill body injected in system prompt
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
        policy.json (same domains)
     e. Retries task with corrected approach → succeeds

2. POST-RUN EXTRACTION (baseline-diff)
   - Compares workspace SKILL.md hash against .motor-baseline.json
   - Validates updated SKILL.md
   - Overwrites data/skills/agentmail/ with updated version
   - Resets trust to "pending_review" (content changed = re-review needed)

3. COGNITION receives motor_result
   - Result includes: updated skills list
   - Reports to user: "Task completed. I also updated the AgentMail skill —
     the API endpoint changed from /v1 to /v2. Re-approve?"
   - The task itself succeeded (Motor fixed it on the fly)
   - But the skill is now pending_review for future use

4. USER approves updated skill
   - Trust restored to "approved"
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

**Current limitation:** Skills are local to this `data/` directory. Cross-agent sharing requires shared filesystem (same `data/skills/` mount). Trust decisions are per-agent — another agent must independently approve the skill's policy. Future: skill registry/marketplace (out of scope for now).

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
   - Sets trust to "pending_review"
   - No Motor involvement — this is a direct file write

2. COGNITION infers policy from skill body
   - Reads the skill content, identifies needed tools/domains/credentials
   - Presents EXPLICIT list to user for confirmation (not silent inference):
     "This skill mentions api.agentmail.to and uses curl commands.
      It needs: shell tool, network access to api.agentmail.to.
      Approve these permissions?"

3. USER approves
   - Cognition saves policy.json with trust: "approved"
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

2. MOTOR fetches the skill
   - fetch https://skills.sh/agentmail/SKILL.md
   - Downloads supporting files if referenced
   - Creates policy.json with provenance.source = URL
   - Writes everything to workspace root (SKILL.md, policy.json, references/)

3. EXTRACTION installs with trust: "pending_review"
   - provenance.source preserved for audit trail

4. COGNITION presents for approval
   - Includes provenance: "This skill was fetched from skills.sh"
   - User approves → trust: "approved"
```

## Post-Run Extraction — Detailed Spec

### Location

After `runMotorLoop` completes successfully, before container teardown.

### Algorithm

```
extractSkillsFromWorkspace(workspace, skillsDir, runId):
  1. Read .motor-baseline.json from workspace
     - If missing → treat as fresh workspace (all files are new)

  2. Scan workspace for skill files matching allowlist:
     SKILL.md, policy.json, references/**, scripts/**
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
     - If no changes → skip (prevents trust churn on unchanged skill runs)

  6. Copy ALL current skill files to temp dir, then atomic install:
     a. Recursive symlink check on workspace
     b. Size limits: 1MB per file, 10MB total
     c. Atomic rename: temp → target (with backup/rollback)
     d. Force policy.json changes:
        - Set trust: "pending_review"
        - Compute contentHash over all skill files
        - Preserve provenance if Motor wrote it
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
| Force trust to pending_review | Motor cannot self-approve |
| Recompute content hash (full directory) | Ensure integrity on future loads — any file change invalidates trust |

### What Extraction Does NOT Do

- Does NOT execute any scripts found in the skill directory
- Does NOT auto-approve skills (always pending_review)
- Does NOT delete existing skills (only create/update)
- Does NOT modify the original workspace files

## Motor Prompt Changes

### For Skill Creation/Research Runs

Motor prompt teaches the sub-agent the Agent Skills standard:
```
Skill files go at the workspace root:
  SKILL.md           — required: frontmatter (name, description) + instructions
  policy.json        — required: security policy (tools, domains, credentials)
  references/        — optional: API docs, schemas, examples
  scripts/           — optional: helper scripts

SKILL.md uses YAML frontmatter for metadata, then markdown for instructions.
The description should explain both what the skill does and when to trigger it.
```

### For Skill Execution Runs

Skill files are copied to workspace root at init. Motor prompt tells sub-agent:
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
2. For each new/updated skill, present what it does and what permissions it needs
3. Ask the user to approve each skill before it can be used

Skills remain at `pending_review` until explicitly approved. Cognition handles the approval conversation.

## Open Questions

1. **Approval mechanism**: Should Cognition use `savePolicy()` directly to set trust, or do we need a dedicated `core.approveSkill` tool? Using savePolicy is simpler but means Cognition needs access to skill-loader functions.

2. **Partial failure**: If extraction finds 3 skills but 1 fails validation, should it install the valid 2 and report the failure? (Proposed: yes, install valid ones, report failures in result.)

3. **Skill versioning**: Should we keep the previous version when overwriting? (Proposed: not now — artifacts archive has a copy of every run's workspace. Add explicit versioning in Phase 3 harvesting.)

4. **Auto-approval for self-fixes**: When Motor fixes a skill during execution (Scenario 4), should Cognition auto-approve if the fix is minor (same tools, same domains, just endpoint change)? Or always require user approval? (Proposed: always require — safer. The iptables enforcement is the real-time safety net; trust approval is for persistent policy.)

5. **Credential handling during creation**: When Motor creates a skill that needs credentials (API key), how does the user provide them? (Existing: `core.credential` tool — Cognition asks user, stores via CredentialStore.)

6. **Skill deletion**: No deletion flow defined yet. (Proposed: add `core.removeSkill` tool or handle via Cognition direct write. Out of scope for initial implementation.)

7. **Rollback mechanism**: If a skill update causes regressions, how does the system revert? (Proposed: artifacts archive preserves every run's workspace. Manual rollback by copying from `data/motor-runs/<runId>/artifacts/`. Automated rollback out of scope for now.)

8. **Policy-only updates**: How does the user change allowed tools/domains without modifying SKILL.md? Content hash won't change, so trust stays `approved`. (Proposed: direct policy.json edit via Cognition is valid — policy changes don't affect content hash since policy.json is excluded from hash.)

9. **Credential expiry**: When a skill fails because credentials expired or are invalid, should this trigger a specific recovery flow? (Proposed: treat as transient error — Cognition reports failure and prompts user to update credentials via `core.credential`.)
