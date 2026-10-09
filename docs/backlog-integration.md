## Backlog integration

Maintained by `setup-shady2k-skills`. The protocol ships with the skills; project
facts and verified commands live here. Changing choices live only in the config.
No installation state is recorded: the installed checks' `--version` on `main` is
the repository's installation, and each person's plugin and hooks are their own.

- **Config:** `.backlog/config.json`; read current values there.
- **Scope: team** (owner, 2026-10-07). The hooks ship with the repository and
  `npm run connect` connects them in every clone; CI's `ci-backlog` job enforces
  the backlog gate, the commit-link check and (on pull requests) the
  present-documents check on everyone's commits. The agent doc (`AGENTS.md`)
  carries the install line for people who do not have the plugin yet.
- **Artifact language:** English (owner, 2026-10-07). The Russian ADRs
  (docs/adr/006..009, on their own branches) stay as they are.
- **Vision, roadmap and charters:** `docs/vision.md` holds the vision and the
  roadmap (milestones in order); charters are `docs/charters/<milestone label>.md`.
  Status comes from the tracker, never from a document.
- **Current specifications:** none in the capability format. The nearest
  current-state documents are `docs/architecture.md`, `docs/concepts/*.md`,
  `docs/features/**/*.md` and `docs/plugins/*.md` — the config's
  `presentDocuments`. Coverage of behaviour is unknown outside them and is read
  from the code and tests.
- **Changes:** design notes live in `docs/` (`docs/adr/` for decisions, 
  `docs/features/<name>/design.md` where they exist); a small change lives in
  its task's body.
- **Document resources:** the plugin's `templates/` and `documents.md`, by the
  plugin's path; nothing is copied in until the document gate is installed.
- **Workflow ownership:** `br` owns task status. The plugin's backlog skills
  (to-backlog, take-task, close-out) own where work belongs; `AGENTS.md` says
  the same. ADRs are the decision records.
- **Architecture and explorations:** `docs/architecture.md`; explorations are
  not retained as documents unless asked.
- **Glossary and decisions:** no glossary yet (`model-domain` will create one);
  decisions are ADRs in `docs/adr/`, numbered, never renumbered.
- **Acceptance records:** on the stage's issue, as a comment: base and final
  revision, the tasks included, the criterion, the full-check, mutation and
  review evidence, and what is left pending. Beside it the marker comment
  `accepted: <accepted revision> -- <evidence>`, which the adapter exports as
  the stage's `acceptance`: an accepted stage stays open until the feature
  lands, and its accepted revision releases the dependants in the later stages
  of the same feature (see ready below). The latest such comment counts.
- **Features and stages:** beads `epic`. A feature is a root epic wearing the
  milestone label; a stage is an epic under it. A stage's coordinator holds it
  (assignee) while it is being integrated.
- **Implemented:** the `br` status `implemented`, declared in
  `.beads/policy.yaml`, set by the coordinator with the transition comment
  `implemented: <merge revision> -- <related-check evidence>`. Neither ready
  nor closed.
- **Submitted:** the `br` status `submitted`, with the comment
  `submitted: <branch>@<revision> -- <local-check evidence>`; the worker's hold
  is cleared and the coordinator takes the assignee. The adapter reads the
  latest such comment.
