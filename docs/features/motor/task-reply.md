# Task replies

Task: lifemodel-653.8.11. The owner delegates long work in ordinary chat.
No task chip or task composer is added. The legacy Motor Cortex loop is unchanged.

## Start

Platform-mode cognition exposes `core.startTask(briefing, profile)`. The complete
briefing includes the goal, context, constraints and the file to produce.
`src/ports/task-profiles.ts` owns the versioned allowed profile catalogue: `small`
revision 1 is 600 seconds, 500 millicores and 512 MiB. Stage 3 deliberately exposes
only this explicit profile. Unknown profile names and missing briefing/turn context
return explicit refusal codes; no default is chosen.
A title is optional at the feature level and is not introduced in this leaf.

The tool applies an explicit `START_TASK` intent through the core applicator and
awaits registry acceptance only. Its launch key is the recipient plus the already
persisted deciding turn id and the one task-effect slot. A replay retains that
key; model-generated tool call ids never define task identity. Before accepting a
new request, a replay-aware execution seam looks up that key in the fenced registry
before both shared argument-validation gates (`prevalidateToolArgs` and
`tool.validate`). An existing task returns accepted with its original ID and current
state even if replay generates missing, null, placeholder, wrong-typed or misnamed
arguments, a different briefing/profile, or a changed caller image. It is not
resubmitted. Fresh calls keep both required fields and strict validation.
The registry's immutable-payload conflict protection remains in place for direct
acceptance requests. The registry persists briefing/profile/settings before dispatch. Acceptance is tracked through
the durable-effect drain. Uncertain infrastructure failures propagate out of the
tool registry so the owned turn fails rather than claiming a refusal after a
possibly committed write. Deterministic registry refusals are safe tool results.

After acceptance, the model tells the owner now that the work has started and
that a result reply will follow. It does not wait for allocation, the executor,
sealing or downloads. The initial reply uses the existing committed outbox.

## End

The [finalizer](task-finalize.md) publishes a sealed `task_outcome`. Both normal
bus append and finalizer relay use its durable keyed admission operation, keyed
by `outcomeKey`, with canonical signal identity. That receipt survives bus and
outbound trimming. Existing snapshot-owned turn ids and atomic snapshot/outbox
commits cover a crash before the reply commit. No in-memory ACK owns deduplication.

The outcome wakes cognition before the energy gate, one outcome per turn. Other
outcomes wait, including when an owner message wins the tick. State, reason code,
summary and all retained objects reach the trigger prompt as data. Plain text is
allowed. The configured primary owner recipient receives this outcome, as with
other infrastructure signals; no task chooses a recipient. CoreLoop captures that
recipient for the outcome turn so the owner's send and the bus-entry completion
share the same snapshot commit, including after outbound receipts are trimmed.
This is a response-only turn. No tools are advertised, and an empty capability
allowlist rejects every tool at execution time, including `core.defer`,
`core.remember`, `core.schedule`, `core.say` and `core.startTask`. Task summaries
and object names are delimited, XML-escaped lower-trust data in a user-role
message, never interpolated into system-role instructions. They cannot authorize
owner-state, schedule or task mutations.

An empty/missing final response is not an acknowledgement, even after a rejected
`core.say` attempt. A `length`-truncated outcome reply is incomplete even when it
contains plain text. The model gets the bounded response retries. If those retries
or model execution fail, a deterministic reply reports the trusted event's terminal
state, maps the reason code to owner words using only own dictionary entries, and
quotes the summary as task output. Unknown codes (including `constructor`) get a
fixed generic explanation, never inherited JavaScript implementation text. This
fallback is fixed English; ordinary model replies still follow the owner's language.
That fallback uses the same trusted result-attachment compiler as a normal reply.
Only the committed answer completes the outcome; neither deferral nor silence does.

For `done`, the intent compiler attaches only `result`-marked sealed object IDs,
with name, size and MIME type (`application/octet-stream` if absent), to the actual
assistant reply. Models cannot choose attachment IDs. The ordinary outbound
consumer stores those references on the message. The existing authenticated
[attachment download](../web/attachments.md) resolves them independently of core.
Failed/stopped replies explain the cause in owner words and attach no objects,
even if partial result marks survived sealing.

The web attachment contract permits 20 files per message. More results use ordered
continuation messages of at most 20 files under the same turn/outbox commit; none
are silently omitted. Invalid result metadata does not strand an immutable outcome
in relay: the reply explicitly says the files could not be attached. Non-result
metadata never blocks result delivery. No bytes, storage URLs or paths enter chat.

## Evidence

`tests/integration/task-reply.test.ts` uses real isolated Postgres and Valkey,
scripted cognition and a fake executor with real launch/finalization infrastructure.
It checks immediate acceptance/reply, sealed outcome/attachment message binding,
crash before each answer commit, duplicate delivery after trimming, concurrent
outcomes, low-energy wake and failure without a fake result. Regressions cover
accepted-launch replay before argument validation, strict fresh-call validation,
forbidden deferral, rejected say followed by empty finals, length-truncated replies
with bounded retry and complete fallback, and adversarial task output with no store
side effects. `tests/unit/task-outcome.test.ts` covers allowed unknown reason codes.
The stale-operation matrix in `tests/integration/task-registry.test.ts` also verifies
that `readByLaunchKey` rejects a stale epoch.
