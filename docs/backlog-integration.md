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
- **Pushes when the owner is away:** on (`notifyPushes`, owner, 2026-10-20,
  after the test message arrived). The channel is the owner's own command in
  `~/.config/shady2k-skills/notify.json` on this machine, sent through the run
  script's `notify`; no token is in the repository. It carries a run's progress
  digest, a point the run could not settle and a decision waiting on the owner.
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
  the stage's `acceptance`: an accepted stage stays open until its accepted work
  lands on the main line and its current specs/docs are synced. Then its own
  DONE WHEN permits closing its tasks and stage; an unfinished parent feature
  stays open. Before closure, its accepted revision releases the dependants in the later stages
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

- **Backlog adapter:** `node .backlog/adapter.mjs`. The tracker lives outside
  the code branches (**Tracker layout**), so it reads the store, never a code
  tree: by default the store as it is now, after a sync with the remote (an
  unreachable remote is said on stderr and in the `source` line: this machine's
  store only); `--offline` skips the sync; `--at <rev>` the state the store
  recorded under that revision's own name, refused (exit 2) where there is
  none; `--at-or-before <rev>` the newest recording among the revision and its
  ancestors, named in `source`; `--ref <ref>` reads the store from a ref's tree
  instead of this machine's store worktree (CI: `refs/tracker/state`);
  `--jsonl <file>` any beads-format export. A status the adapter does not map is
  refused (exit 2); tombstones are dropped. `node .backlog/recorded.mjs <rev>`
  says whether this machine's store recorded a revision (the pre-push hook).
- **Rules:** `.backlog/rules/check.mjs` with `time-format.mjs` beside it,
  `check-commits.mjs`, `check-docs.mjs`, `check-product.mjs`, and `check-present.mjs` with
  `document-format.mjs` beside it, and `regular-file.mjs` and `argv.mjs`, which
  every check imports — byte-for-byte copies of shady2k-skills
  0.126.0's `skills/backlog/setup-shady2k-skills/` at setup version 0.56.0,
  never edited here. Their `--version` is the installation. Proving it: `cmp`
  each against the plugin copy.
