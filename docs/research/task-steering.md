# Research: native mid-turn steering behind ACP (lifemodel-653.9.2)

Date: 2026-10-27 (runtime receipts are UTC on 2026-10-26).
Scope: OpenCode **2.1.4** and Prime Agent **0.10.1** with a scripted model.
This is a research probe for stage 4, not stage acceptance. No production code,
registry, owner model gateway, real model credential or tracker item was changed.

**Result:** OpenCode's baked plugin works for uninterrupted native steering,
including a non-waking late-input fallback. Prime's existing ACP daemon is the
correct engine and handles mid-tool steering, but its native `steer` always
wakes execution. A late admission starts a model request **after ACP returned
`end_turn`**. Do not approve the proposed Prime bridge as an ACP-observed task
harness without an admission/lifecycle fence. Neither observation resolves the
separate ACP gaps from the [previous probe](task-harness-acp.md).

## 1. Question, method and reproducibility

The whole task is one ACP `session/prompt`, potentially hours long. ACP v1 has
no standard mid-turn input. The owner's stage-4 decision retains ACP for task
lifecycle and output, but admits steering through each agent's native queue.
Relay injection and `session/cancel` are not used here.

The supplied `.codex-steer2.md` was source-only analysis. This probe tested its
proposals rather than treating them as runtime guarantees. It reused the
previous probe's raw ACP connection, candidate configuration, verified Prime
release pin and `Dockerfile.probe`. The actual compiled
`createTaskModelRelay` forwards to a loopback TLS stub. **The relay is not changed
and never inserts steering.** The stub logs every request body before replying.
It scripts tool calls from the agent's actual tool offer, not fake tool events.

All runs use a disposable container, `--network none`, 1 CPU, 1 GiB memory and
256 PIDs. Only the two research directories, generated probe certificate/token,
and the run's output directory are mounted. No owner config, credential,
checkout root or Docker socket reaches an agent. Agent environments are built
from explicit values and fresh private HOME/TMPDIR. Model auth is the literal
placeholder `probe-placeholder-only`. `strace -f -e trace=connect` covers the
container's processes. Retained IPv4 attempts are loopback only. OpenCode also
probes local model servers at 1234/11434/8000; those failed probes are not model
requests to the stub or external egress. This is not a new no-egress audit.

Exact pins are in [pins.json](task-steering/pins.json); image identities and
build logs are in [evidence](task-steering/evidence/). Prime's archive SHA-256
was verified against the previous probe's published digest. OpenCode is the
registry-pinned native archive with SHA-256
`ce05abe2dce1041391c8ec8cdb8da066f640fd471e72ac846dcb089c441e11e1`.
The baked plugin has no external dependency. All builds ran serially through
`lifemodel-heavy`, including the previous overlay that installs Prime's bundled
Python runtime and packages at image time. No runtime package install or source
build of either agent was used.

Reproduce from the repository root; [README](task-steering/README.md) gives the
complete build and certificate steps. Each directory refuses reuse:

```sh
python3 docs/research/task-steering/run-local.py opencode mid --name final-opencode-mid
python3 docs/research/task-steering/run-local.py prime-agent mid --name final-prime-agent-mid
# One at a time, all six scenarios for both agents:
python3 docs/research/task-steering/run-all.py
python3 docs/research/task-steering/collect-evidence.py
node docs/research/task-steering/verify-evidence.mjs
```

The [summary](task-steering/evidence/summary.json) indexes **12 retained final
runs**. Each `exit-code.txt` is **0**, the bounded Docker command's status captured by
`run-local.py`, not a claim that the agent passed every criterion. Negative Prime results are expected and
asserted by the verifier. Each folder has the exact command, full stub request
bodies, ACP transcript, native admissions/status/history as relevant, trace and
result. [sha256.json](task-steering/evidence/sha256.json) binds raw evidence, probe source
and reused research runtime inputs. [Script provenance](task-steering/evidence/script-provenance.json)
retains the pre-strengthening driver used for the other 11 cases; only the
OpenCode promoted-retry branch changed before its final rerun. The generic ACP driver speaks the same standard
initialize/new/prompt messages as the loader client; this probe did not add a
native execution fallback or substitute a second engine.

Scenarios:

