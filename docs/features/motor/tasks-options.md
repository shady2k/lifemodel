# Task runtime: options before the design record

Design step A for lifemodel-653.5, 2026-10-20. **Proposals, not accepted architecture or built
behaviour.** The confirmed frame is the feature comment of 2026-10-20 starting “Design frame for
lifemodel-653 confirmed”. This note stops at the owner's trades; it does not amend an ADR or
start implementation.

## Owner answers after step A (2026-10-20)

This document is history, not the final decision. The owner's four comments on
lifemodel-653.5 replace these recommendations; [ADR-014](../../adr/014-task-runtime.md),
[ADR-015](../../adr/015-storage-module.md) and the
[task views](tasks-design.md) record the chosen direction.

- **§4 changed:** a separate platform storage module owns all storage authority,
  allocation, confinement, sealing and byte transfer. Tasks call it directly with
  projected SA tokens, not through core. All callers use its own API/CLI, never
  S3. SeaweedFS credentials stay only there; the owner accepts proxy byte cost.
- **§3 / trade 2 changed:** soft Stop asks the harness to wrap up without new
  external effects, then enforces a settings deadline (default five minutes).
  Agent-set timeout follows the same path. Hard “stop now” deletes the Job at
  once, preserving only already stored and marked output. “Stop all” is soft
  for every current task and does not stop lifemodel.
- **§5 / trade 3 changed:** FIFO within urgent and ordinary queues; urgent starts
  first when a slot frees. Either owner or agent may set urgent. No preemption.
- **Trade 1 settled:** all bytes cross the storage module for live confinement
  and revocation, not direct presigns. Step A's core-owned upload/broker shape
  is superseded, not silently relabelled.

The other options below retain their original wording as history. None is a
present-tense claim about what is built.

## Outcome, drivers and fixed choices

The owner hands long work to lifemodel and keeps talking. The agent answers at once, briefs a
task, steers it live, and returns a summary and attachments. The owner never writes directly to
the harness. In priority order:

1. **D1 Isolation:** two concurrent tasks cannot read each other's files or use another task's
  authority; no model/storage signing key enters a task; model calls reach only the platform
  gateway. Check denied cross-task calls.
2. **D2 Nothing lost:** restart the core at each launch/finalization boundary; recover the same
  task, retained output and one terminal outcome, not a second shell run. Stop/failure retain
  acknowledged output with a reason.
3. **D3 Consent:** before a task changes anything outside its workspace, an exact, current grant
  must exist; replay, wider scope and expired grants fail at the platform boundary, not merely
  in a prompt.
4. **D4 Live steering:** reconnect after a core restart and replay acknowledged messages without
  loss; one task's slow stream cannot block owner intake.
5. **D5 Replaceability:** OpenCode and prime-agent pass the same harness contract; a fake
  executor passes the Jobs executor's caller contract.
6. **D6 Limits:** concurrent admitted Jobs never exceed the effective setting; resource/deadline
  admission rejects excess and survives a core restart.
7. **D7 Visibility:** every accepted task has a durable status, step line, log cursor and result
  or failure reason available to the agent and later UI.

Constraints from that frame: single-node k3s, default-deny networking, Postgres task registry,
one CI-built signed/digest-pinned workbench. Both harnesses and SeaweedFS (`weed mini`) are
**already chosen**, not options to reopen. Output retention is 90 days, with forever/pin, a 20
GB ceiling and one batched warning. The measurements below are proposed checks, not new
latency/RPO promises.

## Inventory before options

