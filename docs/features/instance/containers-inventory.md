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
now; settings saves now reload the endpoint in place through `reloadConfig`; there is no settings restart exit code.

---

## 1. Inventory: building blocks, their state, and what the change touches

### 1.1 The trusted layer today (platform loader + core image)

The owner decision of 2026-10-14 removes the Docker-run instance image and
its all-in-one supervisor path. The platform loader and standalone core image
remain. Docker is a build/test tool, not a target environment for lifemodel.

| Piece | State and behavior it owns today | Where the decision puts it |
|---|---|---|
| Platform loader (`docker/loader/Dockerfile`, `loader/src/main.ts`) | Authenticated platform interface; durable OpenBao and Gitea first-start phases; retries incomplete phases after restart. It does not start lifemodel, Agent Vault, Caddy, or an instance process. | Remains in `lifemodel-system` as platform bootstrap, separate from the generation operator. |
| Loader authentication state (`loader/src/state.ts`) | Password digest and session secret on the loader's persistent platform volume. | Remains platform-owned; phase records are stored in the platform-created Secret. |
| Platform bootstrap (`loader/src/openbao.ts`, `loader/src/gitea.ts`) | Initializes OpenBao custody and provisions initial Gitea access and application sources through Kubernetes and Gitea APIs. | Remains the resumable first-start responsibility of the platform loader. |
| Standalone core image (`docker/core/`, `scripts/build-core-image.sh`) | Builds the core runtime image; it has no instance loader, front door, or personal state volume. | Remains the core artifact used by the k3s platform. |
| Instance image and supervisor | Removed: there is no all-in-one image, instance repository seeding/build loop, child-process supervisor, Docker-run CLI, Agent Vault wiring, Caddy front door, or iptables egress mode in the loader. | No compatibility layer is retained. Outcome 4 is accepted on the k3s shape by the manual clean-VM check. |

### 1.2 Current core construction and stop

The container requires `LIFEMODEL_VALKEY_URL` and
`LIFEMODEL_DATABASE_URL`. It takes a Valkey snapshot epoch and updates the
Postgres active-holder fence before it restores the committed snapshot. The
snapshot owns the tick state, bus offset, inbound offsets, dedup ring and
outbox. The container reads pending inbound stream messages into the signal
queue before `CoreLoop.start()`; no channel is registered in this stage.

Configuration, conversations, memory vectors, graph data and soul data use
Postgres. Configuration is in `core.settings`; saving through the settings
server reloads the endpoint in place. Local state and logs remain under
`DATA_PATH`, but they are not the inbound-message durability boundary.

