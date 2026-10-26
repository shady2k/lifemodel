# OpenCode 2.1.4: source references and runtime corrections

The binary is the registry-pinned 2.1.4 archive. Source reviewed at
`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824` (archive digest in `pins.json`).
The runtime probe, not source inspection alone, decides the results.

- [Promise plugin context](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/plugin/src/promise/plugin.ts): default export is `{id, setup(ctx)}`. No v1 chat.message hook.
- [Local loading](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/plugin/module.ts): absolute directory plugin resolves its server export locally. The probe image bakes a dependency-free ESM plugin. No npm installation at startup.
- [Native prompt](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/session.ts): reconcile stable ID, prepare/admit, wake only when `resume !== false`.
- [Reconcile](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/inbox.ts): checks pending entries and promoted message IDs. A retry is not a history search by text. Do not reuse one ID for different commands.
- [Promotion](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/runner/llm.ts): main boundary promotes input before loading context.
- [Parallel join](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/runner/step.ts): tool batch settles before the next main step. Probe logs independently show two tool messages before steering.
- [Durable events](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-event.ts): `session.inbox.enqueued`, `session.inbox.delivered`, execution started/terminal, step started/ended. The plugin observes native events without creating execution.
- [Event transport](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/event.ts): subscription is volatile; disconnect can miss events. The probe's in-memory disposition map proves a live connection, not restart-safe reconciliation.
- [Public session API](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts): native inbox list, context, log, export. `ctx.session` Promise domain exposes context/get/prompt but not inbox.list or log. A retained production bridge needs durable receipt reconciliation, not only the probe's event map.
- [Compaction](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/compaction.ts): summary must match required headings; it can retain recent work separately. A summary is not guaranteed to preserve arbitrary instructions literally.

## Runtime corrections to the source-only proposal

1. Native admission works as proposed. The ACP session ID really addresses the plugin's session.
2. `resume:false` works both during a sleeping tool and after ACP terminal completion. No successor request appears in the latter case until a plain later ACP prompt.
3. `session.context` omits pending input. A late admission ACK followed by absence from context is **not loss**. The native enqueue event is pending; the later delivered event and model body prove insertion.
4. The probe sets a `model.request` hook header for diagnosis. In these runtime compaction requests it still carried `primary`, although the body was the structured compaction template. The stub therefore identifies summarization by its explicit template too. No steering is injected into model traffic. Do not claim the header alone proves request purpose in this pin.
5. For a pending-steer + compaction request together, compaction ran before that steer promoted. A stronger second run first inserts steering, then requests compaction while the final provider reply is held. Its compaction input includes steering, its completed checkpoint retains it, and the next ACP primary request includes it. Both pathways work; neither warrants an unconditional literal-preservation promise.
6. A plain nonempty ACP continuation is sufficient to wake already queued input without resending steering text. This probe does not prove an empty ACP prompt works.
