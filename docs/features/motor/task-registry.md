# Task registry

The core owns the registry through `src/ports/tasks.ts` and
`src/storage/postgres-task-registry.ts`. Migration
`20261015000019_create_task_registry.sql` expands the existing core schema.
This is the durable record for the new Job runtime, not a replacement execution
loop and not the old Motor Cortex `motor-state.ts`. The [task launch path](task-launch.md)
now wires the registry and allocation/Job reconciliation in platform mode.
[Verified identity and once-only start](task-identity.md) are served by the model
gateway. The [task channel](task-channel.md) now persists step/terminal reports
before ACK and replays normal Signals. [Sealed finalization](task-finalize.md) now commits one fenced terminal outcome and
its Postgres outbox event after compute termination and a storage receipt.

## Tables and ownership

| Table | Facts | Writer |
| --- | --- | --- |
| `core.tasks` | Immutable launch key, briefing, profile, settings revision, selected harness, workbench image digest, wrap grace, accepted order; public state, candidate/reason, finalization pending and timestamps | Fenced core task registry; later lifecycle/finalization writers use the same fence |
| `core.task_launches` | One initial attempt and launch per task, deterministic Job name, allocation receipt, template hash, nullable observed Job/Pod UIDs, irreversible launch tombstone, cleanup pending, soft-stop request and explicit slot reservation | Fenced core admission/reconciler; core observes Job UID, verified binding supplies Pod identity, never cognition |
| `core.task_admission` | One permanent row, locked while accepting, counting/reserving or releasing | Fenced core registry |
| `task_access.intents` | Stable `(task_id, attempt_id, launch_id)` primary key, revision, mode, finite absolute soft/hard deadlines | Fenced core registry initializes once and only UPDATEs afterward |
| `task_access.projections` | Verified Job/Pod binding | Gateway identity writer; not this registry |
| `task_access.start_claims` | Consumed launch/Pod/boot-nonce claim and verified Job-time deadline snapshot | Gateway identity writer in the same transaction as the projection |

No file, `DATA_PATH` directory, Job status or process-local map is task authority.
All adapter operations use the existing fenced Postgres pool. Write transactions
hold the active-holder row through commit and require the exact holder epoch.
SQL failures are translated to an ID and code without attaching private pg error
rows/parameters. Pool acquisition, pre-BEGIN holder-lock waits and the transaction
have a shared finite 15-second SQL-phase bound; lock/statement limits are installed on
the acquired session before entering the fenced seam. Connections are discarded
after each operation (including a late acquisition after timeout), so abandoned
queries cannot retain locks and no session settings leak to another pool borrower.
The launch worker has a separate registry instance with a cancellation signal.
Stopping discards only that instance's checked-out clients and refuses later work;
service clients used by the drained turn remain untouched. The worker drains inside
the core's shared stop deadline before the shared Postgres pool closes.
Acceptance reads settings before acquiring SQL locks, with a separate 15-second
bound (at most 30 seconds across its settings and SQL phases). Admission instead
reads settings after acquiring the admission lock, inside its shared 15-second
SQL-phase bound; a slow read cannot hold that lock beyond the operation deadline.
The production settings reader fails to defaults, but an injected failing reader
can refuse even an acceptance replay before SQL is reached; a replay never
replaces the stored snapshot.
Invalid input and conflicting key reuse are deterministic errors.
The port is core-only and is not added to `PluginPrimitives`.

## Acceptance and identities

`accept` takes the deciding turn's committed effect key as `launchKey`. That turn
identity is fixed before effects and reused on replay. Reuse with the same
briefing, structural JSON profile and caller image digest returns the original record;
a different payload conflicts. The caller digest is stored separately as
`request_image_revision`: platform wiring selects the configured deployment image
only for a new acceptance. An identical replay after deployment keeps the original
selected image, even if the caller digest differed from it. Current settings are
not replay payload: replay keeps the first settings/harness/grace snapshot even
after platform changes.

Domain-separated SHA-256 hashes of the launch key produce task, attempt and
launch IDs. This avoids a new ID on transaction retry and does not expose the
launch key in public identifiers. The Job name is `task-` plus the first 58 hex
characters of the launch hash: exactly 63 DNS-1123-safe characters. A unique Job
name constraint fails closed on a hash-prefix collision; never choose a second
name/launch to recover. The full launch key also has its own SQL UNIQUE constraint.
No hidden second attempt or launch is issued.

Profiles carry an explicit ID/revision, positive integer timeout, CPU and memory.
Image input is a digest, not a mutable tag. Date-unrepresentable timeout values are rejected before acceptance. This leaf
validates shape, not new
platform ceilings; no CPU/memory ceiling declarations exist in the current
platform reader. Dispatch must recheck future declared ceilings without silently
changing the accepted request.

## FIFO admission and slots

`src/storage/postgres-task-registry.ts` admits normal FIFO only. `urgent` is
reserved and defaults to false; there is no urgent setter or queue limit.
Full stop and urgent-lane controls remain lifemodel-653.10 work.
`admitNext` locks the singleton admission row, reads the reservation count, and
commits one `queued → starting` transition with `slot_reserved=true`. Concurrent
contenders cannot spend the same capacity. Accept uses the same lock so accepted
sequence assignment and commit order cannot invert FIFO. Identity sequence gaps
on transaction abort are harmless. Public reads sort by accepted order and ID.