- **Commit task links:** the task id in parentheses in the message, e.g.
  `Fix the thing (lifemodel-7ld)` or `(lifemodel-a, lifemodel-b.2)`. What is
  read is every `lifemodel-…` id inside parentheses in the **header paragraph**
  (the lines up to the first blank one); ids in the body are references, not
  links. The id must be an existing **leaf** (closed ones included); an epic or
  anything with children is refused. A revert keeps the reverted subject and
  its link; a merge with no id carries the links of the commits it brings in.
  Commits before `commitLinksFrom` in the config (the setup's landing) were
  made under no rule and are listed, not checked.
- **Cleanup recovery:** nothing to recover — the queue was created by this
  setup (one task). No bulk edit has run; no age snapshots exist.

### Checks and execution

- **Backlog adapter:** `node .backlog/adapter.mjs` (default: the working
  tree's `.beads/issues.jsonl`; `--at <rev>` reads it as committed at a
  revision — `:0` the staged copy, `HEAD` the last commit; `--jsonl <file>`
  reads any beads-format export). It never opens br's database: `br` resolves
  the main checkout's database from every worktree, so it would answer about
  the wrong branch; the tracked export is the only copy git can show at
  another revision. A status the adapter does not map is refused (exit 2);
  tombstones are dropped.
- **Rules:** `.backlog/rules/check.mjs` with `time-format.mjs` beside it,
  `check-commits.mjs`, `check-docs.mjs`, and `check-present.mjs` with
  `document-format.mjs` beside it — byte-for-byte copies of shady2k-skills
  0.91.0's `skills/backlog/setup-shady2k-skills/` at setup version 0.41.0,
  never edited here. Their `--version` is the installation. Proving it: `cmp`
  each against the plugin copy.
- **Present documents:** the config's `presentDocuments` — `AGENTS.md`,
  `README.md`, `docs/architecture.md`, `docs/concepts/*.md`,
  `docs/features/**/*.md`, `docs/plugins/*.md`. `npm run present` runs the
  check by hand (base defaults to the merge base with `origin/main`); CI runs
  it on every non-draft pull request from the merge base to the PR's head. A
  dead reference the change made refuses it; older drift is printed and fails
  nothing. The first run (2026-10-07, at `16684b0`) found no dead path and no
  ignore needed: `presentIgnores` is empty. It reported one churn item
  (`claude.md`, 44 commits under what it names since its last edit), filed as
  one debt item. `claude.md` was later replaced by `AGENTS.md`
  (lifemodel-nwu) and the debt item (lifemodel-9vw) closed as moot.
- **Work records:** a run's claims, receipts and stops are `br` comments whose
  text starts with `[shady2k-time`. The adapter exports every one raw and
  whole, damaged or not, as `comments: [{ id, at, author, body }]` from beads'
  comment `id`, `created_at`, `author` and `text`. The run script reads that
  export as `--backlog` (`node .backlog/adapter.mjs` written to a file), and a
  record is posted unchanged with `br comments add <id> -f <file> --actor
  <agent>`, the file holding exactly what the script printed. A record is
  never edited or deleted (br has no comment deletion, and the comment id must
  stay the same in every export): a damaged, conflicting or stray one is
  retired by the run script's `void`, naming its comment id, posted the same
  way; where the record still matters it is then written again with the run
  script. `timeRecordsExempt` is empty: time records are adopted by this setup
  and no unclaimed work was in flight.
- **Tracker layout:** the store is `br` (beads_rust 0.7): one SQLite database
  per machine under the main checkout's `.beads/`, which `br` resolves from
  every worktree; its JSONL export `.beads/issues.jsonl` is a tracked file.
  `main` is protected (owner, 2026-10-08): it takes changes only through pull
  requests with green `changes`, `ci-product` and `ci-backlog`, admins
  included, so nothing is pushed to it directly. The export reaches `main`
  only on a session's **landing branch**, `land/<name>`, cut from
  `origin/main`, which carries the session's bookkeeping (the export, lessons,
  document edits; never product code) and lands by one pull request at the
  session's end, merged by the owner. The pre-commit hook refuses the export
  staged on any other branch but `main` (a commit there cannot be pushed) -
  with one carve-out: the seeding commit of the installation itself (a tree
  whose HEAD has no `.backlog/config.json` yet) may carry it, because before
  it lands, `main` has no tracker file at all. The tracker at a code revision
  is the export as committed at it (`adapter.mjs --at <rev>`); on a branch
  that does not carry the export, the newest snapshot the history reaches is
  the honest answer (that is what the pre-push hook and CI use). `br sync
  --merge` is never used to catch up: it tombstones what the export lacks;
  `br sync --import-only` builds a fresh clone's database from the export.
