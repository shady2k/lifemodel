# Prime 0.10.1 native steering: source notes

Read-only review for **lifemodel-653.9.2**. No runtime claim is made here. Read `.worker-brief.md` and `.codex-steer2.md` first. Inspected the supplied `/tmp/pa` source snapshot, not another RPC engine. Its workspace version is `0.10.1`; its daemon protocol is 7, schema revision 30. `/tmp/pa` has no `.git`, so this review cannot independently prove its checkout commit. The probe pin records upstream commit `8aac8692456c00c01d4e53e60e6d3347a3506559`. Source references below are relative to that snapshot. No source edits, builds, tests or tracker writes were made.

## Decisive qualifications to the proposed bridge

1. **Native `steer` wakes idle sessions. There is no OpenCode-style `resume:false` in this handler.** It clears queued-input suspension, enqueues and notifies the runner. An idle-steer test explicitly expects a model reply. A final-answer race therefore can cause successor execution after ACP has sealed its prompt. Merely reading `isStreaming:true` before sending cannot close the race.
2. **Manual `compact` interrupts running execution.** Do not use it during the sleeping-tool check and call the result uninterrupted steering. It aborts the active engine turn before compaction. Use auto-compaction inside a live task, or perform the manual command only at an idle boundary and report its different lifecycle.
3. **`steer` ACK is admission into an in-memory native queue, not durable or exactly-once delivery.** Caller `id` correlates the response only. No caller deduplication key is used. Even supplied `queueKey` / `admissionId` do not become queue identity in `handle_queue`.
4. **Queue absence is not insertion evidence.** The runner removes a batch before executing it. Inspect history/events as well as queue, and use stub request logs for model inclusion.
5. **The supervisor accepts protocol envelopes, not bare command lines.** Although the shared worker parser accepts bare commands, the public supervisor parser explicitly rejects them.

## Same daemon and session identity

`crates/pa-cli/src/print_runtime.rs:93-114` resolves the daemon socket, ensures that daemon is running, then starts `run_daemon_attached_acp_mode` on that socket. Socket precedence is `--daemon-socket` > `PRIME_AGENT_DAEMON_SOCKET` > per-user default (`crates/pa-cli/src/config.rs:13-30`). Pin a private socket path inside the task container and use the exact same path for the steering client. This attaches to ACP's engine. A separate `--mode rpc` process instead calls `build_headless_engine_parts` and constructs its own `RpcEngineHandle` (`print_runtime.rs:230-253`); it is not attachment.

ACP's `sessionId` is a fresh UUID, distinct from the daemon `activeSessionId`: `crates/pa-daemon/src/acp/daemon.rs:1138-1158`. Before the first prompt and before children can appear, list the private daemon and select its single root. Useful root evidence is `rlmDepth:0`, absent `parentActiveSessionId`, correct `cwd`, and `runtimeKind:"top-level"`. Fail if discovery is ambiguous; do not match brief text.

`includeClientOwned:true` is a valid list field (`crates/pa-types/src/daemon/command.rs:124-135`). **In this Rust snapshot it is not a filter:** the supervisor match destructures `all`, `cwd`, `sessionDir`, and `..` (`crates/pa-daemon/src/supervisor/clients.rs:655-670`). The live-list path lists registry residents, without a client-owned exclusion (`supervisor/sessions.rs:532-540`). Thus sending the field is fine, but do not assume it changes Rust behavior. Likewise `cwd` only filters the `all:true` saved-session walk, not the default live registry list.

## Exact daemon wire examples

The supervisor transport is newline-delimited JSON on its socket, **not JSON-RPC**. Read and validate its initial `type:"daemon_hello"` frame. It includes `protocol`, `schemaId`, `schemaRevision`, `appVersion`, `clientId`, and server capabilities. Do not copy or log its whole identity payload; it also includes supervisor ownership information. Source: `supervisor/clients.rs:119-145`. Commands can complete concurrently; correlate response by outer `id`, not read order (`clients.rs:162-215`). Every JSON block below is one line followed by LF.

