---
name: codex
description: Use when the user asks to run Codex CLI (codex exec, codex resume) or references OpenAI Codex for code analysis, refactoring, automated editing, or getting a second opinion on code tasks
---

# Codex Skill Guide

## Purpose
Execute Codex CLI commands to get AI-powered code analysis, refactoring suggestions, and automated editing using OpenAI's Codex models.

## Running a Task

### 1. Gather Configuration
Use defaults unless the user explicitly specifies otherwise.
Only ask the user about configuration if they want to override defaults (e.g., use `gpt-5` model, or `high`/`low` reasoning effort).
Default model: gpt-5.2 with medium reasoning

### 2. Select Sandbox Mode
Choose based on task requirements (default to `read-only` unless user specifies otherwise):
- `read-only`: Read-only review or analysis (safest, default)
- `workspace-write`: Apply local edits (requires user confirmation)
- `danger-full-access`: Network or broad access (requires explicit permission)

### 3. Assemble the Command
Build the command with appropriate options:
```bash
codex exec \
  --model <MODEL> \
  --config model_reasoning_effort="<high|medium|low>" \
  --sandbox <read-only|workspace-write|danger-full-access> \
  --skip-git-repo-check \
  [--full-auto] \
  [-C <DIR>] \
  "<prompt>" \
  2>/dev/null
```

**IMPORTANT**:
- Always use `--skip-git-repo-check`
- By default, append `2>/dev/null` to suppress thinking tokens (stderr)
- Only show stderr if user explicitly requests thinking tokens or debugging
- Use `--full-auto` for workspace-write or danger-full-access modes (with permission)
- You should provide full absolute path to files mentioned in the message

### 4. Handle Scale (Multiple Parallel Analyses)
For scale > 1, run multiple specialized analyses in parallel:
- **Scale ≤ 2**: Execute user prompt directly, optionally with a variant
- **Scale > 2**: Execute specialized analyses:
  - Code quality and best practices
  - Performance optimizations
  - Security vulnerabilities
  - Test suggestions
  - Architecture and design patterns

Each parallel execution should use the same model and reasoning effort settings.

### 5. Execute and Report
- Run the command(s) via Bash tool
- Capture stdout/stderr (filtered as appropriate)
- Summarize the outcome for the user
- **After completion**, inform: "You can resume this Codex session at any time by saying 'codex resume' or asking me to continue with additional analysis or changes."

## Resuming Sessions

To continue a previous Codex session:
```bash
echo "new prompt" | codex exec --skip-git-repo-check resume --last 2>/dev/null
```

**IMPORTANT**:
- When resuming, pipe the prompt via stdin
- Do NOT add configuration flags (model, reasoning, sandbox) unless explicitly requested
- The resumed session inherits settings from the original session
- All flags must be placed between `exec` and `resume`

Example with flags (only if user requests):
```bash
echo "prompt" | codex exec --model gpt-5 --skip-git-repo-check resume --last 2>/dev/null
```

## Quick Reference

| Use case | Sandbox mode | Key flags |
|----------|--------------|-----------|
| Read-only review or analysis | `read-only` | `--sandbox read-only 2>/dev/null` |
| Apply local edits | `workspace-write` | `--sandbox workspace-write --full-auto 2>/dev/null` |
| Permit network or broad access | `danger-full-access` | `--sandbox danger-full-access --full-auto 2>/dev/null` |
| Resume recent session | Inherited | `echo "prompt" \| codex exec --skip-git-repo-check resume --last 2>/dev/null` |
| Run from another directory | Match task needs | `-C <DIR>` plus other flags `2>/dev/null` |
| Multiple parallel analyses | Match task needs | Launch multiple `codex exec` commands with different prompts |

## Following Up

After every `codex` command:
1. Use `AskUserQuestion` to confirm next steps
2. Collect clarifications or decide whether to resume
3. Restate the chosen model, reasoning effort, and sandbox mode when proposing follow-up actions
4. For resuming, pipe new prompts via stdin with `resume --last`

## Error Handling

1. **Verification**: Test `codex --version` before first use to ensure CLI is available
2. **Failures**: Stop and report when commands exit non-zero; request direction before retrying
3. **Permissions**: Before using high-impact flags (`--full-auto`, `--sandbox danger-full-access`), ask user for permission via `AskUserQuestion` unless already granted
4. **Warnings**: When output includes warnings or partial results, summarize and ask how to adjust using `AskUserQuestion`

## Example Workflows

### Simple Analysis
```bash
codex exec \
  --model gpt-5-codex \
  --config model_reasoning_effort="medium" \
  --sandbox read-only \
  --skip-git-repo-check \
  "Review the authentication flow in src/auth for security issues" \
  2>/dev/null
```

### Multi-Scale Analysis (Scale = 5)
Launch 5 parallel codex commands:
```bash
# Quality
codex exec --model gpt-5-codex --config model_reasoning_effort="medium" \
  --sandbox read-only --skip-git-repo-check \
  "Review authentication code for quality and best practices" 2>/dev/null &

# Performance
codex exec --model gpt-5-codex --config model_reasoning_effort="medium" \
  --sandbox read-only --skip-git-repo-check \
  "Analyze authentication code for performance optimizations" 2>/dev/null &

# Security
codex exec --model gpt-5-codex --config model_reasoning_effort="medium" \
  --sandbox read-only --skip-git-repo-check \
  "Check authentication code for security vulnerabilities" 2>/dev/null &

# Tests
codex exec --model gpt-5-codex --config model_reasoning_effort="medium" \
  --sandbox read-only --skip-git-repo-check \
  "Suggest tests for authentication code" 2>/dev/null &

# Architecture
codex exec --model gpt-5-codex --config model_reasoning_effort="medium" \
  --sandbox read-only --skip-git-repo-check \
  "Review authentication architecture and design patterns" 2>/dev/null &

wait
```

### Resume with New Context
```bash
echo "Now check if the JWT implementation follows OWASP guidelines" | \
  codex exec --skip-git-repo-check resume --last 2>/dev/null
```

### Edit Mode (with permission)
```bash
codex exec \
  --model gpt-5 \
  --config model_reasoning_effort="high" \
  --sandbox workspace-write \
  --full-auto \
  --skip-git-repo-check \
  "Refactor the user controller to use async/await consistently" \
  2>/dev/null
```

## Notes

- Store relevant outputs in `subagents/codex/` directory if needed for reference
- Present Codex's responses clearly to the user, highlighting key findings
- For complex tasks, consider breaking into multiple Codex sessions
- Always verify Codex CLI is installed before first use in session
