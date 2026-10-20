# Task runtime design review — evidence and disposition

The independent reviewer report below is preserved verbatim from the worker's
untracked review file. Actual reviewer model: shady2k-gateway/gpt-6.1-sol.
Two rounds: frame-first review at 82eec5eb, fixes and final PASS at 28bc0345.
No third review round. This is design handoff evidence, not stage acceptance.

After the reviewed revision, e196a69d clarified database-time deadline
authorization. The coordinator's step-C verification below addresses that
clarification and simplifies platform controls. **The round-2 verdict does not
claim to cover either later diff.** The records remain proposed architecture
until owner/coordinator acceptance; checks are stage obligations.

## Coordinator verification, step C (2026-10-20)

The coordinator (Claude, a different model) requested simplification after the
two completed review rounds. This section records the response, not a third
review or a new reviewer PASS. Owner choices and 22 closed constraints remain.
Current ADRs/views supersede the component descriptions in the verbatim reports
below. Primary source/pin evidence is in ADR-014 [K]/[KC]/[V].

1. **Replacement Pods:** add explicit Never/0/Failed plus one completion/parallelism
   and fail-on-disruption/nonzero Pod policy. Both install paths pin k3s
   1.35.8+k3s1, whose Kubernetes 1.35.8 replacement policy is GA/locked on.
   This removes ordinary replacement retries/overlap, not Kubernetes' documented
   duplicate-program-start residual. The pinned controller uses in-memory,
   expiring Pod-create expectations; controller/observation failure is not a
   durable start fence. **Retain** the launch/Pod/memory-nonce claim, but fold it
   into the existing model gateway task-identity/binding endpoint, no separate
   gate deployment. Keep launcher's single-start guard and conservative lost-ACK
   failure. T05 names normal policy checks and residual controller/create faults.
2. **Stale-epoch CREATE:** **drop** the fail-closed SQL admission webhook.
   Deterministic names/AlreadyExists/adopt, permanent launch tombstones, current
   intent/live-owner checks before execution and existing registry cleanup cover
   the outcome. Late objects can transiently exist, but are inert and denied
   binding/model/storage/effects. Use built-in RBAC/PSA/quota plus service-free
   CEL for static template/identity and monotone deadlines. CEL/labels cannot
   prove current SQL epoch or actual owner liveness; do not claim they can.
   T03/T05 check stale/forged binding and late-create/Stop cleanup, not zero
   late object creation. Deleted first execution never authorizes another UID.
3. **Deadlines:** **drop** the separate deadline reconciler. Job ADS is mutable;
   native controller enforces the hard bound after a successful patch with core
   down. Convert absolute hardStopAt to seconds **from Job.status.startTime**,
   floor and min with current ADS; do not put now+grace directly into a duration.
   Reject increases/removal/suspend via CEL; use UID/resourceVersion CAS and
   zero extra termination grace. Existing agent/owner control handlers persist
   intent and patch receipt; a pre-patch crash/API outage is enforcement pending,
   repaired by existing keyed control replay on handler restart. The original
   native timeout and canonical database-time access denial remain backstops;
   no claim of earlier physical enforcement before patch confirmation. T08
   covers both sides of that cross-store gap and core-down native termination.
4. **Warning:** change default **24 h → 7 days / 604800 s**, keeping one keyed
   batched notice. A typed loader/platform setting snapshots lead/revision into
   each plan; a later setting cannot shorten an announced window. S07 checks
   default/configured boundary, restart and policy-change behaviour. This allows
   owner absence without changing 90 days/forever/pin/20 GB protections.

The coordinator's request includes the earlier database-time clarification: it
keeps canonical intent/deadline authorization independent of projection/timer
delay. Design-only source inspection, not cluster proof. Product tests, real
Job walks and owner/coordinator integration acceptance remain outstanding.

---

# Round 2 confirmation — final design-review verdict

Date: 2026-10-20. Reviewed revision: `28bc0345af1d04e17fa3b4a68478aeed9571f754`.
Reviewer: **shady2k-gateway/gpt-6.1-sol**, unchanged from session metadata.

**PASS FOR DESIGN HANDOFF. Frame passes. B1–B3 and C1–C2 are resolved at the design level. No remaining blocking finding in this bounded confirmation.** This is not implementation acceptance or evidence that the planned checks pass.

