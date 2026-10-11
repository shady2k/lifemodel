# instance-1 — Your own lifemodel that changes itself

**Agreed:** 2026-10-07 by the owner as `self-change-1`; reshaped and renamed
2026-10-08 by the owner; re-cut 2026-10-11 by the owner around container
generations and a web interface (below). **Design:** ADR-006 (`docs/adr/006-self-evolution.md`,
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

**Generations as containers (owner, 2026-10-11).** The self-development loop
is the milestone's aim and comes first. Generations switch the way Kubernetes
rolls out a stateless service: the existing loader (extended, not rewritten)
runs in its own container, the only one with access to Docker, and starts each
generation of lifemodel as its own container beside the running one; liveness
and readiness probes, then the switch of the epoch, the health window, the
rollback and the maintenance mode. A generation keeps no state of its own:
**Valkey** holds the event bus (streams) and one current snapshot of the tick,
committed atomically with the epoch check and flushed to disk on every write;
**Postgres with pgvector** holds memory and configuration (no shared folder:
the configuration lives in the store); **OpenBao**, beside Agent Vault, issues
the credentials. The tick is the only boundary: asynchronous results arrive on
the bus and are handled in later ticks; a planned switch lets the old
generation finish its tick and leave, and the new one continues from the
current snapshot. Nothing exists to migrate: the instance starts greenfield.
The core is not split into modules now; the bus and the external state are the
seams that later let modules be cut out and written in any language. This
replaces the earlier owner direction of an initialized candidate promoted
inside the same container (`lifemodel-b0r.8`, its documents kept as the record
of that direction); reversible format migrations and "refuse when uncertain"
carry over. The channel of this milestone is a web interface; Telegram comes
later.

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
   through the loader, sets the endpoint and models in lifemodel's own web
   interface; lifemodel's model request reaches the endpoint with the key
   injected by Agent Vault while no key is in lifemodel's process (the test
   environment uses a stub endpoint and a made-up key; owner, 2026-10-08);
   recreating the container keeps the code and the data; panic keeps it down
   across a restart of the container and of Docker until it is resumed.
5. **A new generation takes over from the running one, and a broken one
   reverts itself** (re-cut 2026-10-11; was "A broken version reverts itself,
   and the owner can boot any generation"). *Check:* in the test environment
   the loader, in its own container, starts generation N+1 as a container
   beside N; N+1 passes its readiness probe and the epoch switches; the
   conversation continues from the current snapshot with no message lost or
   answered twice; a generation that never becomes healthy is replaced,
   without the owner, by the previous healthy one with a report; in the
   loader's maintenance mode the owner boots an older generation, and data
   changed by a breaking migration is brought back to that generation's
   format. Outcome 4's check is walked again on this shape: one command still
   starts the instance, no key is in lifemodel's process, panic holds across
   restarts.
6. **Tasks run in parallel, each within its own limits.** *Check:* two tasks
   run at once with different profiles; each sees only its own files and its
   allowed domains, no key is present in its process, and a task asking for
   more than the owner's ceilings is refused. Motor Cortex runs its work on
   this executor instead of Docker.
7. **The owner asks, and lifemodel changes itself and reports.** *Check:* the
   owner writes "learn X" in the web interface (outcome 8; was Telegram); a self-change task changes lifemodel's
   code through prime-agent, passes the gates and becomes a new generation
   through the loader, and lifemodel reports what changed, why and how to roll
   back. A deliberately broken change reverts itself and is reported.
8. **The owner talks to lifemodel through the web interface** (new
   2026-10-11). *Check:* behind the loader's password the owner writes in the
   web chat and gets lifemodel's answer, and the conversation survives a
   switch of generations.

Outcome 4 is needed by all the others; 5, 6 and 8 are independent of each
other; 7 needs 5, 6 and 8. The numbers are names, not an order.

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
- Moving memory behind its own port (`memory-1`); this milestone only moves
  its storage into Postgres with pgvector. Long-term memory is not
  versioned, and data is never rolled back.
- Telegram on the new shape (owner, 2026-10-11): until it is ported, the
  owner talks to lifemodel through the web interface only.
- Replaying the bus journal, a hot standby generation, functions and
  several versions running at once, cutting the core into modules, modules
  in other languages, rewriting lifemodel in Go or Rust (owner, 2026-10-11:
  later, on the same seams).
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

The re-cut of 2026-10-11 carries nothing over and defers nothing open: it
rewrites outcome 5 around container generations, adds outcome 8 (the web
interface) and moves outcome 7's request from Telegram to it. The
candidate-first stages of outcome 5 (`lifemodel-b0r.4`-`.7`) and its design
stage (`lifemodel-b0r.8`) are closed as replaced by that decision; the
vector-memory storage finding (`lifemodel-ww8`) is closed as moot, since
LanceDB leaves for Postgres with pgvector.

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
