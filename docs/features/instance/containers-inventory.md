# Containers inventory — the existing shape and its quality drivers

Status: source-only inventory and quality-attribute drivers for container
generations; no design and no options chosen here — that is the next task.
Change: lifemodel-b0r.9.1. AMENDED 2026-10-12 (platform decision,
lifemodel-b0r.9.11): the target platform is k3s + GitOps (Flux,
CloudNativePG, Traefik, OpenBao's official chart, NetworkPolicy, RBAC, the
generation operator) — the F*/Q* rows below carry inline AMENDED notes where
the platform changed the driver's mechanism; the drivers themselves are
unchanged. The historical FACTs (today's loader, Docker, source lines) are
untouched. Base: worktree design/b0r-containers-inventory at
`8864655` (branch design/b0r-containers-inventory). Every claim is marked
FACT (cited `path:line`, read at this HEAD) or INFERENCE (labeled). Doc
citations describe accepted behavior, not code.

Input the inventory serves (fixed owner decision, docs/charters/instance-1.md:30-51):
the existing loader, extended not rewritten, runs in its own container as the
only one with Docker access and starts each generation of lifemodel as its own
container beside the running one — liveness/readiness probes, epoch switch,
health window (completed work, not a live process), rollback with a report,
maintenance mode. Valkey holds the event bus (streams) and ONE current tick
snapshot, committed atomically with an epoch check, fsync on every write.
Postgres with pgvector holds memory and configuration (no shared folder).
OpenBao beside Agent Vault issues credentials. The tick is the only boundary:
async results arrive on the bus and are handled by later ticks. A planned
switch lets the old generation finish its tick and leave; the new one continues
from the current snapshot. Greenfield — no data to migrate. The core is not cut
into modules now. The channel is a web interface; Telegram is out. Reversible
format migrations and "refuse when uncertain" carry over.
(PENDING CHARTER AMENDMENT — R3-24: this paragraph quotes the charter's
superseded prescriptions. The owner's decisions of 2026-10-12 and ADR-010 as
rewritten decide the opposite shape: greenfield stands, but "the core is not
cut into modules" is superseded — the rewrite already splits core/executor/
intake/adapter/functions/door — and "reversible format migrations" is
superseded by expand/contract with no down path. Do not plan from this
paragraph; plan from the decisions and the rewritten ADR.)

Reading guide: section 1 inventories what exists and where the decision puts
each piece of mutable state; section 2 is what the tick holds and what spans
ticks; section 3 states the functional requirements; section 4 the quality
scenarios with measures; section 5 the constraints. Two superseded source
reports (generations-lifecycle-source.md, generations-containment-source.md,
base `30b9627`, 22 commits behind) were used as reading guides only — every
line number below was re-read at this HEAD (several had moved; e.g.
`recoverOnRestart` was container.ts:1113-1117 then, is container.ts:1114-1117
now; `RESTART_EXIT_CODE` is src/settings/restart.ts:16).

---

## 1. Inventory: building blocks, their state, and what the change touches

### 1.1 The trusted layer today (loader + image)

| Piece | State it owns today (citations) | Where the decision puts it |
|---|---|---|
| Loader process (container main under tini; ENTRYPOINT node /opt/lifemodel/loader/dist/main.js, docker/instance/Dockerfile:152) | supervises EXACTLY ONE lifemodel child: `node <repoDir>/dist/index.js` as uid 1000 (loader/src/supervisor.ts:323, :170-173); process state machine stopped/starting/running/stopping/failed (supervisor.ts:48, :143-163); restart backoff 1 s..30 s reset after 60 s healthy run (loader/src/config.ts:175); exit 75 = immediate restart, not a failure (supervisor.ts:46, :219-227); stop = SIGTERM, drain min(95 s, budget-left minus 5 s), SIGKILL, reap, within ONE 110 s budget (loader/src/config.ts:171-173; supervisor.ts:433-481) | loader-owned; extended to start generation CONTAINERS instead of (or beside) the child process — the loader has NO Docker-controlling code today (grep clean over loader/src; the only docker mentions are stop-semantics comments, supervisor.ts:17, :374; INFERENCE labeled in the runtime findings) |
| `epoch` fields | three exist — supervisor.ts:154 (bumped :394), front-door.ts:51, agent-vault.ts:198 — in-memory restart-race guards only: not persisted, not exposed, no switching semantics | the charter's generation epoch is NEW machinery; today's counters are only naming precedent |
| Panic | root-only `panic.json` on the volume (loader/src/state.ts:24-25, :63-66); blocks every start (supervisor.ts:300-316); survives container and Docker-daemon restarts (docs/features/instance/loader.md:64-65) | loader-owned, unchanged |
| Build (loader/src/repo.ts) | seeds once from /opt/lifemodel/seed.bundle, `npm ci`+`npm run build` as uid 1000 through the vault proxy, 20-min timeout (config.ts:174), verifies only that the entry exists, records ONE `builtCommit` in `<volume>/loader/state.json` (repo.ts:284-289; state.ts:28-32); `dist/` overwritten in place — no artifact/version store | loader-owned; the generation decision needs a per-generation build/publish story this inventory does not design |
| Loader durable files | four root-only 0600 files in `<volume>/loader/`: auth.json, panic.json, cli-token, state.json (state.ts:8-11, :24-25, :63-66) — atomic temp+rename, no fsync, version 1, no migrations | loader-owned; the design requires these record writes power-loss durable — fsynced temp contents, atomic rename, fsynced parent directory — before any dependent action, and rename alone is never treated as durability (R4-09) |
| Agent Vault (loader/src/agent-vault.ts) | passwordless store `<volume>/vault` 0700; API 127.0.0.1:14321, MITM proxy 127.0.0.1:14322; lifemodel's process receives ONLY the proxy env over a named allowlist (agent-vault.ts:766-798; loader/src/env-boundary.ts:27-75 strips OPENROUTER_API_KEY and AGENT_VAULT_MASTER_PASSWORD by name) | Agent Vault stays; OpenBao is ADDED beside it (charter :40-41) — neither exists in lifemodel's own code today |
| Egress (loader/src/egress.ts) | chain LIFEMODEL_EGRESS confines uid 1000 to 127.0.0.1:14322, 127.0.0.1:7000 and the nat-rewritten resolver port; REJECT otherwise; IPv6 half over ::1; needs --cap-add NET_ADMIN; installed before uid 1000 runs (egress.ts:36, :358-385) | loader-owned; any NEW loopback service (a bus or store port) must join the named allow set or sit behind a root-side owner (FACT of the rule's closed set; the design decides) |
| Front door (docker/instance/Caddyfile, loader/src/http.ts) | Caddy :80 (published 127.0.0.1:8080), three pinned hosts -> 7000/7100/14321, every request forward_auth to GET /_auth/verify (Caddyfile:53-106); owner UI = ONE dashboard page: state/commit/panic/restarts/lastError + the vault account + Panic/Resume/Logout (http.ts:263-284, :560-585 CLI API) | loader-owned; operability baseline for the generations UI (scenario Q10) |
| Probes / health / maintenance | NO probe endpoints, no HEALTHCHECK, no readiness concept, no maintenance mode anywhere in the loader or image (FACT of absence, grep; Agent Vault's /health is the only health check, agent-vault.ts:372-384; a start is "healthy" only by surviving healthyRunMs, supervisor.ts:230) | all NEW: liveness/readiness probes, health window, rollback, maintenance mode have no existing loader-side implementation |
| Instance image | node:24-bookworm-slim + tini, git, iptables, netbase, curl, Caddy 2.11.7, Agent Vault 0.40.0, the seed bundle; ONE volume /var/lib/lifemodel with fixed layout repo/ data/ loader/ vault/ (Dockerfile:27-152, :142; config.ts:190-212) | image-owned pieces stay image; NO docker CLI in the image (Dockerfile:77-86) and the documented run mounts no socket (README.md:189-197) — so lifemodel-in-a-container already has no Docker path |

### 1.2 lifemodel's construction and stop (src/core/container.ts, src/index.ts)

Construction (`createContainerAsync`, container.ts:477-1257) writes and arms
BEFORE any activity authority exists (FACT; the numbered order with writers is
in the core findings): config load; logger creation WITH log retention deletes
(container.ts:495-505, logger.ts:49-91); `storage.startAutoFlush()` 30 s timer
(container.ts:517); inbound log load (loud refusal on wrong version,
inbound-log.ts:261-267); state/conversation managers load; LanceDB created
lazily; agent + bus; embedder/model cache dir; Motor Cortex wiring;
recipient/ack registries; scheduler service; plugin loading and activation
(writes manifest schedules); core loop created NOT started; motor tools
registered; `motorCortex.recoverOnRestart()` — prunes daemon-wide by age and
resumes persisted runs (container.ts:1114-1117; motor-cortex.ts:1545-1737);
Telegram channel created; inbound replay (network photo re-fetch possible,
container.ts:1153-1186); `storage.flush()`; `stateManager.startAutoSave()`
2-min timer (container.ts:1205). Then src/index.ts starts the settings server
(127.0.0.1:7100, before the loop, src/settings/server.ts:42), the channel
(un-awaited), and `coreLoop.start()` (src/index.ts:45, :79, :83).

Stop: ONE bounded best-effort sequence, `shutdownSequence`
(container.ts:301-353) under `coreLoop.getStopDrainTimeoutMs()` — default
90 s (core-loop.ts:109): intake_stop -> loop_drain (tick, scheduler, the
cognition turn, awaited sends; late intents fenced, core-loop.ts:1073-1131)
-> state_flush (stateManager.shutdown, recipient+ack flush)
-> channel_stop -> storage_flush (`closeDurableWrites()` FIRST then
`storage.shutdown()`, container.ts:347-349). The hard-exit timer armed in
src/index.ts:197-227 enforces the deadline (exit 1, hard-exit.ts); exit 0
graceful, 75 = settings-save restart (src/settings/restart.ts:16).

### 1.3 Mutable state: where it lives today -> where the decision puts it

The storage reader's full 23-family table (writers, timing, atomicity) is the
source of rows 1-23 below. "unclear" = the charter names no home; marked for
the design, not decided here.

| # | Mutable state | Where it lives today | Where the decision puts it |
|---|---|---|---|
| 1 | Event bus | in-memory EventBus, Promise.allSettled fan-out, zero persistence, no ordering (event-bus.ts:45-117); exactly ONE subscriber (typing) | Valkey bus (streams) |
| 2 | Queued internal signals | CoreLoop `pendingSignals` FIFO array, in-memory (core-loop.ts:315, :1230, :1666-1667) | Valkey bus |
| 3 | The event queue class | `InMemoryEventQueue` exists but is DEAD CODE — never wired (event-queue.ts:12-187; grep: no production caller; its comment names "Valkey, Kafka" as the future, event-queue.ts:10; interface comment src/types/event.ts:61-63) | Valkey bus (the seam already anticipated in code) |
| 4 | Tick snapshot (agent state, sleepState, energy mirror) | `state.json` via StateManager, 2-min auto-save + shutdown save (state-manager.ts:23-26, :238-247; envelope persistable-state.ts:35-62) | Valkey snapshot (ONE current tick snapshot, atomic epoch-checked commit) |
| 5 | UserModel (beliefs, `user` in the envelope) | rides inside state.json (state-manager.ts:61-67, :120) | unclear (neither bus nor plainly memory/config) |
| 6 | Conversation history + statuses + completed actions | one JSON per user, whole-file rewrite, deferred (conversation-manager.ts:77-102, :163-165) | Postgres (memory) — but it is conversational state, not vectors; unclear at the margin |
| 7 | Vector memory (LanceDB) | `data/state/memory/vector`, OWN persistence path bypassing DeferredStorage, lazy open, NO close method (lance-vector-store.ts:8-9, :128-169; absence verified at HEAD) | Postgres with pgvector |
| 8 | Memory graph | `graph.json`, one storage key, written only by the consolidator (graph-store.ts:463-474) | Postgres (memory) |
| 9 | Soul (inner life incl. pendingReflections) | `soul.json`, one envelope, write-heavy, deferred (soul-provider.ts:54-59, :927-937) | Postgres (memory); unclear (charter does not name it) |
| 10 | Durable inbound log | `data/state/core/inbound_log.json` — the ONLY awaited-flush-per-write path; envelope v2 with dedup ring (1000) + per-recipient offsets (inbound-log.ts:64-65, :109-124, :612-618) | unclear (a durability/replay log; Valkey stream + offsets or Postgres could both express it; the no-loss/no-double-answer guarantee lives entirely inside this file today) |
| 11 | Recipient registry | `recipient-registry.json`, debounced 1 s (recipient-registry.ts:317, :343-352) | unclear (Telegram out this milestone) |
| 12 | Ack registry | `ack-registry.json`, debounced 500 ms (persistent-ack-registry.ts:21, :37) | unclear (layer state; see section 2) |
| 13 | Plugin enable/disable | `core/disabled_plugins.json` (intent-applicator.ts:1179-1199) | Postgres (configuration) |
| 14 | Plugin keys + schedules | `plugin/<id>/<key>.json`, incl. `schedules` and `fired:<id>` (storage-primitive.ts:50; scheduler-primitive.ts:42-45, :665-694) | Postgres (configuration); schedules are durable state the next generation must reload |
| 15 | Config file (endpoint, models, telegram fields) | `data/config/agent.json`, its OWN DeferredStorage/JSONStorage pipeline, fsync+rename, awaited flush = durability point (config-loader.ts:26, :60-67, :135-141) | Postgres (configuration) explicitly ("no shared folder: the configuration lives in the store") |
| 16 | LLM keys / Telegram token | placeholders or null in config; real credentials only in Agent Vault, injected at egress (config-schema.ts:87-95; settings.md:15-17) | OpenBao issues them; Agent Vault proxy stays |
| 17 | Motor run registry | `motor-runs.json` (ONE DeferredStorage key), save+flush per transition (motor-state.ts:14-15, :65-88) | unclear (results arrive on the bus per charter; the registry itself is not named) |
| 18 | Motor artifacts/workspaces, skills, plugins dirs, ONNX model cache, logs | host/volume filesystem: `data/motor-runs/`, `data/motor-workspaces/`, `data/skills/`, `data/plugins/`, `data/models/`, `data/logs/` (container.ts:694-696, :1092; embedder.ts:35-48; logger.ts:49-91) | image candidate for ONNX weights (same-for-everyone image, charter :15-16) vs first-use download today: unclear; skills/plugins dirs unclear (code-like artifacts vs the git repository); logs unclear |
| 19 | Loader four files + vault store | `<volume>/loader/*` root-only, `<volume>/vault` | loader-owned |
| 20 | Repository (the instance's code) | `<volume>/repo` git clone, dist/ overwritten by build | git repository on the volume (unchanged); generations select commits — no version store exists today (state.json holds ONE builtCommit, state.ts:28-32) |

Concurrency fact that constrains all of the above (FACT): there is NO
inter-process safety in the storage stack — no flock/lock files, no leases, no
writer identity in any file; the only LockService is in-memory for motor
scripts (lock-service.ts:1-13). Two writers on one root = silent
last-rename-wins whole-document clobbering, inbound-log replay corruption
included. The one-process assumption is what the Valkey/Postgres move replaces.

### 1.4 Runtime surfaces the change touches (Motor Cortex, skills, channel)

- ContainerManager is a pure Docker-CLI wrapper (no dockerode, no socket or
  DOCKER_HOST configuration surface): `execFile('docker', ...)` throughout
  (container-manager.ts:74-86, :272-315, :563-575, :639-785); `isAvailable()`
  = `docker info`. Agentic motor runs HARD-require Docker
  (motor-cortex.ts:476-482); scripts return DOCKER_UNAVAILABLE (:353-364);
  degraded workspace-only execution without isolation otherwise
  (motor-tools.ts:1428-1430).
- Its side effects are DAEMON-GLOBAL: labels carry no instance/generation
  identity (types.ts:283-295), prune removes by label+age regardless of owner
  (container-manager.ts:917-1086; script containers regardless of age
  :973-994), volume/image names are fixed global tags. A second Docker-using
  process on one daemon destroys the first's containers — the reason the
  charter gives Docker to the loader alone.
- The motor egress model assumes lifemodel runs on the Docker HOST: per-run
  proxy binds 0.0.0.0 and containers reach it via
  host.docker.internal:host-gateway (egress-proxy.ts:136-146;
  container-manager.ts:396-406, :52-115); the netpolicy helper joins the
  target's netns with NET_ADMIN (network-policy.ts:300-318, :482-500).
  INFERENCE: inside a container without Docker these surfaces degrade or
  refuse — agentic runs, scripts, browser-auth/news scripts; everything else
  in the tick path is Docker-free.
- Skills are host-FS trees with policy.json sidecars (skill-loader.ts:415-424;
  skill-extraction.ts:186-228); dependencies become derived Docker images
  (dependency-manager.ts). Nothing skill-related lives in an external store.
- Telegram (out this milestone, inventoried as-is): polling starts un-awaited
  (src/index.ts:79); stopIntake vs stop are distinct (channel.ts:84-100);
  photo downloads can run during construction via the replay path
  (container.ts:1170-1178); grammY 409 two-consumer behavior is unverified
  from source.

---

## 2. What the tick holds today

### 2.1 Cross-tick in-memory state (must become snapshot or bus state)

CoreLoop fields that live across ticks (core-loop.ts:273-382): `tickCount`
(:281) and the 1 s setTimeout chain (:1239-1247, tickInterval default
core-loop.ts:106); `pendingSignals` FIFO (:315; deferrable signal types
re-queued while COGNITION is busy, :1391); ONE `pendingCognition` (:333) with
`turnCommits` map (:339) + `activeTurnCommits` (:347) deciding the durable
inbound-log outcome; `drainingTurnTickId` (:297), `lateEffectsFenced` (:302),
`durableWritesClosed` (:310) stop-state flags; `inFlightSends` tracked in the
intent applicator (intent-applicator.ts:441-452); `schedulerTickInFlight`
(:364); typing subscription id (:330); previous alertness mode (:327);
`thoughtsThisTick` (:370). Layers: aggregation buckets, pattern history,
thought-dedup cache, threshold-engine wake state, neuron
previousValue/lastEmittedAt, filter/neuron registries — ALL in-memory except
the ack registry (persisted, debounced 500 ms; persistent-ack-registry.ts:21).
Energy is an in-memory EnergyModel mirrored into AgentState and persisted only
by the 2-min auto-save (agent.ts:64, :188; state-manager.ts:25).

### 2.2 What spans ticks today (the set that must become bus events)

| Work | Re-entry today | Survives a stop? |
|---|---|---|
| COGNITION turn (agentic LLM loop, tool rounds) | a LATER tick's checkPendingCognition applies result intents (core-loop.ts:1416-1424, :2025-2068); stop drain applies inline (core-loop.ts:1073-1131); mid-loop immediate intents call the applicator DIRECTLY (core-loop.ts:423-425, :2084-2130) | No: overrun abandons the turn, its inbound entries replay once (core-loop.ts:1078-1081) |
| SEND_MESSAGE chains | promise chains in `inFlightSends`; settlement chains settleTurn -> inboundLog.commit onto the send (core-loop.ts:661-688, :698-759) | the send result decides answered/failed_send only if settled; otherwise replay |
| Scheduler fires | kicked per tick (core-loop.ts:1585-1599); results re-enter ONLY as pushed signals (container.ts:1059-1061); `nextFireAt <= now`, markFired BEFORE emit = at-most-once (scheduler-primitive.ts:330-378) | schedules persist; a fire whose signal was still in memory is lost as a signal but not re-fired |
| Motor runs | `motor_result` signals pushed via callback into the queue (container.ts:1065-1069); runs persist per transition; recoverOnRestart resumes/fails/re-emits (motor-cortex.ts:1545-1737) | run state yes; in-flight progress re-derived from stepCursor; persisted containerId never reattached — fresh container on resume |
| core.schedule SCHEDULE_EVENT timers | plain setTimeout in the intent applicator (intent-applicator.ts:513-521) | No — lost at restart |
| Queued internal signals / reactions | pendingSignals | No — "a schedule firing, a Motor Cortex result or a reaction that was only queued is lost" (container.ts:1188-1190) |
| Inbound user messages | durable inbound log, awaited flush at EMIT time, replay once at start (inbound-log.ts:612-618; container.ts:1153-1186) | Yes — the only durable async path |

INFERENCE (labeled): the bus-event conversion set is exactly the re-entry rows
above — cognition results, send settlements, scheduler/motor signal pushes,
schedule timers — plus the queued-signal backlog; the snapshot must carry the
cross-tick fields of 2.1 whose loss would change behavior (buckets, wake
state, neuron transitions, turn bookkeeping), and the code's own comments name
what is deliberately recomputable today (container.ts:1188-1192).

### 2.3 What writes to disk during a tick today

Every writer below runs while the loop ticks (trigger -> path): DeferredStorage
30 s auto-flush -> every dirty key under data/state (deferred-storage.ts;
container.ts:517); StateManager 2-min auto-save -> state.json
(state-manager.ts:75-88); inbound log record/commit -> awaited
save+flush per message/outcome (inbound-log.ts:612-618); conversation saves ->
deferred per mutation (conversation-manager.ts:261, :339, :516, :657, :828);
soul persist -> deferred per mutation (soul-provider.ts:927-937); schedule
mutations -> deferred immediately (scheduler-primitive.ts:691-694); pino
logger -> data/logs per line from a worker thread that cannot be fenced
(logger.ts:18-25, :164-180); conversation logger -> per LLM block
(logger.ts:227-258); LanceDB memory writes -> own path, immediate
(lance-vector-store.ts:8-9); skill policy writes -> atomic per skill dir
(skill-loader.ts:415-424). The snapshot design inherits exactly this write set.

---

---

## 3. Functional requirements (from the charter; not re-argued)

### 3.1 Outcome 5's check, verbatim anchors (docs/charters/instance-1.md:78-90)

The DONE WHEN of outcome 5, decomposed into checkable requirements:

| # | Requirement | Charter line |
|---|---|---|
| F1 | The loader, in its own container, starts generation N+1 as a container beside running generation N  AMENDED (2026-10-12, simplification point 1): the unit of replacement is the MODULE — the loader replaces only the modules whose image tag changed, ONE BY ONE in manifest order; the rest of the running set is untouched  AMENDED (2026-10-12, platform decision): the controller is the GENERATION OPERATOR in-cluster; the unit's image arrives from the operator's in-cluster BuildKit build into the local registry (tag = build-input hash), and the replacement is gated per module through its HelmRelease, applied by Flux. | :81-82 |
| F2 | N+1 passes its readiness probe; then the epoch switches  AMENDED (2026-10-12, simplification point 1): readiness is PER MODULE; the epoch switches ONLY at the core's stop-first replacement, after the old core's exit is confirmed — never during a keyed-writer module's start-first replacement  AMENDED (2026-10-12, platform decision): the confirmed exit is a CONFIRMED POD TERMINATION, the probe is the Kubernetes readiness probe, and the NEW CORE takes the epoch itself (the Lua CAS) with the operator verifying the post-conditions. | :82-83 |
| F3 | The conversation continues from the current snapshot with no message lost and none answered twice | :83-84 |
| F4 | A generation that never becomes healthy is replaced, without the owner, by the previous healthy one, with a report  AMENDED (2026-10-12, simplification point 1): the previous commit's DESIRED STATE, module by module, on CURRENT data; health is PER MODULE (each module's own done records), not one generation-wide verdict  AMENDED (2026-10-12, platform decision): the desired state lives in the deploy branch and the restore is its git revert, applied by Flux; health is read by the operator with its cross-schema health role. | :84-85 |
| F5 | In the controller's maintenance mode the owner can boot an older generation AMENDED (2026-10-12, platform decision): maintenance is durable CLUSTER state (the lifemodel releases suspended, the workloads scaled to zero), held in the operator's web UI; the boot is owner-commanded through the same gated machinery  AMENDED (2026-10-12, owner decision 3): the boot works within the compatibility window; older generations REFUSE with the reason when data or contracts are newer than they read; "brought back by a breaking migration" is dropped - there are no down migrations  AMENDED (2026-10-12, simplification point 5): the compatibility window is decided from FILES and the stores' stamped versions at the boot's own rollout — the commit-pair schema comparison plus the snapshot-format rule; no registry of recorded readers. | :85-87 |
| F6 | Data changed by a breaking migration is brought back to that generation's format (reversible up/down migrations; "refuse when uncertain" carries over) AMENDED (2026-10-12, owner decisions 3 and 8): NO down migrations - expand/contract (parallel change) with the invariant "the predecessor reads everything I write", checked as a build-stage check; automatic rollback runs on CURRENT data; snapshot copies are manual recovery in maintenance only; "refuse when uncertain" survives as the Tolerant Reader's newer-version-refuses  AMENDED (2026-10-12, simplification point 5): the invariant is checked as a commit-pair SCHEMA FILE comparison (AsyncAPI + JSON Schema + snapshot format + migration set) at every rollout, bound to the commit pair and never to the image; migrations are squawk-linted expanding-only SQL applied by the loader under a DDL role (dbmate + squawk, decided); no throwaway reader runs, no admission records. | :87-88, :49 |
| F7 | Outcome 4's check still holds on the new shape: one command starts the instance; no key in lifemodel's process; panic holds across restarts AMENDED (2026-10-12, owner decisions 6 and 7): the no-key guarantee is stronger - short-lived per-MODULE-ROLE OpenBao credentials, model keys behind Agent Vault via the egress door  AMENDED (2026-10-12, simplification points 3 and 4): only the ingress and egress gateways touch the world  AMENDED (2026-10-12, platform decision): the one command on a clean VM is the k3s install + Flux bootstrap pointed at the deploy branch; into an existing cluster, `helm install` of the same chart stack; credentials via OpenBao's official chart with Kubernetes auth (delivery AMENDED 2026-10-13, R5-04: the Bank-Vaults secrets webhook's vault-env in daemon mode replaces the Agent Injector — no envconsul, no wrapped secret-ids); panic = Flux suspend + scale to zero, durable cluster state. | :88-90 |

### 3.2 Outcome 4's check re-walked on the new shape (docs/charters/instance-1.md:69-77)

- One command starts the instance from the CI image on a clean Docker machine (:69-70). Today: README.md:189-197 (the documented `docker run`), which must keep working with the added containers (Valkey, Postgres, OpenBao) - the inventory question is whether they join this one command (same compose/run) or the loader starts them.
  (PENDING CHARTER AMENDMENT — R3-24: decided, not open — owner decision 6 fixes the one command as `docker compose up -d` for the static set and the loader creates only generations/modules; the "must keep working" `docker run` question is superseded.)
- The owner sets the loader password, puts the model key into Agent Vault through the loader, sets endpoint and models in lifemodel's own web interface (:70-73). Today's surfaces: loader.md:180-253 (vault provisioning), docs/features/instance/settings.md:19-36 (the settings page).
- The model request reaches the endpoint with the key injected by Agent Vault while no key is in lifemodel's process (:73-75). Today: env-boundary + vault proxy (loader/src/env-boundary.ts, loader/src/agent-vault.ts; verified by the fixture walk, tests/integration/instance-first-start.test.ts:1847 'keeps the made-up key out of lifemodel's environment, config and logs'). The new shape keeps Agent Vault beside OpenBao (charter :40-41).
- Recreating the container keeps code and data; panic keeps the instance down across a restart of the container and of Docker until resumed (:76-77). Today: volume-backed repo/data (loader.md:104-126), panic file root-only (loader/src/state.ts), fixture cases at tests/integration/instance-first-start.test.ts:2331-2574.

### 3.3 The restart contract that outcome 2 already fixed and outcome 5 inherits (docs/charters/instance-1.md:62-65)

A restart in the middle of a cognition turn ends with that turn completed or redone exactly once; no message around it is lost or answered twice. The durable inbound log is today's mechanism (src/core/inbound-log.ts; AGENTS.md "Restart guarantees"). Under generations, the planned switch extends the same promise to an epoch switch (charter :41-44).

## 4. Quality attribute scenarios

Format: stimulus / condition / response / measure. Where today's source already holds the mechanism, it is cited; where the scenario is a driver for the not-yet-built shape, it says so. ISO/IEC 25010 categories used as a checklist: availability, reliability (maturity/fault tolerance/recoverability), security (confidentiality/integrity/authenticity/accountability), performance efficiency, operability (usability for the owner + maintainability), portability, compatibility.

Note on today's baseline (FACT, measured at HEAD): no Valkey, Postgres, pgvector or OpenBao anywhere in the source (dependency check: package.json has none; loader config knows only its own ports). Every scenario below describes the TARGET property; the "today" column records what exists at HEAD 8864655.

| # | Category | Scenario | Measure |
|---|---|---|---|
| Q1 | Availability | Planned switch. Stimulus: the owner (or a successful self-change gate) requests generation N+1 while generation N serves a conversation. Condition: normal operation, a turn may be in flight. Response: N finishes its tick and leaves; N+1 continues from the current snapshot; the loader holds or queues owner input for the pause.  AMENDED (2026-10-12, simplification point 1 + the values): the serving gap is the core's stop deadline (5 s, DECIDED) plus the new core's start-to-first-commit (≤ readinessWindowMs 60 s); no 90 s drain and no overall switch deadline exist; owner input is NEVER dropped — the ingress gateway keeps accepting and XADDing to `inbound` through the gap; a switch moves who READS `inbound`, never who accepts it  AMENDED (2026-10-12, platform decision): the strategies are Kubernetes fields (the keyed writers RollingUpdate maxSurge 1/maxUnavailable 0; the core a ONE-REPLICA STATEFULSET under the operator's suspend/resume gate — Recreate rejected, R5-03); the web surface is Traefik's Service whose Endpoints follow readiness, so a core replacement moves no Service at all. | The switch ends within a bounded pause (today's comparable bounds: lifemodel drain 90 s, core-loop.ts:109; loader stop budget 110 s, loader/src/config.ts:173); every owner message received around the switch is answered exactly once (inbound-log once-only contract survives the switch, src/core/inbound-log.ts); the conversation continues from the snapshot (charter :83-84). |
| Q2 | Reliability / fault tolerance | A generation fails its readiness probe. Stimulus: N+1 starts but never reports ready within its probe window (crash on boot, missing config). Response: the loader never switches the epoch; N keeps serving; the failed generation is discarded and reported.  AMENDED (2026-10-12, simplification point 1): readiness is per module; the epoch is touched only by the core's stop-first replacement.  AMENDED (2026-10-12, round 4 R4-11) — TWO cases: (a) a KEYED module (start-first) fails readiness — the epoch is untouched, the previous instance keeps serving, the discard is reported; (b) the CORE (stop-first) fails readiness — the old core has already exited and the epoch already taken (by the failed core's own CAS, if it got that far) before the failure is declared, so the measure is the epoch moved exactly once (never reused), durable intake throughout, and the bounded fallback on current data  AMENDED (2026-10-12, platform decision): the new core TAKES the epoch itself (the Lua CAS); the operator gates the core's replacement through its HelmRelease suspend/resume and verifies the post-conditions; the probe is the Kubernetes readiness probe. | Case (a): time to declared-failed is a fixed multiple of the probe interval (a named number, readinessWindowMs 60 s); zero epoch changes (operator records); generation N answers throughout. Case (b): the epoch value moved exactly once; no dropped owner message (the ingress gateway kept accepting and XADDing to `inbound`); the previous commit's core restores under the stop-first rules on current data within the fallback deadline. |
| Q3 | Reliability / recoverability | A generation is ready but unhealthy. Stimulus: N+1 passed readiness but its health window shows no completed work (the charter defines health as completed work, not a live process - charter :35-36). Response: the loader rolls back to the previous healthy generation and produces a report.  AMENDED (2026-10-12, simplification points 1 and 6): rollback restores the previous commit's desired state, only the changed modules, on CURRENT data (Postgres is never rolled back); snapshot copies exist ONLY at core replacements and are restored manually in maintenance only; the rollback deadline stays 300 s  AMENDED (2026-10-12, platform decision): the restore is a GIT REVERT of the changed tags in the deploy branch, applied by Flux module by module; the operator is the controller that observes, gates and rolls back. | Rollback's two outcomes are DISTINCT measures (R4-13): restored within the named window (`rollbackDeadlineMs` 300 s), or maintenance-on-expiry with the ran-over step named — never conflated with restored service; the maximum-duration call during a multi-module rollback is MEASURED, not assumed; exactly one report exists naming what was rolled back and why (a durable record, observable in the loader UI/`lifemodel status`); rollback itself follows Q1's once-only message contract. |
| Q4 | Reliability / recoverability | Crash of the running generation mid-tick. Stimulus: generation N's process dies between two tick commits (OOM, kill -9, broken generation). Response: the loader starts the previous/same generation again; it continues from the last committed snapshot; the durable inbound log replays messages whose turns recorded no outcome  AMENDED (2026-10-12, platform decision): on k3s an in-place pod restart IS this path (restartPolicy — a fresh bootstrap re-authenticating through its service account); new CODE arrives only by an operator rollout.  AMENDED (2026-10-12, simplification points 2 and 4): the abandoned tick's pending effects replay with their PERSISTED effect ids; in-flight command events are taken over by the owning module's consumer group via XAUTOCLAIM — no executor and no heartbeats exist. | At most one replay per message (the inbound log's contract, src/core/inbound-log.ts); work committed to the snapshot is not redone (observable: a turn answered before the crash is not answered again); today's known loss window - queued-but-unprocessed in-memory signals (AGENTS.md "Restart guarantees") - is either closed by the bus or explicitly carried as the same documented window. |
| Q5 | Reliability / fault tolerance | Crash of the controller. Stimulus: the loader process (the only Docker-authorized component) dies. Response: the container's restart policy brings the loader back; it recovers its generation records and the running generation (or restarts it); panic still holds.  AMENDED (2026-10-12, simplification point 1): reconciliation is epoch-vs-record over the rollout record — simplified, no closed-apply barrier and no handoff key; the bump pair (epoch Lua CAS + the `active_holder` UPDATE) is re-run idempotently; a candidate container with no record is stopped and discarded.  AMENDED (2026-10-12, platform decision): the controller is the GENERATION OPERATOR — a single replica behind a leader-election Lease; a crash reconciles from CLUSTER-RESOURCE records (written and read back complete — etcd quorum commit) plus the branch's desired state; the epoch bump pair is re-run by the new core's idempotent CAS and the operator's verification; a candidate POD with no record is discarded; panic/maintenance are cluster state (suspend + scale 0) a node restart revives nothing of. | The operator is back within its Deployment restart delay (observable via `kubectl get pods` restart count); no generation is left orphaned (observable: one running generation beside a fresh operator); panic holds without a time limit (today's guarantee, loader.md:64-65, fixture tests/integration/instance-first-start.test.ts:2575). |
| Q6 | Reliability / data durability | Valkey restart. Stimulus: the Valkey process restarts (crash or operator action) while a generation runs. Response: the bus streams and the one committed tick snapshot survive via fsync-on-every-write; events after the last fsync never existed by contract.  AMENDED (2026-10-12, simplification point 3): the epoch record is writable ONLY by the loader role; the trim-floor and consumer-group-durability rules carry (R3-21)  AMENDED (2026-10-12, platform decision): the epoch record is writable by the OPERATOR role (panic bump) and the CORE role (the takeover/commit CAS) — no other role; Valkey runs on a PVC. | No committed event and no committed snapshot is lost across the restart (observable: replay from disk yields identical bus position and snapshot); a generation's writes during Valkey downtime fail visibly rather than silently proceeding (observable: the generation reports unavailability or pauses its ticks). |
| Q7 | Security / integrity | A stale generation writes after the switch. Stimulus: generation N, partitioned or slow to stop, attempts a bus write or snapshot commit after N+1 took the epoch. Response: the epoch check refuses the write atomically with the commit (charter :38).  AMENDED (2026-10-12, simplification points 0 and 1): one host — the stop-first CONFIRMED EXIT gives one writer; the fence is the epoch CAS (Valkey) plus the `active_holder` guard (Postgres); no two-store barrier, no Valkey commit module, no mTLS; the cheap guards defend against LOADER bugs, not hostile modules (point 0)  AMENDED (2026-10-12, platform decision): the confirmed exit is a CONFIRMED POD TERMINATION (observed, never assumed) plus the bounded lease-revocation/backend drain (R4-14); the new core takes the epoch and sets `active_holder` at takeover; the guards defend against OPERATOR bugs (A2). | Zero accepted stale writes (observable: every refused attempt is counted and reported); the current snapshot and bus position are byte-identical before and after the refused write. Today: no epoch concept exists in lifemodel's process (the loader's in-memory `epoch` covers only its own restart scheduling - loader-reader's inventory, loader/src/supervisor.ts); this is new machinery. |
| Q8 | Security / confidentiality | Credentials never in lifemodel's process beyond what it needs. Stimulus: a generation runs any code, including a compromised self-change. Response: credentials stay in Agent Vault/OpenBao and are injected at egress; the generation sees placeholders only.  AMENDED (2026-10-12, simplification points 0 and 3): identity needs NO certificate — a requester's identity is the stream it wrote to (Valkey ACL); sensitive surfaces are unreachable STRUCTURALLY by network membership, no mTLS anywhere; the scoped-kind credential method (R3-17) carries unchanged  AMENDED (2026-10-12, platform decision): the structural unreachability is namespace + default-deny NetworkPolicy (a module has no policy row to a surface it must not reach); credentials are issued through Kubernetes auth (delivery AMENDED 2026-10-13, R5-04: vault-env in daemon mode via the Bank-Vaults secrets webhook — the service-account JWT is the only bootstrap material; the pod spec carries no credential material); the ADR's Q8 network leg is the NetworkPolicy. | The fixture's method stays green on the new shape: the model key's value appears in neither the generation's `/proc/<pid>/environ`, nor its data files, nor its logs (tests/integration/instance-first-start.test.ts:1847); OpenBao-issued credentials are short-lived and scoped (their lease expiry is observable, a named maximum). |
| Q9 | Security / access control | Container-runtime access confined to the controller. Stimulus: code inside a generation container attempts the container runtime. Response: no Docker socket, CLI or DOCKER_HOST reaches the generation container; only the loader container holds it.  AMENDED (2026-10-12, simplification point 4): Motor holds its OWN narrow Docker socket proxy (motor-labelled containers only; no host mounts, no privileges) — the loader stays the only OTHER Docker client; no module holds a network route to either proxy.  AMENDED (2026-10-12, platform decision): there is no Docker anywhere in the cluster to confine — no socket, no CLI, no `DOCKER_HOST`, no socket proxy; the access control is RBAC: the GENERATION OPERATOR holds the whole lifemodel mutation surface, Motor holds Jobs-in-`lifemodel-motor`-ONLY as the ONE module exception, module service accounts grant NOTHING, and Motor's agentic sandboxes run as Kubernetes Jobs under that row. | Zero container-runtime-path facts inside any module pod (observable: no socket mount, no docker/kubectl binary, no DOCKER_HOST env); Kubernetes API attempts from a module pod are refused by the API server and counted; Motor's Jobs row exercised only in `lifemodel-motor`. Today (FACT): the instance image installs no docker CLI (docker/instance/Dockerfile:77-86) and the documented run mounts no socket (README.md:189-197), so in-container Motor Cortex containerization is already inert; Motor Cortex states its requirement as an error ('Docker required for Motor Cortex isolation', src/runtime/motor-cortex/motor-cortex.ts). |
| Q10 | Operability | What the owner sees in the loader UI. Stimulus: the owner opens boot.<host> during normal operation, a switch, or a rollback. Response: today's page (status running/stopped/failed, commit, panic on/off - loader.md:395-416) extends to show the current generation, its health, recent switches/rollbacks and their reports; maintenance mode is reachable from the same login.  AMENDED (2026-10-12, platform decision): the UI is the OPERATOR's web UI, a Traefik route with ForwardAuth to the operator (the `boot.` host; same login, same front door, no second control interface); panic and maintenance are toggled and shown as the cluster state they are (the releases' suspend + the workloads' scale). | Every switch/rollback produces a report visible in the UI without shell access (observable; today `docker exec` + `lifemodel status` is the only programmatic view, loader.md:401-405); the owner can boot an older generation from the page (F5). |
| Q11 | Performance efficiency / resource use, AMENDED (see below) | Two generations alive during the switch. Stimulus: N+1 starts while N still runs, beside Valkey, Postgres and the loader. Response: both fit without starving; the switch is the only two-generation window.  AMENDED (2026-10-12, simplification point 4): the overlap measured in the window is the per-module stop_grace_period overlap — no executor grace exists  AMENDED (2026-10-12, platform decision): the overlap is the per-module `terminationGracePeriodSeconds` overlap, and the measured set names the platform's members too (the Flux controllers, Traefik, OpenBao + the Bank-Vaults secrets webhook — R5-04's amendment, the local registry, a BuildKit build pod, the operator). | Measure and name the two-generation memory need: the peak aggregate memory of (loader + 2 generations + Valkey + Postgres + Caddy + Agent Vault/OpenBao) is MEASURED in the test environment and reported (today UNVERIFIED - no memory numbers exist in the source, and the instance container carries no memory cap; the only in-repo caps are Motor Cortex skill-container defaults 512 MiB / 1.0 CPU / 64 pids, src/runtime/container/types.ts:298-304). AMENDED 2026-10-12, owner decision 1: the dev machine's limits - 11 GB - are NOT a design driver; the original premise ("stays under the 11 GB machine budget with a named margin") is dropped and the scenario is now a measurement, not a constraint. |
| Q12 | Performance efficiency / time behavior | Time to build and start a generation. Stimulus: a self-change commit becomes generation N+1. Response: build (if needed) then start then readiness.  AMENDED (2026-10-12, simplification points 1 and 5): builds are PER MODULE (an unchanged module builds zero times); the commit-pair schema check's cost is timed at every rollout regardless of reuse; the egress gateway's longest realistic sync call is measured here to set its stop grace (open question 1)  AMENDED (2026-10-12, platform decision): builds run as in-cluster BuildKit pods into the local registry; the 20-minute budget carried from the loader needs RE-MEASUREMENT on the cluster's own 2-CPU envelope (open question 6); the grace is the chart's `terminationGracePeriodSeconds`. | Build is bounded by today's build budget, 20 minutes (loader/src/config.ts:174 buildTimeoutMs; the loader refuses a build that writes no entry, loader.md:455-457) — on k3s re-measured (open question 6); container start + readiness adds a named, measured time in the test environment (today UNVERIFIED; the same repo builds in the CI image job within its 45-minute ceiling, image.md:116-120). |
| Q13 | Maintainability / portability | The tick is the only boundary. Stimulus: any async result (model reply, tool result, Motor run completion, schedule fire) reaches the loop. Response: it arrives as a bus event handled by a later tick, never as a callback into mid-tick state (charter :41-44). | Observable in review: no component writes tick state except through committed snapshots + bus events; today's counter-inventory (section 2 of this document) lists every span-tick work item that must convert. |

## 5. Constraints

1. Owner decisions (docs/charters/instance-1.md:30-51), fixed inputs: loader extended, not rewritten; loader container is the only one with Docker; generations as containers beside the running one; probes + epoch switch + health window + rollback + maintenance mode; Valkey for bus streams + one tick snapshot with atomic epoch-checked commits and fsync on every write; Postgres with pgvector for memory and configuration (no shared folder); OpenBao beside Agent Vault; tick as the only async boundary; planned switch = old finishes its tick and leaves, new continues from the snapshot; greenfield (no data migration); the core is not cut into modules now; web interface channel, Telegram out; reversible format migrations (up/down + format version) and "refuse when uncertain" carry over.
   (PENDING CHARTER AMENDMENT — R3-24: this constraint quotes charter text
   that the owner's decisions of 2026-10-12 and ADR-010 as rewritten
   supersede in part: per-module images, no down migrations (expand/contract
   only), the core/executor/function split, and the door/network shape.
   Historical FACTs in this document remain valid; plan from the decisions
   and the rewritten ADR until the coordinator's charter amendment lands.)
2. Test isolation (AGENTS.md "Test isolation"): local and ordinary CI suites never start on the host; `npm run test`/`check` go through scripts/test-isolated.mjs (disposable container, node 24, offline, 2 CPUs / 3 GiB / 256 pids, at most 2 vitest workers); heavy Docker image/first-start acceptance is CI-only (AGENTS.md; image.md:110-122). Any test strategy for generations must fit this boundary or extend the named CI exception.
   (AMENDED 2026-10-12, platform decision: the heavy acceptance surface is the k3d walk — a throwaway k3d cluster with the real Flux/CNPG/Traefik/OpenBao surfaces, running in the PR-only `ci-image` job and locally reproducible with the same command; k3d is the dev/CI test environment and nothing runs a cluster on the host or inside the isolated launcher. AMENDED 2026-10-12, R5-17: k3d covers CLUSTER MECHANICS only — the two delivery entrypoints have their own bounded disposable clean-VM walks (`generations/clean-vm-install`, `generations/existing-cluster-helm`), each marked UNPROVED-in-CI until its first recorded run.)
3. The 19-case first-start fixture (tests/integration/instance-first-start.test.ts, 19 it() cases at HEAD; enabled only in the PR ci-image job, :1-11,43-47) is the accepted outcome-4 walk; outcome 5's design must keep its guarantees re-walkable on the new shape (charter :88-90).
   (AMENDED 2026-10-12, platform decision: re-walked on the k3s shape — the walk base case of the k3d `generations/*` set; CI-only on k3d.)
4. The loader's front door / egress / vault behavior is accepted (outcome 4): Caddy the only entrance with pinned hosts and forward_auth (docker/instance/Caddyfile:33-111), the uid-1000 iptables confinement (loader.md:274-322), Agent Vault provisioning and proxy environment (loader.md:158-272), the stop budget (loader.md:66-102). These constrain where a generation's probes, epoch records and reports may live (the loader's interfaces).
5. Design principles that carry (AGENTS.md): signals not events; restart-safe scheduling; no backward compatibility shims (clean breaks); no attribute-prefix routing; plugin isolation.
6. This milestone ships no Telegram on the new shape (charter :127-128); the channel is the web interface, designed separately.

---

## 6. Explicitly unverified / unknown (not resolvable by source reading)

1. grammY's exact behavior with two pollers on one token (no probe allowed;
   telegram.ts facts are code-level only).
2. Whether concurrent multi-process access to one LanceDB directory is safe
   (no probe; the wrapper has no close/dispose at HEAD — absence verified).
3. Memory/CPU numbers for two generations + Valkey + Postgres on an 11 GB
   machine (no source carries any; Q11 is a to-measure driver).
   (PENDING CHARTER AMENDMENT — R3-24: superseded as a CONSTRAINT by owner
   decision 1 — the dev machine's 11 GB limits are NOT design drivers; Q11
   is a synchronized measurement of the two-generation window, not a margin
   against this machine. See containers-design.md "Checks", Q11.)
4. Container start + readiness time for a generation image (Q12's second
   number; to be measured in the test environment).
5. Whether the pinned ONNX/lancedb/sharp native stack runs in an
   Alpine-or-slim Valkey/Postgres-side container layout — outside this
   inventory's scope; the instance image itself pins node:24-bookworm-slim
   (Dockerfile:27) and needs no extra libraries for them (Dockerfile:73-76).
6. Agent Vault's own strictness (what its mitm grants a credential-less
   process) is external, checksum-pinned behavior — carried as unknown by the
   superseded containment report and unchanged here.

## Verification statement

Every FACT above carries a `path:line` citation read at HEAD `8864655` of
branch design/b0r-containers-inventory. All citations were machine-checked for
file existence and line range (~500 citations across five reader passes plus
the coordinator's own reads); one stale line number from the superseded
reports' style was corrected (src/settings/restart.ts:16, not :18). Spot
content checks confirmed the cited line holds the claimed constant, field or
comment for: the supervisor spawn/uid/backoff/stop numbers, egress install,
the three epoch counters, state auto-save default, LanceDB bypass header,
inbound-log durability point, motor Docker refusal, labels/images, the
lock-service in-memory header, the "lost at stop" comments, the event-queue
Valkey comment, and the config path defaults. The worktree was not modified
except by creating and committing this document.

Reader provenance: five parallel source-only passes (loader+image; core loop
and wiring; storage+config; layers; runtime/motor/skills) with per-pass
findings retained outside the repository; the coordinator read the charter,
the superseded source reports, the accepted-behavior docs, the fixture
structure, and every load-bearing seam cited in sections 1.1-1.2, 2.3 and
section 3-5 measures personally.