Scope: read the round-1 fix commit and the affected current ADR-014/015 and tasks-design sections only. No third review round is requested. No tests, runtime probes, installs, tracker writes, product/doc edits or deployment actions ran. Only this untracked report changed.

| Finding | Confirmation and remaining stage obligation |
| --- | --- |
| **B1 — CLOSED** | ADR-014 T05/D3 now measures **one authorized harness execution**, not impossible exactly-once Pod creation. A separate execution gate consumes a durable SQL claim for launch + actual live Pod UID + memory-only process nonce before harness start/runtime binding. Reconnect cannot regrant; lost or delayed reply fails conservatively; replacement Pods remain inert and are deleted; first authorized Pod loss fails the task. Claim retention covers old delivery/cleanup paths. T05 now includes two candidate UIDs, running-Pod deletion/replacement, authority restart and delayed first-claim response. This addresses the controller-replacement mechanism without side-effecting admission or assuming a pre-CREATE UID. Implementation must prove these exact cuts. |
| **B2 — CLOSED** | ADR-015 S-D2 and ADR-014 D1 no longer rely on watcher freshness. Each authorization reads **canonical committed lifecycle access intent together with verified binding**, with newer stop/revoke taking precedence over lagging projections; current API reads establish Pod/Job liveness and failures deny. The canonical intent is the permission boundary, with already-authorized chunks explicitly distinguished from later authorization. Module revoke ACK additionally confirms stream cancellation. S02/T03/T06 now pause the writer, commit stop without revoke-RPC delivery, and inject delayed active revisions across storage/model/effect listeners. The narrow SQL operation and revision ordering must be implemented and concurrency-tested, not replaced by cached watch state. |
| **B3 — CLOSED** | T07/D2 supplies 64 KiB frames, 16 frames/1 MiB per task, 4 MiB process control buffer, 5 s ACK timeout, round-robin task processing, isolated owner/control resources, and 20+20 independent ACKs within 2 s under a stalled stream. S10/S-D3 supplies 8 transfer workers, 2/task, 2 reserved owner-read slots, 2 independent control workers, 32 MiB chunk buffers, 64 KiB queued metadata/32 requests, 1 s overload refusal, 10 s chunk deadline and ≤512 MiB fixture RSS. The record distinguishes 20 **attempted** streams from active buffers. These are finite engineering/fixture budgets with overload behavior and worker fairness, not invented product SLOs. Stages must retain the explicit attempted-overload/independent-progress workload and assert the budgets, including real owner-read progress through its reserved slots; recording measurements alone is no longer enough. |
| **C1 — CLOSED** | D4/D5 and the stop view choose persisted **Job.status.startTime**, so post-Job scheduling/startup counts and pre-Job queue wait does not. The verified absolute softDueAt reaches the launcher, whose local timer wraps with core down; late handshake starts wrapping instead of new work. Platform control observes the same deadline and timeout intent is deduped. T08 explicitly includes delayed/unscheduled Jobs and core outage spanning softDueAt. |
| **C2 — CLOSED** | S-D5 and the access view serialize pin/retention changes with entry to deleting under the same row lock/CAS. Winning pin excludes the object; losing pin returns already_deleting and cannot ACK protection. Tombstone blocks new pins; S07 carries both orderings and replay. |

## Final boundaries

- The confirmed owner outcome and all three trade answers remain unchanged. Forever/pin protection remains intact.
- Both records still clearly call their checks **future stage obligations**. The 22-constraint count is unchanged; scale/pressure fixture sizes now have relevant pass criteria.
- Real harness steering, workload identity support, SQL/Kubernetes fences, per-chunk authorization cost, pressure budgets and recovery remain implementation/acceptance risks to prove, not residual design blockers or successes claimed here.
- Proceed to stage decomposition with the named checks attached. No implementation approval, deployment approval or product-test result is implied.

---

# Round 1 report — historical findings, superseded by confirmation above

# Independent design review — lifemodel-653.5, step B

Date: 2026-10-20. Round: first independent review of step B.
Reviewer model: **shady2k-gateway/gpt-6.1-sol**. This is the actual provider/model in this session's `model_change` metadata, not inferred from the task brief. Reviewer did not implement these documents.

