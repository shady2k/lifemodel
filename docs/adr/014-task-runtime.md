# ADR-014: Task runtime with a live, replaceable harness

Date: 2026-10-20. Task: lifemodel-653.5 (motor-1).

## Status and provenance

Direction confirmed by the owner; decision record proposed for integration,
not implementation acceptance. Different-model review passed for design handoff
at 28bc0345 after two rounds; [review evidence](../features/motor/tasks-design-review.md)
retains findings/dispositions and scopes the later e196a69d deadline clarification
for coordinator verification. No third review round or runtime proof is claimed. The feature's confirmed frame is the
2026-10-20 comment beginning “Design frame for lifemodel-653 confirmed”. The
four 08:40–08:44 comments on lifemodel-653.5 settle storage, Stop and urgency.
They supersede the corresponding recommendations in
[the options history](../features/motor/tasks-options.md). No trade is reopened.

This record owns task orchestration; [ADR-015](015-storage-module.md) separately
owns the platform storage boundary. Separate records make sense because the
storage service has its own identity, release, state, outage and consumers,
including web downloads while the core is down. Their
[shared views](../features/motor/tasks-design.md) define the interaction.

## Context and inventory

The owner delegates long work and keeps talking to one lifemodel. The core
answers promptly, creates a briefed task, steers it, and later replies with a
summary and attachments. A new message never cancels a task. The task never
talks to the owner directly. Progress belongs in “Сейчас”, not transcript chips.

Today `src/runtime/motor-cortex/motor-cortex.ts` serializes agentic work and runs
its own LLM loop with Docker. Its `motor-state.ts` rewrites one `motor-runs`
object through `PostgresStorage` into `core.kv`; this is already Postgres, not
file state. `core/act.ts` prepares workspaces/dependencies and resolves keys;
`core/task.ts` reads local artifacts/logs and treats a user trigger as approval.
Those are not parallel admission or exact-scope consent. File-backed skills,
credential injection and best-effort `TaskLogger` cannot meet the new boundary.

Reuse the core's fenced Postgres operations, Valkey snapshot/bus signal seams,
ADR-013's platform model-key custody, ADR-012 loader auth/kit and the signed
platform release. Add domain ports rather than raw clients in callers. New
task orchestration lives in the core, not a new Motor/executor service. The
workbench contains both harness adapters, git, build tools and pinned dev deps;
no install or network bootstrap at task start. Old loop/Docker deletion is
97bj; there is no compatibility path that executes the old loop alongside Jobs.

## Decision drivers (in order)

1. **Isolation:** two Jobs see only their own files; no signing/API key reaches
   task spec, env, files, model context or logs; model traffic only via gateway.
2. **Nothing lost:** a core restart, stop or failure preserves task status and
   acknowledged output and produces one logical terminal outcome, not a rerun.
3. **Nothing without consent:** external changes require a current exact-scope
   platform grant; owner words, not model confidence, authorize dangerous acts.
4. **Live steering:** task findings/questions reach the agent; agent commands
   reach a running harness; stalled tasks never block owner intake.
5. **Replaceability:** both real harnesses and a fake second executor use the
   same ports without changing callers.
6. **Platform limits:** profile/resources/deadlines and concurrency settings
   constrain admission and execution, even after a core restart.
7. **Visible progress:** durable queued/running/wrapping/terminal status,
   short step, log cursor and result/reason are available without asking a task.

## Constraints (closed requirements and their checks)

The IDs below are the complete constraint set of this record. Each check is a
**stage obligation**, not a test claimed to exist or have passed. Proposed test
paths are under `tests/`; WALK names identify concrete single-node acceptance
scripts/receipts to create. Storage's additional constraints are S01–S10 in
ADR-015. Fixture sizes specify evidence, not a maximum number of owner tasks.

