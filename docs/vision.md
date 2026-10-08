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
  lifemodel ships only as a Docker image, the same for everyone.

## Roadmap

The path leads to evolution first: the thinnest end-to-end version in which the
agent changes itself without a human step, then layers added where real use
shows they are needed. Only the current milestone is broken down into work; the
next one exists as feature titles; the rest lives here. Status comes from the
tracker, never from this page.

| Milestone | What becomes possible | Design |
|---|---|---|
| `instance-1` — Your own lifemodel that changes itself | A person starts their own instance from the Docker image; the owner asks in Telegram and lifemodel changes its own code, applies it and reports; a broken change reverts itself. Restart without loss, gates, an up-to-date map of the code, the image with a supervisor, the change-yourself tool | ADR-006 (simplified: git, restart and a supervisor instead of generations and cutover); razzant/ouroboros for the instance shape |
| `upstream-1` — The instance lives next to upstream | An instance takes upstream updates by a three-way merge behind the gates; the owner's fork is its personal remote; it proposes its own changes to upstream as pull requests without its owner's data | razzant/ouroboros (managed updates) |
| `evolution-1` — It decides on its own | Pressure, repeated failures and reflection start a self-change without a request; the owner's development process (tracker, roles, review) runs inside the agent | ADR-006 C; ADR-009 |
| `memory-1` — Memory behind a port | Our own memory moves behind a port with a tick cache: facts superseded over time, hybrid search, structured records in SQLite | `docs/research/memory-service.md` (option E) |
| `dialogue-1` — Live dialogue | The owner writes during a turn and the agent takes it into account; `/stop` interrupts a turn; messages survive restarts | ADR-007 |
| `platform-1` — Hardening, when needed | Generations and a cutover without a pause, an LLM gateway that meters spend, bubblewrap isolation per run — each added when real use hits its limit | ADR-006 B, D, E |

Why this order: evolution is the point, so the first milestone delivers it end
to end with the least machinery that still makes a change cheap to undo;
everything else is added where the running agent shows it is missing.

Where the target machine lives is a deployment decision, separate from
these milestones; milestone checks run in a development test environment.
