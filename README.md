<div align="center">

# 🧠 lifemodel

### A digital human, not a chatbot.

**A human-like, proactive AI agent whose architecture mirrors the human body — senses, neural impulses, brain regions, a heartbeat, and physiology.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/tested%20with-vitest-6E9F18.svg?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Code style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io/)

</div>

---

## What is this?

Most "AI agents" are request/response loops: you send a message, the model replies, nothing happens in between. **lifemodel is built the other way around.** It runs continuously, *feels* internal and external pressure building up over time, and **decides on its own when to think, act, or reach out to you** — the same way a person does.

The guiding metaphor is the human body, taken seriously as an engineering constraint:

| Body | lifemodel |
|------|-----------|
| 👂 Senses | **Inbound stream** (gateway adapters are separate) |
| ⚡ Neural impulses | **Signals** (one unified data model for everything) |
| 🧠 Brain regions | **Layers** (autonomic → aggregation → cognition) |
| ❤️ Heartbeat | **CoreLoop** (a fixed 1-second tick) |
| 🔋 Physiology | **Energy & state** (thinking is expensive; resting is free) |
| 💪 Motor function | **Motor Cortex** (sandboxed code execution & tools) |

This isn't just naming. The metaphor drives real architectural decisions — energy conservation, emergence over polling, and layered processing where cheap reflexes run constantly and expensive reasoning only wakes up when it's truly needed.

---

## ✨ Highlights

