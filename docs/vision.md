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
- Not a product for other people.

## Roadmap

Five directions, delivered as milestones in this order. Only the current
milestone is broken down into work; the next one exists as feature titles;
the rest lives here. Status comes from the tracker, never from this page.

| Milestone | What becomes possible | Design |
|---|---|---|
| `platform-1` — Lives on a VM | A new version rolls out with one command and a sub-second gap and rolls back in a minute; the owner's controls (panic, limits, autonomy) live outside the agent | ADR-006, stage 1 |
| `dialogue-1` — Live dialogue | The owner writes during a turn and the agent takes it into account; `/stop` interrupts a turn; messages survive restarts and cutovers | ADR-007 |
| `hands-1` — Hands without Docker | Agentic tasks run in prime-agent under bubblewrap, network through the allowlist proxy | ADR-006, stage 2 |
| `memory-1` — Memory with history | Every memory write knows its generation; writes of a bad generation are found and reverted; the tick no longer walks the whole memory | ADR-008, M1–M3 |
| `evolution-1` — The agent changes itself | Signal recording and replay, the evolution loop, the owner's development process inside the agent; autonomy raised to `full` under a charter | ADR-006, stages 3–4; ADR-009, E1–E3 |
| `maturity-1` — Maturity | The trusted layer outside evolution (loader, LLM gateway, proxy, memory journal, tracker and checks) consolidated into one platform with one update path; Hindsight as a second memory loop if a benchmark justifies it; owner verdicts and forks | ADR-008, M4; ADR-009, E4 |

Why this order: without the loader and generations there is nothing to evolve
and nowhere to roll back to; memory must survive rollbacks before the agent may
change itself; dialogue gives value on the current deployment and supplies the
graceful end of a turn that a cutover needs.

Where the target deployment VM lives is a deployment decision, separate from
these milestones; milestone checks run in a development test environment.