| Part | Exists today / evidence | Reuse or replace |
| --- | --- | --- |
| Launch / loop | `src/runtime/motor-cortex/motor-cortex.ts` enforces one active agentic run; `motor-loop.ts` calls the LLM in core; Docker handles and abort controllers live in memory | Replace with task service + executor/harness ports; old loop/Docker removal belongs to 97bj, no compatibility runner |
| Registry | `motor-state.ts` rewrites the `motor-runs` object through `Storage`; today `PostgresStorage` stores it in `core.kv`, not a file | Reuse Postgres, replace whole-object read/modify/write with keyed task rows and transactional transitions |
| Cognition tools | `core/act.ts` builds prompts/workspaces/deps and resolves credentials; `task.ts` reads local logs/artifacts and gates approval on trigger type | Keep short async delegation and result signals, replace concrete Motor calls with ports; trigger type is not an exact-scope grant |
| Skills / credentials | `core/skill.ts` reads files/policies and starts Motor review; `core/credential.ts` sets process-env credentials; Motor injects values into shell | Skills become Postgres instructions (ADR-010 Q4); no key injection or policy-file approval reused as authority; OpenBao/grants are ey3e |
| Output | `task-logger.ts` appends best-effort local `log.txt`; Motor copies workspace files to a local artifact directory | Replace with acknowledged durable events, retained output objects and a validated manifest; no local durable-state fallback |
| Core stores | `src/core/container.ts` builds pg Pool + iovalkey from required URLs; `fenced-postgres.ts` fences writes; snapshot/bus use Valkey epoch CAS | Reuse `src/storage/` implementations and `src/ports/` domain operations, never give task pods raw clients or store passwords |
| Model gateway | `loader/src/model-gateway{,-app}.ts`, ADR-013: platform-owned Chat Completions + models; ignores inbound Authorization; trusts core network identity | Reuse key custody, safe response filtering and failover; add a separately authenticated task ingress, not broad access to core's listener |
| Loader / settings | `loader/src/http.ts` has session/CSRF guards and explicit model routes; `web/loader/src/App.tsx` hand-renders settings; `core.settings` is one config document | Reuse auth, kit and store seams; add typed declarations and domain settings operations, not a second untyped JSON editor |
| Web | ADR-011 D4 operations only; ForwardAuth and same-origin downloads; no task API today | hf2k needs explicitly approved narrow task/read/download/Stop operations; no raw pg/Valkey/S3 client in web handlers |
| Platform | ADR-010 Jobs/ephemeral volumes, PSA/admission, namespace RBAC and deny-first policies are the target; ADR-012 owns repair/login | Reuse platform release/bootstrap ownership; extend named policies explicitly, never let a task create/patch labels, Jobs or grants |

Today's disabled Motor registry already reaches Postgres indirectly; the missing piece is a
concurrent, keyed task registry, not a proposed file-to-SQL migration. ADR-010's Motor-
schema/module view predates the confirmed **core starts Jobs** frame: final design must name its
schema owner and amend that view explicitly.

## Options and recommendations

Each option is judged **D1 → D7**, in that order; ties mean no material difference. Sources [R],
[J], [K], [E] and [S] are collected below. Costs include failure and tenfold-load behaviour, not
only the single-node happy path.

### 1. Task identity at the model gateway, channel and S3 broker

- **A — workload identity: projected ServiceAccount token + TokenReview [K].** D1: no signing
  key in task; token is still a stealable bearer capability. Validate audience, expiry, bound
  Pod UID and the trusted Pod→Job UID→task mapping, not a task-supplied header/label alone. D2:
  kubelet rotates it; verifier fails closed on API outage. D3: identity grants no extra action.
  D4: reconnect authenticates afresh; D5: harness-neutral launcher handles it; D6: validation
  rate/cache bounded; D7: audit task/Job IDs, never token bytes.
- **B — capability security: core-minted, signed per-task JWT [E, K].** D1: no private signer in
  task, but another bearer and a new signing authority in the changeable core. D2: issuer
  rotation, restart custody and revocation ledger must survive; D3: a JWT scope cannot replace
  live consent checks. D4/D5: portable outside Kubernetes; D6: local validation scales better;
  D7: issuance/revocation needs its own audit. Reject extra authority for now.
- **C — trusted relay: no task model identity, core relays model calls [E].** D1: gateway
  remains core-only, but core must bind every task connection; D2: core outage cuts model
  streams too; D3: still needs grant checks; D4: couples steering and inference availability;
  D5: portable harness URL; D6: inference bytes compete with chat; D7: attribution is relay-
  owned.

