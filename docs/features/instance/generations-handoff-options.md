# Native lifetime and current-data handoff — source-only contract

**Superseded 2026-10-11 (owner):** generations run as their own containers started by the loader, with state in Valkey and Postgres; the same-container candidate this document reasons about is not built. Kept as the record of that direction; see `docs/charters/instance-1.md`.

Status: supporting source-only design proposal; not operational release or migration proof.
Change: lifemodel-b0r-design. Task: lifemodel-b0r.8.2. Source baseline: 78a5dca.
Input: fresh `shady2k-gateway/glm-5.3-flash` report, with coordinator corrections. Raw `/tmp/lifemodel-b0r-handoff-options.md` remains historical, not an acceptance contract.

## Pinned evidence and limits

Lockfile pins `@lancedb/lancedb` 0.26.2, `@huggingface/transformers` 3.8.1, `onnxruntime-node/common` 1.21.0, pino 10.3.0, thread-stream 4.0.0 and grammy 1.39.3. Public pinned tarballs were read, never installed/executed.

- Lance `dist/connection.d.ts` and `dist/table.d.ts` expose `close(): void` and `isOpen()`. Connection documentation says created tables remain independent after connection close: close every owned table then connection. Package API exists; `src/storage/lance-vector-store.ts` wrapper has no close surface. Flags/declarations do not prove native fd/mmap/task release.
- Pinned Transformers package source (`@huggingface/transformers` tarball, pipelines.js and models.js) awaits model dispose and disposal of owned session handlers; these are package paths, not repository files. ONNX binding exposes dispose and common interface exposes release. Actual native completion remains a proof gate; current embedder hides disposal.
- Explicit pino transport can retain thread-stream, end and observe close. Existing logger discards that handle. Flush/end/close, child transports and external owners must be accounted; no bounded native release guaranteed by these declarations.
- grammy stop does not await middleware. Existing Telegram intake adds its own emit drain. Same-token cross-process exclusivity is an admission obligation, not Telegram/grammy dedup proof.

## Release and same-process construction

Recommended pattern: explicit resource ownership + awaited release, then whole-container fresh construction **in the same initialized candidate process**. Partial graph rewiring lacks a current surface. Process-exit/new-process activation is rejected because it violates the settled owner requirement; this design does not ask to reopen it.

Inventory to close/await/fence: state/deferred flush/autosave timers, registries/debounces, conversation/memory graph/vector, embedder/native sessions, provider/tool/consumer references, every plugin activation/continuation, scheduler, loop, Telegram bot/download/emits/sends, Motor workers/containers/results, settings/config writer, logging threads/descriptors. Arbitrary dynamic import remains denied/deferred. Cancel/await tracked operations and prevent new admissions before final flush; current loop durable-write guard is not a universal writer fence. Any unknown owner refuses release.

Primary release requires both authenticated per-step observations and independently validated lifetime/descendant/external-owner closure. Child preflush intent is diagnostic only, never authoritative release. Loader stop/exit code alone is likewise insufficient. A loader-owned attempt/epoch grant is valid only for its matching candidate and verified exclusive release; stale grants/panic/restart refuse. The stopped primary cannot continue holding write authority or external work. Failure/uncertainty enters safe refusal, not inferred quiescence.

Candidate closes private graph before opening shared stores. Authenticated activation payload names attempt/epoch, authoritative current root and configuration identity; candidate validates it and constructs fresh consumers under an explicit root/config input. Loader cannot change its existing spawn environment. `DATA_PATH` reassignment alone is insufficient. Audit **every** resolved path/cache/client/config/settings/model/vector/log reference and rebuild against that root before activity grant; any hardcoded or retained reference fails the gate. Existing code has no such input/rewiring contract; this is proposed work.

## Durable authority options

D1 single trusted-loader writer + fencing token record is recommended over child-owned release authority and in-memory epoch alone. Child diagnostics cannot forge final authority. Placement is root-only loader record family; authoritative phase transitions must reject inconsistent/stale identity and require authenticated observation. Single-writer recovery derives refusal whenever process/descendant/resource ownership is uncertain; loader restart does not prove old children are gone.

`loader/src/fs.ts` currently implements write→rename→chmod, **no fsync**. It provides atomic replacement, not demonstrated crash/power durability. Required new protocol must sync staged files and directories, sync temporary record, atomic publish then parent-directory sync, order data-before-pointer, and define outcomes for each failed sync/crash. Storage/filesystem/platform guarantees must be verified; no durable claim borrowed from current helper. Multi-file records must not introduce competing authorities.

## Current-data migration options

M1 shadow-copy + single authoritative root publication is recommended **conditional on verified quiescence and durability**, not proven implementation. M2 in-place cross-store journal is not selected: to meet consistent JSON/config/vector rollback it needs its own complete transactional recovery design, unavailable today. It is not intrinsically impossible, just unsupported here.

1. Prove exclusive release of all writers/readers that affect copying, including settings, direct vector operations, native tasks and external helpers. Final deferred flush alone does not establish zero owners.
2. Trusted coordinator allocates staging from the **latest authoritative root**, not any retained historical root. Migration code is generation-owned, executed under a restricted migration identity with only staging write access, no live-write/external-activity grant, and bounded resources. Down belongs to generation being left; up belongs to destination. Executor trust/isolation and metadata/schema validation remain required design/proof gates, not free child authority.
3. Copy uses validated stable store-specific semantics; ordinary recursive copy of live stores forbidden. Verify symlinks/path boundaries, complete format/ownership manifest and data integrity; all required syncs must succeed.
4. Atomically/durably publish one authoritative root/format/attempt decision only after staging checks. Prepublish failure leaves old **current** root authority unchanged. Crash recovery must prove which committed pointer won; uncertainty refuses.
5. After publication, newly published latest root remains authority even if candidate activation fails. Fallback transforms that root toward the prior healthy generation; **never** reopen retained old roots. Same candidate activation uses explicit authenticated root input and fresh construction. Retired roots are non-authoritative evidence subject to owner retention policy, never restore sources.

At 10x data, staging needs additional bounded disk and longer quiescence; neither cost nor available capacity is assumed. Owner trade is failure atomicity/current-data integrity versus handoff latency/storage overhead. Recommend M1 once capacity/durability and native consistency are proven; if unavailable, refuse migration rather than weaken preservation. Unknown-newer format refuses before acquisition. `lifemodel-ww8` remains open; this lifecycle proposal does not decide vector persistence ownership.

## Scenarios and gates, not executed

Success: same PID, private handles closed, every consumer on latest root, no two active owners. Negative: pending async/vector/config/transport/descendant work, failed close/sync, stale payload/epoch, unsupported format and ambiguous restart all refuse. Crash before/after each publication/sync boundary preserves exactly one latest authority or refuses. Postpublish activation failure migrates latest root, never historical restore. 10x tree/data remain within approved ceilings/capacity and primary service during rehearsal. Record ordering, `isOpen`, mtime, tick starts or exit codes alone do not prove these scenarios. Future checks need explicit executable proof/CI permission; constants unset.