The cap comes from the existing platform reader's `tasks.concurrency`, not a new
key or process cache. Admission reads it inside the fenced transaction, after
acquiring the singleton admission lock and before counting/reserving. A setting
changed while an attempt waits on that lock therefore applies to that attempt's
serialized reservation decision, not just the next attempt. This uses the
existing reader without adding a separate policy-revision fence. Its current
declaration permits a fraction; admission floors the cap so integer reservations
never exceed it. Lowering the cap does not remove existing reservations; new
admission waits until their count falls below the new effective cap. Pending/unknown creates
continue to consume capacity. `releaseSlot` is an explicit idempotent operation
for the finalizer/reconciler **after confirmed compute termination**. Terminal
state, reply, or storage GC does not implicitly release it. Unknown task IDs fail.

## Access intent and clocks

Acceptance and admission do not guess Job start time. Missing intent denies
binding and runtime access. After a Job exists, the trusted reconciler or
verified-start path must call `initializeAccessIntent(taskId, Job.status.startTime)`
**before verified binding or any start permit**. It requires a reserved,
non-tombstoned `starting` task without a terminal candidate, and atomically stores
the immutable observed start time plus revision-0 active intent:

- `soft_due_at = Job.status.startTime + accepted profile timeout`;
- `hard_stop_at = soft_due_at + snapshotted wrap grace`.

This choice follows ADR-014 D3/D4: queued time does not consume the timeout;
scheduling and launcher delay after Job start do. Initializing at acceptance
would need either a wrong timeout origin or a forbidden deadline extension.
A core crash before initialization leaves no authority and an inert launcher;
reconciliation retries with the same observed start time. Repeated initialization
returns the current row, including later revocation, and never resets deadlines.
A different start time conflicts. Nonfinite/unrepresentable dates are refused.

`advanceAccessIntent` locks task then stable intent and UPDATEs that row. Each
accepted update increments the bigint revision. Neither deadline may move later;
hard must remain at least soft. `wrapping` cannot return to `active`, and `revoked`
cannot return to either. Refusals leave the old row available for a valid shorter
update. Writers must never DELETE/reinsert authority. The existing table CHECKs
validate modes, revisions and finite ordered dates; cross-version monotonicity is
enforced by this canonical writer (not an added trigger on storage consumers'
shared read-contract table). Readers' short FOR SHARE locks conflict with UPDATE.
Changing only intent is not a complete Stop operation: later control leaves must
atomically pair public lifecycle/control-command changes with canonical intent,
and native Job deadline enforcement under ADR-014 D4. No Stop is claimed here.

## States and finalization seams

SQL CHECKs constrain states and candidate/reason shape. Update triggers protect
accepted payload, initial start time, launch identity, once-bound UIDs and launch
tombstones. State edges follow the design table, including queued infrastructure
failure with an empty seal. Terminal state, candidate, reason and terminal time
cannot change once committed. Before terminal commit, candidate/reason remain
separate from public state and may change (hard Stop can supersede success).
`finalization_pending` annotates a nonterminal task; it is not a new public state.

There is no public terminal setter. The [finalizer](task-finalize.md) uses
`beginFinalization` to save its candidate with canonical revocation and the launch
tombstone. `confirmComputeTerminated` records executor proof; `releaseSlot` refuses
without it. `prepareSeal` saves the storage revision and immutable keyed request;
`recordSealReceipt` validates its match. `commitFinalization` compares the candidate
version and atomically writes terminal state plus one `core.task_outcomes` event.
SQL guards reject an unsealed transition or a terminal transaction without its
outbox row. Cleanup and delivery have separate durable fields. A storage outage
cannot justify leaving compute running. Tombstones survive late-create adoption
through `bindCleanupJob`, which grants no execution rights. No Job-name-only deletion.

## Eight T04 crash boundaries

These are handoff obligations for later restart tests, not eight runtime checks
claimed by this leaf's registry integration tests.

| Boundary | Durable recovery fact / later leaf |
| --- | --- |
| Slot reserve | `starting` and reservation commit together; .5 retries storage/launch by the same IDs |
| Storage allocate | Keyed allocation receipt before deterministic Job create; .5 adopts/retries allocation, never another task |
| Create response | Deterministic Job name, immutable UID and tombstone; .5 GET/adopts exact name/template/UID after unknown response |
| Mailbox ACK | .8 persists unique message/cursor before ACK; replay cannot lose an acknowledged command/event |
| Mark ACK | Storage's durable mark receipt is authority; .8/.9 do not infer retained bytes from launcher memory |
| Seal response | .9 retries keyed seal and saves candidate/pending reason, never publishes terminal from Job success alone |
| Terminal outbox commit | .9 atomically CASes one terminal outcome and one unique outbox key; delivery deduplicates by key |
| Job delete | .5/.9 retain exact-UID cleanup/tombstone intent, confirm termination, then release reservation; terminal never reopens |

`.6` consumes canonical intent with live verified binding and a once-only start
claim; an intent alone never grants execution. See [task identity](task-identity.md). `.11` uses `TaskService.accept`
with a committed deciding-turn key. Later leaves must not bypass this writer
with unfenced raw SQL or introduce another registry authority.
