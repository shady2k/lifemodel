Generate a handoff prompt that I can paste into a NEW Claude Code session to continue this work.

**CRITICAL RULES:**
- Output must be a WORK REQUEST — start with action verb, not status report
- Focus on what's NEXT, not what's done — keep "Completed" section brief
- **Avoid loop traps** — if we've been doing tests/reviews repeatedly, the next task should include NEW functionality
- Be specific: file paths, function names, exact next step, if it is plan file - you should provide full path to it
- **Always include NEW work** — next session can finish polish (tests/review) but MUST also include the next functional task

## Output Format

```markdown
Continue [feature] on branch `[branch]`.

**Context:** [1 sentence — what and why]

**Tracker:** [ISSUE-ID]

**Done:** [bullet list, max 5 items, brief]

**NOW DO THIS:**
1. [THE most important next step — be very specific]
2. [second priority]
3. [third priority]

**Files:** `path/file.ts:123`, `path/other.ts`

**Watch out:**
- [critical gotcha that will waste time if missed]
- **Check tracker** — run yandex tracker skill to see overall progress, don't lose the big picture

**Future Plans:** [if known — upcoming phases/features after current task]
- [next phase or feature to implement]
- [subsequent work items from spec/tracker]

**Important notes:**
- **Explore if needed** — if unclear what's next, explore codebase/spec to determine next functional task
- **Update tracker checklist** — mark items done with yandex tracker skill
- **No optional tasks** — ALL checklist items must be done. Complete current layer before moving to next
```
