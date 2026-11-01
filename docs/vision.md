# Vision

## Direction

lifemodel is a digital human that decides on its own when to think, act and
reach out, and that develops itself. The owner steers it through conversation.
Safety comes from cheap rollback and from limits the agent cannot change, not
from forbidding change: any part of the agent, its core included, may evolve.

## Audience

One owner. lifemodel is the owner's personal companion and agent.

## What it is not

- Not a multi-user service.
- Not a public chatbot.
- Not a hosted service: each person runs their own instance, with one owner.
  lifemodel ships as signed releases, the same for everyone, and runs on a
  dedicated VM installed by one command.

## Roadmap

The path leads to evolution first: the thinnest end-to-end version in which the
agent changes itself without a human step, then layers added where real use
shows they are needed. Only the current milestone is broken down into work; the
next one exists as feature titles; the rest lives here. Status comes from the
tracker, never from this page.

| Milestone | What becomes possible | Design |
|---|---|---|
| `instance-1` — Your own instance you can talk to (closed 2026-10-19) | A person installs their own instance with one command and talks to it in the web interface with their own model; restart without loss, gates, an up-to-date map of the code, a trusted loader on k3s by GitOps, state in Valkey and Postgres with pgvector, OpenBao for keys, a model gateway | ADR-006 (simplified); ADR-010 (k3s + GitOps); ADR-013 (model gateway); razzant/ouroboros for the instance shape |
| `motor-1` — The agent runs tasks again, each within its own bounds (closed 2026-11-01) | Delivered: CI builds and renders what is deployed; each task runs as its own Kubernetes Job with its own files, from one workbench image, its agent (OpenCode or prime-agent) chosen by a loader setting, and talks live with the agent; the rest moved to `motor-2` | `docs/charters/motor-1.md`; OpenAI dots for the conversation shape |
| `observability-1` — You see what it did | Logs of every module are collected on the machine, kept across restarts and searched in the loader's interface by time, module and conversation; failures carry safe reasons; one request id from the chat to the model gateway; the checks catch what the owner and the test machine caught in motor-1 | `docs/charters/observability-1.md`; lifemodel-vbog (owner, 2026-10-19) |
| `instructions-1` — The agent's instructions agree with each other | The agent's instructions are assembled from registered statements, each with its meaning and reason, so a contradiction between them is found before a walk | lifemodel-7iej (owner, 2026-11-01: after observability-1) |
| `registry-1` — Your own image registry is a mirror | A source without the release's image does not stop tasks: the loader resets to the default source in one step, and the agent explains a missing image and switches only on the owner's yes | lifemodel-w3fb (owner, 2026-10-30; placed before motor-2 on 2026-11-01) |
| `motor-2` — Tasks within the owner's bounds, shown beside the conversation | Tasks stop softly or at once, wait in a queue and survive a core restart; the agent sets a task's profile and a task asks for more within the owner's ceilings; tasks show in the right panel while the conversation stays replies; the old Motor Cortex is gone | `docs/charters/motor-1.md` (moved there on its closure, 2026-11-01) |
| `observability-2` — The platform watches its own health | The loader watches the cluster and tells the owner which part is unhealthy and why, with a notification; machine and cluster metrics are kept on the machine and the agent reads its own footprint from them; a small supervisor outside the cluster watches k3s and the machine | lifemodel-7514, lifemodel-sw1s, lifemodel-ahrm (owner, 2026-11-01) |
| `generations-1` — A commit becomes a generation | Changed modules are built in the cluster and replaced one by one; a format-breaking commit is refused; a broken generation reverts itself with a report; panic holds across restarts | ADR-010; containers switched as Kubernetes does (owner, 2026-10-11) |
| `self-change-1` — It changes itself on request | The owner asks in the web interface and lifemodel changes its own code in a task, applies it as a generation and reports | ADR-006 |
| `upstream-1` — The instance lives next to upstream | An instance takes upstream updates by a three-way merge behind the gates; the owner's fork is its personal remote; it proposes its own changes to upstream as pull requests without its owner's data | razzant/ouroboros (managed updates) |
| `evolution-1` — It decides on its own | Pressure, repeated failures and reflection start a self-change without a request; the owner's development process (tracker, roles, review) runs inside the agent | ADR-006 C; ADR-009 |
| `memory-1` — Memory behind a port | Our own memory moves behind a port with a tick cache: facts superseded over time, hybrid search, structured records in Postgres | `docs/research/memory-service.md` (option E) |
| `dialogue-1` — Live dialogue | The owner writes during a turn and the agent takes it into account; `/stop` interrupts a turn; messages survive restarts; Telegram returns on the container shape | ADR-007 |
| `platform-1` — Hardening, when needed | A cutover without a pause, an LLM gateway that meters spend, stronger per-task isolation (microVMs where KVM exists) — each added when real use hits its limit | ADR-006 B, D, E |

Why this order: evolution is the point, so the first milestone delivers it end
to end with the least machinery that still makes a change cheap to undo;
everything else is added where the running agent shows it is missing.

Where the target machine lives is a deployment decision, separate from
these milestones; milestone checks run in a development test environment.
