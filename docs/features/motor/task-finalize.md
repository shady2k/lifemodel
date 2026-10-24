# Sealed task finalization

Task: lifemodel-653.8.9. This is the core infrastructure end of ADR-014 D3,
not a cognition tool or a replacement execution loop. It does not send an owner
message. The later task tool consumes its durable outcome to make that reply.

## Authority and order

`src/core/task-finalize.ts` uses the fenced Postgres registry, durable mailbox,
storage control HTTPS client and exact-UID executor. Startup scans terminal
mailbox rows without consulting `signalled_at` or the bus watermark. Terminal
`task_report` Signals hand off a saved candidate before tick-local completion.
The launch reconciler also hands off failed, missing and completed Jobs. A
completed Job without a semantic report is `failed/semantic_report_missing`,
never success. A stored semantic report wins over the Job observation.

1. Save candidate, summary and reason separately from public state. In the same
   fenced transaction, tombstone the launch and advance canonical intent to
   `revoked`. Never delete/reinsert existing authority or extend deadlines.
2. Delete exact validated Job/Pod identities, then confirm compute termination.
   A Job DELETE response or 404 alone proves nothing about its Pods. Persist the
   confirmation before releasing its admission reservation. Storage availability
   and owner delivery do not hold compute capacity.
3. Persist the exact seal request before HTTPS: a deterministic candidate-version
   effect key, storage-space access revision and requested outcome. This revision
   is **not** the canonical task intent revision. Unknown responses replay the
   same request. A rejected `revision_conflict` may refresh the request only after
   checking that the module has no frozen/sealed operation for that space; its
   candidate and summary stay unchanged. Explicit `missing_result` or `checksum_mismatch` refusal changes
   an uncommitted success candidate to failure and allows a new recovery key.
4. Validate and persist the sealed receipt, including manifest ID/hash. One
   fenced transaction compares the candidate version, commits terminal state,
   and inserts one `core.task_outcomes` row. There is one unique task and launch
   per outbox row. Replayed terminal reports cannot change it.
5. Confirm Pod and generic ephemeral PVC garbage collection before clearing
   cleanup pending. Cleanup is durable independently of the terminal outcome.

A hard stop supersedes an uncommitted normal candidate. If storage already
sealed a completed manifest, that immutable retention receipt can support a
`stopped` public outcome: physical retention success is not semantic task
success. The stopped candidate still wins the terminal CAS. No new manifest is
invented or substituted. Stage 5 supplies the owner Stop control operation.

Storage down or refusal leaves a nonterminal task with `finalization_pending`,
a saved candidate and a safe failure code. Compute is still stopped first.
Retries back off to 30 seconds. A done outcome requires semantic success **and**
a sealed manifest containing a marked result. Failures preserve sealed partial
output and their reason. No Job status, exit code or private process map owns an
outcome. No automatic new attempt is created.

## Outcome contract for the task tool

The transaction writes this immutable event (not a `send.command`):

```ts
{
  taskId: string;
  outcomeKey: string; // "outcome_" + immutable launchId
  state: 'done' | 'failed' | 'stopped';
  reasonCode: string; // completed, report reason, missing_result, compute_missing, ...
  summary: string; // the single-line semantic report, or an infrastructure summary
  objects: readonly {
    id: string;
    name: string;
    size: number;
    sha256: string;
    mark: string; // result, log or artifact
    contentType?: string;
  }[];
}
```

Only manifest members can appear in `objects`; report object IDs alone are not
retention proof. Current storage manifests do not supply MIME metadata. When
absent, consumers use `application/octet-stream`, not a guessed trusted type.
Object IDs are attachment artifact IDs. The task tool must follow
[the attachment contract](../web/attachments.md), bind attachments to its actual
assistant message, and deduplicate by `outcomeKey`. No bytes, signed URLs or
workspace paths enter the outcome event.

The outbox relays `task_outcome` / `task.finalizer` to the existing Valkey bus.
Its data is `{kind:'task_outcome', ...event}` and its Signal ID is `outcomeKey`.
Atomic keyed bus admission uses the same durable task-dedup receipt mechanism as
mailbox reports. Postgres marks delivery only after admission. An interrupted
relay retries the same key, including after bus trimming. This is at-least-once
delivery, not a Postgres/Valkey transaction. Outbox/receipt retention must be
paired in any future task-history collector.

## Shutdown and cleanup limits

Finalizer SQL has its own cancellable registry instance. It never destroys a
shared pool or an unrelated drained-turn client. A blocked owned SQL backend is
terminated through an independent short-lived, deadline-bound control connection;
closing its socket alone does not promptly cancel a PostgreSQL lock wait. Stop aborts only owned SQL and
HTTPS/executor I/O, then drains inside the core's one shared stop deadline.
The HTTPS client uses one keep-alive agent, per-request deadlines, projected
credentials reread on every call and retained error listeners. Logs carry IDs,
codes and counts only.

Kubernetes ownership checks use exact controller UIDs, not labels as authority.
Conservative PVC owner-name checks may delay cleanup but never authorize deletion.
Native Kubernetes garbage collection owns ephemeral volume removal. As ADR-014
states, a delayed stale CREATE may temporarily create an inert launcher; launch
tombstones persist and reconciliation re-arms exact-identity cleanup. API state
is not proof against arbitrary node partitions or an external force-delete.

Evidence lives in `tests/integration/task-restart.test.ts` (same-store component
restart at T04's eight boundaries), `tests/unit/task-executor-termination.test.ts`
and neighbouring registry/launch/channel tests. These are source-level checks,
not a claim of deployed stage acceptance.