- `mid`: a shell runs `sleep 20`; send steering after its start marker and before
  its completion marker. Require the real tool result before the steering user row.
- `parallel`: one response contains **two** tool calls, sleeping 4 and 8 seconds;
  require both results before steering. This tests batch ordering. Prime executes
  its Python calls serially in this configuration; simultaneous OS execution is
  **not** claimed.
- `compact`: admit steering during the long tool, insert it, then compact native
  history before checking a later primary request. Details below distinguish
  OpenCode's compaction command from Prime's automatic threshold path.
- `duplicate`: submit twice while pending, then retry once more after promotion.
  OpenCode uses the same message ID; Prime uses the same outer command ID. This
  models a replay after a lost ACK; it does not physically cut the socket mid-write.
- `tail`: flush final assistant text, hold the response before the stop frame,
  admit steering, then finish that response. Check the next model call is covered
  by the **same** original ACP prompt.
- `late`: admit immediately after ACP `end_turn`, watch two seconds with the
  agent alive, inspect native disposition, then send a **plain nonempty ACP
  continuation** without resending steering text. This brackets the late side
  of the final-answer race deterministically; it is not random race sampling.

## 2. OpenCode 2.1.4

### Mechanism

The [baked local plugin](task-steering/plugin/index.mjs) exports `{id, setup}`.
It listens on a private Unix socket in the container and calls the pinned v2 API:

```js
await ctx.session.prompt({
  sessionID, id: "msg_steer_unique_6539", text,
  delivery: "steer", resume: false,
});
```

The ACP session ID is the native session ID. Admission returns the native user
inbox item. The plugin also subscribes to native enqueue/delivered events and
exposes `pending` / `inserted` disposition for the live probe. It neither edits
model messages nor owns a second loop. [Source notes](task-steering/opencode-source-notes.md)
link exact pinned mechanisms and explain the limits of this small observer.

### Checks 1–2: uninterrupted tool and whole-batch ordering — pass

[Mid-tool evidence](task-steering/evidence/opencode-mid/): ACP began at
`21:53:07.782`; steering ACK at `21:53:08.640`, with completion marker absent;
ACP ended at `21:53:28.398` (20,616 ms). The shell completes normally:

```json
{"ok":true,"data":{"id":"msg_steer_unique_6539","type":"user","payload":{"text":"STEER_UNIQUE_6539: use the native input queue."},"delivery":"steer"}}
```

The next stub body contains, in order (system and earlier history omitted):

```json
[
  {"role":"assistant","tool_calls":[{"id":"call_probe_1_0","function":{"name":"shell"}}]},
  {"role":"tool","tool_call_id":"call_probe_1_0","content":"start-0\ndone-0\n"},
  {"role":"user","content":"STEER_UNIQUE_6539: use the native input queue."}
]
```

ACP emits the shell's completed update and finishes `end_turn`. No cancel was
sent. Both model calls occur within that single prompt. The two-second observer
sees no extra request.

[Two-tool evidence](task-steering/evidence/opencode-parallel/): the first response
contains two shell calls. ACK arrives before either done marker. The next body
has **two** `role:tool` results, each with its matching ID and `done-N`, followed
by **one** steering `role:user`. ACP ends after 8,642 ms. This establishes join
ordering, not merely the presence of one completed tool.

### Check 3: compaction — pass, semantic retention is not exactly-once text

[Compaction evidence](task-steering/evidence/opencode-compact/): steering first
appears in primary request 2. While that response is held, the driver asks the
plugin to call `ctx.session.compact({sessionID, delivery:"steer"})`. It runs at
the next boundary without aborting the sleeping tool (which has already settled).
The actual summarizer request includes steering. Native context reports:

```json
{"type":"compaction","status":"completed","reason":"manual","metadata":{"keepID":"msg_steer_unique_6539","recent":"[User]: STEER_UNIQUE_6539: use the native input queue.\n\n[Assistant]: PROBE_FINAL: finished."}}
```

The first ACP prompt includes this compaction and ends at `21:54:07.663`.
No request occurs during the subsequent idle observation. A plain later ACP
prompt begins at `21:54:09.680`; its primary request contains the checkpoint and
steering. The stub summary copies the marker **only if it occurs in its input**.
It does not manufacture a missing steering instruction.

