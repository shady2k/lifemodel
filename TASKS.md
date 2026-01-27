# Implementation Tasks

Tracking implementation progress for the Human-Like Proactive AI Agent.

---

## Phase 1: Project Setup

- [ ] Initialize Node.js + TypeScript project
- [ ] Set up tsconfig with strict mode (`strict: true`, `noUncheckedIndexedAccess`, etc.)
- [ ] Set up ESLint with strict rules (@typescript-eslint/strict)
- [ ] Set up Prettier for formatting
- [ ] Set up Husky + lint-staged for pre-commit hooks (type check + lint)
- [ ] Add Pino + pino-pretty for logging
- [ ] Create folder structure:
  - `src/core/` — event loop, logging, metrics
  - `src/plugins/` — core plugins (rules, storage, llm-providers, channels)
  - `src/types/` — shared interfaces
- [ ] Create data folder structure (for local dev):
  - `data/plugins/` — external plugins
  - `data/state/` — agent state
  - `data/config/` — configuration
  - `data/logs/` — log files
- [ ] Add npm scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `format`
- [ ] Set up tsx for development with watch mode

## Phase 2: Core Infrastructure

- [ ] Define core interfaces:
  - `Plugin`, `PluginManifest`, `PluginContext`
  - `Intent` types
  - `Event` types
  - `EventQueue` interface
  - `Metrics` interface (no-op for MVP)
- [ ] Implement manual DI container (`createContainer`)
- [ ] Implement logging setup (Pino, file rotation, max 10 files)
- [ ] Implement circuit breaker utility
- [ ] Implement `InMemoryEventQueue`
- [ ] Implement `NoOpMetrics`

## Phase 3: Core Agent

- [ ] Implement AgentState interface
- [ ] Implement AgentIdentity (hardcoded for MVP)
- [ ] Implement Energy model (drain/recharge)
- [ ] Create Agent class (receives dependencies via constructor)

## Phase 4: User Model

- [ ] Implement User interface
- [ ] Time-of-day based energy estimation
- [ ] Availability belief with confidence

## Phase 5: Event System

- [ ] Define Event interface (source-based: communication, thoughts, internal, time)
- [ ] Define Priority enum (CRITICAL, HIGH, NORMAL, LOW, IDLE)
- [ ] Implement PriorityQueue (higher priority first, FIFO within same priority)
- [ ] Implement EventBus (pub/sub with priority)
- [ ] Implement overload handling:
  - Aggregation (merge similar events within time window)
  - Drop by age + priority
  - Emergency drop by priority
- [ ] Implement tick loop (heartbeat, never stops)
- [ ] Implement dynamic tick rate based on agent state (alert/normal/relaxed/sleep)
- [ ] Implement sleep mode with disturbance accumulation
- [ ] Implement wake-up mechanism (CRITICAL wakes immediately, accumulated LOW can wake)
- [ ] Energy modulates wake threshold

## Phase 6: Processing Layers

- [ ] Define Layer interface and LayerResult
- [ ] Define Thought interface
- [ ] Implement Layer 0: REFLEX (mechanical events, no understanding)
- [ ] Implement Layer 1: PERCEPTION (parse, extract structure)
- [ ] Implement Layer 2: INTERPRETATION (intent, sentiment — heuristics for MVP)
- [ ] Implement Layer 3: COGNITION (belief updates, memory, thoughts — LLM when needed)
- [ ] Implement Layer 4: DECISION (should act? threshold checks)
- [ ] Implement Layer 5: EXPRESSION (compose output — LLM)
- [ ] Implement confidence-based hoisting
- [ ] Implement PatternAccumulator (frequency triggers awareness)
- [ ] Wire layers into event processing pipeline

## Phase 7: Plugin System

- [ ] Implement plugin loader (priority: /data first, src/plugins fallback)
- [ ] Implement plugin watcher for hot reload (dynamic import)
- [ ] Implement reload strategy (queue-based with rollback)
- [ ] Implement worker thread manager for LLM/channel plugins

## Phase 8: Rules Engine

- [ ] Define Rule interface (returns Intent[], no direct mutation)
- [ ] Implement RuleEngine (collects intents, validates, applies)
- [ ] Create default rules as core plugins:
  - Social debt increases over time
  - Task pressure from pending items
  - Night suppression

## Phase 9: Threshold & Decision

- [ ] Implement neuron-like pressure calculation
- [ ] Threshold-based contact decision
- [ ] Integrate with event loop and intent system

## Phase 10: LLM Integration

- [ ] Define LLMProvider interface
- [ ] Implement OpenRouterProvider as core plugin (runs in worker)
- [ ] Add retry + circuit breaker
- [ ] Message composition logic

## Phase 11: Telegram Channel

- [ ] Implement TelegramChannel as core plugin (runs in worker)
- [ ] Send/receive messages
- [ ] Add retry + circuit breaker
- [ ] Connect to agent via events

## Phase 12: Storage (MVP)

- [ ] Define Storage interface
- [ ] Implement JSONStorage as core plugin
- [ ] State persistence between restarts
- [ ] Add retry + circuit breaker

## Phase 13: Configuration

- [ ] Implement config loader (JSON from /data/config/)
- [ ] Environment variable handling for secrets
- [ ] Runtime config updates (prepare for UI integration)

## Phase 14: Integration & Test

- [ ] Wire everything in index.ts via DI container
- [ ] Manual test: observe agent behavior
- [ ] Iterate based on "feel"

---

## MVP Checklist

Cross-reference with CLAUDE.md "Must Have" items:

| MVP Requirement | Phase |
|-----------------|-------|
| Agent with energy and basic state | Phase 3 |
| User model (belief) | Phase 4 |
| Dynamic tick rate | Phase 5 |
| Processing layers (brain-like) | Phase 6 |
| Simple rules (2-3 hardcoded) | Phase 8 |
| Threshold-based contact decision | Phase 9 |
| Telegram integration | Phase 11 |
| One LLM for composing messages | Phase 10 |

---

## Architecture Checklist

| Decision | Phase |
|----------|-------|
| Manual DI | Phase 2 |
| Pino logging | Phase 2 |
| Circuit breakers | Phase 2 |
| Processing layers | Phase 6 |
| Plugin system with hot reload | Phase 7 |
| Intent-based state mutation | Phase 8 |
| Worker threads for LLM/channels | Phase 7, 10, 11 |
| Event queue abstraction | Phase 2 |
| Metrics abstraction | Phase 2 |