## Verdict

**FRAME PASS; VERIFICATION BLOCKED** on B1–B3 below. These are mechanism/check gaps in the chosen direction, not requests to reconsider the owner's choices. Fix them before handing the record to stages. No implementation acceptance is claimed.

Reviewed the worker brief; `br show` and all `br comments` for lifemodel-653 and lifemodel-653.5; ADR-014/015; tasks-design/options; relevant ADR-010 baseline contracts, ADR-011/012/013; and the harness/storage evidence in task-runtime research. Read the latest on-disk retention correction: **forever and pin are protected from automatic quota eviction**. Reviewed tree includes commit `82eec5eb8ef4d5443df5dfdc29c54085f069d2f9` (HEAD observed during review); findings name sections so subsequent edits do not depend on line stability.

Only short read-only commands and file reads were used. No tracker writes, tests, probes, installs, cluster/VM operations or external URL fetches ran. This untracked report is the only file written by the reviewer.

## 1. Validation first: owner's outcome, direction and trade answers

**The direction serves the confirmed frame.** The owner delegates long work while continuing the conversation. The design keeps short ordinary replies, a separate task panel, agent-set profiles, durable results and attachments, live agent↔task steering, no owner↔harness composer, and no cancellation on a new message.

It retains the actual choices rather than the superseded recommendations:

- Separate plain Kubernetes Jobs first, one signed/pinned offline workbench, both OpenCode and prime-agent behind one harness port, an executor port with a fake second implementation.
- A separate platform storage service, direct task→module bytes with projected identity, only the module holding Seaweed signing credentials, its own API/CLI and internal-only S3.
- Soft wrap plus the settings hard deadline (300 s default), hard stop-now without an upload/seal wait, and soft stop-all for current tasks.
- Urgent first when a slot frees, FIFO within each class, owner **or agent** can set urgent, no preemption.
- Exact-scope platform grants and owner words for configured actions, broker-side OpenBao secrets, deny-by-default until ey3e exists.
- Loader-owned typed settings, 90-day default/forever/pin, 20 GB logical ceiling and one warning batch before automatic deletion.

The split into ADR-014 and ADR-015 is justified by separate custody, failure, recovery and consumer boundaries. The explicit amendments to previous registry ownership, task model ingress and web operations resolve real baseline differences. No unanswered owner trade needs to be reopened to repair the findings below.

## 2. Blocking findings

### B1 — The no-rerun claim needs a durable one-execution gate, not only a deterministic Job name

**Where:** ADR-014 T05; D1 (`restartPolicy: Never`, `backoffLimit: 0`); D3 “Kubernetes fencing,” especially “Job spec forbids any manual restart/replacement policy”; tasks-design task lifecycle/launch sequence.

**Scenario/mechanism:** The first Pod has started the harness, then is deleted or otherwise disappears while its Job remains nonterminal. A Job controller can create another Pod for that same Job. Neither deterministic Job naming nor `restartPolicy: Never` is a single-execution guarantee: the latter stops container restarts inside a Pod, not all controller-created replacement Pods. The admission description checks current epoch/reservation/template/nonterminal state, but does not claim the first execution or reject a second Pod identity. Its current predicates can still be true for a replacement, which can rerun an ambiguous shell action. Saying the Job spec forbids replacement does not name an enforceable policy.

**Needed design change:** Specify the durable at-most-one Pod/execution claim and its linearization point. A viable location is the existing platform task-control/binding authority: one admitted Pod identity/start claim per launch, keyed and never released for another Pod after first execution; same-identity request replay must be safe; replacement identities must fail closed and trigger visible failed/lost-Pod reconciliation. Account for the UID/admission lifecycle rather than assuming a Pod UID already exists at CREATE validation. An admission-created reservation may need a token/name plus post-create binding or a launcher-side one-start claim. Conservative failure is acceptable; hidden shell replay is not.

**Concrete required check:** Extend T05 with one running Pod deletion while the Job controller attempts replacement, two simultaneous Pod/start claims for the same launch, an unknown/lost admission or bind response, and restart of the authority. Assert exactly one harness execution, no replacement task execution, one failed/partial outcome where appropriate, and cleanup. This is distinct from two competing **core** Job-create requests already in T05.

