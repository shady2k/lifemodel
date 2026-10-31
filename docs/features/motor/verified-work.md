# Verified delegated work

Tasks: lifemodel-653.9.21, lifemodel-653.9.23. The owner speaks to one agent. Delegated work remains
that agent's own work. This change extends the existing task surface; it does not
add an execution system or a second artifact store.

## Drivers and chosen shape

- Facts and claims stay separate. Core observes task state, startup phase,
  sealed object metadata, read bytes and command receipts. Worker final text,
  result text and transcript entries remain untrusted claims.
- Expected outputs form a durable delivery contract: at most 16 unique, safe,
  flat names, each at most 128 ASCII characters. Answer-only starts omit them.
  `task-report.txt` is reserved for the launcher's semantic report, never a
  work output or expected output (`reserved_output_name` at start). A work
  file named `result.txt` remains valid. The launcher refuses the reserved
  name in the output folder and in explicit uploads. It also refuses duplicate
  owner-facing names across its own-space listing, so each delivered name
  resolves to one object. The report remains readable as untrusted claim text.
  The existing fenced task row owns that contract. Finalization compares it
  with `result`/`artifact` members of the immutable seal manifest before the
  state and event commit together. A log is not a delivered output.
- Presence and correctness are different. Duplicate eligible names can be
  present but ambiguous to read; that fails verification, not the presence
  check. A seal proves which bytes were retained, not that they meet the request.
- Read access uses `core.steerTask(action="read", view="file", name)` and the
  core's existing trusted marked-object route. Only an exact eligible name in
  the task's terminal sealed receipt can select a file. The view reads at most
  8 KiB from the head, rejects binary/control or malformed UTF-8 in that excerpt,
  marks truncation and escapes content as untrusted data. It never executes
  content or accepts a workspace path or caller-selected object UUID.
- Verification precedes a result reply. The agent compares read contents with
  the owner's request and reads the transcript when uncertain. Opening bytes
  can be enforced; a core `file_not_text` refusal for an exact sealed name counts
  as checked presence, with name/size facts only and an explicit inability to
  inspect contents. Missing/unavailable reads do not count. Semantic correctness
  remains a model judgment. An excerpt
  cannot prove the unseen remainder. The fallback never repeats the summary.
- A failed verification permits one corrected start with `redoOf` equal to the
  original ID. A unique durable link prevents concurrent duplicate redos, and
  a redo cannot be redone. Redos retain the original expected output names;
  corrected instructions can change the method, not silently weaken delivery.
  Output contracts compare as sets; a reordering does not change delivery.
  Only the exact original outcome can supply `redoOf`; ordinary turns do not
  advertise it. Deterministic refused starts do not consume the accepted-start
  slot. Existing deciding-turn effect keys recover accepted starts on replay.
  Pre-model recovery retries have 200 ms and 1 s backoffs within the turn budget.
  Failed recovery reads (including in-loop reads) yield a conditional uncertainty
  notice rather than losing the outcome reply or claiming that a redo exists or
  does not exist. The notice names delivered files and sizes without attachments;
  actual uncertain mutations still fail closed.
- First-person status uses actual observations. A plan stays a plan. A launch
  is stated only after an accepted receipt in that turn. Ambiguous requests
  need an agreed concrete plan (what, range, files) before launch when the
  request does not name what to deliver and in what form or has several reasonable
  readings; clear requests run at once, without another question. Status speaks
  as my own work: «готово», «содержимое файла проверено», «с первого раза не вышло, переделываю»,
  never «задача завершилась/остановилась».
- Deterministic fallback and redo replies support Russian and English. The user
  model's supported preferred language wins (including region codes). Otherwise
  Cyrillic in the latest owner message selects Russian; otherwise English.
  Unknown preferences use that same fallback. Names, counts and quoted changes
  are unchanged between languages. Russian replies follow the configured female/male
  identity; neutral or absent gender uses constructions without gendered past tense.
  Question relays use the same language selection and first-person voice while
  preserving question text, task ID and question ID exactly.
- The launcher collects `outputs/` automatically; do not also upload those files
  with the storage CLI. Reserved or duplicate names fail successful runs. On
  unsuccessful runs, invalid entries and all members of duplicate-name groups
  are skipped, while unrelated partial artifacts remain available.

Transient: old rows and old-launcher rollout are not adapted (No Backward Compatibility).

## Alternatives not chosen

Prompt-only delivery checks cannot make stored state agree with the reply, so
missing names are checked at the finalization transaction. A new download tool
would duplicate the task surface, so file reads extend the existing read action.
Using the web identity for core reads would cross a service boundary, so the
existing core space/object route is retained. An in-memory redo counter would
reset on restart and race concurrent turns, so the linkage lives in Postgres.

## Checks and review

`tests/integration/task-reply.test.ts` exercises the core-loop seam with scripted
models and real isolated stores. Registry checks cover durable delivery, replay,
SQL constraints and concurrent redo admission. The bounded read tests cover exact
lookup, range/length limits, malformed/binary data, escaping and stream cleanup.
The storage integration checks the real core read route and identity. Mutation
results and command exit codes are recorded in the worker report. Source checks
are not the deployed two-model/two-adapter walk or stage acceptance.
