# motor-1 — The agent runs tasks again, each within its own bounds

**Agreed:** 2026-10-19 by the owner, item by item, after instance-1 closed on
what it delivered (the owner: "веха перегружена", "Закрыть на сделанном"). The
owner's order of the next milestones: Motor Cortex, then generations, then
self-change ("Motor Cortex → поколения → самоизменение"); self-change needs
Motor Cortex first.

Motor Cortex is switched off in the cluster since lifemodel-avy. This milestone
brings it back on the platform: the agent hands work to tasks, each task runs in
its own container with its own files, network and limits, and the owner talks to
lifemodel while tasks run. The decisions behind each outcome are recorded on
lifemodel-653 (2026-10-13, 2026-10-14, 2026-10-19).

## Outcomes

Each outcome is one feature issue labelled `motor-1`. Checks run on the owner's
test VM, never on a real instance; interfaces are accepted by PRA-001.

1. **A broken image or platform render cannot merge green** (lifemodel-5f4q).
   *Check:* a pull request that removes a file the loader image needs, or a
   resource the platform render names, fails CI; normally such a pull request
   passes. First, because this milestone adds an image, a gateway and platform
   manifests.
2. **Each task runs in its own container** (lifemodel-653). *Check:* two tasks
   run at once as separate Kubernetes Jobs with different profiles; each sees
   only its own files; no key is in either; the model is reached only through
   the model gateway. The executor (first: plain Jobs) and the agent harness
   inside a task (prime-agent one candidate; others compared in research) each
   stand behind a seam and are replaceable. One workbench image, built by CI
   until the generation operator exists.
3. **The agent sets a task's profile, a task asks for more, and the platform
   holds the owner's ceilings** (lifemodel-ey3e). *Check:* a domain outside a
   task's profile is unreachable and an allowed one is reached through the
   egress gateway with no key in the task; a request within the ceilings is
   granted by the agent, one beyond them is asked of the owner as an ordinary
   reply and takes effect only after the owner agrees; a profile over a ceiling
   is refused by the platform whatever the agent asks.
4. **The conversation stays replies; tasks show in the right panel**
   (lifemodel-hf2k), the shape of OpenAI's dots. *Check:* in real browsers the
   owner asks for minutes of work, gets a reply at once, keeps talking while the
   task runs in the right panel, and gets its result as a reply; a task stops
   from the panel or in words; no task card or chip appears in the transcript.
5. **The old Motor Cortex is gone** (lifemodel-97bj). *Check:* no code starts a
   Docker container or runs Motor's own model loop; skills and run records live
   in Postgres and survive a restart.

## Out

- Generations, rollback and panic (`generations-1`: lifemodel-pwe, -u8t,
  -b0r); self-change on request (`self-change-1`: lifemodel-n6r).
- The rest of lifemodel-2t5: per-module store credentials through OpenBao, the
  Gitea admin Secret retirement. Only its egress gateway is taken here.
- The five feature plugins as functions (lifemodel-e64).
- A second workbench image; SkyPilot as a second executor for heavy, GPU or
  cloud tasks (idea lifemodel-zn55); microVM isolation.
- Spending limits (`platform-1`).

## Carried over

From instance-1: the tracker store's move out of the code branches
(lifemodel-hsyc, setup upkeep, spends no finding budget) and the CI render task
lifemodel-lut.3.6, now under lifemodel-5f4q. The open findings and tasks of
instance-1 not named here are deferred; lifemodel-alf9 and lifemodel-3wkt wait
for `generations-1`, where the deploy branch they concern is built on.

## Finding budget

9 findings: 8 agreed by the owner on 2026-10-19, raised to 9 on 2026-10-23
to admit lifemodel-pf3v (a random model-gateway test timeout that turned main
red), with no planned work displaced. The value lives in `.backlog/config.json`
(`findingBudget`). A tenth comes to the owner for a decision.

No target date: none was set from outside the work.

## Next milestone: `observability-1` — The owner sees what every part of the platform did

Owner, 2026-10-19: observability is the next milestone, before `generations-1`
(lifemodel-vbog). Logs of every module are collected and kept on the machine
across restarts and searched in the loader's interface; failures carry safe
reasons; basic metrics; one request id from the chat to the model gateway.

Then `generations-1` — A commit becomes a generation, and a broken one reverts itself:

- A commit becomes a generation: changed modules are built in the cluster and
  replaced one by one (lifemodel-pwe; zot registry with password push, TLS
  later; build budget 20 minutes, configurable).
- A broken generation reverts itself with a report, and panic holds across
  restarts (a simplified lifemodel-u8t).

Then `self-change-1` — the owner asks, and lifemodel changes itself and reports
(lifemodel-n6r) — and `upstream-1`.
