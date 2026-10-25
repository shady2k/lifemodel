# Disposable run traces

Serves: lifemodel-653.8.24.

A task run writes execution evidence to the Postgres `observability` schema.
This is private content, not process diagnostic logging. Commands, tool output
and final agent text can appear here. Limit access as for conversations.
Core tick tracing onto this store is deferred to lifemodel-vbog.2.

## Schema and writer

Migration `db/migrations/20261015000024_create_observability.sql` creates:

- `trace_spans`: `(trace_id, span_id)` key, parent span id, component,
  start/end timestamps, status and JSON attributes.
- `trace_events`: record-id key, trace/span ids, event name, timestamp and
  JSON fields. An event may survive a dropped span; the reader shows it.

`src/ports/observability.ts` defines generic records. Closed statuses are `ok`,
`failed` and `suppressed`. Open spans have no end or status. The writer maps
unknown closed statuses to `failed`, never to `ok`.

`src/storage/postgres-trace-store.ts` uses the raw Postgres pool. It deliberately
has no active-holder fence. These rows are disposable evidence, not task state,
completion records, replay offsets or outcome authority. An overlapping old
writer must not gain the right to write authoritative state from this API.
A transaction advisory lock only serializes evidence writes with retention.

`enqueue(record)` is synchronous and does not wait for I/O. The default queue
holds at most 10,000 records, including the batch in flight. It writes batches
of at most 128 records in one transaction. A partial batch wakes after 200 ms.
A full queue, invalid record or failed batch increments `droppedCount` and
returns or continues without failing the task. Failed batches are not retried.
Every record is detached and scrubbed before entering the queue. String values
and keys are scrubbed recursively. Token-shaped strings, authorization values,
URL user credentials and configured known secret values are removed. Authorization
header values are removed for every scheme, including comma-separated Digest
parameters. A quoted header ends at its enclosing delimiter; a bare header ends
at CR/LF or the end of the string. Same-line text after a bare header is part of
that value, not a safe suffix. Bags,
strings and records have size bounds. The launcher also removes known token-file
contents before transport; this independent writer boundary is defense in depth.

`flush()` drains queued writes for tests or an explicit read-after-write barrier.
`close(deadlineMs?, signal?)` stops intake and drains. A supplied deadline is an
absolute Unix time in milliseconds. At the deadline or abort signal, the writer
drops queued/in-flight records and destroys its owned checked-out client. A connection acquired after
the deadline is destroyed too. The caller owns the pool and its timeouts.
Core stops trace intake at shutdown start and drains alongside authoritative
work. The stop coordinator passes one absolute deadline into the container,
including time spent closing intake. When authoritative work finishes, an abort
signal cancels the remaining trace writes and stops waiting for disposable pool
disposal. Trace work gets no later budget and cannot hold state-pool cleanup
until the hard-exit deadline. A direct container stop uses the same cancellation
but derives its deadline locally.

## Retention

Retention runs after the first batch, then every 50 batches. It is lazy on
writes: an idle store does not start a separate retention timer. Defaults are
14 days since the latest span
closure, 5,000 traces and 256 MiB of logical row data. The size budget counts
`pg_column_size` across span and event rows; it is not a promise to shrink
Postgres relation files, indexes or WAL to that size.

Pruning removes whole traces, oldest closure first. Every span must have a
closed status and end time. One open child protects the entire trace. Events-only
traces are protected because their closure is unknown. Protected traces can
exceed every budget; retention never trades active evidence for a hard limit.
Lost open/close frames can leave incomplete traces. This is an explicit cost of
fail-open tracing. The schema is disposable and can be cleared independently
when this protected data needs operator cleanup.

## Reader

Run on the installed host:

```text
lifemodel doctor trace last
lifemodel doctor trace last 5
lifemodel doctor trace <trace_id>
```

The reader executes a read-only Postgres transaction inside `core-0`, using its
existing `pg` dependency, environment and database route. It does not fetch
Kubernetes Secrets, expose credentials in command arguments, install a database
client on the host or require a task pod to have database access. The core pod
and observability schema must be available. Errors report a fixed unavailable
message, not raw database errors. An explicit trace id is a bound SQL parameter.
`last` defaults to one trace; the allowed range is 1–20. Each trace display is
capped at 10,000 spans and 10,000 events and marks truncation.

Example:

```text
trace 9e739f
  task [failed] 1250ms span=run failureSpanId="tool-1" reasonCode="required_tool_failed"
    tool [failed] 120ms span=tool-1 command="false" exitCode=1 outputTail="command failed"
    tool [ok] 30ms span=tool-2 command="true" exitCode=0
```

Open spans display `[incomplete] open`. A missing parent becomes a displayed
root. Orphan events and malformed span cycles remain visible. Control characters
are removed from terminal output. This command reads committed evidence only;
a recent frame can still be queued or lost. An empty trace is not proof that a
run did nothing.

## Checks

`tests/unit/trace-store.test.ts` checks real Postgres persistence, failed and
successful tool spans, closure updates, unknown status, queue and write drops,
known-secret and shaped-token canaries, shutdown drain, and each retention axis.
`tests/unit/doctor-trace.test.ts` runs the reader's actual query against the test
Postgres database through an emulated `kubectl exec`, then checks the stored tree,
exit codes, durations, incomplete spans, latest selection and safe errors.