- **🔋 Energy-conserving cognition.** Every tick runs free, zero-LLM "autonomic" and "aggregation" layers. The expensive LLM-powered **cognition** layer only wakes up when accumulated pressure crosses a threshold (or you message it directly). No wasteful polling, no burning tokens to do nothing.
- **🌱 Emergence over polling.** The agent doesn't run on timers asking "should I do something now?". State *accumulates*, pressure builds, and actions **emerge** when thresholds are crossed — proactive messages, thoughts, reminders.
- **⚡ Signals, not events.** Everything that flows through the system — an inbound message, an internal urge, an overdue commitment — is a single unified `Signal` type. One model for all data flow.
- **🧠 Two-speed thinking (System 1 + System 2).** A cheap **fast model** handles classification and quick reactions; an expensive **smart model** is escalated to only on low confidence (and only when it's safe to retry). Inspired by Kahneman's dual-process theory.
- **💪 Sandboxed Motor Cortex.** When the agent needs to *act* (run code, fetch data, use a skill), it dispatches to a separate agentic runtime that executes inside **per-run Docker containers** — `--read-only`, `--network none`, `--cap-drop ALL`, strict resource limits. Results flow back as signals.
- **🗂️ Dual-layer long-term memory.** A **vector store** (semantic recall, salience decay) backed by [LanceDB](https://lancedb.com/) combined with a **graph store** (entities, relations, spreading activation) for associative context.
- **🧩 Strictly-isolated plugin system.** Core *never* imports plugin types. Plugins extend the agent (neurons, channels, tools, providers, filters) only through a small `PluginPrimitives` API.
- **📜 Agent Skills standard.** Skills declare their own dependencies (`npm` / `pip` / `apt`) and are loaded into the sandbox with content-addressed dependency caching.

---

## 🏗️ Architecture

### The 3-Layer Brain

Signals enter through channels and flow up through progressively more expensive layers. Most ticks never reach the top.

```mermaid
flowchart TD
    GW["📥 Inbound stream<br/>— gateway input"] -->|Signals| AUT

    subgraph BRAIN [" "]
        direction TB
        AUT["🧬 AUTONOMIC LAYER<br/>Neurons monitor state · Weber–Fechner change detection<br/><b>Zero LLM cost · like the brain stem</b>"]
        AGG["🔀 AGGREGATION LAYER<br/>Buckets signals · detects patterns · habituation/deferral<br/>Decides: wake COGNITION?<br/><b>Zero LLM cost · like the thalamus</b>"]
        COG["💡 COGNITION LAYER<br/>Fast model first (System 1) · smart retry if uncertain<br/>Deep reasoning only when needed<br/><b>LLM cost · like System 1 + 2</b>"]
        AUT --> AGG
        AGG -->|only if threshold crossed| COG
    end

    COG -.->|core.act| MC["💪 Motor Cortex<br/>Sandboxed agentic runtime<br/>(Docker-isolated code & tools)"]
    MC -.->|motor_result signal| AUT
```

> Most ticks: only **autonomic** and **aggregation** run. **Cognition** wakes for user messages or threshold crossings. The smart (expensive) model is used only on retry — when confidence is low *and* it's safe to retry.

### The Heartbeat (CoreLoop)

A fixed **1-second tick** drives everything:

1. Collect signals from channels (sensory input)
2. Update **thought pressure** & **desire pressure** from memory
3. Check overdue **commitments** and **predictions** → emit signals
4. **Autonomic** layer: neurons emit internal signals
5. **Aggregation** layer: collect, aggregate, decide wake threshold
6. **Cognition** layer (only if woken): process with the LLM
7. Apply the intents returned by all layers

### The Agentic Loop (Cognition)

Cognition uses **native OpenAI tool-calling** with *Codex-style natural termination* — the model stops calling tools when it's done; there's no mandatory "final" tool. It supports smart escalation (`core.escalate`), smart retry on low confidence, and proactive deferral (`core.defer`) so the agent can choose *not* to interrupt you right now.

📖 Full details: **[`docs/architecture.md`](docs/architecture.md)**

---

## 🚀 Quick Start

### Prerequisites

- **Node.js ≥ 24**
- **Docker** — required for the Motor Cortex's agentic (code-executing) runs
  and for the isolated test boundary (see [Test isolation](#-development))
- An OpenAI-compatible endpoint with a model per role — LM Studio, Ollama, vLLM, [OpenRouter](https://openrouter.ai/), …

### Install & run

```bash
# 1. Clone
git clone https://github.com/shady2k/lifemodel.git
cd lifemodel

# 2. Install dependencies
npm install

# 3. Configure environment (see below)
cp .env.example .env   # then edit .env

# 4. Run in development (hot-reload via tsx)
npm run dev

# — or build & run for production —
npm run build
npm start
```

The supported deployment is the k3s platform. See the [platform installation guide](deploy/nixos/README.md).

### Configuration

lifemodel is configured via a `.env` file. The essentials:

| Variable | Description |
|----------|-------------|
| `TZ` | Your timezone (e.g. `Europe/Moscow`) |
| `LOG_LEVEL` | `info`, `debug`, … |

<details>
<summary><b>The model endpoint — the only model configuration</b></summary>

Any OpenAI-compatible server works (LM Studio, Ollama, LocalAI, vLLM), and the
endpoint carries no key of its own — a server that needs one is reached through
Agent Vault, which injects it. This endpoint is the only model configuration
there is: there is no separate keyed provider surface to fall back to. The
endpoint and its models are lifemodel's own
settings: they are set in lifemodel's settings interface (`docs/features/instance/settings.md`) or in a checkout with these environment variables, which name the same fields:

| Variable | Description |
|----------|-------------|
| `LLM_ENDPOINT_BASE_URL` | Base URL of the endpoint (e.g. `http://localhost:1234/v1`) |
| `LLM_ENDPOINT_FAST_MODEL` | The model for the *fast* role (classification) |
| `LLM_ENDPOINT_SMART_MODEL` | The model for the *smart* role (reasoning, composition) |
| `LLM_ENDPOINT_MOTOR_MODEL` | The model for the *motor* role (Motor Cortex) |

There is no second endpoint and no fallback: a role the endpoint does not name
is refused with an error naming that role, never answered with a different
endpoint or another role's model. No key is ever set here — a server that needs
one is reached through Agent Vault, which injects it.

</details>

<details>
<summary><b>Optional: web search providers</b></summary>

| Variable | Description |
|----------|-------------|
| `SERPER_API_KEY` | [Serper](https://serper.dev/) API key |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com/) API key |
| `SEARCH_PROVIDER_PRIORITY` | Provider fallback order |

</details>

---

## Deployment

The core image requires an x86-64-v2 CPU or newer for memory search. On a VM, set the vCPU type to `host` or to an x86-64-v2 model; the hypervisor default `Common KVM processor` / `qemu64` may expose only x86-64-v1. `lifemodel doctor` warns when `/proc/cpuinfo` lacks the `sse4_2` or `popcnt` flags, because memory search may fail to load.

The supported deployment target is the k3s platform installed through the
NixOS module or the generic Linux installer. See the
[platform installation guide](deploy/nixos/README.md) and
[ADR-010](docs/adr/010-container-generations.md). The standalone core image is
built by `scripts/build-core-image.sh` for platform use; the former Docker-run
instance image is not supported.

---

## 🧩 Plugins

Capabilities are added through strictly-isolated plugins — neurons (monitor state), channels (senses), tools (cognition capabilities), providers (external services), and filters (signal transformation).

| Plugin | Type | What it does |
|--------|------|--------------|
| `reminder` | tool | Natural-language reminders with recurrence |
| `thoughts` | neuron | Builds **thought pressure** from accumulated unprocessed thoughts |
| `social-debt` | neuron | Builds **social pressure** from lack of interaction |
| `calories` | tool + neuron | Tracks food, calories & weight with proactive deficit monitoring |
| `news` | tool + filter | Fetches & filters news articles by your interests |
| `web-search` / `web-fetch` | tool | Search the web and fetch/clean page content |

📖 Plugin model & API: **[`docs/plugins/overview.md`](docs/plugins/overview.md)**

---

## 📚 Documentation

The codebase is heavily documented. Start here:

- **[Architecture](docs/architecture.md)** — the 3-layer brain, CoreLoop, the agentic loop, project structure
- **Concepts** — [Signals](docs/concepts/signals.md) · [Intents](docs/concepts/intents.md) · [Energy](docs/concepts/energy-model.md) · [Memory](docs/concepts/memory.md) · [Soul](docs/concepts/soul.md) · [Conversation history](docs/concepts/conversation-history.md)
- **Features** — [Thinking](docs/features/thinking.md) · [News](docs/features/news.md) · [Reminders](docs/features/reminders.md) · [Commitments](docs/features/commitments.md) · [Desires](docs/features/desires.md) · [Social debt](docs/features/social-debt.md) · [Motor Cortex](docs/features/motor-cortex/design.md)
- **Plugins** — [Overview](docs/plugins/overview.md) · [Neurons](docs/plugins/neurons.md) · [Channels](docs/plugins/channels.md)
- **[Architecture Decision Records](docs/adr/)** — the *why* behind key choices

---

## 🛠️ Tech Stack

**Language & runtime:** TypeScript (strict, ESM) on Node.js ≥ 24
**LLM:** [Vercel AI SDK](https://sdk.vercel.ai/) · OpenAI-compatible providers
**Memory:** [LanceDB](https://lancedb.com/) (vector store) + a custom graph store · [Transformers.js](https://huggingface.co/docs/transformers.js) embeddings
**Sandbox:** Docker-isolated runtime + IPC
**Infra:** [Fastify](https://fastify.dev/) · [Pino](https://getpino.io/) logging · [Zod](https://zod.dev/) validation · [Luxon](https://moment.github.io/luxon/) time

---

## 🧪 Development

```bash
npm run dev          # run with hot reload (tsx)
npm run build        # compile TypeScript → dist/
npm start            # run the compiled build

npm test             # isolated unit and ordinary integration tests
npm run test:docker  # retained backend; heavy image acceptance is CI-only
npm run test:watch   # unsupported — see Test isolation below

npm run check        # typecheck + lint + format + suite, via the isolated launcher
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier --write
```

Tests live under `tests/` (unit, integration, helpers) — never inside `src/`. Pre-commit hooks (Husky + lint-staged) enforce lint & formatting on staged files, then run the product checks through the isolated launcher.

### Test isolation

Local and ordinary CI suites never start on the host. `npm test` and `npm run check` start
`scripts/test-isolated.mjs`, which runs the checks and the suite one-shot and
bounded inside a disposable Node 24 container built from a selective snapshot
of the tree. Real Kubernetes server-side apply ownership transitions are accepted
against `managedFields` on the owner's VM; the local installer double does not
emulate an API server. The run never sees your `.env`, your `data/` state, your git
credentials or your Docker daemon — nothing of your checkout is bind-mounted
and no Docker socket is mounted — and the launcher stops and removes the
containers it started when the run ends, fails, times out or is interrupted
(a hard kill leaves a container that the next run prunes and reports).

Prerequisites for tests and checks: **Node.js ≥ 24 and Docker**. Watch mode is
explicitly unsupported (`npm run test:watch` explains why and exits): run a
bounded one-shot suite instead, e.g.
`node scripts/test-isolated.mjs test -- tests/unit/energy-management.test.ts`.
Ordinary checks use an offline, non-root Node 24.21.0 container (2 CPUs,
3 GiB memory, no extra swap, 256 processes). Its root is read-only; temporary
writes use capped memory-backed filesystems. Dependencies are installed inside
a container and cached. Per-run containers and source images are removed after
success, failure, timeout or interruption. The default deadline is 25 minutes.

`docker` mode uses a private rootless daemon in a disposable OrbStack machine
on macOS: no Mac mounts, no SSH forwarding, and network isolation from the host
and other machines. Its limits are 2 CPUs, 4 GiB memory and 32 GiB disk. OrbStack
shares a Linux kernel; it is not a hardware VM. Missing or unsupported backends
fail closed, never to your socket or a privileged fallback. CI runs ordinary
checks through the same launcher with GitHub's disposable Docker daemon.

CI builds the standalone core image separately; it does not run tests directly on the host.