Discover live sessions:

```json
{"type":"command","id":"list-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"list","includeClientOwned":true}}
```

Reply shape (illustrative subset of a real row; the actual row has more fields):

```json
{"type":"response","id":"list-1","command":"list","success":true,"data":{"sessions":[{"id":"ROOT","activeSessionId":"ROOT","rlmDepth":0,"runtimeKind":"top-level","cwd":"/workspace","isStreaming":false,"isCompacting":false}]}}
```

Admission:

```json
{"type":"command","id":"steer-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"steer","activeSessionId":"ROOT","message":"[steer command=cmd-17] After the tool finishes, inspect the result."}}
```

Successful admission response:

```json
{"type":"response","id":"steer-1","command":"steer","success":true,"data":{"queued":true}}
```

The unique text marker above is a **launcher reconciliation aid**, not native idempotency. Repeating the frame can insert the text twice, even with the same outer `id`. The handler ignores input identity fields and stores `queue_key:None`, `admission_id:None` (`worker/input.rs:197-215`). `resume:false`, `queueIfBusy`, and `streamingBehavior` do not make `steer` non-waking: this handler does not consult them. Do not infer semantics from their presence in the shared `PromptInput` schema.

Exact `queueKey` / `agentMessageId` trace: `PromptInput` declares both (`pa-types/src/daemon/command.rs:85-105`). Supervisor serializes the full typed command into a payload (`supervisor/clients.rs:36-43`), so the fields can reach the worker; they are not rejected by the wire schema. But dispatch sends `steer` directly to `handle_queue` (`worker/commands.rs:74`). That handler never reads either field and creates `agent_message:None`, `queue_key:None`, `admission_id:None` (`worker/input.rs:208-210`), then always enqueues (`:217-220`). The later native `PromptRequest` likewise has `agent_message_id:None` (`worker/turn.rs:332-345`). Thus **valid shared schema does not imply implemented steering semantics**. The different `worker_deliver_message` path also generates a fresh receiver ID (`worker/input.rs:330`) and sets `queue_key:None` (`:375`); it is not caller deduplication either. `restore_actions` does read an action's `queueKey` (`session_custom.rs:198-204`), but restores by pushing items (`:218-222`); that separate restoration path is not `steer` admission.

Queue projection:

```json
{"type":"command","id":"queue-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"get_queue","activeSessionId":"ROOT"}}
```

```json
{"type":"response","id":"queue-1","command":"get_queue","success":true,"data":{"steering":["[steer command=cmd-17] After the tool finishes, inspect the result."],"followUp":[]}}
```

`get_queue` returns text or a labeled preview only; there are no IDs in this projection (`worker/commands.rs:525-539`). It is not an acknowledged-command ledger.

Status:

```json
{"type":"command","id":"state-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"get_state","activeSessionId":"ROOT"}}
```

Its `data` is the same `SessionSummary` used in list rows (`worker/commands.rs:412-423`; `worker/summary.rs:53-70,546-599`). Useful fields: `activeSessionId`, `activity`, `isSessionActive`, `isStreaming`, `isCompacting`, `isRunningTools`, `hasRunningSubagents`, `sessionActions`, `messageCount`, `sessionFile`, `sessionId`. Distinguish `sessionId` (store identity) from `activeSessionId` (routing identity). `activity` excludes queued work in its working test, whereas `isSessionActive` includes queued work; neither is an atomic future-admission fence.

For the more detailed connection flags:

```json
{"type":"command","id":"connection-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"get_connection_state","activeSessionId":"ROOT"}}
```

This includes `isStreaming`, `isCompacting`, `compactionCount`, `autoCompactionEnabled`, `sessionActions`, `contextUsage` and `leafId` (`worker/summary.rs:84-139`).

Model-context history:

```json
{"type":"command","id":"history-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"get_messages","activeSessionId":"ROOT"}}
```

