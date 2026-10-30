# Task replies

Tasks: lifemodel-653.8.11, lifemodel-653.8.22. The owner delegates long work in ordinary chat.
No task chip or task composer is added. The legacy Motor Cortex loop is unchanged.

## Start

Platform-mode cognition exposes `core.startTask(briefing, profile, expectedOutputs?, redoOf?)`.
The complete briefing includes the goal, context, constraints and the output files
to produce. Optional `expectedOutputs` is a list of at most 16 unique plain file
names (ASCII letters/digits first, then letters/digits, `.`, `_` or `-`, at most
128 characters each). Omit it for answer-only work. Core stores these names with
the accepted task. A clear request runs at once. If a request has material doubts
or several readings, agree the plan and expected files with the owner first.
A plan is not a result, and "started" is permitted only after acceptance in the
current turn, including a recovered acceptance receipt.
`src/ports/task-profiles.ts` owns the versioned allowed profile catalogue: `small`
revision 1 is 600 seconds, 500 millicores and 512 MiB. The catalogue exposes
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
This is a verification-and-reply turn. Cognition may read only this outcome's
status, transcript and delivered files through `core.steerTask(action="read")`.
Before claiming a result, it checks expected names, opens their contents and
compares them with the owner's request; it reads the transcript when in doubt.
For `done` outcomes with declared expected files, core requires successful reads
of all expected names before accepting a normal final reply. Missing read evidence
gets bounded retries, then an honest fallback instead of an unverified claim.
Outcome turns allow up to 24 iterations so all 16 expected files can be read
within the existing tool and time bounds. Reading bytes does not prove semantic
correctness; that comparison remains the agent's responsibility.
A transcript and final report are claims, not evidence that a command ran or that
its result is correct. Task state, reason, startup phase, sealed file metadata,
bytes read through core and command delivery receipts are observations.
The agent speaks in first person about its own work. It does not relay a worker's
claim as fact or say "the worker reported" as a substitute for verification.
Status answers use actual state and receipts, with uncertainty made explicit.
Task summaries, file contents and object names remain delimited, XML-escaped
lower-trust data, never system instructions. They cannot authorize owner-state
or schedule mutations.

If verification fails, the agent may start exactly one corrected redo and briefly
tell the owner it is redoing. It calls `core.startTask` with `redoOf` equal to
this outcome's task ID. Core refuses a redo of a redo and a second redo of the
same original, including concurrent requests. An omitted redo output list
inherits the original; a different explicit list is refused. The linkage is
durable and an accepted launch still replays under its deciding-turn key. A second failed
verification ends with an honest account of what failed and why, and a question
about how to proceed. Other tools, including `core.defer`, `core.remember`,
`core.schedule` and `core.say`, remain forbidden in an outcome turn. An accepted
redo suppresses the original output attachments on the redo notice. If the model
fails after acceptance, the fallback acknowledges that redo instead of asking as
if no work were running.

An empty/missing final response is not an acknowledgement, even after a rejected
`core.say` attempt. A `length`-truncated outcome reply is incomplete even when it
contains plain text. The model gets the bounded response retries. If those retries
or model execution fail, a deterministic first-person reply uses only the
core-committed state and a fixed reason dictionary. It never quotes the worker's
summary or claims content verification it did not do. Even for `done`, it says
that the files arrived but their contents could not be verified. Unknown codes
(including `constructor`) get a fixed generic explanation, never inherited
JavaScript implementation text. This
fallback is fixed English; ordinary model replies still follow the owner's language.
That fallback uses the same trusted output-attachment compiler as a normal reply.
Only the committed answer completes the outcome; neither deferral nor silence does.

For `done`, the intent compiler attaches `result`- and `artifact`-marked sealed
object IDs, with their plain name, size and MIME type (`application/octet-stream`
if absent), to the actual assistant reply. Artifact files reported through
`artifactObjectIds` reach the reply through the seal manifest, not model-selected
attachment IDs. A completed outcome still requires a sealed `result`; artifacts
cannot substitute for it. The launcher no longer produces a fixed log object
or reports `logObjectId`; task traces are observability data, not attachments.
Explicit `log`-marked objects are not attached. The ordinary outbound consumer
stores those references on the message. The existing web attachment component
renders the plain name and uses the object ID only for its authenticated
[attachment download](../web/attachments.md). Failed/stopped replies explain the
cause in owner words and attach no objects, even if partial result or artifact
marks survived sealing.

The web attachment contract permits 20 files per message. More result and artifact
files use ordered continuation messages of at most 20 files under the same
turn/outbox commit; none are silently omitted. Invalid output metadata does not
strand an immutable outcome in relay: the reply explicitly says the files could
not be attached. Trace availability and log metadata never block output delivery. No storage URLs or workspace paths enter chat. The bounded read view provides
text for verification, not a second attachment transport.

## Evidence

`tests/integration/task-reply.test.ts` uses real isolated Postgres and Valkey,
scripted cognition and a fake executor with real launch/finalization infrastructure.
It checks immediate acceptance/reply, sealed result and artifact attachment binding
with plain names (without logs), ordered output continuations,
crash before each answer commit, duplicate delivery after trimming, concurrent
outcomes, low-energy wake and failure without a fake result. Regressions cover
accepted-launch replay before argument validation, strict fresh-call validation,
forbidden deferral, rejected say followed by empty finals, length-truncated replies
with bounded retry and complete fallback, and adversarial task output with no store
side effects. `tests/unit/task-outcome.test.ts` covers allowed unknown reason codes.
The stale-operation matrix in `tests/integration/task-registry.test.ts` also verifies
that `readByLaunchKey` rejects a stale epoch.
