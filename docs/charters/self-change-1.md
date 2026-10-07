# self-change-1 — The agent changes itself

**Agreed:** 2026-10-07 by the owner. **Design:** ADR-006 (`docs/adr/006-self-evolution.md`,
not yet on main), simplified: git, restart and a watchdog instead of generations and cutover.

The walking skeleton of evolution: the thinnest end-to-end version in which
lifemodel changes its own code without a human step, and a broken change is
cheap to undo. In this milestone the owner's request starts a change; deciding
on its own comes next.

## Outcomes

Each outcome is one feature issue labelled `self-change-1`. They are listed in
the order they build on each other; checks run in a development test
environment.

1. **`AGENTS.md` is the one agent doc and describes the code as it is**,
   since the agent changes itself by it. `claude.md` is removed; `AGENTS.md`
   is written anew from the code. *Check:* `claude.md` no longer exists, every
   path `AGENTS.md` names exists, and the present-documents check reports no
   drift in `AGENTS.md` and `docs/architecture.md`.
2. **A restart loses neither the turn in flight nor a message.** Applying a
   change is a restart. *Check:* a restart in the middle of a cognition turn
   ends with that turn completed or redone exactly once, and no Telegram
   message around the restart is lost or answered twice.
3. **Every change to lifemodel is checked before it is applied.** *Check:*
   typecheck, lint and the tests run in CI on every pull request and push to
   main, and one local command runs the same checks with the same verdict.
4. **lifemodel runs on a test VM and rolls out, stops and panics on
   command.** *Check:* one command rolls it out to a given commit and
   restarts it; panic keeps it down across a VM reboot until resumed; the
   provider key carries a hard spending limit.
5. **A broken version reverts itself.** *Check:* rolling out a commit that
   never becomes healthy ends, without the owner, with lifemodel back on the
   previous commit and data, and a report to the owner.
6. **The owner asks, and lifemodel changes itself and reports.** *Check:* the
   owner writes "learn X" in Telegram; lifemodel changes its own code through
   prime-agent, applies it under the watchdog and reports what changed, why
   and how to roll back. A deliberately broken change reverts itself and is
   reported.

## Out

- Starting a change without the owner's request (`evolution-1`).
- Generations, a cutover without a pause, the LLM gateway, bubblewrap
  isolation (`platform-1`, added when needed). The test VM is the sandbox.
- Moving memory behind a port (`memory-1`). Long-term memory is not
  versioned: the watchdog's data copy may leave it out.
- Steer and `/stop` (`dialogue-1`).
- Choosing where the target VM lives.

## Carried over

From the replaced `platform-1` charter: the product checks in CI
(lifemodel-cup, now under outcome 3). The `claude.md` drift (lifemodel-9vw)
was closed as moot when the owner decided to replace `claude.md` with a new
`AGENTS.md` (outcome 1). The five `platform-1`
features and the document gate are deferred.

## Finding budget

10 findings; the value lives in `.backlog/config.json` (`findingBudget`).
An eleventh comes to the owner for a decision.

## Next milestone: `evolution-1`

- lifemodel decides on its own when to change itself.
- The owner's development process runs inside the agent.