Reply is `data:{"messages":[...]}`. The no-page form is the **compacted model-context view**, not the full historical transcript. After compaction it begins with a `compactionSummary`, then retained messages and later appends (`session_store/view.rs:352-405`). Searching only this form after compaction can miss a previously inserted command that was summarized.

Display transcript, including summaries in branch order:

```json
{"type":"command","id":"history-page-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"get_messages","activeSessionId":"ROOT","page":{"from":"end","limit":100}}}
```

Reply additionally contains `firstEntryId`, `lastEntryId`, `more`, `historyLeafId`. To go older, send `page:{"from":"end","before":"FIRST_ENTRY_ID","limit":100}` and pass the returned `historyLeafId` at command level. Alternatively `page:{"from":"start","limit":100}` walks from the head; optional `after` and `until` bound it. A branch-navigation mismatch returns `success:false,error:"History branch changed"`. Source: `command.rs:12-30,657-667`; `worker/commands.rs:466-522`. Do not treat absence from a limited page as never admitted.

A barrier useful for inspection, but **not an admission lock**:

```json
{"type":"command","id":"idle-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"wait_for_idle","activeSessionId":"ROOT","waitForRlmQuiescence":true}}
```

Do not call a barrier and assume no later steer can wake the engine. Native commands from independent connections are not atomically fenced by it.

Force manual compaction **only after establishing an appropriate idle boundary**:

```json
{"type":"command","id":"compact-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"compact","activeSessionId":"ROOT","customInstructions":"Preserve all steering instructions and their command markers."}}
```

Success has `command:"compact",success:true,data:<CompactionResult>`; skipped, cancelled or failed compactions have `success:false,error:<message>` (`worker/lifecycle.rs:458-522`). It can skip if insufficient history exists, so a success requirement must inspect the response and compaction count/events. Do not count a failed/skip response as compaction exercised.

Automatic compaction toggle (does not itself force a compaction):

```json
{"type":"command","id":"auto-1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"set_auto_compaction","activeSessionId":"ROOT","enabled":true}}
```

Protocol parsing: `protocol.rs:208-268,365-381`; constants: `pa-types/src/daemon/mod.rs:12-17`. The current source accepts only version 7 (both lower and higher fail despite the error saying "7 or newer"). Error/success response schema is `pa-types/src/daemon/outbound.rs:14-28,219-230`.

## Boundary, tools and receipt semantics

`worker.rs:329-339` wires a probe that checks whether the steering lane is nonempty. `pa-core/src/session_engine/engine.rs:712-729` uses it in the post-turn stop hook. The `take()` there removes the probe from the subsequent before-turn configuration in this snapshot, so the explicit post-turn hook is the decisive path.

`pa-agent/src/agent_loop/run.rs:91-117` awaits the whole `execute_tool_calls` batch and appends all results before emitting `turn_end`. Only then does it run the post-turn stop hook (`run.rs:125-160`). Therefore a steer does not itself abort the executing tool batch. It ends the internal engine run at that boundary. The worker then picks the steering batch and runs another internal engine prompt in the same native session (`worker/turn.rs:45-112`). This is not a second process/engine.

The worker's default `steeringMode` is `all`, `followUpMode` is `one-at-a-time` (`worker.rs:314-315`). Multiple distinct steering admissions can therefore be coalesced into one next native delivery batch; this is not a guarantee of one model request per steer. No deduplication follows from batching.

The runner dequeues the batch **before** `run_turn` and sets busy (`worker/turn.rs:62-72,89-112`). Thus a `get_queue` response that is empty can coincide with an item preparing or running, before a model request. Observe its native user row using `get_messages` / `message_start` / `message_end`, and inspect the stub request log to prove model-request inclusion. A native history row alone does not prove that a provider request containing it began or succeeded.

`worker/input.rs:223-240` checkpoints, emits an action update, notifies work and ACKs `queued:true`. `worker/queue.rs:246-294` silently returns if no recovery journal is installed, and discards `record_queue_checkpoint` errors. Therefore the ACK supports **accepted to native live memory** only, not durable persistence. No receipt proves obedience.