### B2 — Authorization projection freshness is asserted but not mechanically fenced

**Where:** ADR-015 S02 and S-D2 paragraphs on the platform SQL authorization projection/current revision/lifecycle-watch failure; ADR-014 D1, D3/D4; tasks-design ownership table and storage access view.

**Scenario/mechanism:** Core or owner intake durably records a stop/revocation intent. The platform projection writer stops or stalls before copying that intent. The Pod and Job remain live, so fresh TokenReview and live Pod/Job reads still succeed. The storage module reads an old `active` projection and can authorize new operations. “Lifecycle-watch failure rejects fresh access” does not explain how an independent reader detects the dead or lagging writer. Re-reading a stale projection per chunk does not make it current. Module-local `revoke` is well defined **after its durable ACK**, but it does not by itself close this prior authority-propagation gap or define task-mode freshness for model/effect listeners.

**Needed design change:** Define the authority/freshness contract, not a second outcome registry. For example, compare projection revision against canonical committed lifecycle/stop intent through a narrow linearizable SQL operation on each authorization, and reject pending/mismatched revisions; or specify a bounded authority lease with explicit expiry/failure semantics. If using a lease, say the stale-access bound rather than calling it immediate. Name which stop/authority ACK is the permission boundary. Preserve the already honest exception for physical/cross-service actions under partition; this finding does not demand instantaneous cross-service cancellation.

**Concrete required check:** With two spaces and a live Pod, pause/kill the projection writer, commit hard stop or soft-wrap intent **without delivering the module revoke RPC**, and attempt new PUT/mark/GET chunks plus new effect/model operations as applicable. Also inject a delayed old active projection after revoke. Assert fail-closed under the chosen revision/lease contract, with a measured/configured bound and no revival. API-down tests and revoke-mid-PUT tests alone do not exercise this case.

### B3 — Some “closed constraints” are not yet measurable acceptance requirements

**Where:** ADR-014 T07/D2 (responsive owner intake, bounded frames/queues), ADR-015 S10/S-D3 (bounded transfers/memory/client pressure and no starvation), tasks-design “Every wait/network request has a bounded timeout.”

**What is already good:** The record concretely sizes two concurrent Jobs, 100 queued tasks at cap 2 with two contenders, 100 GC objects, 32×4 MiB restore objects plus two partials, a decimal 20 GB ledger with ±1-byte boundaries, and 20 simultaneous 4 MiB streams. Those are honest fixture sizes, not unsupported scale claims. All checks are clearly future stage obligations.

**Gap/mechanism:** Fixture size is not a pass criterion. Recording RSS/latency does not decide whether memory is bounded or another task/web client is starved. Apart from chunk size, no configured/global/per-task transfer cap, queue/frame budget, fairness/reserved capacity rule or finite wait criterion is selected. Twenty streams from one task can hold every transfer slot indefinitely unless admission/scheduling prevents it. “Owner intake succeeds” also has no bounded completion point while a stream stalls. A check can currently record arbitrarily bad results and still claim the constraint passed.

**Needed design change:** Give these constraints measurable engineering acceptance bounds/configured budgets and the mechanism that meets them. A small table of frame/queue byte limits, per-task/global active-transfer limits with independent web capacity or bounded fair scheduling, request/idle limits, and fixture completion/memory criteria is enough. Values can be explicit design defaults or a named stage calibration gate that must choose and freeze the budgets **before** acceptance. These are fixture/implementation budgets, not invented owner-facing availability SLOs. Name the verification for exceeding each budget and for independent progress.

**Concrete required check:** In the existing 20-stream fixture, have one task exhaust/stall its allowance while the second task and one web download complete bounded work; assert configured queue/transfer maxima, a finite fixture deadline and stated RSS/container budget. In T07, hold one task stream forever, fill its queue to its stated cap, and require owner intake plus another task's steering to finish within the declared test bound. State overload outcomes (pause/reject/429) instead of unbounded waiting.

## 3. Nonblocking comments

### C1 — Clarify timeout onset and the core-down soft-wrap actor

**Where:** ADR-014 D4/D5; tasks-design stop sequence.

