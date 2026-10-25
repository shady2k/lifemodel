# Task trace schema upgrades

Task traces are disposable evidence. They do not replace terminal task state or
its sealed-outcome outbox proof.

Migration `20261015000025_task_trace_context.sql` assigns each existing task its
immutable task id as a deterministic trace id. Its parent span remains absent:
there is no earlier trace context to recover.

The backfill changes only trace context. The deferred terminal/outbox trigger
skips that exact class of update, so it does not leave pending trigger events
before the trace constraint is installed and validated. All non-trace columns
participate in the comparison, including columns added later. No-op updates and
updates to any non-trace column still run the original deferred proof check.
The trace immutability guard rejects later trace changes.

Terminal rows created before migration 23 may have no sealed receipt or outbox.
They retain their existing outcome without synthetic proof or a new event. The
trace backfill does not revalidate historical finalization. A later non-trace
update of such a row still needs outbox proof; terminal and finalization fields
remain immutable. Valid post-23 terminal rows and their outbox are unchanged.