**Recommend A.** Disable automatic API-audience token mounting and project only service-specific
audiences; zero-RBAC task SA, no API-server network route. A platform verifier uses its own
TokenReview permission and namespace-scoped Pod reads; require TokenReview's bound Pod identity
and a live UID match, or reject, never fall back to SA name. Gateway/broker/channel share the
validation contract, not a signing key. A new task-only gateway listener validates identity,
then supplies `x-lifemodel-session = task ID` itself; the existing core listener keeps ADR-013
behaviour. Placeholder Authorization from Prime is not identity.

### 2. Live agent ↔ task channel and the two harnesses

- **A — Pipes and Filters + durable request/reply [E]: outbound task stream through core,
  adapter RPC only inside pod.** D1: only task listener exposed; D2: persist event/command IDs
  and ACK before advancing cursors; D3: messages carry requests, never grants; D4: bidirectional
  reconnect/replay and bounded backpressure; D5: normalized port hides both APIs; D6: per-task
  byte/rate bounds; D7: ordered step/log projection. Core outage pauses steering only.
- **B — Message Channel / competing consumers: tasks use Valkey Streams [J,E].** D1: per-task
  ACL credentials enter pods (or a broker recreates A); D2: good replay but ACL/trim/consumer
  lifecycle grows with every task; D3: stream writes cannot grant access; D4: good live
  exchange; D5: transport-neutral; D6: tenfold tasks multiply clients/ACLs; D7: ordered but raw
  harness events still need normalization. Reject direct store authority in tasks.
- **C — synchronous request/reply: core calls each pod's HTTP server [R,E].** D1: opens per-pod
  ingress; D2: streams alone lose gaps at core restart; D3: same grant hook required; D4: simple
  live calls, fragile pod addressing; D5: useful only behind a common adapter; D6: core fan-
  out/reconnect work; D7: needs a separate durable event sink. Reject as the cross-pod
  transport.

**Recommend A:** one outbound TLS stream from launcher to a task-only core endpoint; ordered
command/event envelopes `{taskId, attemptId, id, sequence}`. Postgres holds the acknowledged
mailbox/cursors; Valkey carries core-owned signal hints through existing seams, not a new source
of truth. OpenCode's loopback server messages/SSE/abort and Prime's stdin/stdout RPC
prompt/abort map to `steer`, `question`, `step`, `log`, `artifact`, `terminal`; internal raw
APIs never leave the pod. Adapter acceptance must prove mid-run steering, not just print mode.
Result/failure/stopped normalize semantic events + process state; CLI 0, `agent_end` or
`step_finish` alone never mean success [R].

### 3. State, restart reconciliation and one terminal outcome

- **A — Registry + reconciliation loop + Transactional Outbox [K,E,J].** D1: pods hold no
  registry client; D2: Postgres owns intent/result, Job owns observed compute lifecycle, neither
  overwrites the other; D3: grants stay separate; D4: recover mailbox alongside registry; D5:
  executor returns a stable external handle; D6: transactional admission; D7: explicit
  finalizing and cleanup states. Extra reconciler, but no second workflow engine.
- **B — event sourcing / Job as sole truth, reconstruct task on restart [K,E].** D1: possible
  without pod keys; D2: deleted Jobs cannot recover briefings, queue order or results; add a
  durable event store and it ceases to be Job-only. D3: consent history also external; D4:
  reconstruct delays steering; D5: Kubernetes status leaks into callers; D6: queue needs another
  owner; D7: exit code is not a retained result. Reject the Job-only assumption.

**Recommend A.** Natural launch key comes from the committed deciding turn; insert task + launch
intent before dispatch. Deterministic Job name and stored UID let a lost create response adopt
that exact Job, never blindly create a second one. `restartPolicy: Never`, `backoffLimit: 0`; no
auto replay of ambiguous shell effects. Fence core writes and stale reconciler actions; an old
core losing its fence must stop dispatch, and admission binds the launch identity so delayed
creates cannot become a second execution. On startup list nonterminal rows and namespace Jobs,
adopt matching handles, resume streams, reconcile missing/failed Jobs with a reason, and re-
drive cleanup. Unique terminal row/CAS + same-transaction outbox gives one logical outcome;
consumers dedup its event key. Delivery remains at-least-once, not exactly-once shell execution
or a Postgres/Kubernetes/S3 transaction. Seal the manifest before terminal success; track
cleanup separately so a dead cleanup worker cannot resurrect a task. Stop records intent first,
aborts new effects, drains acknowledged output within a declared grace, then deletes Job and
verifies Pod/ephemeral-PVC removal. Do not enable TTL cleanup before seal.

