# instance-1 — Your own lifemodel that changes itself

**Agreed:** 2026-10-07 by the owner as `self-change-1`; reshaped and renamed
2026-10-08 by the owner. **Design:** ADR-006 (`docs/adr/006-self-evolution.md`,
not yet on main), simplified: git, restart and a supervisor instead of
generations and cutover. The instance shape follows razzant/ouroboros: the
instance's code is a git repository it changes by commits.

The walking skeleton of evolution, delivered as a personal instance: a person
starts their own lifemodel from the Docker image, and it changes its own code
without a human step, with a broken change cheap to undo. In this milestone the
owner's request starts a change; deciding on its own comes next.

**Delivery:** lifemodel ships only as a Docker image, the same for everyone. The
image carries the runtime (Node and the native libraries); the instance's code
is a git repository on a volume next to its data; a small supervisor inside the
container runs lifemodel, holds panic and reverts a broken version. A
self-change is a commit to that repository and a restart by the supervisor: no
image rebuild, no access to the host's Docker.

## Outcomes

Each outcome is one feature issue labelled `instance-1`. Checks run in a
development test environment, never on somebody's real instance.

1. **`AGENTS.md` is the one agent doc and describes the code as it is**,
   since the agent changes itself by it. *Check:* `claude.md` no longer
   exists, every path `AGENTS.md` names exists, and the present-documents
   check reports no drift in `AGENTS.md` and `docs/architecture.md`.
2. **A restart loses neither the turn in flight nor a message.** Applying a
   change is a restart. *Check:* a restart in the middle of a cognition turn
   ends with that turn completed or redone exactly once, and no Telegram
   message around the restart is lost or answered twice.
3. **Every change to lifemodel is checked before it is applied.** *Check:*
   typecheck, lint and the tests run in CI on every pull request and push to
   main, and one local command runs the same checks with the same verdict.
4. **A person starts their own instance with one command.** *Check:* on a
   clean test machine with Docker, one command with a settings file brings
   lifemodel up from the image; its code is a git repository on the volume;
   recreating the container keeps both the code and the data; panic stops it
   so that it stays down across a restart of the container and of Docker until
   it is resumed.
5. **A broken version reverts itself.** *Check:* switching the instance to a
   commit that never becomes healthy ends, without the owner, with the
   supervisor back on the previous commit and data, and a report to the owner.
6. **The owner asks, and lifemodel changes itself and reports.** *Check:* the
   owner writes "learn X" in Telegram; lifemodel changes its own code through
   prime-agent, passes the gates, applies it under the supervisor and reports
   what changed, why and how to roll back. A deliberately broken change
   reverts itself and is reported.

## Out

- Spend limits (a global limit and one per task): the owner's decision of
  2026-10-08, kept on "LLM spending cannot exceed the owner's limit"
  (`platform-1`). lifemodel talks to any OpenAI-compatible endpoint.
- Updates from upstream, proposals back to upstream, the owner's fork as the
  instance's personal remote (`upstream-1`). Outcome 4 keeps the instance's
  code a plain git repository so they fit on top.
- Any delivery form other than the Docker image.
- Starting a change without the owner's request (`evolution-1`).
- Generations, a cutover without a pause, the LLM gateway, bubblewrap
  isolation (`platform-1`, added when needed).
- Moving memory behind a port (`memory-1`). Long-term memory is not
  versioned: the supervisor's data copy may leave it out.
- Steer and `/stop` (`dialogue-1`).
- Choosing where the target machine lives.

## Carried over

From the replaced `platform-1` charter: the product checks in CI
(lifemodel-cup, now under outcome 3). The `claude.md` drift (lifemodel-9vw)
was closed as moot when the owner decided to replace `claude.md` with a new
`AGENTS.md` (outcome 1). The five `platform-1` features and the document gate
are deferred. The reshape of 2026-10-08 replaced outcome 4's "test VM, roll
out, stop and panic on command, a hard spending limit on the provider key"
with the instance started from the image; outcomes 5 and 6 keep their checks,
moved inside the supervisor.

## Finding budget

10 findings; the value lives in `.backlog/config.json` (`findingBudget`).
An eleventh comes to the owner for a decision.

## Next milestone: `upstream-1` — The instance lives next to upstream

- An instance takes upstream updates by a three-way merge behind the gates,
  and goes back if they fail.
- The owner's fork is the instance's personal remote and the backup of its
  evolution.
- lifemodel proposes its own change to upstream as a pull request carrying
  none of its owner's personal data.