The bounded shutdown sequence stops intake, drains the loop within its single
deadline, persists state/registries and flushes storage. A hard kill does not
run that sequence. Restart behavior and remaining crash windows are documented
in AGENTS.md "Restart guarantees" and docs/architecture.md.

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
| 5 | UserModel (beliefs, `user` in the envelope) | travels in the tick snapshot | Valkey snapshot |
| 6 | Conversation history + statuses + completed actions | Postgres `core.conversation_messages` and related tables | Postgres (conversational state) |
| 7 | Vector memory | Postgres `core.memory_vectors` with pgvector; local embedding generation | Postgres with pgvector (current implementation) |
| 8 | Memory graph | Postgres `core.memory_entities` and `core.memory_relations` | Postgres (memory) |
| 9 | Soul (inner life incl. pendingReflections) | Postgres core schema via `PostgresSoulStore` | Postgres |
| 10 | Inbound messages | Valkey `inbound` stream; committed offsets and bounded dedup ring live in the atomic tick snapshot | Valkey stream + snapshot |
| 11 | Recipient registry | Postgres recipient table | Postgres |
| 12 | Ack registry | Committed tick snapshot section | Valkey snapshot |
| 13 | Plugin enable/disable | `core/disabled_plugins.json` (intent-applicator.ts:1179-1199) | Postgres (configuration) |
| 14 | Plugin keys + schedules | `plugin/<id>/<key>.json`, incl. `schedules` and `fired:<id>` (storage-primitive.ts:50; scheduler-primitive.ts:42-45, :665-694) | Postgres (configuration); schedules are durable state the next generation must reload |
| 15 | Configuration | Postgres `core.settings`; `PostgresConfigStore` reads and writes configuration | Postgres (configuration); endpoint changes reload in place |
| 16 | LLM keys | Secret values are not stored in configuration; platform credentials are injected at the egress boundary | OpenBao / Agent Vault |
| 17 | Motor run registry | Motor Cortex is disabled in the cluster; the registry is owned by lifemodel-653 | no cluster state home in this stage |
| 18 | Motor run/workspace artifacts, skills, ONNX model, logs | Motor directories are disabled in the cluster; skill definitions are Postgres rows; ONNX model is read-only at `/opt/model-cache`; logs are stdout | Postgres; image; stdout |
| 19 | Loader four files + vault store | `<volume>/loader/*` root-only, `<volume>/vault` | loader-owned |
| 20 | Repository (the instance's code) | `<volume>/repo` git clone, dist/ overwritten by build | git repository on the volume (unchanged); generations select commits — no version store exists today (state.json holds ONE builtCommit, state.ts:28-32) |

Concurrency is enforced by the Valkey epoch snapshot and fenced Postgres pool. Mutable core state is no longer shared through a filesystem tree.

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
- The core registers no channel adapter in this stage. Gateways append to `inbound`; answers are committed to `outbound` for a gateway to deliver.

---

## 2. The committed tick boundary

A Valkey tick snapshot is committed atomically under the active epoch. It
contains the core state sections, internal bus offset, inbound stream read
offset, per-recipient offsets, bounded recent-message-id ring, pending inbound
messages and outbound outbox events. An uncommitted tick does not advance any
of these durable positions. The Valkey epoch check rejects a stale core; the
Postgres active-holder fence protects Postgres writes.

The inbound stream is the gateway-to-core boundary. A gateway appends a
`user_message` event to `inbound`; the core queues pending messages from the
committed snapshot on startup. The bounded ring deduplicates recent external
message ids. It does not promise unbounded deduplication.

A committed outbound event is the answer boundary. Postgres applies it with
the event id as an idempotency key and advances its cursor after the row write.
A deliberate silent turn commits without an outbound event. A failed or
interrupted turn does not commit its partial answer, leaving its inbound
messages eligible for the next core. The future gateway owns delivery and
retry. With no channel registered, the core logs each event once per process
and advances only its in-process scan position; the persisted gateway cursor
and the event itself remain untouched.

Remaining crash windows are described in AGENTS.md "Restart guarantees": a
Postgres row can be applied before its cursor advances (safe idempotent
reapply); a gateway can deliver before its cursor advances (at-least-once
delivery); and Valkey and Postgres are separate fenced stores, not one
cross-store transaction. Queued work outside the committed snapshot or its own
durable store can still be lost.

Configuration is stored in Postgres `core.settings`; the settings server
reloads model endpoints in place. Memory vectors and graph data use Postgres
with pgvector. The working directory and `DATA_PATH` hold files such as logs
and Motor artifacts, but not the core's inbound/outbound durability boundary.

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

Amended 2026-10-14 (owner, lifemodel-avy): the Docker-run instance image and
its first-start fixture are removed. Outcome 4 is re-walked on the k3s shape by
the manual clean-VM acceptance check. The clean-VM flow installs k3s and Flux;
the platform loader performs resumable OpenBao and Gitea setup; the generation
operator then manages the application layer. No Docker-run compatibility path
or instance-image CI walk remains.

### 3.3 The restart contract that outcome 2 already fixed and outcome 5 inherits (docs/charters/instance-1.md:62-65)

The current restart boundary is the Valkey stream and the atomic tick snapshot. A crash before commit leaves offsets unchanged; a committed outbound event and its inbound offsets move together. See AGENTS.md "Restart guarantees" and docs/architecture.md.

## 4. Quality attribute scenarios

Format: stimulus / condition / response / measure. Where today's source already holds the mechanism, it is cited; where the scenario is a driver for the not-yet-built shape, it says so. ISO/IEC 25010 categories used as a checklist: availability, reliability (maturity/fault tolerance/recoverability), security (confidentiality/integrity/authenticity/accountability), performance efficiency, operability (usability for the owner + maintainability), portability, compatibility.

Note on today's baseline (FACT, measured at HEAD): no Valkey, Postgres, pgvector or OpenBao anywhere in the source (dependency check: package.json has none; loader config knows only its own ports). Every scenario below describes the TARGET property; the "today" column records what exists at HEAD 8864655.

| # | Category | Scenario | Measure |
|---|---|---|---|
| Q1 | Availability | Planned switch. Stimulus: the owner (or a successful self-change gate) requests generation N+1 while generation N serves a conversation. Condition: normal operation, a turn may be in flight. Response: N finishes its tick and leaves; N+1 continues from the current snapshot; the loader holds or queues owner input for the pause.  AMENDED (2026-10-12, simplification point 1 + the values): the serving gap is the core's stop deadline (5 s, DECIDED) plus the new core's start-to-first-commit (≤ readinessWindowMs 60 s); no 90 s drain and no overall switch deadline exist; owner input is NEVER dropped — the ingress gateway keeps accepting and XADDing to `inbound` through the gap; a switch moves who READS `inbound`, never who accepts it  AMENDED (2026-10-12, platform decision): the strategies are Kubernetes fields (the keyed writers RollingUpdate maxSurge 1/maxUnavailable 0; the core a ONE-REPLICA STATEFULSET under the operator's suspend/resume gate — Recreate rejected, R5-03); the web surface is Traefik's Service whose Endpoints follow readiness, so a core replacement moves no Service at all. | The switch ends within a bounded pause (today's comparable bounds: lifemodel drain 90 s, core-loop.ts:109; loader stop budget 110 s, loader/src/config.ts:173); every owner message received around the switch is answered exactly once (the committed stream offsets survive the switch, the former file-based inbound implementation); the conversation continues from the snapshot (charter :83-84). |
| Q2 | Reliability / fault tolerance | A generation fails its readiness probe. Stimulus: N+1 starts but never reports ready within its probe window (crash on boot, missing config). Response: the loader never switches the epoch; N keeps serving; the failed generation is discarded and reported.  AMENDED (2026-10-12, simplification point 1): readiness is per module; the epoch is touched only by the core's stop-first replacement.  AMENDED (2026-10-12, round 4 R4-11) — TWO cases: (a) a KEYED module (start-first) fails readiness — the epoch is untouched, the previous instance keeps serving, the discard is reported; (b) the CORE (stop-first) fails readiness — the old core has already exited and the epoch already taken (by the failed core's own CAS, if it got that far) before the failure is declared, so the measure is the epoch moved exactly once (never reused), durable intake throughout, and the bounded fallback on current data  AMENDED (2026-10-12, platform decision): the new core TAKES the epoch itself (the Lua CAS); the operator gates the core's replacement through its HelmRelease suspend/resume and verifies the post-conditions; the probe is the Kubernetes readiness probe. | Case (a): time to declared-failed is a fixed multiple of the probe interval (a named number, readinessWindowMs 60 s); zero epoch changes (operator records); generation N answers throughout. Case (b): the epoch value moved exactly once; no dropped owner message (the ingress gateway kept accepting and XADDing to `inbound`); the previous commit's core restores under the stop-first rules on current data within the fallback deadline. |
| Q3 | Reliability / recoverability | A generation is ready but unhealthy. Stimulus: N+1 passed readiness but its health window shows no completed work (the charter defines health as completed work, not a live process - charter :35-36). Response: the loader rolls back to the previous healthy generation and produces a report.  AMENDED (2026-10-12, simplification points 1 and 6): rollback restores the previous commit's desired state, only the changed modules, on CURRENT data (Postgres is never rolled back); snapshot copies exist ONLY at core replacements and are restored manually in maintenance only; the rollback deadline stays 300 s  AMENDED (2026-10-12, platform decision): the restore is a GIT REVERT of the changed tags in the deploy branch, applied by Flux module by module; the operator is the controller that observes, gates and rolls back. | Rollback's two outcomes are DISTINCT measures (R4-13): restored within the named window (`rollbackDeadlineMs` 300 s), or maintenance-on-expiry with the ran-over step named — never conflated with restored service; the maximum-duration call during a multi-module rollback is MEASURED, not assumed; exactly one report exists naming what was rolled back and why (a durable record, observable in the loader UI/`lifemodel status`); rollback itself follows Q1's once-only message contract. |
| Q4 | Reliability / recoverability | Crash of the running generation mid-tick. Stimulus: generation N's process dies between two tick commits (OOM, kill -9, broken generation). Response: the loader starts the previous/same generation again; it continues from the last committed snapshot; the durable inbound log replays messages whose turns recorded no outcome  AMENDED (2026-10-12, platform decision): on k3s an in-place pod restart IS this path (restartPolicy — a fresh bootstrap re-authenticating through its service account); new CODE arrives only by an operator rollout.  AMENDED (2026-10-12, simplification points 2 and 4): the abandoned tick's pending effects replay with their PERSISTED effect ids; in-flight command events are taken over by the owning module's consumer group via XAUTOCLAIM — no executor and no heartbeats exist. | At most one replay per message (the committed stream-and-snapshot contract); work committed to the snapshot is not redone (observable: a turn answered before the crash is not answered again); today's known loss window - queued-but-unprocessed in-memory signals (AGENTS.md "Restart guarantees") - is either closed by the bus or explicitly carried as the same documented window. |
| Q5 | Reliability / fault tolerance | Crash of the controller. Stimulus: the loader process (the only Docker-authorized component) dies. Response: the container's restart policy brings the loader back; it recovers its generation records and the running generation (or restarts it); panic still holds.  AMENDED (2026-10-12, simplification point 1): reconciliation is epoch-vs-record over the rollout record — simplified, no closed-apply barrier and no handoff key; the bump pair (epoch Lua CAS + the `active_holder` UPDATE) is re-run idempotently; a candidate container with no record is stopped and discarded.  AMENDED (2026-10-12, platform decision): the controller is the GENERATION OPERATOR — a single replica behind a leader-election Lease; a crash reconciles from CLUSTER-RESOURCE records (written and read back complete — etcd quorum commit) plus the branch's desired state; the epoch bump pair is re-run by the new core's idempotent CAS and the operator's verification; a candidate POD with no record is discarded; panic/maintenance are cluster state (suspend + scale 0) a node restart revives nothing of. | The operator is back within its Deployment restart delay (observable via `kubectl get pods` restart count); no generation is left orphaned (observable: one running generation beside a fresh operator); bootstrap phases are re-attempted after a loader restart; panic and maintenance are platform cluster state. |
| Q6 | Reliability / data durability | Valkey restart. Stimulus: the Valkey process restarts (crash or operator action) while a generation runs. Response: the bus streams and the one committed tick snapshot survive via fsync-on-every-write; events after the last fsync never existed by contract.  AMENDED (2026-10-12, simplification point 3): the epoch record is writable ONLY by the loader role; the trim-floor and consumer-group-durability rules carry (R3-21)  AMENDED (2026-10-12, platform decision): the epoch record is writable by the OPERATOR role (panic bump) and the CORE role (the takeover/commit CAS) — no other role; Valkey runs on a PVC. | No committed event and no committed snapshot is lost across the restart (observable: replay from disk yields identical bus position and snapshot); a generation's writes during Valkey downtime fail visibly rather than silently proceeding (observable: the generation reports unavailability or pauses its ticks). |
| Q7 | Security / integrity | A stale generation writes after the switch. Stimulus: generation N, partitioned or slow to stop, attempts a bus write or snapshot commit after N+1 took the epoch. Response: the epoch check refuses the write atomically with the commit (charter :38).  AMENDED (2026-10-12, simplification points 0 and 1): one host — the stop-first CONFIRMED EXIT gives one writer; the fence is the epoch CAS (Valkey) plus the `active_holder` guard (Postgres); no two-store barrier, no Valkey commit module, no mTLS; the cheap guards defend against LOADER bugs, not hostile modules (point 0)  AMENDED (2026-10-12, platform decision): the confirmed exit is a CONFIRMED POD TERMINATION (observed, never assumed) plus the bounded lease-revocation/backend drain (R4-14); the new core takes the epoch and sets `active_holder` at takeover; the guards defend against OPERATOR bugs (A2). | Zero accepted stale writes (observable: every refused attempt is counted and reported); the current snapshot and bus position are byte-identical before and after the refused write. Today: no epoch concept exists in lifemodel's process (the loader's in-memory `epoch` covers only its own restart scheduling - loader-reader's inventory, the removed instance supervisor); this is new machinery. |
| Q8 | Security / confidentiality | Credentials never in lifemodel's process beyond what it needs. Stimulus: a generation runs any code, including a compromised self-change. Response: credentials stay in Agent Vault/OpenBao and are injected at egress; the generation sees placeholders only.  AMENDED (2026-10-12, simplification points 0 and 3): identity needs NO certificate — a requester's identity is the stream it wrote to (Valkey ACL); sensitive surfaces are unreachable STRUCTURALLY by network membership, no mTLS anywhere; the scoped-kind credential method (R3-17) carries unchanged  AMENDED (2026-10-12, platform decision): the structural unreachability is namespace + default-deny NetworkPolicy (a module has no policy row to a surface it must not reach); credentials are issued through Kubernetes auth (delivery AMENDED 2026-10-13, R5-04: vault-env in daemon mode via the Bank-Vaults secrets webhook — the service-account JWT is the only bootstrap material; the pod spec carries no credential material); the ADR's Q8 network leg is the NetworkPolicy. | The fixture's method stays green on the new shape: the model key's value appears in neither the generation's `/proc/<pid>/environ`, nor its data files, nor its logs (the removed Docker instance first-start fixture:1847); OpenBao-issued credentials are short-lived and scoped (their lease expiry is observable, a named maximum). |
| Q9 | Security / access control | Container-runtime access confined to the controller. Stimulus: code inside a generation container attempts the container runtime. Response: no Docker socket, CLI or DOCKER_HOST reaches the generation container; only the loader container holds it.  AMENDED (2026-10-12, simplification point 4): Motor holds its OWN narrow Docker socket proxy (motor-labelled containers only; no host mounts, no privileges) — the loader stays the only OTHER Docker client; no module holds a network route to either proxy.  AMENDED (2026-10-12, platform decision): there is no Docker anywhere in the cluster to confine — no socket, no CLI, no `DOCKER_HOST`, no socket proxy; the access control is RBAC: the GENERATION OPERATOR holds the whole lifemodel mutation surface, Motor holds Jobs-in-`lifemodel-motor`-ONLY as the ONE module exception, module service accounts grant NOTHING, and Motor's agentic sandboxes run as Kubernetes Jobs under that row. | Zero container-runtime-path facts inside any module pod (observable: no socket mount, no docker/kubectl binary, no DOCKER_HOST env); Kubernetes API attempts from a module pod are refused by the API server and counted; Motor's Jobs row exercised only in `lifemodel-motor`. Today (FACT): the instance image installs no docker CLI (the removed Docker instance image:77-86) and the documented run mounts no socket (README.md:189-197), so in-container Motor Cortex containerization is already inert; Motor Cortex states its requirement as an error ('Docker required for Motor Cortex isolation', src/runtime/motor-cortex/motor-cortex.ts). |
| Q10 | Operability | What the owner sees in the loader UI. Stimulus: the owner opens boot.<host> during normal operation, a switch, or a rollback. Response: today's platform loader page provides authentication and bootstrap status extends to show the current generation, its health, recent switches/rollbacks and their reports; maintenance mode is reachable from the same login.  AMENDED (2026-10-12, platform decision): the UI is the OPERATOR's web UI, a Traefik route with ForwardAuth to the operator (the `boot.` host; same login, same front door, no second control interface); panic and maintenance are toggled and shown as the cluster state they are (the releases' suspend + the workloads' scale). | Every switch/rollback produces a report visible in the UI without shell access (observable in the generation operator's platform UI); the owner can boot an older generation from the page (F5). |
| Q11 | Performance efficiency / resource use, AMENDED (see below) | Two generations alive during the switch. Stimulus: N+1 starts while N still runs, beside Valkey, Postgres and the loader. Response: both fit without starving; the switch is the only two-generation window.  AMENDED (2026-10-12, simplification point 4): the overlap measured in the window is the per-module stop_grace_period overlap — no executor grace exists  AMENDED (2026-10-12, platform decision): the overlap is the per-module `terminationGracePeriodSeconds` overlap, and the measured set names the platform's members too (the Flux controllers, Traefik, OpenBao + the Bank-Vaults secrets webhook — R5-04's amendment, the local registry, a BuildKit build pod, the operator). | Measure and name the two-generation memory need: the peak aggregate memory of (loader + 2 generations + Valkey + Postgres + Caddy + Agent Vault/OpenBao) is MEASURED in the test environment and reported (today UNVERIFIED - no memory numbers exist in the source, and the instance container carries no memory cap; the only in-repo caps are Motor Cortex skill-container defaults 512 MiB / 1.0 CPU / 64 pids, src/runtime/container/types.ts:298-304). AMENDED 2026-10-12, owner decision 1: the dev machine's limits - 11 GB - are NOT a design driver; the original premise ("stays under the 11 GB machine budget with a named margin") is dropped and the scenario is now a measurement, not a constraint. |
| Q12 | Performance efficiency / time behavior | Time to build and start a generation. Stimulus: a self-change commit becomes generation N+1. Response: build (if needed) then start then readiness.  AMENDED (2026-10-12, simplification points 1 and 5): builds are PER MODULE (an unchanged module builds zero times); the commit-pair schema check's cost is timed at every rollout regardless of reuse; the egress gateway's longest realistic sync call is measured here to set its stop grace (open question 1)  AMENDED (2026-10-12, platform decision): builds run as in-cluster BuildKit pods into the local registry; the 20-minute budget carried from the loader needs RE-MEASUREMENT on the cluster's own 2-CPU envelope (open question 6); the grace is the chart's `terminationGracePeriodSeconds`. | Build runs in bounded in-cluster BuildKit pods; its 20-minute budget is re-measured on the cluster's 2-CPU envelope (open question 6). Container start and readiness are measured by platform acceptance checks. |
| Q13 | Maintainability / portability | The tick is the only boundary. Stimulus: any async result (model reply, tool result, Motor run completion, schedule fire) reaches the loop. Response: it arrives as a bus event handled by a later tick, never as a callback into mid-tick state (charter :41-44). | Observable in review: no component writes tick state except through committed snapshots + bus events; today's counter-inventory (section 2 of this document) lists every span-tick work item that must convert. |

## 5. Constraints

1. Owner decisions and ADR-010 define the k3s + Flux target. The Docker-run
   instance image and supervisor mode were removed by the owner on 2026-10-14;
   the standalone core image and platform loader remain.
2. Test isolation (AGENTS.md "Test isolation"): local and ordinary CI suites
   run only through `scripts/test-isolated.mjs`. CI builds and publishes the
   standalone core image only; there is no host-side test exception.
3. Outcome 4 is re-walked on k3s by the manual clean-VM acceptance check. The
   removed `instance-first-start` Docker fixture is not a delivery gate.
4. The platform loader's present duties are authenticated access and resumable
   OpenBao/Gitea bootstrap. The generation operator owns rollout, health,
   rollback, maintenance and panic behavior on the platform.
5. Design principles that carry (AGENTS.md): signals not events; restart-safe scheduling; no backward compatibility shims (clean breaks); no attribute-prefix routing; plugin isolation.
6. This milestone ships no Telegram on the new shape (charter :127-128); the channel is the web interface, designed separately.

---

## 6. Explicitly unverified / unknown (not resolvable by source reading)

1. grammY's exact behavior with two pollers on one token (no probe allowed;
   the former bot-channel source facts are code-level only).
2. Whether concurrent multi-process access to a legacy local vector directory was safe
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
reports' style was corrected (the former settings restart helper:16, not :18). Spot
content checks confirmed the cited line holds the claimed constant, field or
comment for: the supervisor spawn/uid/backoff/stop numbers, egress install,
the three epoch counters, state auto-save default, legacy vector-store bypass header,
inbound stream/snapshot commit point, motor Docker refusal, labels/images, the
lock-service in-memory header, the "lost at stop" comments, the event-queue
Valkey comment, and the config path defaults. The worktree was not modified
except by creating and committing this document.

Reader provenance: five parallel source-only passes (loader+image; core loop
and wiring; storage+config; layers; runtime/motor/skills) with per-pass
findings retained outside the repository; the coordinator read the charter,
the superseded source reports, the accepted-behavior docs, the fixture
structure, and every load-bearing seam cited in sections 1.1-1.2, 2.3 and
section 3-5 measures personally.