### 4. Artifact authority, retained output and owner download

- **A — capability URLs: core broker presigns each object [R,S].** D1: signer stays outside, but
  task/browser holds a transferable URL; D2: idempotent upload ID + checksum + seal recover
  incomplete publication; D3: issued URLs survive revocation until expiry; D4: bytes bypass
  core; D5: S3 seam; D6: PUT URL alone does not enforce byte quota; D7: publish only after
  verification. Requires a narrowly reachable S3 data route.
- **B — Proxy / reference monitor: broker streams every operation [R,E].** D1: no S3 key or URL
  in task, only its workload token; S3 stays private; D2: durable upload ledger/chunk ACKs,
  retry by immutable ID; D3: check live task/grant on each new operation, cancel revoked
  transfers; D4: more bandwidth/CPU and one chokepoint; D5: S3 behind broker; D6: enforce actual
  byte counts before ACK; D7: manifest publishes validated IDs, not paths.
- **C — federated identity: SeaweedFS STS web identity [R,S].** D1: direct STS returns signing
  keys to task, disallowed even if short-lived; D2: expiry/revocation/restore more complex; D3:
  session policy is not exact action consent; D4: direct transfer; D5: S3-compatible but IAM-
  specific; D6: prefix policy ≠ byte quota; D7: requires IAM audit. Reject direct STS; broker-
  held STS remains optional defense in depth for A or B.

**Recommend B initially, behind an artifact port.** Core owns authorization and upload records;
a separately bounded trusted broker data path holds S3 signing authority in platform custody,
not cognition or the task. Use immutable upload IDs, canonical relative names (reject
traversal/symlinks/special files), byte reservations, hashes and read-only sealed manifests.
Stream log/result chunks during execution; end-only copy loses output on failure. Only durable
ACKed bytes are guaranteed; force-kill/node-disk loss can lose unacknowledged bytes. Owner GET
is same-origin through ForwardAuth/web and a narrow domain download operation that proxies
broker bytes with no-store/attachment headers; web gets no raw store client, public Seaweed
route or durable signed URL. Attachments store artifact IDs and resolve through that same
authenticated route. Retention GC must coordinate active reads, pin and publication; never
delete pinned data to meet quota: stop new uploads and warn if only protected data remains.

### 5. Queue, admission and fairness

- **A — database work queue + FIFO, transactional admission [E,P].** D1: no pod credentials; D2:
  Postgres `queued` row/order survives restart; D3: recheck effective profile/grants at
  dispatch; D4: waiting does not block chat; D5: executor-neutral; D6: lock one admission
  counter/row while reserving slots (SKIP LOCKED alone cannot cap aggregate concurrency); D7:
  stable order.
- **B — weighted fair queues per project, reserved owner slots [E].** D1/D2/D3: same durable
  boundaries; D4: urgent work can start sooner; D5: neutral; D6: needs starvation/aging policy
  and project identities; D7: less obvious ordering. Reject priority machinery before a
  demonstrated fairness need.

**Recommend A**, oldest accepted first with ID tie-break, no model priority flag. “В очереди”
means durably accepted, no compute slot/Job yet, not a paused pod or a lost in-memory promise.
Reserve starting/running/finalizing Jobs until compute is confirmed stopped; reconcile uncertain
creates before releasing a slot. Lowering concurrency lets existing Jobs drain, admits none
until below limit. Quota-induced Pending Jobs occupy a slot and show an infrastructure reason;
bounded startup failure releases it only after cleanup is confirmed.

### 6. Typed settings registry: location and loader rendering

- **A — core-owned metadata API (Registry + Metadata Mapping [N,E]).** D1: secret get absent;
  D2: reuse `core.settings`; D3: changeable core cannot be the authority for owner ceilings; D4:
  loader settings fail with core; D5: natural runtime integration; D6: needs independent
  platform validation; D7: UI metadata easy to enumerate. Reject as sole policy authority.
