# instance-1 — Your own lifemodel that changes itself

**Agreed:** 2026-10-07 by the owner as `self-change-1`; reshaped and renamed
2026-10-08 by the owner. **Design:** ADR-006 (`docs/adr/006-self-evolution.md`,
not yet on main), simplified: git, restart and a loader instead of
generations and cutover. The instance shape follows razzant/ouroboros: the
instance's code is a git repository it changes by commits.

The walking skeleton of evolution, delivered as a personal instance: a person
starts their own lifemodel from the Docker image, and it changes its own code
without a human step, with a broken change cheap to undo. In this milestone the
owner's request starts a change; deciding on its own comes next.

**Delivery:** lifemodel ships only as a Docker image, the same for everyone,
built by CI. Inside it a trusted layer that lifemodel and its tasks can neither
see nor change: the **loader** (the owner's always-on web interface; panic;
generations, self-healing and a maintenance mode like BIOS/UEFI; the first
start), the **task executor** (each task a prime-agent confined by its profile
under the owner's ceilings) and **Agent Vault** (keys and the network allowlist;
keys are injected into requests, lifemodel and tasks see placeholders). The
instance's code is a git repository on a volume next to its data; a self-change
is a commit that becomes a new generation, with no image rebuild. Only what
lifemodel must not change sits in the loader; model settings, Telegram,
embeddings and the rest are lifemodel's own settings in its own web interface,
which it can extend. Data is never rolled back: format changes are expanding,
or carry an up/down migration pair the loader runs when switching generations.
The decisions and their evidence are on the outcome-4 feature's decision log.

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
   clean test machine with Docker, one command starts the image from CI; the
   owner sets the loader's password, puts the model key into Agent Vault
   through the loader, sets the endpoint, models and Telegram in lifemodel's
   own web interface, and lifemodel answers in Telegram; recreating the
   container keeps the code and the data; panic keeps it down across a restart
   of the container and of Docker until it is resumed.
5. **A broken version reverts itself, and the owner can boot any
   generation.** *Check:* a generation that never becomes healthy is replaced,
   without the owner, by the previous healthy one with a report; in the
   loader's maintenance mode the owner boots an older generation, and data
   changed by a breaking migration is brought back to that generation's format.
6. **Tasks run in parallel, each within its own limits.** *Check:* two tasks
   run at once with different profiles; each sees only its own files and its
   allowed domains, no key is present in its process, and a task asking for
   more than the owner's ceilings is refused. Motor Cortex runs its work on
   this executor instead of Docker.
7. **The owner asks, and lifemodel changes itself and reports.** *Check:* the
   owner writes "learn X" in Telegram; a self-change task changes lifemodel's
   code through prime-agent, passes the gates and becomes a new generation
   through the loader, and lifemodel reports what changed, why and how to roll
   back. A deliberately broken change reverts itself and is reported.

Outcome 4 is needed by all the others; 5 and 6 are independent of each other;
7 needs 5 and 6.

## Out

- Spend limits (a global limit and one per task): the owner's decision of
  2026-10-08, kept on "LLM spending cannot exceed the owner's limit"
  (`platform-1`). lifemodel talks to any OpenAI-compatible endpoint.
- Updates from upstream, proposals back to upstream, the owner's fork as the
  instance's personal remote (`upstream-1`). Outcome 4 keeps the instance's
  code a plain git repository so they fit on top.
- Any delivery form other than the Docker image.
- Remote embeddings (the image keeps local ones; it is a lifemodel setting
  that can be added later, even by a self-change); microsandbox as a second
  task executor where KVM exists; Infisical as a source of short-lived keys.
- Starting a change without the owner's request (`evolution-1`).
- A cutover without a pause, the LLM gateway that meters spend
  (`platform-1`, added when needed).
- Moving memory behind a port (`memory-1`). Long-term memory is not
  versioned, and data is never rolled back.
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
moved inside the supervisor. The same day the owner settled the instance's
design (loader, task executor, Agent Vault, generations without data
rollback) and the outcomes were re-cut: outcome 4 grew to the loader, Agent
Vault and lifemodel's own interface; generations became outcome 5 with a
maintenance mode; the task executor became outcome 6; change-yourself moved
to outcome 7.

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