Lost ACK procedure: use a launcher command marker and reconcile both queue and native history, then stub model logs in the probe. If the marker is found, do not resend. Absence cannot always establish rejection: it can be in the dequeued/in-flight window or removed by compaction. Report uncertainty instead of blind retry. Outer IDs are transport correlation, not deduplication. The queue has no stable native command ID to query.

## Final-answer / ACP observer race

ACP sends daemon `prompt_and_wait` with `streamingBehavior:"followUp"`, `queueIfBusy:true`, and an admission ID (`acp/daemon.rs:1445-1475`). That wait settles the original worker delivery; the worker then runs any steering batch. ACP subsequently calls `wait_for_headless_completion`, and again a stronger RLM-quiescence barrier, so already queued work can be covered by the original ACP prompt (`acp/daemon.rs:1512-1524,1574-1614`). The idle wait requires no busy turn and no steering/follow-up queue, except paused-input handling (`worker/lifecycle.rs:526-624`).

However, that is an observation, not an atomic close of admission. After the final idle check, independent `steer` remains admissible. `handle_queue` always resumes and notifies; the worker can therefore execute a successor model call. Existing source test `worker/compaction_admission_tests.rs:208-237` proves this intended idle behavior by expecting both idle steer text and a reply.

ACP `producer.finish_prompt` sets the active prompt turn ID to 0 (`acp/producer.rs:65-84`). The terminal path explicitly says later updates resume turn 0 (`acp/daemon.rs:1612-1614`). Thus late work may still produce connection-scoped ACP updates, but is **outside the completed task's original prompt lifecycle**, not invisible engine work in an absolute sense. A client which stops collecting at the terminal response misses it. Runtime probe must hold a final stream open, inject steer around terminal settlement, then continue watching both stub requests and ACP after the response.

A plain later ACP prompt does not merely wake parked native input: Prime's idle steer may already be running, and a nonempty ACP prompt adds another user input. Do not blindly resend steering text. An empty ordinary prompt is rejected by native input handling when it has no images (`worker/input.rs:19-26`), so do not assume an empty-prompt wake fallback works. Plain status polling plus sending steer is subject to TOCTOU. Source provides no non-waking native-steer switch to directly copy OpenCode's completion-barrier design.

**Acceptance risk:** even if ordinary mid-tool steering passes, Prime check 6 (no model work outside an ACP prompt) is not established for a final-answer race by this native bridge alone. A lifecycle fence or changed integration is needed to promise it generally. Runtime evidence can demonstrate a particular successful timeline, but cannot make the source race disappear.

## Compaction qualifications

Manual handler sets `queued_input_suspended:true` before compaction (`worker/lifecycle.rs:347-357`). `compaction.rs:62-63,152-171` aborts an active turn, suppresses its aborted row, and waits for settle. The suspension survives ordinary skip/failure/abort and often successful outcomes unless a resume site clears it. A subsequent native `steer` clears it; ACP prompts also carry `streamingBehavior` and resume it. A plain native prompt without that field on a suspended idle session fails with the suspension error (`worker/input.rs:45-65`).

A steer admitted *during* compaction is parked by `core.compacting`, even though it clears suspension. The compaction tail wakes the pump. Existing source test `compaction_admission_tests.rs:99-205` asserts `compaction_end` precedes the racing steer row and its reply. It is source-test evidence, not a test run in this review.

Once steering is a native user row, normal compaction receives that conversation slice. The summarizer request serializes dropped messages and previous summary (`pa-core/src/session_engine/compaction_exec.rs:40-78`). That is stronger than relay-only injection, but is not a guarantee that literal text or an imperative survives arbitrary summarizer output. Distinguish: pending queue survived; native insertion survived; retained user text survived; summary preserved the instruction; next primary model request contained it. Check each with the stub log and history. Force-compaction custom instructions are helpful test setup, not a native durable steering ledger.