- **B — platform-owned registry + typed read projection [N,E].** D1: separate secret descriptor
  has set/delete/exists only; D2: settings in Postgres, loader is repair path independent of
  core; D3: platform validates writes; D4: runtime reads versioned effective values; D5: pure
  TypeScript declarations; D6: platform admission consumes same revision; D7: loader renders
  controls from descriptions, not a duplicate list. More bootstrap/store plumbing.

**Recommend B for new Motor settings**, in a loader-owned settings module; shared pure
descriptor types/validation may be built into both processes, but core cannot author the
platform registry or raise ceilings. One declaration per setting: typed key/value, default,
label/description locale keys, section, control, data class, choices, bounds/unit, authority and
apply timing. Reject unknown keys/types and duplicate declarations; no numeric “forever”
sentinel. Loader API enumerates safe descriptors/current values; generic kit controls render
them, with errors at that field. Secret storage is OpenBao only, never a returned default/value.
Use narrow settings store operations on a dedicated platform-owned Postgres scope; add explicit
bootstrap grants/migrations, not loader JSON files or direct access to core's whole config
document. Keep current core settings ownership; this is the first registry step, not their
silent move. Harness selection snapshots at acceptance (recommend OpenCode default); later
changes affect new tasks only. Concurrency applies at next admission; retention changes apply
through announced GC. Other defaults need derivation/prototypes, not inheritance of old Docker
constants. ey3e adds ceilings/dangerous-action list declarations to this registry and enforces
them outside core.

### 7. Consent hook left for ey3e

- **A — capability grant ledger + reference monitor [E].** D1: access stays at trusted boundary;
  D2: grant/action-use rows survive restart; D3: exact action digest, target, allowed operation,
  task/attempt, expiry and use key; D4: task requests, agent asks/steers; D5: harness-neutral;
  D6: grant never overrides hard denials; D7: request→owner receipt→grant→use is auditable.
- **B — policy-as-code only: approval patches a NetworkPolicy label or Bao role [K].** D1: can
  narrow reachability; D2: cluster/Bao reconciliation needed; D3: a domain/role allows more than
  “push this branch once”, so not sufficient; D4/D5: live and neutral; D6: useful coarse
  backstop; D7: lacks exact-use audit.

**Recommend A with B as enforcement backstop.** 653 carries opaque request/grant references and
denies any ungranted external-effect operation. ey3e interprets owner words, binds the exact
proposal/receipt (explicit words for configured dangerous actions), persists/revokes grants,
then platform code changes approved profile labels/egress policy. Tasks cannot patch labels or
mint grants. A label opens only the approved gateway, never arbitrary cluster access; L3/L4
policy cannot enforce a domain or HTTP verb. Egress checks domain, redirects, private addresses
and operation scope. Bao role permits only broker-side credential use; a short-lived push
credential stays in the trusted push/PR service, not a task env/file. That service accepts an
approved immutable diff/branch action, not arbitrary git transport with reusable credentials. No
deploy/publish, settings write, new network or secret use until its grant exists. Artifact
output and model calls are narrowly defined runtime services, not general permission to mutate
external state. 653 alone must not ship unrestricted tool egress while ey3e is pending; admitted
initial access must be scoped and platform-validated, with additional access denied until the
grant path exists.

## The owner's trades (only these need an answer)

1. **Immediate access withdrawal versus large-file throughput.** Proxying each file lets the
  platform check access and stop new transfers without leaving a usable URL; all bytes consume
  broker capacity. Direct signed transfers are cheaper for big files but remain usable until
  expiry. Recommend proxy first; do you prefer that tighter withdrawal bound over direct-
  transfer speed?
2. **Fast Stop versus salvaging the last output.** Stop can cut compute now, or briefly drain
  uploads before deletion; a forced cut loses unacknowledged bytes, not already retained output.
  Recommend a bounded drain with immediate denial of new external effects, then forced removal;
  the bound is measured in the prototype, not borrowed from core's five-second stop deadline.