The post-compaction body contains the marker twice: once in the structured
summary and once in the retained recent-context checkpoint. This is **not two
native admissions**, but it disproves a stronger “the literal marker always
occurs exactly once in every future provider body” claim. Native-ID idempotency
and summary semantics are different guarantees. A real model could also omit or
paraphrase an instruction in a summary. Keep command disposition separate from
summarized conversation.

Runtime correction: the diagnostic plugin `model.request` header called these
compaction requests `primary` on this pin. The stub therefore also identifies
the explicit native summarizer template. Neither that header alone nor a low
context setting is counted as proof compaction happened; completed native state
and the actual summarizer body are retained.

### Check 4: lost-ACK replay — pass for native admission

[Duplicate evidence](task-steering/evidence/opencode-duplicate/): two pending
submissions return the same native ID **and original creation time**. The next
body has one steering user message. After ACP finishes, a third identical-ID
submission returns the same stored identity; no model request appears during
the one-second idle check. A later plain ACP continuation then makes request 3,
which still has only one steering user row. Post-retry native context contains
exactly one user row with that ID. The promoted receipt reports its promoted-row creation time, which differs
from the original pending enqueue time; stable identity is the ID, not that
timestamp. The plugin uses `resume:false` even for retries. This tests pending and already-promoted
reconciliation; it does not test a crash or storage corruption.

### Check 5: final-answer race — delivered or pending, visible to driver

[Tail evidence](task-steering/evidence/opencode-tail/): final text is flushed at
`21:54:39.858`. Admission happens before the stop frame. Primary request 2
contains steering; original ACP ends only at `21:54:40.092`. The live native
receipt is `inserted`. A later control prompt does not resend the text.

[Late evidence](task-steering/evidence/opencode-late/): after first ACP terminal
at `21:54:45.935`, admission ACK succeeds. Two seconds later model requests are
still **1 → 1**, native context has no steering row yet, and the plugin returns:

```json
{"ok":true,"data":{"id":"msg_steer_unique_6539","status":"pending"}}
```

The next ordinary ACP prompt contains only:

```text
Continue with any already queued input; no steering text is resubmitted.
```

It wakes the same native session. Request 2 contains the previously admitted
steering once, then the continuation user input. The plugin records
`session.inbox.delivered`. No text was lost or resent. An **empty** ACP prompt
was not tested and is not required by this recommendation.

### Check 6: ACP observer — pass on tested paths

All model requests, including compaction, lie within an open ACP prompt.
The late input stays parked until the next ACP prompt. Stable-ID retries after
completion do not wake a successor. There are no new tool calls outside ACP.
This is the central reason to retain `resume:false`; default wake behavior was
not used. The observer is tested for a bounded two-second idle interval, not
all possible future background features.

## 3. Prime Agent 0.10.1

### Mechanism: same daemon, not a second RPC engine

ACP launches the existing supervisor/worker through:

```text
/opt/probe/prime-agent/prime-agent --mode acp --offline --no-session --provider probe --model task
PRIME_AGENT_DAEMON_SOCKET=/work/probe/tmp/daemon.sock
PRIME_AGENT_CODING_AGENT_DIR=/work/probe/home/.prime/agent
PRIME_AGENT_KERNEL_PYTHON=/opt/probe/python/bin/python
```

Only explicit offline/telemetry-disable controls and private config from the
[previous probe](task-harness-acp.md) are used. The launcher attaches to **that
same** Unix supervisor socket. It reads protocol 7 / appVersion 0.10.1 hello,
then sends a newline-delimited native envelope, not JSON-RPC:

```json
{"type":"command","id":"native-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"list","includeClientOwned":true}}
```

Before the brief, list has exactly one root. The driver refuses ambiguity and
saves its `activeSessionId`. The ACP UUID is **different**. For the retained mid
test they are respectively `0243fa784cb3` and
`ed1968c2-8799-481d-8aa2-f618872c394a` (see raw result for authoritative IDs).
Native status during the running ACP tool reports that root, `runtimeKind:
"top-level"`, `isRunningTools:true`, `isStreaming:true`, `workerPid:22`, and the
pending steering queue. The next ACP-observed tool/result request contains that
same steering. No `--mode rpc`, second daemon or second native engine is started.

Admission envelope:

```json
{"type":"command","id":"steer-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"steer","activeSessionId":"ROOT","message":"STEER_UNIQUE_6539: use the native input queue."}}
```

Reply:

```json
{"type":"response","id":"steer-1","command":"steer","success":true,"data":{"queued":true}}
```

[Source notes](task-steering/prime-source-notes.md) document framing, root
selection, queue/history inspection and the source evidence for weaker
semantics. The supplied `/tmp/pa` snapshot has no Git metadata; the runtime
version and release archive digest are independently pinned. Its shared schema
contains `queueKey` / `agentMessageId`, but the **steer handler does not use them**.
Do not mistake a schema field for implemented deduplication.

### Checks 1–2: uninterrupted tool and whole-batch ordering — pass

[Mid evidence](task-steering/evidence/prime-agent-mid/): admission takes 13 ms
while `sleep 20` is live. During-tool native status shows one queued item and
running tools. ACP lasts 20,225 ms, the done marker exists, and the next body is:

```json
[
  {"role":"assistant","tool_calls":[{"id":"call_probe_1_0","function":{"name":"python_repl"}}]},
  {"role":"tool","tool_call_id":"call_probe_1_0","content":"start-0\ndone-0\n\n"},
  {"role":"user","content":[{"type":"text","text":"[python-skills-unavailable] ..."}]},
  {"role":"user","content":[{"type":"text","text":"STEER_UNIQUE_6539: use the native input queue."}]}
]
```

The intervening kernel notice is real; it is not stripped to invent adjacency.
Steering is a separate **user** message after the tool result. Both model calls
are within the one ACP request. No tool interruption or `session/cancel` occurs.
The notice means optional Python skill modules were not installed in this probe
image. The exercised built-in `bash` path succeeds; unrelated skills are not tested.

The scripted Python uses `bash(command, yield_after=60)` then awaits its handle.
The pin's default await returns a live snapshot after ten seconds. An initial
scratch run omitted the explicit bound and raised on `exit_code=None` before
the 20-second command ended. That run is **not valid mid-tool evidence** and is
excluded from the retained final runs. The corrected stub waits for the actual
shell exit, including its own nonzero-exit check.

[Two-tool evidence](task-steering/evidence/prime-agent-parallel/): the first
model response has two `python_repl` calls. ACP's next request contains both
matching tool results before the single steering user row. Both markers exist;
ACP lasts 12,251 ms because these Python calls are serial. This proves the
requested whole-response batch join; it does not claim Prime parallelizes them.

### Check 3: automatic compaction — pass on the scripted path

[Compaction evidence](task-steering/evidence/prime-agent-compact/) uses a declared
32,768-token model window, native compaction settings `reserveTokens:1024`,
`keepRecentTokens:100`, `thresholdPercent:50`, a 120k-character initial brief,
and large shell output. Stub usage reports 30,020 tokens until compaction; that
is a deliberate trigger, not a measurement of real model tokens. A second tool
round creates compactable work after steering. No manual daemon `compact` is
sent in this retained run: that command aborts active work and would invalidate
the uninterrupted claim.

Within the **original ACP prompt**, the actual sequence is:

```text
primary 1:       no steering; starts sleep 20
compaction 1:    pending steering is not in dropped-prefix input
primary 2:       tool result + native steering user row, once; second tool round
compaction 2a:   summarizer input includes STEER_UNIQUE_6539
compaction 2b:   split-turn prefix summary (no marker in that slice)
primary 3:       native steering still in context, once; final answer
ACP end_turn
```

The split summarizer calls are not new ACP prompts or a second engine.
`get_connection_state` reports **compactionCount:2**. Native compacted history
contains the steering marker in the compaction summary (not the original
steering user row). Primary request 3 and the next plain ACP control prompt
carry the summary-backed marker once. Both the pending-before-compaction and
inserted-before-compaction cases therefore have runtime evidence for Prime. The stub only
copies a marker it was given; there is no relay reinjection. In primary request 3
the marker is summary-backed content inside a harness-digest user message,
not the original steering user message preserved verbatim.

Early smaller histories skipped compaction as `Session is too short to compact`;
usage counters alone did not make them valid. Enlarging only the first brief
was also insufficient: the native keep-tail cut could retain that whole brief.
Large later tool output and another tool round made the prefix discardable.
Only successful native compactions above count toward the verdict. Arbitrary
real summarization quality and all context limits are outside this probe.