| ID | Requirement / origin | Concrete check and fixture |
| --- | --- | --- |
| T01 | Deploy on **one k3s node**, plain Jobs first; no Docker socket/privilege/hostPath/other-task volume (owner frame, ADR-010) | WALK-TASK-ISOLATION: one fresh k3s node, **two concurrent Jobs**, distinct files/profiles; each cross-read and raw cluster/store access denied; inspect Pod admission and final volume removal |
| T02 | One CI-built signed, digest-pinned workbench contains **OpenCode and prime-agent**; setting selects one per accepted task; startup offline (owner) | `tests/unit/task-workbench-contract.test.ts`: rendered image/signature/pin; WALK-TWO-HARNESSES: **two tasks per adapter**, shell + actual gateway + live steering + stop, no startup installs |
| T03 | Task has zero RBAC and no model/S3/git/store signing key; explicitly projected service-audience SA tokens are bearer bootstrap identity, not secret keys (owner) | `tests/integration/task-identity.test.ts`: **two task UIDs**, wrong audience/SA/Pod/Job, replay after revoke, token rotation; WALK-TASK-ISOLATION inspects specs/env/files/logs without printing secrets |
| T04 | Persist task registry/mailbox in **Postgres**, tick/outbox signals in existing **Valkey** seams; no file state or task store client (frame, standing durable-home rule) | `tests/integration/task-restart.test.ts`: read-only DATA_PATH and kill/restart core at **eight boundaries** named in D3; zero lost ACKs and one terminal event key |
| T05 | Commit launch/profile/effect intent before dispatch; one launch authorizes **at most one harness execution**, including controller replacement Pods (ADR-010 keyed effects) | `tests/integration/task-launch-fence.test.ts`: **two core epochs + two candidate Pod UIDs**, delayed create/delete, lost response/duplicate start, deleted-running-Pod replacement; WALK-TASK-RESTART verifies only one execution claim and zero replacement harness starts |
| T06 | Network is deny-first; task can reach only scoped runtime services and granted egress; internal cluster targets/other files/keys remain hard-denied (owner, ADR-013) | `tests/integration/task-consent-contract.test.ts` plus WALK-TASK-ISOLATION: **two profiles**, no-network and one approved domain, forbidden methods/private IP/redirect/domain denied |
| T07 | Both harnesses expose live commands/events/one semantic terminal result; one stalled task cannot block owner intake (owner) | `tests/integration/task-harness-contract.test.ts`: **two real adapters + one scripted adapter**; with one blocked stream, 20 owner intakes and 20 second-task control messages each ACK **within 2 s**, frame/buffer/timeout limits in D2 hold; mid-tool steer/question/abort/error and duplicate replay |
| T08 | Soft Stop and agent timeout wrap up without new external effects; hard deadline defaults to **300 s**; hard Stop deletes immediately; stop-all soft-stops current tasks, not core (owner answer) | `tests/integration/task-stop.test.ts`: virtual clock, **two running + one queued + one starting**, repeated Stop/timeout/hard/all; WALK-TASK-STOPS observes real delete requests, retained marked bytes and no remaining Pod/PVC |
| T09 | Urgent precedes normal; FIFO in each class, owner or agent can mark urgent, no preemption; concurrency is platform bounded (owner answer) | `tests/integration/task-admission.test.ts`: **100 queued tasks, cap 2, two dispatch contenders**, mixed urgent/normal and cap decrease/restart; no third live reservation, stable class FIFO |
| T10 | Registry descriptors are typed, loader/platform-owned; secrets set/delete/exists only; ceilings cannot be raised by core (owner/nocx) | `tests/unit/task-settings-registry.test.ts`: duplicate/unknown/type/bounds/secret-read refusal; WALK-TASK-SETTINGS: add **one declaration**, render bounds/errors in deployed Chromium + Firefox, core unavailable |
| T11 | Web uses narrow domain operations, authenticated same-origin downloads, no raw clients; tasks only in panel, Stop/Stop-now/Stop-all/urgent available (owner, ADR-011/012) | `tests/unit/web-layer-boundary.test.ts` extension and WALK-TASK-PANEL: **two tasks**, ordinary dialogue, restart, attachment download, session expiry and controls on Chromium + Firefox under PRA-001 |
| T12 | Kept principles below remain requirements, including no compatibility runner, atomic tool history and safe logs (AGENTS.md) | `tests/unit/task-boundaries.test.ts`: forbidden imports/old runner paths, **one tool-call/result pair** replay kept atomic, deterministic invalid profile rejected without retry; secret/token/URL canaries absent from diagnostic logs |

