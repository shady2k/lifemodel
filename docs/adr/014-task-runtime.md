# ADR-014: Task runtime with a live, replaceable harness

Date: 2026-10-20. Task: lifemodel-653.5 (motor-1).

## Status and provenance

Direction confirmed by the owner; decision record proposed for integration,
not implementation acceptance. Different-model review passed for design handoff
at 28bc0345 after two rounds; [review evidence](../features/motor/tasks-design-review.md)
retains findings/dispositions and the coordinator's step-C verification.
Step C checks the pinned Kubernetes mechanisms, removes the CREATE webhook and
separate deadline reconciler, retains only the residual execution claim, and
sets the configurable warning lead to seven days. No third review round or runtime proof is claimed. The feature's confirmed frame is the
2026-10-20 comment beginning “Design frame for lifemodel-653 confirmed”. The
four 08:40–08:44 comments on lifemodel-653.5 settle storage, Stop and urgency.
They supersede the corresponding recommendations in
[the options history](../features/motor/tasks-options.md). No trade is reopened.

This record owns task orchestration; [ADR-015](015-storage-module.md) separately
owns the platform storage boundary. Separate records make sense because the
storage service has its own identity, release, state, outage and consumers,
including web downloads while the core is down. Their
[shared views](../features/motor/tasks-design.md) define the interaction.

## Amendment — 2026-10-26: the task Pod is one untrusted zone

Owner decision on lifemodel-653, 2026-10-26: the launcher, agent and commands it
runs are one untrusted zone. The barrier is the Pod boundary, not a boundary
between processes or containers inside it. This amendment governs D1's success
rule and D3's terminal outcome without changing their launch/finalization order.

The boundary enforces only what its trusted services can check:

- **Identity and authority:** `src/core/task-channel.ts` and
  `src/core/task-kubernetes-identity.ts` check audience-bound TokenReview, live
  non-deleting Pod/controller Job identity and controlled template; the mailbox
  checks the registered launch, won start claim and current intent/deadlines.
  `loader/src/task-identity.ts` binds that identity through one durable start
  claim and authorization projection. These checks identify the task, not which
  process inside its Pod made a request.
- **No platform keys:** `src/core/kubernetes-task-executor.ts` projects separate
  channel/model/storage audience tokens and the public CA, not provider, S3 or
  platform signing keys. Service tokens are task bearer identity, not proof of
  an honest launcher. The model gateway retains provider-key custody (ADR-013).
- **Scoped, sealed storage:** `loader/src/storage-access.ts` limits operations to
  the bound task space under current intent; `loader/src/storage-seal.ts` freezes
  writes, checks retained object length/hash and saves an immutable manifest.
  A seal verifies retained bytes and marks, not their meaning or correctness.
- **Network and resources:** `deploy/platform/d/network-policy.yaml` allows only
  the selected runtime listeners and kube-dns; other egress stays default-denied.
  `src/core/kubernetes-task-executor.ts` renders CPU/memory limits, restricted
  security context, a private ephemeral volume and the native Job time bound.
  Kubernetes availability still limits physical deadline/termination guarantees.

D1's ACP success rule is launcher policy **inside** the untrusted zone
(`loader/src/task-acp.ts`, `loader/src/task-launcher.ts`), not semantic verification
at the boundary. Outcomes, events and traces are the task's own claims, even
when authenticated, durably ACKed or sealed. D3's `done` records accepted task
success plus sealed output and finalization; it does not certify that the work
is correct or grant authority beyond sealing that task's own result and the reply.

Residuals: code inside the Pod can report false success for its own task, with
the same standing as untrue final agent text. DNS egress via kube-dns on UDP/TCP
53 remains allowed (owner decision, 2026-10-21); this policy does not restrict
query names or prevent DNS-mediated egress. Splitting launcher/agent/tools into
containers, signing, user namespaces or ptrace hardening is not adopted as a
fix for report truthfulness. Independent result verification is later work,
not a stage-3 guarantee.

## Amendment — 2026-10-27: live steering behind the harness port