### Check 4: lost ACK — native exactly-once fails; launcher must reconcile

[Duplicate evidence](task-steering/evidence/prime-agent-duplicate/) deliberately
reuses outer ID `lost-ack-stable-id`. Two pending sends each ACK `queued:true`.
The next model body contains **two** identical steering user rows. Native history
also has two rows. A third retry after promotion starts a new request outside
ACP, containing **three** rows. The outer ID is correlation, not idempotency.

A launcher must retain its own command ledger and serialize submissions. After
an ambiguous send it must reconcile **both** native pending queue and history
using a unique command marker, with complete history pagination where required.
Queue absence alone is not insertion: the worker dequeues before running.
If positive/negative evidence cannot distinguish in-flight admission from a
never-written command, return **uncertain**, not blindly retry. This protocol
does not prove durable exactly-once across launcher/daemon failure, and this
probe does **not** implement such a reconciliation algorithm. `queued:true`
cannot be upgraded to that promise.

### Check 5: final-answer race — partial mechanism works; contract fails late

[Tail evidence](task-steering/evidence/prime-agent-tail/): final content is
flushed at `21:56:31.912`. Steering is queued before stop; request 2 includes it
and original ACP returns at `21:56:31.996`. Thus this side of the boundary is
covered by the existing ACP quiescence wait.

[Late evidence](task-steering/evidence/prime-agent-late/) is decisive:

```text
21:56:39.405  ACP prompt 1 returned {stopReason:"end_turn"}
21:56:39.413  native steer ACK {queued:true}
21:56:39.423  NEW primary model request 2 includes steering
21:56:41.414  observer: requestsAtEnd=1, requestsAfter=2
21:56:41.431  ACP prompt 2 starts (plain continuation, no resend)
```

The driver can inspect queue/history and observe that work happened, but native
steer offers no non-waking accepted-and-deferred state. The ordinary continuation
works without resending text, yet it comes **after** a successor already ran.
A status check before `steer` has a time-of-check/time-of-use race; it is not a
completion fence. See raw timestamps for the exact interval, not assumed timer
or tool-count ordering.

### Check 6: ACP observer — fail

Request 2 above lies after original terminal and before any next prompt. No
second engine was used, and ACP can still emit some connection-level updates,
but it is **outside an active ACP prompt lifecycle**. A client that stops at
`end_turn` does not own this successor. The duplicate-after-promotion control
independently reproduces the same wake. This bridge cannot guarantee “all work
is observed inside an ACP turn.” Its ordinary mid-tool success does not waive
that failure.

## 4. Honest receipts and proposed TaskHarness contract

Admission must return promptly, without waiting for the model or a stalled tool.
No receipt proves obedience, correctness or that the provider successfully
finished the request.

| Receipt / state | OpenCode plugin | Prime daemon `steer` |
|---|---|---|
| `received` | Launcher durably records command ID before forwarding (proposed launcher duty, not implemented by this probe) | Same launcher duty |
| `accepted` | Native inbox item returned; source commits native admission before ACK. Stable ID reconciles pending and promoted input. Crash durability was not fault-injected here. | `{queued:true}` proves in-memory native queue admission. Checkpoint errors are discarded in the source; **not a durable ACK**. No native dedup. |
| `pending` | Native enqueue observed, no delivered event yet. Late run proves non-waking deferral. | Queue projection can show pending, but `steer` may immediately wake it. Absence does not prove insertion. |
| `inserted` | `session.inbox.delivered` plus native user row; live observer tested. | Native history/events show the user row. ACK alone does not. |
| `model-requested` | Stub received a main-session body containing the instruction; diagnostic model hook alone is insufficient identity proof after compaction. | Stub body plus identified native root; history alone is not proof. |
| `uncertain` | Event subscription disconnect/restart requires reconciliation. Probe map is volatile. | Lost ACK / dequeued-in-flight / incomplete history requires reconciliation; never silently retry. |
| `deferred-to-next-turn` | Honest after completion barrier: admitted but still pending with `resume:false`; next plain ACP prompt wakes stored text. | **Not safely available** from native steer on this pin: admission itself resumes. |