## Decisions

### D1. Two ports, one Job, explicit identities

`TaskService` is the core domain API: accept/list/read/steer/stop/stopAll/setUrgent
and read result references. `TaskExecutor` exposes ensureStarted, observe,
requestSoftStop and deleteNow by immutable task/launch identity. First adapter:
Kubernetes Jobs. Fake adapter proves the caller contract; SkyPilot remains a
later backend, not a dependency. `TaskHarness` lives inside the Job launcher:
start/steer/wrap/abort, normalized events and one semantic terminal report.
OpenCode loopback HTTP/SSE and Prime stdin/stdout RPC implement it. Raw harness
APIs never leave the pod. CLI 0, `agent_end` or `step_finish` alone is not success;
normalize provider errors, aborts and unresolved required tool failures [R].

Jobs use restricted security context, one generic ephemeral working volume,
private HOME/session directories, `restartPolicy: Never`, `backoffLimit: 0` and
an absolute hard deadline. No shared source/workspace volume. Both harnesses
use baked mounted non-secret endpoint/model configuration; Prime's ignored
placeholder is not authorization. Skills are versioned Postgres instructions,
not executable shared files or hot-installed plugins. Workbench inputs pin the
harness/runtime/native libraries and offline dev dependencies [R].

A platform-provisioned task SA has **no bindings**; many tasks may share it,
but identity includes the bound Pod UID, never just the SA name. Disable default
API-audience mounting; explicitly project separate `lifemodel-task-channel`,
`lifemodel-task-model`, `lifemodel-task-storage` tokens. The launcher rereads
rotated tokens and carries the model token on a dedicated internal header,
not the harness placeholder Authorization. The model adapter's local relay
adds it if the harness cannot. Loopback relay is transport glue, not a new
model provider; untrusted task code has the same task identity either way.

Each trusted listener uses TokenReview with its audience and namespace-scoped
Pod/Job reads: authenticated result, bound Pod UID, live non-deleting Pod and
controller Job UID must match the registered attempt. Reject absent bound UID
rather than accept SA-only identity. Core registers binding via allocation/bind
(ADR-015); a platform-only authorization projection verifies Job existence and
launch identity. No task can patch labels, request tokens or reach the API.
The task model listener replaces caller session with trusted task ID and uses
ADR-013 filtering/failover/custody; core's existing listener is unchanged.
Model, channel, storage and effect listeners use the narrow SQL authorization
read of ADR-015 S-D2: current committed lifecycle access intent and binding are
read together; newer revoke/stop wins over lagging projection. Model remains
available during wrapping, external effects do not; hard revoke denies both.
Never cache positive liveness across revocation; API/authority outage rejects
new operations. T03/T06/S02 pause the projection writer, commit stop without
delivering revoke RPC, and inject delayed active revisions: no post-intent
operation may authorize against the stale revision. Authorization also derives
effective mode from absolute deadlines at database time, so a core-down timeout
cannot rely only on eventual local-timer reporting. Existing model responses may end;
they do not confer permission to execute an external effect.

Rejected from options §1: core-signed JWT adds signer custody/revocation and
makes a changeable core a credential issuer; core-relayed model bytes couple
model availability to core. Task-direct Valkey (§2) requires keys/ACL churn;
core-to-pod HTTP opens pod ingress and does not supply replay. Named patterns:
workload identity, Ports and Adapters, Pipes and Filters, Idempotent Receiver.

### D2. Core-owned registry and durable live channel

New task/attempt/mailbox/outbox rows belong to the **core schema**, written by
its existing active-holder-fenced Postgres seam. This explicitly replaces
ADR-010 Q4/containers state row 17's separate Motor-schema owner **for these
tasks**. Storage owns only its own schema (ADR-015). No external workflow engine,
executor module or dual registry with authority to launch is introduced.