- **Landing a session:** `br sync --flush-only` writes the database to the
  **main checkout's** export (br resolves it from every worktree); copy that
  file into the landing worktree, run the gate there (`npm run backlog`),
  commit naming the task it records, push the branch and open one pull request
  (its CI is `changes` and `ci-backlog`, seconds; `ci-product` is skipped for
  the export and documents). After the owner merges, bring the main checkout to
  the merge without letting `br` import an older export: in one command, copy
  `.beads/issues.jsonl` aside, `git checkout -- .beads/issues.jsonl`,
  `git pull --ff-only`, copy it back (the database is newer than any merged
  snapshot).
- **Run script inputs in a worktree:** a worktree's own `.beads/issues.jsonl`
  is the snapshot of its branch, not the tracker; a worker reads the tracker
  for `runs.mjs` as `node .backlog/adapter.mjs --jsonl
  /home/dev/repos/lifemodel/.beads/issues.jsonl` (the main checkout's export,
  which br keeps flushed), refreshed after its own br writes. A stale export
  made a worker's receipt miss its own claim (lifemodel-ggc run).
- **Document gate: not installed yet.** Its task is "Install the document
  gate: specs and acceptance evidence checked at each transition"
  (filed beside the setup task, milestone `platform-1`). Until it lands,
  document readiness is checked by reading, and every report says the
  automatic check did not run. Evidence level when installed: **records**
  (a receipt reports a run of work, not a change to a revision, so no check on
  the change can verify it — `main` takes changes only through pull requests
  with green required checks).
- **Backlog gate:** `npm run backlog` (`node .backlog/gate.mjs --worktree`) by
  hand; in the pre-commit hook it judges the **staged** export
  (`--at :0`) against `HEAD` (`--base <rev>` to override), each judged by the
  config of its own day, under the config's strength (`block-new`). A base
  that predates the installation (no export at it) is the empty backlog —
  everything this change adds is new, honestly. A merge is judged against
  both parents (`merge-gate.mjs`): an error is new only when it is new
  against HEAD and against the other parent.
- **JSON report:** `npm run backlog:json`.
- **Commit-link input and check:** `node .backlog/commits.mjs
  --message-file <f>` (the pending message; tasks from br's own export, so a
  task filed a minute ago resolves), `--range <base>..<head>` (every commit
  the range introduces), or `--introduced <tip> --by <ref> [--before <sha>]`
  (what a push of `<ref>` introduces: the commits of its tip that no other
  remote ref reaches; none is a pass that says so). `--export-at <rev>`
  resolves tasks from the export at a revision. An empty range is exit 2,
  never a pass. Its tests: `node --test .backlog/commits.test.mjs` (a scratch
  remote); the adapter's: `node --test .backlog/adapter.test.mjs`; ready's:
  `node --test .backlog/ready.test.mjs`; the merge gate's:
  `node --test .backlog/merge-gate.test.mjs`.
- **Local entry points:** `.githooks/pre-commit` (tracker layout guard, then
  the backlog gate when the export or the gate is staged),
  `.githooks/commit-msg` (commit links), `.githooks/pre-push` (the introduced
  range per pushed ref; no ref lines is refused), `.githooks/pre-merge-commit`
  (delegates to pre-commit). A hook that cannot find what it reads refuses and
  names `npm run connect`. `scripts/connect-clone.sh` also appends the gate to
  `.husky/pre-commit` and `.husky/commit-msg`, marked and idempotently: husky
  (an `npm ci`) sets `core.hooksPath=.husky/_`, and with the blocks in place
  the gate runs whichever hooks directory is active — husky's product checks
  (lint-staged, then the isolated check through `scripts/test-isolated.mjs`)
  included.