The record says timeout is from **Job start**, also says queue has no running timeout until compute starts, and calls the 120 s startup deadline distinct from the agent's running timeout. Kubernetes Job start/Pod-running/harness-ready can differ. It also clearly assigns hard deadline deletion to platform control, but is less explicit about who sends the first soft-wrap command at timeout if core is absent.

Name the clock origin and actor once. If platform control only deletes, require the launcher to enforce the snapshotted soft timeout locally and dedupe its wrap event. If control sends wrap, show that route and its identity. A virtual-clock check with an unscheduled/start-delayed Job and a core outage spanning timeout should assert the intended wrap interval and fixed outer deadline. This is clarification of the selected soft-then-hard behavior, not a new Stop trade.

### C2 — Close pin-versus-deleting semantics in the same CAS rule

**Where:** ADR-015 S07/S-D5, paragraph starting “Before delete”.

The pre-delete revision recheck and tombstone are sound. State explicitly that pin/retention-change operations serialize with entry to `deleting`: a pin that wins excludes the object; a pin that loses must report already-deleting/not-available and must never ACK protection of bytes about to be removed. The current text explicitly blocks reads/marks but not pin updates at the tombstone. Add both orderings to the already planned owner-pin-after-warning/two-GC-contender fixture.

## 4. ATAM-style coverage and sensitivity points

| Attribute/scenario | Assessment of chosen mechanisms/checks |
| --- | --- |
| Cross-task isolation / no keys | Strong design intent: zero-RBAC bound-Pod audiences, distinct listeners, namespace AND pod selectors, no raw task store routes, only module signing custody, broker-side effect secrets. T01/T03/T06/S01/S02 provide concrete negative checks. Bound-UID support remains an explicitly named deployment risk, not proven here. |
| Restart / one terminal outcome | Registry-before-dispatch, keyed allocation/adoption, candidate before seal, terminal CAS+outbox and separate cleanup are coherent. Eight crash cuts and S03–S05 make this checkable. **B1** is the missing compute-execution fence. |
| Exact consent | Grant ties task/action/arguments/expiry/use key; network reachability is explicitly not authorization; unavailable adapters deny. Ey3e ownership is respected. Stopped-state freshness depends on **B2**. |
| Live steering / responsiveness | Durable mailbox before ACK, task-private command acceptance log, no replay after Pod loss, both real adapters plus scripted adapter are suitable. Real mid-tool steering remains future evidence. **B3** needs bounded responsiveness/overload criteria. |
| Replaceability | Ports hide raw harness/Kubernetes/S3 APIs; both real harness contracts and fake executor contract are correctly distinguished from research mocks. No reopening of harness/store selection needed. |
| Stop / limits / queue | Urgent FIFO/no preemption, counted starting reservations, cap reduction without killing, immutable wrap deadline and independent hard-delete path serve owner answers. Timeout wording needs **C1**. |
| State / revoke races | Immutable object versions, per-chunk guards, keyed freeze/manifest/cleanup and receipt-based terminal commit are well framed. **B2** addresses upstream authority freshness; **C2** clarifies pin linearization. |
| Settings / web / retention | Typed platform declarations, authority/apply timing, secret no-get, loader independent of core and generic generated controls match direction. Latest forever protection avoids an unapproved data-loss trade. Browser/download walks are planned, not claimed. |
| Operations / recovery / scale | Fresh restore of catalog+objects+filer/IAM/custody/tombstones, external failure-domain caveat and no invented disk-loss RPO/RTO are honest. Sized scale fixtures are useful. **B3** is what prevents pressure measurements becoming acceptance by assertion. |

Accepted trade-offs are explicit: proxy byte cost for confinement/revocation; storage outage delays terminal publication but not compute removal; wrap grace occupies capacity; hard Stop loses unmarked/unacknowledged work; urgent-first can starve normal queued work; API/authority outages fail closed. These match the confirmed direction. No additional standards-driven mechanism is requested outside the scenario defects above.

## 5. Handoff

Correct B1–B3 in the record/views and attach each new check to its stage obligation. Resolve C1/C2 when tightening those sections. A confirmation review should inspect those specific changes, not re-open the settled direction. This report is design review only; no product tests, deployment proof or stage acceptance occurred.