The owner decisions on lifemodel-653.9 narrow the 2026-10-24 ACP-only
choice, not the [whole-Pod trust boundary](#amendment--2026-10-26-the-task-pod-is-one-untrusted-zone).
The evidence is [the ACP probe](../research/task-harness-acp.md) and
[the steering probe](../research/task-steering.md); the later owner decision
keeps prime-agent despite their negative recommendations. No upstream reports
are requested. Immediate stop deletes the Job, not an ACP cancel. Steering
never interrupts a turn.

**Harness and admission.** ACP drives start, session/update events and the
initial terminal response. A shared ACP client delegates native steering and
completion reconciliation to the selected agent's registry adapter, behind
`TaskHarness`; launcher and core must not import agent-specific code. A boundary
test enforces this. Registry adapters export `admit` and
`reconcileEndTurn` (returning `idle | continue | successor | unknown`);
`TaskHarnessEvent` gains a correlated receipt event. OpenCode 2.1.4 uses a baked local plugin and a stable native
message ID derived from the command ID, `delivery: "steer"`, always
`resume: false`. Prime-agent 0.10.1 uses native `steer` over the private socket
to the daemon backing that same ACP root session, not a second engine. Its
socket send is at most once: never retry it, including on a lost reply; socket
failure is `uncertain` and fails the task with `steer_uncertain`; it aborts the
harness mid-turn, an explicit exception to the non-interruption rule. Native Prime admission is in-memory,
not a durable exactly-once receipt. Relay injection lacks native history and
has compaction, tool-shape and Responses API risks; cancel/re-prompt interrupts
work; a second engine does not steer the ACP session. The probe rejects these
alternatives.

`steer({commandId, text})` returns promptly `accepted`, `rejected`, or
`uncertain`, without waiting for a model or tool. Accepted means native queue
admission, not obedience or completion. Later correlated receipts are
`inserted`, `deferred-to-next-turn`, `failed`, or `uncertain`; emit only when
evidence supports them. OpenCode can defer; Prime wakes on admission, so do not
claim its deferral without evidence. Receipts do not prove the model obeyed or
literal text appeared exactly once after compaction. Record command identity
and a pre-send state in a launcher-private, size-reserved journal before calling
the adapter, then
record its disposition before ACK to core. ACK `accepted` only after native
acceptance and that record; acknowledge rejected or uncertain honestly, never as
accepted. A concurrent replay of the same command joins the in-flight native call and
returns its disposition. After the launcher process loses that call, a Prime
pre-send or ambiguous state is uncertain, never a reason to resend. If recording fails after native acceptance,
report uncertainty, not a durable acceptance. Journal loss and Pod loss
are not recovery of execution; fail the task rather than rerun commands.

**End-of-turn barrier.** On ACP `end_turn`, atomically close this turn's intake
and settle admitted/in-flight calls. If a task question remains unanswered,
keep intake open for its correlated answer and ordinary steers, and wait until
admission or the accepted task timeout from the briefing (`softDueAt` in
`TaskAccessIntent`). At expiry the barrier ends unanswered and the task proceeds
as D4's `failed`/`timeout`; the 653.10 wrap command replaces this once available.
The Job deadline is the hard bound. Otherwise commands after closure receive explicit rejection or uncertainty.
OpenCode reconciles native IDs and pending items; admitted input causes a plain
nonempty ACP continuation prompt without resending it. Reopen intake for that
continuation turn and repeat the barrier. Prime admission wakes a successor run;
await it and repeat until the daemon reports idle and an empty queue. Before the
brief, bind the ACP session to exactly one native root; ambiguity fails closed.
Across turns use the last final text and retain tool state. Unsettled calls
always block success. Settled failures carry across a turn reset but later agent
prose or new/resumed tool work recovers them under the same within-turn policy;
a reset alone is not recovery.
A Prime successor succeeds only with daemon evidence of final text and settled
tools; missing tool evidence is `required_tool_failed` or uncertain, never
success. The accepted task timeout bounds every repeat loop. The Prime idle/queue/result
and tool evidence and production barriers are **unverified**: implementation
tests must prove race and loss paths. Ambiguity fails closed. Only after the
barrier, semantic checks and process-tree cleanup may the launcher declare its
terminal candidate; sealing still precedes public completion.

**Duplex control without Pod ingress.** Keep the existing outbound authenticated
HTTP frame posts. Add bounded launcher long-poll on the same task-only TLS core
listener, plus outbound command ACK/receipt posts; no ingress port into the task Pod.
Core commits immutable steer commands in its fenced Postgres mailbox before
making them available. Each carries task/attempt, command/message ID, direction,
sequence, kind (`steer` or `answer`) and text, optionally a question correlation ID.
Reserve `wrap` for 653.10; reject new steer and answer commands while wrapping. Delivery is ordered
per task; replay uses outstanding rows and exact IDs, not a contiguous watermark.
A redelivery with changed content conflicts. Launcher persists intake before
native send and replays its stored disposition after an ambiguous ACK. Core
persists that ACK before retiring delivery. Separate subsequent receipt frames
are idempotent and correlated to the command. Apply D2's identity, bounds,
timeout, per-task fairness and independent owner-intake reserves to both
 directions; no unbounded held request or worker. A commit-path in-process
notification wakes a held poll; a bounded recheck handles lost notifications.
Hold at most one poll per attempt, for at most 25 seconds, without holding a SQL
connection. The core-to-task ACK timeout is at least the adapter admission bound. Terminal/revoked tasks reject
new commands; no command is silently reissued to a replacement Pod.

**Questions and steps.** Supply launcher-hosted MCP tools over a stdio
subprocess in ACP `session/new` `mcpServers` (currently empty). The stdio server
is a thin launcher-shipped shim relaying to the launcher over an inherited pipe
or launcher-private local socket; it holds no channel credentials. Frames, IDs
and limits belong to the launcher and core. MCP operation,
including Prime under `--offline`, is unverified and requires real-harness tests.
One tool reports a bounded step, another asks a bounded question. The launcher
generates the question ID from the frame message ID, not agent input. Allow at
most one unanswered question per task; further calls fail explicitly. Core refuses
a `question` frame while that task has an unanswered question, including from a
compromised launcher. A question counts as answered once its answer command is
committed. The tool
returns after durable channel ACK, not an answer. Core stores the frame before
ACK and emits `task_report`; only `eventKind: question` wakes cognition. Its
trigger prompt reads the mailbox and presents the question as untrusted quoted
data. Cognition can answer or ask the owner. In a turn triggered by a task question,
`core.steerTask` may target only that task.

Add `core.steerTask` beside `core.startTask`, registered independently of Motor
Cortex, backed by new TaskService read, steer and answer operations. Leave legacy
`core.task` untouched for 97bj to remove. Agent-initiated steers and answers
need no user-message trigger; privileged effects require D7 grants only. Every
command ID derives from the deciding turn's recipient, correlationId and call
index, with `recoverAcceptedEffect` as for `core.startTask`. The tool returns
queued after the fenced Postgres commit, never waiting for launcher ACK or
receipts. A rejected or uncertain ACK or failed receipt is recorded on the
command and shown to cognition through TaskService read and status views.
Answers correlate to the question; the launcher prefixes the question
ID to their plain-text native continuation. The accepted deadline still applies.
ACKs and receipts are task claims, not core evidence of execution or obedience.

**Second registry entry.** Add `prime-agent` with the existing registry's ACP
command/args, version check, adapter module, provision and contract fixture;
pin 0.10.1 from upstream and checksum every required architecture asset. Provision
the adjacent distribution/runtime and baked Python packages as well as the
binary; the probe's executable-only sketch is incomplete. Bake non-secret
models/settings templates and offline controls, then render the dynamic relay URL
and private daemon socket into task-private config. No startup installs or
external bootstrap. Both supported architectures require verified pins for both agents;
a missing pin fails the workbench build instead of omitting a harness.
Append Prime to the registry so its first key and default remain OpenCode. The
loader setting selects a registered harness at acceptance and snapshots it in
the task record/briefing; caller input and Job environment do not change. The
probe found Prime's ACP permission method missing and Python exceptions reported
completed; the owner accepts those gaps, not a claim they were fixed. Prime’s
Python-tool path is exempt from the required-tool failure contract and has
weaker failure detection; other missing required-tool evidence cannot succeed.

## Amendment — 2026-10-28: recovered model requests and partial outputs

Owner decision on lifemodel-653.9 (verbatim): «Давай. Но это в принципе
неправильно помечать задачу ошибочной. Prime-agent прекрасно умеет ретраить».

D1's “no provider error” means no terminal ACP prompt error, not zero failed
HTTP requests. An intermediate model request the agent recovers from never
fails the task. The completion barrier, normal turn end, final text, required-tool
checks and cleanup still apply to every harness. `provider_error` names an ACP
prompt error or an abnormal turn with an outstanding model-request failure.
A normal turn without final text remains `no_final_result`.

Each failed relay request is a `task.model.request` child of `task.model`, with
failed status and warning severity, HTTP status (null without a response), method,
allowlisted path without query, duration and attempt ordinal. Failed children
remain visible under a successful model/task. An unrecovered provider failure
links `failureSpanId` to its deciding request; a prompt error with no outstanding
request failure gets a safe ACP error observation. Excerpts are at most 300 UTF-8
bytes, selected only from upstream JSON `error.message`, `error.type`, or
`error.code`. No raw body, headers, prompts or raw ACP error is recorded; known
credentials are redacted and credential-bearing fields omitted. Oversized or
non-JSON error bodies have no excerpt. Gateway failure warnings include status,
slot route and trusted task/trace identity even if reserve recovers. The gateway
already obtains that trace context from task authorization, not caller headers.

D3's retained-partial-output rule includes regular files in the launcher's
`outputs/` folder after failed or aborted harness completion. Validate, upload
and mark them under the same limits as successful output. They are diagnostic
partial objects, never attachments to a successful owner reply. Already marked
objects survive later transfer failures; hard deletion cannot retain bytes that
were never uploaded. Sealing and public-outcome policy are unchanged.

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
| T03 | Task has zero RBAC and no model/S3/git/store signing key; explicitly projected service-audience SA tokens are bearer bootstrap identity, not secret keys (owner) | `tests/integration/task-identity.test.ts`: **two task UIDs**, wrong audience/SA/Pod/Job/owner reference, unbound late-create Pod, replay after revoke, token rotation and paused binding projection; WALK-TASK-ISOLATION inspects specs/env/files/logs without printing secrets |
| T04 | Persist task registry/mailbox in **Postgres**, tick/outbox signals in existing **Valkey** seams; no file state or task store client (frame, standing durable-home rule) | `tests/integration/task-restart.test.ts`: read-only DATA_PATH and kill/restart core at **eight boundaries** named in D3; zero lost ACKs and one terminal event key |
| T05 | Commit launch/profile/effect intent before dispatch; one launch authorizes **at most one harness execution**, including controller replacement Pods (ADR-010 keyed effects) | `tests/integration/task-launch-fence.test.ts`: **two core epochs + two candidate Pod UIDs**, delayed create/AlreadyExists/adopt/stop/delete, controller restart or lost Pod-create observation, duplicate/lost start reply and authority restart; render Never/0/Failed plus fail-on-disruption/nonzero policy; WALK-TASK-RESTART verifies one claim, zero replacement harness starts, failed partial outcome and cleanup |
| T06 | Network is deny-first; task can reach only scoped runtime services and granted egress; internal cluster targets/other files/keys remain hard-denied (owner, ADR-013) | `tests/integration/task-consent-contract.test.ts` plus WALK-TASK-ISOLATION: **two profiles**, no-network and one approved domain, forbidden methods/private IP/redirect/domain denied |
| T07 | Both harnesses expose live commands/events/one semantic terminal result; one stalled task cannot block owner intake (owner) | `tests/integration/task-harness-contract.test.ts`: **shared ACP lifecycle, two real agent adapters + one scripted agent**; with one blocked task, 20 owner intakes and 20 second-task control messages each ACK **within 2 s**; D2 bounds hold. Check mid-tool steering, parallel tools, final-answer races, in-flight duplicate replay, question wake/end-turn/round trip and flood refusal, missing successor tool evidence, hard stop and errors |
| T08 | Soft Stop and agent timeout wrap up without new external effects; hard deadline defaults to **300 s**; hard Stop deletes immediately; stop-all soft-stops current tasks, not core (owner answer) | `tests/integration/task-stop.test.ts`: virtual clock, **two running + one queued + one starting**, repeated Stop/timeout/hard/all; WALK-TASK-STOPS checks mutable Job deadline shortening from startTime, no extension/suspend, delayed patch/conflict/restart and core-down timeout/soft Stop; observes native deadline termination, real hard-delete requests, retained marked bytes and no remaining Pod/PVC |
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
ACP over stdio owns lifecycle and events; agent-specific native steering is
confined to registry adapter modules as specified by the
[2026-10-27 amendment](#amendment--2026-10-27-live-steering-behind-the-harness-port).
Launcher/core know only the port. Success requires the completion barrier, ACP
`end_turn` or the reconciled Prime successor result, final assistant text, no
terminal provider error (recovered request failures are warnings; see the
[2026-10-28 amendment](#amendment--2026-10-28-recovered-model-requests-and-partial-outputs))
and no unresolved required tool failure; CLI 0 or a completed
step alone is not success. This is policy inside the untrusted Pod, not a
boundary guarantee. `cancelled` maps to aborted.

Jobs use restricted security context, one generic ephemeral working volume,
private HOME/session directories, `parallelism: 1`, `completions: 1`,
`restartPolicy: Never`, `backoffLimit: 0`, `podReplacementPolicy: Failed` and
an absolute hard deadline. `podFailurePolicy` fails the Job on
`DisruptionTarget=True` or any nonzero launcher/container exit (NotIn [0]);
all unmatched failures count, never Ignore. These policies prevent normal
retry and wait for terminal Pods rather than replacing a terminating Pod.
They are supported by the pinned k3s v1.35.8+k3s1 / Kubernetes v1.35.8; the
replacement policy is GA/locked on since 1.34 [K]. They are not a documented
at-most-once program-start guarantee; D3 covers the remaining ambiguity. No shared source/workspace volume. Both harnesses
use baked mounted non-secret endpoint/model configuration; an agent's ignored
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
rather than accept SA-only identity. Core allocates the space (ADR-015); the existing model gateway identity
endpoint verifies actual Job/Pod ownership and registers the once-only binding
of D3. Its platform-only authorization projection verifies launch identity. No task can patch labels, request tokens or reach the API.
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

A task uses outbound TLS posts and a bounded long-poll to a task-only core listener, as specified by the 2026-10-27 amendment. Commands and
events carry task/attempt ID, immutable message ID and per-direction sequence.
Postgres inserts idempotently before ACK; replay scans outstanding rows by exact
IDs, never assuming contiguous IDs after deletions. Core emits normal Signals through its
existing bus seam; control transport envelopes are not a second cognition
model. Owner input is never sent raw to a task; the agent turns it into steer.
`step` is a bounded short line; `question` asks the agent, which may ask owner.
Use independent per-task queues; output/log bytes go **directly to storage**,
not this stream. Design defaults: control frame **64 KiB**, at most **16**
unacknowledged frames/**1 MiB** per task connection, **4 MiB** process-wide
control buffer, **5 s** event ACK timeout before disconnect/replay; command ACK timeout is
at least the bounded adapter admission time. Event processing
uses round-robin task queues, at most **one frame per task per scheduling pass**;
control/owner-intake workers and their bounded SQL pool reservations are separate
from artifact transfer workers. Saturated task queues apply backpressure/429,
never borrow the owner-intake reserve. T07's 2 s fixture bound tests this
mechanism locally without claiming a production network/LLM latency SLO.
Frame/queue/timeout values are typed platform settings with hard validation;
raising them requires rerunning the fixture, not silently permitting infinity.

The launcher records command intent before native admission and ACKs acceptance only after its adapter accepts and records the disposition in its launcher-private size-reserved journal; rejected and uncertain dispositions are never reported as accepted. A core restart preserves that journal
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

**Kubernetes fencing after coordinator verification:** no task CREATE
webhook. Deterministic launch names give AlreadyExists/GET/adopt, not a second
Job, and current canonical intent plus live Pod/Job identity gates all runtime
binding. A delayed old-epoch Job/Pod CREATE may reach Kubernetes after Stop;
it can consume bounded startup resources but stays an inert launcher, cannot
start a harness or obtain model/storage/effect rights, and the existing core
registry reconciler deletes it by exact UID on watch/resync. This is not a
promise that no stale Kubernetes object can exist. Keep launch tombstones;
never authorize another Job UID for that launch after terminality or loss.
A delayed deletion must match recorded irreversible stop/cleanup intent and
UID/resourceVersion preconditions; no Job-name-only delete and no launch reuse.
Core losing its SQL fence stops dispatch; takeover reconciles deterministic
names before new dispatch. No separate epoch-admission service is needed.

**Residual once-only execution claim retained, not a new service:** D1's
Never/0/Failed/failure policies remove normal replacement retries but do not
make Job Pod creation transactional. Kubernetes explicitly warns that even a
one-completion, one-parallelism Never Job can start a program twice [K]. The
pinned controller uses informer observations and in-memory creation expectations
that expire after five minutes; failed/unknown Pod-create responses or controller
restart do not create a durable application start claim [KC]. Failed waits for
known terminating Pods; it cannot fence an unobserved duplicate. Do not turn
normal-controller behaviour into a no-rerun guarantee for ambiguous shell acts.

Keep one small SQL claim in the existing verified-binding operation, served
by the platform model gateway's task-identity listener, not a standalone gate
process/deployment. Each Pod starts an inert launcher, not a separately trusted
reporter (see the [2026-10-26 amendment](#amendment--2026-10-26-the-task-pod-is-one-untrusted-zone)). TokenReview,
live non-deleting Pod/controller Job UID/template/launch checks and current
canonical nonterminal intent precede a CAS on launch ID, Pod UID and fresh
memory-only process boot nonce. The same verified binding transaction records
Job.startTime and the snapshotted soft/hard timeout bounds before any start
permit, so core loss cannot leave deadline authorization uninitialized. Only
the durable winner receives runtime binding and a start ACK; both candidate UIDs cannot win. The launcher retains
its guarded single-start transition. Lost/timed-out reply consumes the claim
and fails conservatively even if an ACK arrives later; reconnect reads binding
but never grants a new start. New process/nonce or Pod UID cannot reacquire it.
First execution Pod loss fails with partial/uncertain effects, never reruns.
Duplicate/replacement Pods stay inert and are deleted. Retain the claim through
all late-create/cleanup paths. Gateway/SQL/API outage denies start, not a
fallback run. T05 must exercise observation loss/authority restart as well as
normal failed-Pod handling; no runtime test is claimed by this source review.

Static guards use Kubernetes built-ins, not a live SQL webhook: RBAC and PSA,
ResourceQuota/LimitRange, and a service-free ValidatingAdmissionPolicy/CEL rule
for the task namespace. Validate approved SA/image/template bounds, owner
reference/launch-label consistency and fixed Never/0/Failed/failure policy;
reject suspend/resume, manual selector/adoption, deadline removal/increase and
launch-identity mutation. On Job UPDATE, require non-null
`activeDeadlineSeconds <= oldObject.spec.activeDeadlineSeconds`; deadline-only
patches use UID/resourceVersion CAS. Pod CREATE checks owner-reference shape
and launcher-only template, not a nonexistent pre-CREATE UID. CEL cannot query
SQL/current epoch or resolve an owner reference by itself: live binding checks,
not labels/CEL, provide that proof [V]. Old-epoch late object creation is the
narrow residual, safely denied execution by the claim/intent path above.
Platform control handlers hold only necessary namespace-scoped create/read/
patch/delete; task SAs still have none.
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

Normal success requires reported semantic harness success and a sealed result;
this is not verification of the task's claim (see the [2026-10-26 amendment](#amendment--2026-10-26-the-task-pod-is-one-untrusted-zone)). Runtime
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
permission and persists `wrapping-up` plus one wrap command on the 653.10 wrap path.
New steer and answer commands are rejected during wrapping. Harness should
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
even while core is down, then reports the keyed event on reconnect. Canonical
database-time authorization independently denies new effects after softDueAt
and all task operations after the hard bound, even with delayed timer reporting.

**Drop the separate platform deadline reconciler.** At Job creation set Job-level
`activeDeadlineSeconds = timeout + snapshotted wrap grace`. Kubernetes' Job
controller enforces it without the core; it is mutable on a running Job [K, KC].
Earlier soft Stop persists `hardStopAt = min(existing hard bound, first Stop +
snapshot grace)` and immediately patches the same Job. The field is a duration
from persisted `Job.status.startTime`, **not an absolute timestamp or a new
countdown from patch time**: set it to
`min(current ADS, floor((hardStopAt - Job.startTime) / 1 second))`.
If due/nonpositive, delete immediately rather than write an invalid value.
Use UID/resourceVersion CAS, GET/retry on conflict, never move the bound later;
CEL rejects increases/removal/suspend so a delayed stale patch cannot extend it.
Set `terminationGracePeriodSeconds: 0`: the 300 s application wrap has already
provided the grace. Node/API/controller outage still prevents a literal timed
physical kill; report unhealthy, never promise instantaneous termination.

The existing task-control operation in core (agent) or loader/web domain handler
(owner, even with core down) owns this finite patch, not a new timer worker.
Persist keyed intent and patch-pending receipt before the request; Stop returns
`enforcement pending` until GET verifies the shortened bound on the correct UID.
If the handler dies between SQL commit and PATCH, the original native timeout
still holds, authorization already forbids effects, and the existing durable
control-operation replay on handler restart retries the patch. Do not claim the
earlier physical bound was installed before that receipt. Native Kubernetes
eliminates the independent deadline scheduler **after patch confirmation**;
no cross-store atomicity is invented. T08 kills core after confirmation and
also tests the pre-patch crash gap, API-down pending status and recovery.
A never-started/missing startTime Job is stopped/deleted, never launched just
to obtain a timer; late CREATE remains inert under D3. Timeout keeps the same
soft-wrap path and fixed native outer bound.
Hard “stop now” records revocation/stop intent and initiates storage revoke
and Job DELETE in parallel **without waiting for harness, seal or upload**.
Removal uses zero requested grace; API latency and kubelet termination are
observable, not promised instantaneous physical deletion. Storage enforces
revocation as ADR-015 defines; only already stored and marked objects survive.
Seal/terminal reply can follow later. Repeating hard Stop is idempotent.
Soft/hard Stop on a queued task creates no Job and yields stopped/empty seal;
on starting task it cancels the reservation, denies late launcher binding/start
and reconciles late Kubernetes objects for deletion.

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
ResourceQuota/LimitRange and service-free CEL admission enforce profile CPU/memory/time
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
- Storage remains a separate service. Identity/start binding reuses the model
  gateway; CEL admission and native Job deadlines need no webhook/deadline
  deployment. Binding SQL/API outage fails closed, not to SA-name fallback.
  A Stop patch crash gap remains explicit as enforcement pending, not success.
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

[K] [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/):
Handling Pod/container failures (explicit duplicate-program warning), Pod
replacement policy, Pod failure policy and Job termination/active deadlines.
Pin evidence: `scripts/install.sh` sets `K3S_VERSION="1.35.8+k3s1"`;
`flake.nix` injects locked nixpkgs `k3s` into `deploy/nixos/default.nix`, which
asserts that exact package. `flake.lock` pins nixpkgs
`7993f34ee47e28a3d607a525aadc6c94b73be728`; its
[alias](https://github.com/NixOS/nixpkgs/blob/7993f34ee47e28a3d607a525aadc6c94b73be728/pkgs/top-level/all-packages.nix)
selects `k3s_1_35`, whose
[version](https://github.com/NixOS/nixpkgs/blob/7993f34ee47e28a3d607a525aadc6c94b73be728/pkgs/applications/networking/cluster/k3s/1_35/versions.nix)
is 1.35.8+k3s1. The pinned
[k3s go.mod](https://github.com/k3s-io/k3s/blob/e952d68a5a5f8953c4549cf8fb557f3eae417107/go.mod)
selects Kubernetes v1.35.8-k3s1. Its
[feature table](https://github.com/k3s-io/kubernetes/blob/v1.35.8-k3s1/pkg/features/kube_features.go)
locks JobPodReplacementPolicy GA on at 1.34.

[KC] Pinned Kubernetes source:
[Job controller](https://github.com/k3s-io/kubernetes/blob/v1.35.8-k3s1/pkg/controller/job/job_controller.go)
(`syncJob`, `manageJob`, `onlyReplaceFailedPods`, `pastActiveDeadline`),
[controller expectations](https://github.com/k3s-io/kubernetes/blob/v1.35.8-k3s1/pkg/controller/controller_utils.go)
(`SatisfiedExpectations`, `ExpectationsTimeout`, in-memory store),
[Job validation](https://github.com/k3s-io/kubernetes/blob/v1.35.8-k3s1/pkg/apis/batch/validation/validation.go)
(`ValidateJobSpecUpdate` permits ADS mutation). Source review, not a cluster
probe; duplicate creation is a residual failure case, not normal retry policy.

[V] [ValidatingAdmissionPolicy](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/):
in-process CEL rules over object/oldObject/parameters, without a webhook service.
Static policy cannot replace canonical task-intent or live-UID authorization.

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
  native monotone Job deadline patches/receipts, simultaneous core restart and
  hard Stop, patch-pending crash/replay and core-down post-patch termination.
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