- **The hooks directory is `.githooks`, not husky's `.husky/_`:** the gate
  hooks must fire in a clone that has not run `npm ci` (agents' worktrees
  never do), and `.githooks` needs only `node` and `git`. The product checks
  stay where the project put them (`.husky/pre-commit`: lint-staged, then the
  isolated check through `scripts/test-isolated.mjs`) and run when husky is
  active; until then the hook says they were skipped and CI runs them: the
  `ci-product` job runs `node scripts/test-isolated.mjs check` (node 24,
  behind GitHub's disposable Docker daemon, no host `npm ci`) for a change
  whose paths include product code — and when the `changes` job that decides
  that did not succeed — and is skipped for one that cannot touch it.
- **Connecting a clone:** `npm run connect` (`scripts/connect-clone.sh`). It
  checks `git`, `node`, `br`, the four hooks, the gate's files and a readable
  `.backlog/config.json`, reports everything missing in one run and connects
  nothing until nothing is missing; then it sets `core.hooksPath .githooks`,
  imports the tracked backlog into br's database (`br sync --import-only`),
  appends the marked gate blocks to the husky hooks, and runs the gate once
  (`--worktree`); exit 2 disconnects the proof and fails the connect. Safe to
  rerun. With no `node_modules` it still connects and says the product checks
  are skipped until `npm ci` — a message that is already stale under the
  launcher wiring (the hook needs the isolated launcher, not `node_modules`),
  `lifemodel-z5e`.
- **CI:** `ci-backlog` in `.github/workflows/ci.yml`, on pull requests to
  `main` and pushes to `main`, node 24, `fetch-depth: 0`, no npm install. The
  backlog baseline is the PR's merge base or the push's `before` (else
  `HEAD^`), with the export judged at each end by its own day's config. The
  commit range is merge base..PR head on a pull request (never GitHub's
  synthetic merge; an empty range is an error) and `commits.mjs --introduced`
  on a push. The present-documents check runs on pull requests only. Tasks
  resolve from the newest export the checked history reaches. `ci-product` is
  the product checks and needs the `changes` job in front of it: `changes` reads
  the change's paths with `git diff --no-renames` for range merge base...head on
  a pull request or `before..after` on a push (a `before` this checkout cannot
  read means every path is product, and so does an empty list), runs
  `scripts/ci-product-paths.sh` over them (with its tests,
  `tests/unit/ci-product-paths.test.ts`) and answers `product=true|false`
  through `scripts/ci-verdict.sh`, which refuses any output that is not exactly
  one verdict on the last line — a classifier that fails or prints nothing
  fails the job instead of leaving the answer unset. `--no-renames` is
  deliberate: without it a move of product code into `docs/` would be read by
  its destination only and answer `false`. `ci-product` runs on `true` — and
  also when `changes` did not succeed, so a broken `changes` job cannot skip it
  — on ubuntu-latest with node 24, running `node scripts/test-isolated.mjs
  check` through the launcher with no host `npm ci`; it is skipped for a draft
  pull request and for a cancelled run. A skipped job reports as success to a required check, so branch
  protection requires **`changes`, `ci-product` and `ci-backlog`**: requiring
  `changes` is what makes a failed `changes` job a red check rather than a
  quiet skip.
- **Bulk-edit age correction:** none yet; no bulk edit has run. When one does,
  keep paired `--ages-from`/`--ages-through` snapshots of the export before
  and after, and pass them to `check.mjs` (the gate will grow that wiring
  then).
- **Static checks:** `npm run check` runs them together with the suite:
  typecheck, lint (`npm run lint`), the format check (`npm run format:check`),
  then the suite — all started through the isolated launcher
  (`node scripts/test-isolated.mjs check`), stopping at the first failure.
  It needs **Node.js ≥ 24 and Docker**, not host `node_modules` (AGENTS.md,
  "Test isolation"). The gate's own checks need only node: `npm run backlog`.
- **Related tests:** `node scripts/test-isolated.mjs test -- <touched test
  files>` — tests live in `tests/` (unit, integration), never in `src/`
  (AGENTS.md). The suite never starts on the host.
- **Full stage checks:** `npm run check` — typecheck, lint, the format check
  and the suite, all through the isolated launcher
  (`node scripts/test-isolated.mjs check`), stopping at the first failure
  (Node.js ≥ 24 and Docker; no host `node_modules`). It is exactly the command
  CI's `ci-product` job runs: the same launcher command, whose boundary is
  node 24 with the dependencies of the committed lockfile. A manifest that
  disagrees with `package-lock.json` fails the entrypoint policy tests in the
  suite (`tests/unit/test-entrypoints.test.ts`) — what `npm ci` used to prove
  before the checks started. On this machine memory is short (owner,
  2026-10-07): every suite run uses at most 2 workers — enforced twice, by the
  launcher and by `vitest.config.ts` — and only one vitest process runs at a
  time; repeated full runs go one after another.
- **`npm ci` in a worktree** re-runs husky's `prepare`, which switches the
  repository-wide `core.hooksPath` to `.husky/_`: commits in every checkout then
  run husky's hooks. Run `npm run connect` afterwards to restore `.githooks`.
  `npm ci` is still what installs dependencies for `dev`, `build` and `start`;
  tests and checks no longer need it — the isolated launcher provisions its
  environment inside the boundary.
- **Mutation checks:** no mutation tool is installed. The agreed alternative
  is the config's `execution.mutationFallback`: the coordinator hand-plants
  2–3 mutations in the changed logic at stage acceptance and records which
  tests went red. A survivor becomes a test or a question to the owner, never
  a pass. A skipped check is recorded as skipped, never as passed.
- **Reviewer:** `openai-codex/gpt-6-sol` (another model), at stage
  acceptance, in its own prime-agent session:
  `prime-agent --provider openai-codex --model gpt-6-sol`. Its brief must
  explicitly allow writing its report file (told "read-only", it wrote none).
  The fallback is a same-model independent session (a fresh glm-5.3-flash
  session), disclosed as the same model. Independent review is required for
  acceptance.
- **Parallel execution:** one git worktree per worker (herdr worktrees for
  prime-agent worker sessions), up to the config's `maxWorkers`. Claims are
  atomic and exclusive (`claim_exclusive` in `.beads/config.yaml`) through
  `node .backlog/claim.mjs <id> --actor '<full agent name>'`; the holder is the agent
  doing the work under its full name
  `<harness>-<role>:<person>@<machine>:<branch>#<session>`, never the person.
  Generated files and `package-lock.json` count as collisions. The stage's
  coordinator merges and records `implemented`.
- **Starting a worker:** `prime-agent --provider shady2k-gateway --model
  glm-5.3-flash` in the worker's herdr pane, then check the pane footer before
  dispatching. A bare `--model glm-5.3-flash` resolves to the `opencode`
  provider, which has no key here, and the worker never starts. A brief says
  that the owner's rules in `AGENTS.md` are not reworded to fit the code: a
  violation is filed as a finding and the rule stays (a worker once weakened
  Plugin Isolation that way). A brief also carries the tracker claim
  (`node .backlog/claim.mjs <id> --actor '<full agent name>'`), not only the run
  script's claim record: without it the gate reads the span as ended. A leaf
  set `implemented` must sit under a stage.
- **One task, one fresh session; one stage, one fresh reviewer.** A worker
  session that ran several rework rounds degraded around 300k tokens of context
  (garbled reasoning, tests that did not exercise their scenario); a reviewer
  session that ran all day reviewed the wrong commits. Start a new worker
  session for each task and a new reviewer session for each stage.
- **Watching a worker:** every wait on a worker also watches its session
  transcript (`~/.prime/agent/sessions/<id>.jsonl`) and wakes the coordinator
  after about 10 minutes of silence, not only when its report file appears. A
  worker can end its turn mid-task and sit at its prompt: one stood idle for an
  hour while the wait polled only for the report.
- **Run bookkeeping that the gate enforces:** when the coordinator posts its
  claim record on a feature, it also sets the feature `in_progress` with
  itself as assignee; otherwise the gate reads the span as ended with no
  receipt. `submitted` and `implemented` take their comment atomically:
  `br update <id> --status implemented --transition-comment "implemented: ..."`;
  a separate comment does not satisfy `.beads/policy.yaml`. A worker's span in
  prime-agent gets a measured receipt (`receipt --end finished --harness
  prime-agent --session <id>`): the run script reads its transcript. The
  worker posts it as its last record, after the work, so the span covers it.

### Tracker operations

`br`'s own reference is `br robot-docs guide` and `br <command> --help`; only
what this protocol adds is listed.

| operation | project implementation |
| --- | --- |
| create | `br create "<title>" -t task\|bug\|epic -l <milestone>,<area> -d "<body with DONE WHEN for an epic>" [--parent <id>] [--acceptance ...] --silent` |
| link / unlink | `br dep add <consumer leaf> <producer leaf>` (`blocks`), the reason and what releases it in a comment; provenance is `discovered-from`, which the adapter never reads as a dependency |
| claim | `node .backlog/claim.mjs <id> --actor '<harness>-<role>:<person>@<machine>:<branch>#<session>' [--checkout <revision>]`, then the record `runs.mjs claim` prints. Requires `br >=0.7.0`: reads the authoritative flushed tracker, checks an open unheld ready leaf and revision ancestry, then uses native exclusive `--claim --if-unchanged`. Only a satisfied implemented prerequisite permits the internal `--force` advisory-readiness override. Direct/manual `--force` is not the workflow; unknown, held, unmerged, cross-feature or stale-target claims refuse without a claim mutation. No early closure or edge removal |
| release | `br update <id> --status open --assignee '' --actor ...`; submitted and implemented work keeps its status |
| implemented | coordinator: `br update <id> --status implemented --assignee '' --transition-comment 'implemented: <rev> -- <checks>' --actor ...` |
| submitted | worker: `br update <id> --status submitted --assignee '' --transition-comment 'submitted: <branch>@<rev> -- <evidence>' --actor ...`; the coordinator then takes the assignee |
| reopen | `br update <id> --status in_progress --transition-comment 'reopened: <why>'`, then recheck dependants |
| close | `br close <id> --reason 'accepted at <rev>: <evidence a stranger can check>'` after stage acceptance; cancellation or duplicate says so in the reason |
| comment / edit | `br comments add <id> ...`, `br update`; a work record with `br comments add <id> -f <file> --actor <agent>`, the file exactly as the run script printed it, never reflowed, edited or deleted; a wrong one is retired by the run script's `void` record |
| defer / undefer | `br defer <id> --until <date>` (the reason in a comment); `br undefer <id>` |
| milestone / label | `br label add <root> <milestone>` (values from the config); `br update <id> --add-label ...` |
| ready | `npm run ready` (`node .backlog/ready.mjs [--stage <id>] [--checkout <rev>]`): open unheld leaves whose prerequisites are closed, or implemented in the same stage with the recorded revision contained in the checkout, or implemented in an earlier stage of the same feature whose `accepted:` revision is contained in the checkout (the stage still open). A prerequisite in another feature waits for closure. `br ready` alone never releases a dependant of an implemented prerequisite |
| holds | `br list --status in_progress` |
| pending integration / acceptance | `br list --status submitted` / `br list --status implemented` |
| children | `br show <id>` lists them, every status; or the adapter's export filtered on `parent` |
| search / show | `br search`, `br show <id>`, `br list -l <area>` |
| publish | at the session's end, on `land/<name>` from `origin/main`: `br sync --flush-only`, copy the main checkout's export in, gate clean, commit naming the task it records, push, one pull request the owner merges; then fast-forward the main checkout as **Landing a session** says |

When a skill reports the installation is out of date, run `setup-shady2k-skills`. An explicit
setup invocation rechecks everything even if its recorded version matches.