Suggested port shape (recommendation, not an ADR or implementation change):

```ts
steer({ commandId, text }): Promise<{
  commandId: string;
  admission: 'accepted' | 'rejected' | 'uncertain';
  nativeMessageId?: string;
  persistence: 'native-committed' | 'best-effort' | 'unknown';
}>;
// Separate async receipts: inserted, model-requested, deferred-to-next-turn,
// failed, uncertain. Never make the intake ACK wait for these.
```

`received` belongs to the launcher intake ledger. Agent ACK determines
`accepted`; the two must not be conflated. A local IPC write alone is only a
send attempt. Record native evidence and command identity separately from
compacted message text. Preserve D2's independent owner-intake workers.

For OpenCode, amend ADR-014 narrowly to permit a baked native-admission plugin
behind TaskHarness while ACP owns start, output and terminal lifecycle. Require:

1. Stable per-command native IDs, `delivery:"steer"`, **always `resume:false`**.
2. A completion barrier that closes this turn's intake, settles all admissions
   in flight, reconciles command dispositions, then declares task completion.
   Accepted late commands remain pending; use a plain ACP continuation without
   resending them. The probe tests the primitives, not this production barrier.
3. Persistent launcher receipts and restart/disconnect reconciliation. The
   probe's live event map is not sufficient production storage. Native context
   alone omits pending input and can summarize older input.
4. Guarantee only the **next available main boundary or explicit deferred/
   failed/uncertain disposition**, not bounded-time consumption while preserving
   an indefinitely stalled tool. Do not promise literal once-only text after
   compaction.

For Prime, **do not approve the proposed daemon-steer bridge under the current
observer requirement**. A non-waking native admission mode or an atomic
admission/lifecycle fence must be demonstrated before acceptance. Separate
launcher dedup/reconciliation is also needed. A second RPC process, ACP cancel,
prose parsing or relay injection is not a valid workaround. This is a completed
negative finding, not permission to weaken the owner's rule. The native queue
is viable for busy-turn delivery, but the final boundary remains unsafe.

## 5. Verdict and limits

| Check | OpenCode 2.1.4 | Prime Agent 0.10.1 |
|---|---|---|
| 1. `sleep 20`, then user steering after result | **Pass** | **Pass**, explicit native Python await bound |
| 2. Two calls in one response, after both results, once | **Pass** | **Pass**, batch ordering; serial execution |
| 3. Admitted input survives actual compaction | **Pass**, instruction may appear in summary and retained context | **Pass**, two automatic compactions inside ACP |
| 4. Same-ID resend | **Pass**, pending and promoted | **Fail** native exactly-once; reconciliation requirements documented, not implemented |
| 5. Final boundary + plain prompt, no resend | **Pass**, tail inserted / late pending | **Fail** full contract: tail works, late already executes a successor |
| 6. No model/tool work outside ACP prompt | **Pass** tested paths | **Fail**, direct runtime counterexample |
| Recommendation | Permit narrowly scoped plugin integration with completion barrier and durable receipt work | Reject this bare bridge for the required lifecycle contract |

No production code, Job, registry, ADR, live model quality, real gateway,
external provider, Responses API, arm64, arbitrary nested agents, multi-hour
load, daemon/Pod/launcher crash, disk-full checkpoint, malicious input, or
restart-safe receipt algorithm is tested. The fixture IPC socket is unauthenticated
inside the private container and records full synthetic requests; a production
bridge needs socket access control and redacted logging. Exact command receipts
include the host worktree path, not credentials; published examples can use a
checkout placeholder. Prime uses `--no-session`; durable
restart of its history is not claimed. Lost-ACK testing replays stable commands
without forcibly dropping transport. Final boundary tests bracket controlled
points, not every possible scheduler interleaving. The two-second observer plus
source wake semantics support these bounded conclusions, not universal future
background inactivity. Full product checks are not run for research-only files.
The automatic stage document gate is not installed and did not run.

The evidence verifier and scoped syntax/compilation checks are recorded in
[checks.txt](task-steering/evidence/checks.txt). An independent same-model
read-only evidence review is retained in [review.md](task-steering/review.md);
it is not stage acceptance. Probe containers/images are removed after evidence
capture; shared dependency images/cache are not pruned.