3. **Quiet normal work versus advancing an urgent task.** FIFO starts work in accepted order and
  cannot starve an old task; reserved/priority slots start urgent work sooner but make ordinary
  work wait longer. Recommend FIFO now, reopening priority only when the owner wants that
  service distinction.

Everything else above is the design recommendation, not a question about patterns for the owner.
None of these three trade answers is assumed here.

## Risks and the first prototypes / checks (future work, no probes here)

1. **First: both real harnesses, one live seam.** Pin full offline workbench; demonstrate mid-
  tool steering/question/answer, gateway identity + task session, semantic error vs CLI 0,
  aborted children and process-tree cleanup. Research mocks did not establish these deployment
  contracts [R].
2. **Identity/consent boundary:** wrong audience, foreign Pod/Job UID, stolen task token after
  Stop, forged session, expired/replayed/widened grant and raw internal routes all fail. Verify
  no model/storage/push signing key in specs/env/files/logs; token files are acknowledged bearer
  bootstrap material.
3. **Crash matrix:** kill core before/after reserve, create response, command ACK, upload ACK,
  manifest seal, terminal outbox and delete. Assert one adopted Job, one logical terminal event,
  queue order and cleanup replay; killing a pod never auto-replays ambiguous shell work.
4. **Storage:** hostile prefix/name/size/hash, retry/multipart cleanup, Stop during upload, full
  quota with pins/forever and download-vs-GC races. Verify a fresh restore of objects + filer
  metadata + IAM/custody + Postgres manifest and hashes; one node is not disk-loss resilience
  [R]. Pick RPO/RTO with owner.
5. **Limits/settings/UI:** concurrent admission at tenfold queue depth, lower cap during runs,
  unavailable API/store, stale settings revisions; add one declaration and see its bounds/errors
  in loader Chromium + Firefox. hf2k supplies task progress/download/Stop UI checks under
  PRA-001.

No full design record or independent design acceptance yet. Final design must resolve two
documentary deltas: the confirmed panel-only/no-chip flow replaces the older web target's chips;
task APIs/downloads require an explicit ADR-011 D4 extension (until then those new web
operations are not authorized). ADR-012 HTTPS/session rules amend ADR-011's old HTTP wording.
These are not permission to bypass the existing web storage boundary. 653/ey3e/hf2k/97bj
ownership remains as stated in the frame; generation-operator provisioning is not assumed built.

## Sources

- [R] [Task-runtime research](../../research/task-runtime.md), both rounds, pinned harness
  APIs/probe limits and SeaweedFS 4.48 S3/STS/backup evidence.
- [J] [Jobs-engine research](../../research/jobs-engine.md), especially §§4, 7, 9: keyed
  effects, retry ambiguity, Job/result dual truth; no engine adoption.
- [K] Kubernetes [ServiceAccount projection and
  TokenReview](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/),
  [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/),
  [NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/).
- [E] Hohpe/Woolf, [Enterprise Integration
  Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/): Pipes and
  Filters, Message Channel, Idempotent Receiver, Competing Consumers; [Transactional
  Outbox](https://microservices.io/patterns/data/transactional-outbox.html). Reference
  monitor/capability security: [Saltzer/Schroeder, complete
  mediation](https://web.mit.edu/Saltzer/www/publications/protection/).
- [P] PostgreSQL [SELECT locking / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-
  select.html).
- [S] SeaweedFS [OIDC](https://github.com/seaweedfs/seaweedfs/wiki/OIDC-Integration) and the
  released authorization/presign sources linked in [R].
- [N] nocx `internal/settings/settings.go`, read at commit
  `71cc0698823b5d618f08a441e434e99d9a91eb5a`: typed keys, Descriptor/Declaration, bounds/unit,
  data classes and secret set/delete/exists without get. Port the registry idea, not nocx's
  storage or transport. Local source, not a dependency.
- Baselines: [ADR-010](../../adr/010-container-generations.md), [ADR-011](../../adr/011-web-
  interface.md), [ADR-012](../../adr/012-loader-interface-and-access.md),
  [ADR-013](../../adr/013-model-gateway.md), [containers view](../instance/containers-
  design.md), [web target](../instance/web-interface.md). Named-pattern applications above are
  design inferences; no new live/probe evidence is claimed.