A task opens a TLS outbound stream to a task-only core listener. Commands and
events carry task/attempt ID, immutable message ID and per-direction sequence.
Postgres inserts idempotently before ACK; replay uses stored cursors, never
assumes contiguous IDs after deletions. Core emits normal Signals through its
existing bus seam; control transport envelopes are not a second cognition
model. Owner input is never sent raw to a task; the agent turns it into steer.
`step` is a bounded short line; `question` asks the agent, which may ask owner.
Use independent per-task queues; output/log bytes go **directly to storage**,
not this stream. Design defaults: control frame **64 KiB**, at most **16**
unacknowledged frames/**1 MiB** per task connection, **4 MiB** process-wide
control buffer, **5 s** ACK timeout before disconnect/replay. Event processing
uses round-robin task queues, at most **one frame per task per scheduling pass**;
control/owner-intake workers and their bounded SQL pool reservations are separate
from artifact transfer workers. Saturated task queues apply backpressure/429,
never borrow the owner-intake reserve. T07's 2 s fixture bound tests this
mechanism locally without claiming a production network/LLM latency SLO.
Frame/queue/timeout values are typed platform settings with hard validation;
raising them requires rerunning the fixture, not silently permitting infinity.

The launcher ACKs steering only after its adapter accepts it and records the
command ID on its private working volume. A core restart preserves that volume
and launcher; it does not restart the harness. A lost task Pod is not replayed:
report failed/uncertain effects rather than auto-reissue shell commands. On
core outage the task can continue approved local work/model/storage operations;
new grants/steering pause. Backpressure pauses producing unacknowledged control
events; the artifact CLI remains separately usable. Long human waits are
correlations in Postgres, not a requirement to keep a Pod forever; existing
profile deadline still applies.

### D3. Launch, reconciliation and one terminal outcome

Acceptance follows the core's existing committed effect-key discipline: task
ID/launch key is fixed by the deciding turn; a replay returns the same task.
Store briefing, profile, harness/image/settings revisions, accepted order and
launch intent before a Job create. Admission reserves a slot in the same SQL
transaction as `queued → starting`. Storage allocation is idempotent by launch
key, before ensureStarted; allocation failure creates no Job and is retried as
infrastructure work, not a second task. Once the Job exists, bind its UID and
Pod UID; launcher waits for that binding before accessing runtime services.

Job name is deterministic from launch ID. An unknown create response triggers
GET/adopt of that exact name/UID/template hash, not a new attempt. A mismatch
fails visibly. No new Job after a recorded terminal launch tombstone. Job GC
is driven by reconciler; no `ttlSecondsAfterFinished` before storage seal.

**Kubernetes fencing:** SQL fencing alone cannot stop a delayed API request.
A fail-closed platform admission verifier handles task Job and Pod CREATE and
Job mutation: under a narrow authorization read it checks current core epoch,
reserved task/launch revision, allowed template and nonterminal launch marker.
Job restart fields alone do **not** forbid controller-created replacement Pods.
Each Pod starts only a trusted inert launcher. Before it invokes a harness,
a platform execution gate makes an atomic once-only SQL claim on launch ID,
bound live Pod UID and a fresh process boot nonce; only that claimant gets a
start acknowledgement and runtime binding. Claim is durable before response;
two Pod UIDs racing cannot both win. Same-identity reconnect can read its saved
binding but cannot mint another start permit. Launcher has one guarded start
transition and never invokes start twice; a timed-out/lost start reply consumes
the claim and fails conservatively, even if a delayed acknowledgement arrives.
Nonce is memory-only; after launcher/process loss, a new nonce or Pod UID cannot
reacquire execution. Include authority restart and delayed first-claim reply
in T05, not only competing Pod requests. A replacement Pod
may transiently exist as an inert launcher, with no model/storage/effect rights;
it is rejected and deleted, not called a second execution. First authorized
Pod loss is failed, not a request to reissue. The gate is not side-effecting
admission: Pod UID exists and TokenReview is validated at handshake. Its row is
retained until all old Job/delivery paths are fenced, including cleanup.
On takeover, the new
core reconciles the deterministic name **before** any further dispatch; a
terminal Job/name is retained until old-epoch requests cannot be admitted.
A create admitted just before takeover can arrive late: new core adopts it,
never creates another name. If stop wins meanwhile, Pod CREATE admission
rejects the revoked launch even if Job CREATE was already admitted. For delete,
require a recorded stop/cleanup intent and use UID/resourceVersion preconditions;
a stale arbitrary delete is refused by the verifier. No broad task CRUD bypass
for ordinary core credentials. The verifier is platform-owned, not a generation
hook; API/verifier outage fails closed. This added dependency is intentional.

On startup and watch resync, reconcile nonterminal registry rows with Jobs,
storage space state and cleanup rows. No recomputation from Job status alone:
a Job success does not prove retained result; a lost Job does not erase output.
Eight crash boundaries for T04: slot reserve, storage allocate, create response,
mailbox ACK, mark ACK, seal response, terminal outbox commit, Job delete.

A terminal candidate/reason is persisted separately from public terminal state.
Freeze task writes/revoke token access and stop compute, then seal storage;
only a sealed receipt (including partial-output/missing-result reason) allows
one compare-and-set `done|failed|stopped` plus unique outcome outbox key in one
transaction. If storage is down, remain nonterminal with `finalization pending`
and saved candidate; **never leave compute running merely to wait for storage**.
Slots release after confirmed Pod termination, not after reply or storage GC.
Cleanup has its own durable pending/complete fields; retries never reopen a
terminal task. Outcome delivery is at-least-once and deduped by outcome key;
this is not exactly-once shell execution or a cross-store transaction.

Normal success requires semantic harness success and a sealed result. Runtime
error/OOM/eviction/missing Pod gives failed with reason and retained partial
output. Owner Stop gives stopped even if wrapping yields a useful result;
timeout gives failed (`timeout`) after the same wrap path. Hard stop overrides
an uncommitted normal candidate; a committed terminal outcome cannot change.
A new retry is an explicit new task linked to the prior outcome, not a hidden
rerun of ambiguous external effects.

Rejected §3: Job-only reconstruction loses briefings/queue/results on deletion;
event sourcing needs another durable authority and still cannot infer a result
from exit status. Temporal/Windmill remain rejected for confined Jobs [J].

### D4. Soft Stop, hard Stop, timeout and stop-all

Soft Stop atomically records stop cause/time, revokes new external-effect
permission and persists `wrapping-up` plus one wrap command. Harness should
finish its current local step, save/mark output and write a result. Model,
channel and storage remain available only for wrapping; revoked egress actions
cannot start. In-flight external actions may already have happened: record
uncertain/delivered by effect key, cancel where supported, never claim undo.

`wrapGraceSeconds` defaults to **300** (owner answer, not core's five-second
shutdown deadline). Its absolute `hardStopAt` is persisted, never moved later
by repeat Stop, settings changes, reconnect or core restart. Agent profile has
required positive timeout from the Kubernetes Job's persisted `status.startTime` (not harness-ready time).
Scheduling/startup delay therefore counts against it; the separate 120 s
startup deadline can end a never-ready task earlier. Handshake gives launcher
the verified absolute `softDueAt = Job.startTime + timeout`; a launcher arriving
past it starts wrapping, not new work. Its local timer triggers wrap/cause timeout
even while core is down, then reports the keyed event on reconnect. The platform
control component also observes that absolute deadline as a backstop. Job
`activeDeadlineSeconds` is fixed to timeout + snapshotted wrap grace, protecting
the same outer bound if core dies. Earlier manual soft Stop
sets the earlier persisted deadline; a platform deadline reconciler watches
that intent and deletes at that deadline independently of core. It belongs to
the platform task-control/admission component, holds only namespace-scoped
Job delete rights, and checks UID/current stop intent. It is not an executor
backend or an LLM loop. Restore its deadlines from Postgres after restart;
queue admission is never delegated to it. The Job field remains the final
backstop for agent timeout; cluster/API outage prevents a literal timed delete
and is an unhealthy platform condition, not an extension approved by the task.

Hard “stop now” records revocation/stop intent and initiates storage revoke
and Job DELETE in parallel **without waiting for harness, seal or upload**.
Removal uses zero requested grace; API latency and kubelet termination are
observable, not promised instantaneous physical deletion. Storage enforces
revocation as ADR-015 defines; only already stored and marked objects survive.
Seal/terminal reply can follow later. Repeating hard Stop is idempotent.
Soft/hard Stop on a queued task creates no Job and yields stopped/empty seal;
on starting task it cancels the reservation and fences late Pod creation.

Stop-all takes a transactional snapshot of all current nonterminal task IDs
and creates idempotent soft-stop intents for each; queued tasks are stopped,
not launched to wrap. Later accepted tasks are not silently included. Partial
progress is resumable by the batch ID. Core/chat and unrelated platform pods
keep running. This is task control, not loader panic or generation rollback.

### D5. FIFO with an urgent class; bounded admission

Priority key is `(urgent first, acceptedSequence, taskId)`. Urgent is a boolean
owned by the task service, set by owner **or agent**, not an encoded name/prefix.
Changing it while queued preserves original accepted order within the new class.
Running tasks are never preempted/restarted; urgency on them changes display
only. A steady urgent stream can starve normal work: this is the accepted
priority trade; do not silently add aging/quotas that violate urgent-first.

Lock a single admission row while counting/reserving starting/running/wrapping
compute; `SKIP LOCKED` alone is not a concurrency cap. Reconcile unknown creates
before releasing a reservation. Desired concurrency is a typed setting, default
**2** (engineering default for parallel operation; not a machine-memory claim),
subject to platform ceiling. Lowering it does not kill existing work; new
admission waits below the new effective cap. Pending unscheduled Jobs count;
use an explicit settings startup deadline (design default **120 s**) to report
failure and clean up rather than hold capacity forever. This deadline is not
the agent's Job-lifetime timeout. Queue wait before Job.startTime does not
consume that timeout; Job scheduling/launcher startup afterward does.

At tenfold fixture depth (100 tasks versus a 10-task functional fixture), SQL
ordering and one admission row keep cap=2; no claim of unlimited throughput.
ResourceQuota/LimitRange and platform admission enforce profile CPU/memory/time
ceilings. Reject invalid profiles; capacity shortage reports queued/starting
reason, not invented fallback resources. Recheck effective ceilings/settings
at dispatch; if lowered below requested profile, wait with `profile exceeds
current ceiling`, ask via agent, never silently expand or alter the briefing.

Rejected §5 strict FIFO/no urgency is superseded by owner. Weighted project
queues, preemption and reserved slots add unrequested policy; urgent FIFO is
not that algorithm. Queue lives in Postgres, not memory or Kubernetes Pending.

### D6. Platform settings registry, first step

Port nocx's typed declaration/Descriptor idea (source revision in options).
Pure shared TypeScript types/validators describe key, typed default, label and
description locale keys, section, control, data class, options, bounds/unit,
authority and apply timing. Registration rejects duplicate keys; write rejects
unknown keys, invalid units/types/ranges. Secret descriptors have no getter or
default: set/delete/exists against OpenBao only. Do not expose secret values in
description, exports, errors or logs. This does not copy nocx's storage module.

New Motor declarations and revisioned values live in loader/platform ownership
with a dedicated Postgres settings scope, narrow operations and grants. The
loader remains a repair path when core is down. Keep `core.settings` ownership
unchanged; core cannot mutate platform ceilings or author new platform setting
metadata. Existing loader model slots remain in Bao, not migrated into SQL.
Generated controls use the shared kit; no frontend switch keyed by individual
setting names. English/Russian labels and validation come from declarations.

Task acceptance snapshots harness (default **OpenCode**, both adapters shipped),
workbench digest, profile and wrap grace. Concurrency/urgency affect next
admission; retention revisions go through ADR-015's warning/deletion process.
Core requests changes only through consent-gated operations, never direct SQL
writes. ey3e adds ceilings/dangerous-action descriptors and enforcement. Defaults
300 s, 2 and 120 s above are explicit choices; 90 days/20 GB are inherited owner
values, not rediscovered from old Docker constants. Forever is an enum, not 0.

Rejected §6 core-owned metadata as policy authority: a generation could raise
its own ceilings and a core failure would disable repair settings. Platform
registry adds bootstrap work but reuses loader's existing auth and policy seam.

### D7. Exact-scope consent seam (ey3e), not prompt-based approval

653 supplies immutable task/profile/action IDs, request/correlation messages,
platform authorization hooks and deny-by-default effect adapters. ey3e owns
owner proposal/receipt interpretation, access requests, ceilings and grants.
A grant binds task/attempt, exact action digest, target/operation, allowed
arguments, expiry/revocation revision and idempotent use key. Some configured
actions require owner restatement in words; a bare boolean/user-message trigger
is not a grant. A task cannot grant itself authority through its stream.

NetworkPolicy labels open only the approved gateway; L3/L4 cannot enforce DNS
names, methods or “one push”. A trusted egress/effect service validates current
grant, destination/redirect/private-address policy and action scope on every
use. OpenBao role permits broker-side credential use; a short-lived push/PR
credential stays in the trusted effect service, never task env/file. A staged
diff may be uploaded locally; publishing it is separate granted effect. Local
edits and runtime model/channel/storage protocols are explicitly confined
services, not general permission to change other state. No task settings
write, deploy, publish, secret use or extra network without the matching grant.
Before ey3e is implemented, unavailable effect adapters return access-required;
653 must not ship unrestricted network or secret injection as an interim path.

Rejected §7 label/role-only approval: it grants reachability, not exact action.
Capability ledger + complete mediation is chosen; labels/Bao roles are backstops.
Grant checks also gate stopped tasks, regardless of cached model instructions.

### D8. Web and earlier-ADR amendments

ADR-011 D4 gains narrow operations implemented in `src/storage/`/`src/ports/`:
`readTasks`, `readTask`, `watchTaskChanges`, `requestTaskStop(mode)`,
`requestAllTaskStops`, `setTaskUrgent` and `openTaskArtifact`. HTTP handlers get
these operations, never pg/Valkey/S3 clients. Read/download operations project
registry plus storage-module references; the web fetches bytes from the module,
not core. Durable control intake records owner request IDs even during a core
restart; the platform stop path is independent of cognition. State-changing
web requests keep ADR-012 session/CSRF/origin rules; attachment routes keep
ForwardAuth/same-origin/no-store and safe Content-Disposition rules (ADR-015).
Actual rendering/route implementation and PRA-001 walks belong to hf2k.

Amend the web target: no task cards/chips in transcript, no task composer;
ordinary replies may carry artifact attachments. Task bindings remain metadata
on ordinary messages; panel/drawer shows progress, urgent, soft Stop, stop-now,
stop-all. Agent may set urgency too. New owner messages cancel nothing.
ADR-013 gains the separate task-authenticated model ingress of D1; upstream
filtering/custody are unchanged. ADR-010 task run-registry ownership is D2, Job
launch by core is D3, no old Docker or credential-in-task route survives 97bj.

## Kept principles and lessons

From AGENTS.md: **Energy Conservation** (short conversation turns, no LLM for
queue/deadline/reconciliation), **Emergence Over Polling** (task Signals wake
cognition; lifecycle watches/timers restore state, not periodic LLM polling),
**Signals, Not Events**, **Plugin Isolation** (plugins only PluginPrimitives),
**No Backward Compatibility**, **No Attribute Prefix Routing**,
**Restart-Safe Scheduling**, **Long-Term Architecture Over Quick Wins**.
Kept lessons: **Read-Write Symmetry** for domain operations; **Atomic Units in
Conversation History** for replayed tools; **Deterministic Errors Need
Prevention** (invalid profile/token never blind-retried); **explicit durable
home**; **content timestamps**, not fetch time, for output/event cursors; and
**Stop Conditions Handle Gaps** (opaque IDs/exact cursors, no `<=` heuristic).
**Secrets Are Never Printed Whole** includes tokens, signed URLs, cookies and
artifact/message bodies in diagnostic logs. Retained task logs are private
content in storage, not process diagnostic logging; strip credential material.

## Consequences, risks and invalidators

- Owner can keep talking while independent tasks run. Core outage pauses
  steering/new dispatch, not already authorized storage/model/local work.
- One logical outcome requires durable finalization; a storage outage delays
  outcome/attachments, not hard Stop. Expose pending reason and alert rather
  than fake success or keep a Job indefinitely for uploads.
- Urgent-first permits starvation; no preemption gives predictable running
  work at the cost of waiting for a slot. Wrap grace can occupy capacity five
  minutes longer; hard Stop deliberately loses unmarked/unacknowledged work.
- Platform identity/admission/deadline and storage add services and failure
  dependencies. TokenReview/API outage fails closed, not to SA-name fallback.
- Pin/contract-test the real harnesses first; round-2 mocks [R] did not prove
  mid-tool steering, full offline workbench or hostile process-tree cleanup.
- Review boundary: single-node process isolation, not a hardware-VM boundary.
  Foreign privileged plugins, multi-node/GPU/cloud scheduling or sustained
  workflow branching reopens identity/executor choice, not silent extensions.
- Monitor queue age by class, active slots, stream lag, wrap deadlines, seal/
  cleanup pending and stale-fence refusals without content. Before acceptance,
  stages supply runbook actions for stuck startup, missing output and overdue
  cleanup; no user-facing availability SLO/RPO is invented by this record.

## Sources

[R] [Task-runtime research, both rounds](../research/task-runtime.md).
[J] [Jobs-engine research](../research/jobs-engine.md).
Pattern/source links and original rejected-option evaluations are retained in
[step A](../features/motor/tasks-options.md): Ports and Adapters, EIP durable
request/reply and Idempotent Receiver, Transactional Outbox, Kubernetes Jobs/
TokenReview, PostgreSQL locking, complete mediation and nocx registry.
Baselines: [ADR-010](010-container-generations.md),
[ADR-011](011-web-interface.md), [ADR-012](012-loader-interface-and-access.md),
[ADR-013](013-model-gateway.md). This record changes their named task surfaces,
not their unrelated rollout/bootstrap contracts.

## Checks the stages must carry

- **653 / identity + workbench:** T01–T03, T06, T07; real pinned adapters first,
  not print-mode mocks as deployment proof; fake executor caller contract too.
- **653 / registry + launch + channel:** T04–T05 crash matrix, deterministic
  launch/admission fence and one terminal/outbox contract with real test stores.
- **653 / stops + admission:** T08–T09, persisted absolute deadlines/urgent FIFO,
  platform deadline enforcer, simultaneous core restart and hard Stop.
- **653 / storage module:** ADR-015 S01–S10; allocate/bind/mark/revoke/seal and
  all crash/recovery/quota/download checks are required integration evidence.
- **653 / registry settings:** T10; one declaration renders without a hand list;
  changes have declared authority/apply timing and secret get is impossible.
- **ey3e:** T03/T06/T12 exact-scope grants, words-required action, expired,
  widened and replayed grants, no secret in task; no open-egress interim path.
- **hf2k:** T11 + S08 authenticated downloads and both browser walks; no task
  chip or task composer, two Stops, urgent and stop-all with chat still usable.
- **97bj:** T12 removes old Motor loop/Docker/file-artifact/key-injection paths,
  and preserves atomic tool history/Signals/short owner conversation turns.
- **Acceptance coordinator:** fresh-node WALK-TASK-ISOLATION/RESTART/STOPS,
  two different profiles concurrently, no remaining Pod/PVC, kept results;
  different-model frame-first review before stages implement this proposal.