- **Charter outcomes:** none with ids yet. The rules that read them
  (`orphaned-outcome`, `unobservable-first-stage`, `unserved-outcome`), the
  vision's journeys and principles with ids, `Serves:` lines and `codePaths`
  are adopted with the next charter, `observability-1` (owner, 2026-10-20, at
  the 0.51.0 setup: adopting them on motor-1, whose three features are not yet
  staged and with no document gate, would refuse every landing and every
  feature commit). Until then they report nothing and `codePaths` is absent.
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
- **Tracker layout:** the store is `br` (beads_rust 0.7) and lives **outside
  the code branches** (lifemodel-hsyc, owner at the instance-1 retrospective,
  moved at the 0.51.0 setup on 2026-10-20). One store per machine: a worktree of
  this repository detached at `refs/tracker/state`, a ref no branch contains,
  parked at `$XDG_STATE_HOME/lifemodel/tracker` (`~/.local/state/lifemodel/tracker`;
  named after the main checkout, so every worktree of the machine reaches the
  one store). It holds `.beads/issues.jsonl`, `.beads/beads.base.jsonl` and
  `.beads/config.yaml` (the state files the recipe carries between machines,
  `claim_exclusive` among them), `.tracker-sync/recordings/<sha>.jsonl` (the
  state under each code revision's own name, written once and never moved) and
  `.tracker-sync/machines.json` (machine ordinals). br's database there is this
  machine's own, rebuilt from the state files, never committed. The project's
  statuses (`submitted`, `implemented`) are br's policy file, which the recipe
  does not carry: `.backlog/br-policy.yaml` is the project's copy, and `npm run
  connect` installs it as the store's `.beads/policy.yaml`. Every checkout and
  worktree has `.beads` as a link to the store's `.beads` (ignored in
  `.gitignore`); a new worktree gets it from the post-checkout hook. No code
  branch carries a tracker record, and the pre-commit hook refuses a staged path
  under `.beads`. The tracker at a code revision is the store's recording of it
  (`adapter.mjs --at`), never the revision's tree; the last in-tree revision,
  `d2354717` (main before the move), was recorded from its own committed export.
  A branch from before the move still tracks a real `.beads` folder: checking it
  out replaces the link with that folder (the store is untouched; proved), and
  switching back relinks it (post-checkout); a folder holding a tracker is
  refused and named, never overwritten. Pushing `refs/tracker/state` starts no
  workflow: GitHub's push event fires for branches and tags only, and the
  project's run list after the first push showed none (proof on lifemodel-hsyc).
  `main` is protected (owner, 2026-10-08): it takes changes only through pull
  requests with green `changes`, `ci-product` and `ci-backlog`, admins included.
- **Tracker synchronization:** `.backlog/sync/tracker-sync.mjs` with the recipe
  `.backlog/sync/trackers/br.mjs` and the systemd template
  `.backlog/sync/supervisors/systemd-user/tracker-sync.service`, byte-for-byte
  copies of shady2k-skills 0.126.0, with `argv.mjs` and `regular-file.mjs`
  beside the mechanism (`tracker-sync.version`; `node
  .backlog/sync/tracker-sync.mjs status --expect-version <the set's version>`
  says whether this copy is behind). **No background sync runs** (owner,
  2026-10-20: "я один работаю" — one person, one machine): the store reaches
  the remote when a commit is recorded (post-commit, post-merge) and before
  every push (`.githooks/pre-push` runs `publish` first and refuses the push if
  it cannot), which is what CI reads; a tracker write between commits stays on
  this machine until then, and `node .backlog/sync/tracker-sync.mjs publish`
  sends it now. A second person or machine is the moment to add the
  supervisor: the systemd `--user` unit `lifemodel-tracker-sync.service`,
  rendered and started by `sh scripts/tracker-sync-service.sh install`, running
  `watch --interval 10 --debounce 2 --max-age 5` (publish 2 s after the last
  write or 5 s at most, the other machines' state every 10 s), with `loginctl
  enable-linger <user>` to outlive logout and reboot. Every network operation
  is killed after 10 s (push) or 20 s (fetch). A claim and a status transition through
  the mechanism (`claim`, `transition`) are written against the state just
  merged from the remote and count only once they are on it; a lost one is exit
  3, said, and nothing is left behind. Two machines claiming one item in the same
  seconds can both believe they hold it until the next sync; after it every
  machine shows one holder. The merge is per item: comments (records) only
  append and keep both sides, a field changed on two sides takes the tracker's
  order and the overwritten value is kept on the item, and where that cannot
  separate them the order on the ref decides. While the remote is unreachable,
  writes continue in the store and are published at the next commit or push
  that reaches it;
  a read that needs every machine's state says the remote is unreachable. Each
  revision is recorded by the post-commit and post-merge hooks (in the
  background) and again by pre-push for the pushed tip. A record (a `br`
  comment) posted on one machine keeps its id on every machine only while one
  machine writes: two machines posting records should post through the
  recipe's `post`, which gives globally unique ids (not yet wired; this
  project has one machine, vm-agents). Proved at installation on this machine;
  a real reboot and a second real machine are not proved yet.
- **Landing a session:** nothing to land for the tracker: no branch carries
  it. A session that wrote to the tracker after its last push ends with
  `node .backlog/sync/tracker-sync.mjs publish`, and `status` showing nothing
  queued locally. Bookkeeping that is a document (lessons, docs edits) lands like any
  change, on a branch named for its task. After a pull request merges, the main
  checkout fast-forwards with `git pull --ff-only`; nothing about the tracker is
  copied.
- **Run script inputs in a worktree:** every checkout reads the same store;
  the run script's `--backlog` is the adapter's export written to a file
  (`node .backlog/adapter.mjs > <file>`), refreshed after one's own br writes.
- **Product-document form check:** `.backlog/rules/check-product.mjs` runs
  unconditionally in both commit-hook paths on `--staged`, preserving Git's
  commit-specific index, and in `ci-backlog` on the PR head or pushed revision
  (`--rev`). It checks recognized product documents under `docs/`; with none,
  it passes without imposing that format on ordinary project documents.
  Missing checker inputs refuse and name `npm run connect`. This is not the
  deferred transition document gate below. Shipped selftests run from the
  plugin directory, where their fixtures and product templates live.
- **Document gate: not installed yet.** Its task is "Install the document
  gate: specs and acceptance evidence checked at each transition"
  (filed beside the setup task, milestone `platform-1`). Until it lands,
  document readiness is checked by reading, and every report says the
  automatic check did not run. Evidence level when installed: **records**
  (a receipt reports a run of work, not a change to a revision, so no check on
  the change can verify it — `main` takes changes only through pull requests
  with green required checks).
- **Backlog gate:** `npm run backlog` (`node .backlog/gate.mjs`): the store now
  (synced) judged against the newest recording at or before `HEAD` (`--base
  <rev>` to override), each judged by the config of its own day, under the
  config's strength (`block-new`); a history with no recording is the empty
  backlog, said in its `baseline:` line. The pre-commit hook runs it with
  `--offline` (a commit does not wait on the remote). CI runs `gate.mjs --head
  <sha> --base <sha> --ref refs/tracker/state`, the recording of the pull
  request's head (`--head-or-before` on a push to main, whose merge commit
  GitHub made and nobody recorded). A merge in progress is judged against both
  parents (`merge-gate.mjs`): an error is new only when it is new against HEAD
  and against the other parent.
- **Landed commits (`merged-but-open`):** each judged state carries `landed`,
  the main line's commits with the ids their header names, read by
  `.backlog/landed.mjs` with the commit-link parser (`commits.mjs` `linkedIds`).
  The main line is this clone's `refs/remotes/origin/main` (local `main` without
  one) locally and the `--base` revision in CI; a state recorded at revision R
  counts only the commits R and the main line share (their merge base), so a
  branch's own commits never make its active leaf "merged". The rule reports an
  open or active leaf a landed commit names; the fix is to close it, or set it
  `implemented` under a stage, with the revision that delivered it. The
  adapter's command output carries the same list (`readWithLanded`). Tests:
  `node --test .backlog/landed.test.mjs`.
- **Recordings read in both formats:** a revision's recording is a whole state
  (sections, mechanism before 0.126.0) or a reference to the store commit that
  holds it (`tracker-sync-recording/1`); `readAt` reads both, from this
  machine's store or from `refs/tracker/state` in CI (tested in
  `.backlog/adapter.test.mjs`).
- **JSON report:** `npm run backlog:json`.
- **Commit-link input and check:** `node .backlog/commits.mjs
  --message-file <f>` (the pending message), `--range <base>..<head>` (every
  commit the range introduces), or `--introduced <tip> --by <ref> [--before
  <sha>]` (what a push of `<ref>` introduces: the commits of its tip that no
  other remote ref reaches; none is a pass that says so). Tasks resolve against
  the store **as it is now**, never as a revision held it, so a task filed
  after a branch was cut resolves for its commits: this machine's store locally
  (offline for the message, synced for a push), `--tracker-ref
  refs/tracker/state` in CI. An empty range is exit 2, never a pass. Tests:
  `node --test .backlog/commits.test.mjs` (a scratch remote and a store ref),
  `node --test .backlog/adapter.test.mjs`, `node --test .backlog/ready.test.mjs`,
  `node --test .backlog/merge-gate.test.mjs`, `node --test
  .backlog/landed.test.mjs`, and `node --test
  .backlog/claim.test.mjs` (a real store on a scratch remote).
- **Local entry points:** `.githooks/pre-commit` (the product-document check,
  the tracker guard — no staged path under `.beads` — then the backlog gate,
  offline), `.githooks/commit-msg` (commit links), `.githooks/pre-push` (the
  pushed tip recorded in the store, recorded now when it is HEAD and refused
  otherwise, then the introduced range per pushed ref; no ref lines is
  refused), `.githooks/pre-merge-commit` (delegates to pre-commit),
  `.githooks/post-commit` and `.githooks/post-merge` (record the revision in the
  store, in the background, never failing), `.githooks/post-checkout` (relink
  `.beads` to the store). The last three carry the mechanism's marker lines
  and portable commands, so `tracker-sync.mjs connect` accepts the tracked
  folder and writes no hook of its own. A hook that cannot find what it reads
  refuses and names `npm run connect`. `scripts/connect-clone.sh` also appends
  the gate to `.husky/pre-commit` and `.husky/commit-msg`, marked and
  idempotently; husky's hooks folder has no record steps, so a checkout on
  `.husky/_` records revisions only at push (lifemodel-j6n9 is the fix).
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
  checks `git`, `node`, `br`, the seven hooks, the gate's and the mechanism's
  files and a readable `.backlog/config.json`, refuses a real `.beads` tracker
  folder from before the move (move it aside), reports everything missing in
  one run and connects nothing until nothing is missing; then it sets
  `core.hooksPath .githooks`, runs `tracker-sync.mjs connect` for this
  checkout (the machine's store made from the remote's ref where it has none,
  `.beads` linked to it), installs the project's br policy into the store,
  appends the marked gate blocks to the husky hooks,
  says whether a background sync also runs (none is required), and runs the gate
  once offline; exit 2 fails the connect. Safe to rerun. With no
  `node_modules` it still connects and says the product checks are skipped
  until `npm ci` — a message that is already stale under the launcher wiring,
  `lifemodel-z5e`.
- **CI:** `ci-backlog` in `.github/workflows/ci.yml`, on pull requests to
  `main` and pushes to `main`, node 24, `fetch-depth: 0`, no npm install; it
  fetches `refs/tracker/state` and fails if it cannot. The backlog baseline is
  the newest recording at or before the PR's merge base or the push's `before`
  (else `HEAD^`), the head the recording of the PR's head (at or before, on a
  push), each judged by its own day's config. The commit range is merge
  base..PR head on a pull request (never GitHub's synthetic merge; an empty
  range is an error) and `commits.mjs --introduced` on a push. The
  present-documents check runs on pull requests only. Tasks resolve against the
  store ref as it is now. `ci-product` is
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
  quiet skip. The image jobs follow one pattern: `ci-core-image`,
  `ci-web-image` and `ci-workbench-image` build the standalone core, web and
  task workbench images on their pull requests without a write permission, and
  the three matching `-publish` jobs publish them on a push to `main` — core and
  web on every push, the workbench when its selector says the change reaches its
  inputs — and are the only jobs that ask for `packages: write`
  (lifemodel-653.8.15). The platform loader image is built by the release
  workflow. There is no instance image or host-side test exception; tests stay
  inside the isolated launcher.

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
  tests went red. Meaningful survivors are filed as tasks. Mutation evidence
  reports test strength, not a correctness verdict, and does not block the
  change. A skipped check is recorded as skipped, never as passed.
- **Reviewer:** `shady2k-gateway/gpt-6.1-sol` (another model than the
  workers), at stage acceptance, in its own prime-agent session:
  `prime-agent --provider shady2k-gateway --model gpt-6.1-sol` (the
  `openai-codex` provider has no key since 2026-10-15). Its brief must
  explicitly allow writing its report file (told "read-only", it wrote none).
  At most two model review rounds per task; after that the coordinator
  verifies the fixes itself (owner, 2026-10-16). The fallback is a
  same-model independent session, disclosed as the same model. Independent
  review is required for acceptance.
- **Parallel execution:** one git worktree per worker (herdr worktrees for
  prime-agent worker sessions), up to the config's `maxWorkers`. Claims are
  atomic and exclusive (`claim_exclusive` in `.beads/config.yaml`) through
  `node .backlog/claim.mjs <id> --actor '<full agent name>'`; the holder is the agent
  doing the work under its full name
  `<harness>-<role>:<person>@<machine>:<branch>#<session>`, never the person.
  Generated files and `package-lock.json` count as collisions. The stage's
  coordinator merges and records `implemented`.
- **Starting a worker:** `prime-agent --provider shady2k-gateway --model
  deepseek-v4.1-flash-auto` in the worker's herdr pane (the default since
  2026-10-18, owner; the most security-critical code, and a worker that is
  not coping, go to `gpt-6.1-sol`; deepseek gives a second review opinion on
  security-heavy work, never on its own), then check the pane footer before
  dispatching. Always name
  `--provider shady2k-gateway`: a bare `--model` may resolve to a provider
  with no key here, and the worker never starts. A brief says
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
  a separate comment does not satisfy the store's `.beads/policy.yaml`. Such a
  transition is a br write that reaches the remote at the next recorded
  commit or push; it counts once `node .backlog/sync/tracker-sync.mjs publish`
  has sent it. A worker's span in
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
| claim | `node .backlog/claim.mjs <id> --actor '<harness>-<role>:<person>@<machine>:<branch>#<session>' [--checkout <revision>]`, then the record `runs.mjs claim` prints. Reads the store synced with the remote, checks an open unheld ready leaf and revision ancestry, then claims through the mechanism (`tracker-sync.mjs claim`, then `transition --to in_progress --expect open`), each counted once it is on the remote; a lost claim is exit 3, said, with nothing left behind. Unknown, duplicate or incomplete options, a malformed actor and an unready leaf refuse without a claim |
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
| publish | at each recorded commit and before each push, by the hooks; `node .backlog/sync/tracker-sync.mjs publish` pushes now, and `status` shows what is queued. Nothing lands on a branch |

When a skill reports the installation is out of date, run `setup-shady2k-skills`. An explicit
setup invocation rechecks everything even if its recorded version matches.
