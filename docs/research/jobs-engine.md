# Research: a job engine for lifemodel's parallel tasks (lifemodel-653.2)

Date: 2026-10-13. Method: desk research. The external candidates were researched
from primary sources only — official docs, the projects' repositories, licence
files, npm/registry metadata and release notes — fetched directly over HTTPS (no
web search was available in this session, so nothing rests on secondary
aggregators). The project's side was read from the local branch
`design/b0r-containers-simplify` (ADR-010 and the containers design), the
charter `docs/charters/instance-1.md`, and today's Motor Cortex code. Every
factual claim carries its URL and was read on 2026-10-13; facts from sources,
vendor claims and inferences are marked. No benchmarks, no running services, no
builds.

## 1. The question and the recommendation

**Keep our own.** ADR-010's plain job mechanics (keyed command events on Valkey
streams, consumer groups, XACK after the result, XAUTOCLAIM takeover, keyed
done records, `uncertain` for unkeyed ambiguity, mandatory declared timeouts,
waits answered by bus events) should stay, and plain **Kubernetes Jobs should
be adopted as the per-task run unit** with those mechanics as the bus around
them — which is what ADR-010 already drew for Motor's sandboxes and outcome 6
generalizes to tasks. Neither Windmill nor Temporal can carry outcome 6's
confinement checks for us: Windmill has no per-task admission ceilings, no
per-task domain allowlist, isolation off by default, its isolation-relevant
features (agent workers, dedicated workers, concurrency limits) priced as
Enterprise, an AGPLv3 + proprietary-binary licence, and a secrets model that
puts the fetched key inside the task process; Temporal has no file isolation,
no allowlist and no per-task limits at all — confining a Temporal task means
running a one-task worker in its own pod, i.e. building the Kubernetes Jobs
machinery anyway, underneath Temporal. Both engines would also become a second
control plane beside the adopted bus (signals only on the bus, keyed commands,
per-module ACL identity), and both replace the keyed done-record discipline
that outcome 6's "refused over ceilings" and ambiguity reporting ride on.

**What would change the recommendation:**

- **Temporal becomes the choice if the need stops being "confined parallel
  tasks" and becomes durable multi-step workflow orchestration** — workflows
  with branching, crossing code versions, and days-long human gates authored
  as code. Its waiting semantics (durable timers, signals, updates), Worker
  Versioning (pinned workflows, ramp, instant rollback, replay testing) and
  MIT licence are strictly better than anything we would build for that
  problem ([Temporal Q1/Q4](#q4--jobs-surviving-a-module-replacement) below).
  Trigger: outcome-6 design discovers tasks need flow-level composition, not
  just a run unit.
- **Windmill becomes attractive if the owner wants jobs authored OUTSIDE the
  repository** (UI-authored scripts, cron/webhook triggers, self-serve
  scheduling) — that is its product, it needs only Postgres, and its suspend/
  approval wait UX is good. The confinement checks would still fall to the
  surrounding platform, and the licence/EE boundaries would need weighing.
  Trigger: self-serve job authoring becomes a requirement.
- **A sandboxing weakness would re-open the engine question:** if per-task
  pods on Kubernetes prove too coarse (a task needing nested containers, a
  full isolated machine or stronger kernel isolation), the question comes
  back — then it should re-open with gVisor/Firecracker-class runners in
  scope, not with workflow engines.
- **Scale out of one node** (several machines, many workers) would re-open
  the whole platform decision, not just this one (ADR-010's threat-model
  invalidator says the same).

## 2. Comparison at a glance

| Question | Windmill (self-hosted) | Temporal (self-hosted) | Our own, as adopted (A) | Our own on Kubernetes Jobs (B) |
|---|---|---|---|---|
| **Q1 waits / resumption / semantics** | Flows suspend/approve at no cost; sleeps to months; zombie monitor re-queues lost jobs (60 s ping, 3 re-runs); at-least-once; task code must be idempotent; no caller-defined exactly-once key | Durable timers, signals, updates; the engine re-fires crashed work itself (unlimited workflow retries); workflows effectively-once, activities at-least-once; idempotency is the task code's job | No suspension to lose: waits are correlation state + a later bus event; XACK after result; keyed = effectively-once at destination, unkeyed ambiguous = `uncertain`, reported, never retried | Same as A; the Job is only the run unit — but the Job's own `backoffLimit` re-runs are an extra re-issue path to reconcile |
| **Q2 per-task limits & confinement** | Timeouts (7 days default self-host) + nsjail rlimits/F-ns — OFF by default; memory = worker container's; NO per-task admission ceilings; NO domain allowlist (`clone_newnet: false`); secrets fetched INTO the process (Vault backend = EE) | Timeouts (mandatory), retries, task queues, per-worker slots, 2 MB payload caps; NO file isolation, NO allowlist, NO per-task CPU/mem; engine holds no secrets; task secrets enter the worker process | Manifest timeouts + module-level confinement (namespace, per-module policy, vault-env); per-TASK nothing — the task is the module process | All five of outcome 6's checks natively: pod requests/limits + `activeDeadlineSeconds`; own pod + ephemeral volume; per-task NetworkPolicy or egress-gateway policy; no key (egress injection); refusal at the Job-template VAP |
| **Q3 footprint & licence** | Postgres + server + stateless workers; 1 worker/1 vCPU/1-2 GB (vendor claim); AGPLv3 source + proprietary CE binaries (no wrapping/reselling); clients Apache-2.0; CE caps 3 workspaces/50 users/30-day retention; isolation features EE | Server services + SQL store (+optional Elasticsearch) + UI; no published vendor minimum; honest heavy-ops docs; MIT everywhere; paid = Cloud only | Nothing new — Valkey, CNPG, OpenBao+vault-env, operator, Flux, k3s already adopted; licences all permissive (Valkey BSD-3-Clause, OpenBao MPL-2.0, rest Apache-2.0/MIT) | Same, plus in-tree k3s primitives only; Job/policy objects to render |
| **Q4 surviving module replacement** | Script versions immutable by hash; flows pinned by version at queue time; 30 s graceful stop; no replay/determinism constraints; rollback = redeploy an old version | Strongest: Worker Versioning (pinned/auto-upgrade, ramp %, instant rollback; server >= 1.29.1), patching APIs, replay testing — at the price of strict replay determinism on workflow code | Start-first RollingUpdate (join group before old pod terminates), stop-first core, XAUTOCLAIM min-idle above declared bounds, reclaim on confirmed termination; FULL bus compatibility both ways — old jobs run on the new module; git-revert rollback safe | Inherits A's bus answer; a Job outlives its creating pod and is only bounded by its own deadline + the run-registry cleanup |
| **Q5 migration cost** | Replaces claim/ack/steal + done records + timeouts wholesale; adds flows/approval/schedules/caching/audit/UI; TS SDK active; the 1 s tick polls SSE results (no push callback); a second control plane beside the bus; EE for what confinement needs | Replaces nearly everything, adds versioning/schedules/visibility; mature TS SDK (1.24.0); worker process + client-starts + signals keep the tick shape; workflow-code determinism discipline is a real cost; second control plane; new ops surface | Zero migration — it IS ADR-010; outcome 6 builds: per-task profiles, the ceiling registry, admission wiring, Motor off Docker | Small and additive: a Job-creating controller in the owning module, RBAC + VAP + policy extensions; results stay bus-first; limits/deadlines move to Kubernetes primitives |

## 3. Decision context (fixed here, do not reopen)

- **ADR-010** moved the instance onto k3s by ADR-010 (`docs/adr/010-container-generations.md`,
  branch `design/b0r-containers-simplify`, read 2026-10-13): Flux-applied Helm
  chart as the static topology; namespaces with default-deny NetworkPolicy;
  CloudNativePG Postgres; Valkey; OpenBao + the Bank-Vaults secrets webhook
  (vault-env, daemon mode); the generation operator as the only workload with
  cluster mutation rights; Motor holds RBAC rights ONLY on Jobs in its own
  namespace (`lifemodel-motor`).
- **The job mechanics adopted (simplification point 2)** — the ENTIRE
  in-flight/async machinery — are quoted and analyzed in
  [Q1/Q4/Q5 for Config A](#q1--durable-long-waits-and-resumption); their
  option row O2-J explicitly deferred the engine question: "NOT for this
  milestone; the owner's research (Windmill vs Temporal vs own) is filed
  BEFORE outcome 6 ... The job surface is deliberately plain so that research
  can move it wholesale" (ADR-010, "Q2 continued — the job mechanics", read
  2026-10-13). This document is that research.
- **Charter outcome 6** (`docs/charters/instance-1.md` lines 91-95, read
  2026-10-13): "Tasks run in parallel, each within its own limits. *Check:*
  two tasks run at once with different profiles; each sees only its own files
  and its allowed domains, no key is present in its process, and a task asking
  for more than the owner's ceilings is refused. Motor Cortex runs its work on
  this executor instead of Docker."
- **The core is fully async; the tick is the only boundary**: "a command event
  goes out, a result event comes in, the tick never blocks on a round trip"
  (ADR-010, Q2 continued, read 2026-10-13). Any adopted engine must not make
  the tick block, and results must arrive as events handled in later ticks.
- **Credentials are decided** (ADR-010 Q7, read 2026-10-13): OpenBao
  per-process roles, Kubernetes-auth service-account logins, vault-env in
  daemon mode; nothing is delivered to a pod; model keys are injected by Agent
  Vault at the egress gateway — a task pod's environment is designed to hold
  NO key, and its only egress route is the egress gateway acting as
  `HTTPS_PROXY` under a per-module (motor) policy (ADR-010 Q5, read
  2026-10-13).
- **Today's Motor Cortex** runs sandboxes as Docker containers driven over a
  length-prefixed IPC protocol, with the host delivering credentials over the
  wire (`CredentialDeliverRequest`), "never written to disk inside the
  container" (`src/runtime/container/types.ts`, read 2026-10-13) — outcome 6
  replaces this runner.

## 4. Q1 — Durable long waits and resumption

### Windmill

- **Waits are engine features, priced cheap while waiting.** A flow can
  contain a suspend/approval step — "a normal script" that returns resume
  URLs; after it, the flow "suspend[s] at no cost until it is resumed by
  getting an approval/resume signal"; sleep steps handle "several hours,
  days, months (years); Sleeping is passive and does not consume any
  resources" (https://www.windmill.dev/docs/flows/architecture,
  https://www.windmill.dev/docs/flows/sleep, read 2026-10-13). Approval
  forms and step-permission customization are Cloud/EE
  (https://www.windmill.dev/docs/flows/flow_approval +
  https://www.windmill.dev/pricing, read 2026-10-13).
- **State survives engine and worker crashes** because the whole queue and
  job state (including results and logs) is Postgres: "Database volume is
  persistent" (https://www.windmill.dev/docs/advanced/self_host, read
  2026-10-13); "The database holds all jobs, and the workers are stateless"
  (https://www.windmill.dev/docs/advanced/scaling, read 2026-10-13). A
  suspended flow is DB state, so it survives (inference from that
  architecture; no dedicated page verified for suspensions over crash).
- **A crashed worker's job is recovered by a zombie monitor**: a job whose
  worker stops pinging for `ZOMBIE_JOB_TIMEOUT` (60 s default) is re-queued
  and re-run up to `RESTART_LIMIT = 3`, each restart raising a critical alert
  (https://github.com/windmill-labs/windmill/blob/main/backend/src/monitor.rs
  and https://www.windmill.dev/docs/advanced/instance_settings, read
  2026-10-13; graceful stop gets a ~300 s grace,
  https://www.windmill.dev/docs/core_concepts/critical_alerts, read
  2026-10-13).
- **Semantics: at-least-once.** Zombie re-runs and step retries re-execute
  the script body, so task code must be idempotent; per-(script, inputs)
  result caching with a TTL absorbs re-triggers of identical input, and job
  debouncing is EE-only (https://www.windmill.dev/docs/core_concepts/caching,
  https://www.windmill.dev/docs/core_concepts/job_debouncing, read
  2026-10-13). There is no caller-defined key the engine carries to the
  destination — the exactly-once-at-destination work of an effect key stays
  with the task code (inference from the docs; nothing promises once-only
  application).
- **Default timeouts**: self-hosted default 7 days
  (`DEFAULT_SELFHOSTED_TIMEOUT = 604_800`,
  https://github.com/windmill-labs/windmill/blob/main/backend/windmill-common/src/worker.rs,
  read 2026-10-13); per-flow-step custom timeouts cannot exceed the instance
  timeout (https://www.windmill.dev/docs/flows/custom_timeout, read
  2026-10-13).

### Temporal

- **Waiting is the engine's core primitive.** Durable timers ("Timers are
  persisted, ensuring execution continues after downtime, using minimal
  resources" — https://docs.temporal.io/develop/typescript/workflows/timers),
  signals (async) and updates (sync, with value and validator; ≤10 in-flight,
  ≤2,000 total per workflow — https://docs.temporal.io/develop/typescript/workflows/message-passing
  and https://docs.temporal.io/self-hosted-guide/defaults), plus
  `condition()` predicates. A human-in-the-loop wait of days is a persisted
  timer/condition, not a held process (all read 2026-10-13).
- **Engine crash**: state is event-sourced in the persistence store and
  resumable ("the state of the Workflow Execution persists in the face of
  failures and outages and resumes execution from the latest state" —
  https://docs.temporal.io/workflow-execution; persistence options Postgres
  12+/MySQL 8.0.17+/Cassandra/SQLite-dev —
  https://docs.temporal.io/self-hosted-guide/deployment, read 2026-10-13).
- **Worker crash**: workflow tasks are retried by the server "until the
  Workflow Execution Timeout (which is unlimited by default) with an
  exponential backoff and a max interval of 10 minutes"
  (https://docs.temporal.io/retry-policies); an in-flight activity is
  re-delivered after its Start-To-Close timeout per the retry policy
  (https://docs.temporal.io/activity-execution, read 2026-10-13); heartbeats
  detect a wedged-but-alive worker faster and carry progress to the next
  attempt (https://docs.temporal.io/encyclopedia/detecting-activity-failures,
  read 2026-10-13).
- **Semantics: workflows effectively-once, activities at-least-once.** Side
  effects inside activities WILL re-run on retry — "Temporal guarantees that
  an Activity Task either runs or timeouts" — so the task code must key its
  dedup on the (implicitly available) Workflow ID + Activity ID; there is no
  engine-supplied effect key for external destinations
  (https://docs.temporal.io/activity-execution, read 2026-10-13; the
  keying-by-IDs shape is our inference).
- **Ceilings that bound long waits**: history cap 51,200 events / 50 MB
  (warn at 10,240 / 10 MB; https://docs.temporal.io/workflow-execution/limits,
  read 2026-10-13); `continueAsNew` is the documented escape
  (https://docs.temporal.io/develop/typescript/workflows/continue-as-new;
  that it is the intended escape for long flows is our inference).

### Our own as adopted (Config A)

- **A wait is not a suspended execution, so there is nothing to resume.**
  "A call whose answer arrives on the bus later (webhook, human reply, timer
  fire): send, record the correlation as ordinary state, XACK, be done — the
  answer arrives as a future event. NO special suspension mechanism"
  (ADR-010, Q2 continued; containers design, "Keyed job rules" — branch
  `design/b0r-containers-simplify`, read 2026-10-13). Days-long waits are
  durable Postgres correlation rows; delayed events are durable rows fired by
  the core's scan (design, streams section, R3-14).
- **Everything durable lives in Valkey's AOF and Postgres, in the module's
  own schema.** The ACK boundary is the fsync: `appendfsync-always`; the
  ingress gateway answers HTTP 202 only after its fsynced XADD; Valkey
  restart restores each group's position and PEL; "Valkey restart inside any
  cut: ids and commands live in the outbox (AOF) and records in Postgres, not
  in process memory" (design "Keyed job rules" + "Valkey persistence,
  retention and pressure", read 2026-10-13). The core's tick commit (snapshot
  + outbox + pending effects) is one atomic epoch-checked Lua-CAS write per
  tick (design, streams/stop-first sections, read 2026-10-13).
- **Semantics**: delivery is at-least-once ("Delivery is at-least-once
  (stream consumer groups); every consumer is idempotent by the event's own
  key" — design, streams section, read 2026-10-13). Keyed destinations get
  effectively-once outcomes via the done record + the destination honoring
  the effect key; an ambiguous `unkeyed` attempt is recorded `uncertain`,
  reported, and NEVER automatically re-dispatched — "the report is the
  owner's re-issue surface"; "No disposition claims 'no duplicate
  application' for an ambiguous unkeyed effect" (design "Keyed job rules",
  destination idempotency classes, read 2026-10-13).
- **Five crash cuts are enumerated** in the design ("Keyed job rules", crash
  cuts, read 2026-10-13), and every recovered attempt "follows recorded state
  instead of guessing": the done record is admitted (`in-flight`) BEFORE the
  effect dispatches and updated after.
- **What the effect/task code must do**: mint the effect id ONCE at the
  deciding tick and persist it (never re-derive); declare per-destination
  timeouts AND the module's delivery-to-result bound in the build-checked
  manifest (missing either FAILS THE BUILD); declare the keyed/unkeyed
  class; make the destination honor the key (design "Keyed job rules":
  stable effect ids, timeouts, destination classes, read 2026-10-13).

### Our own on Kubernetes Jobs (Config B)

- **Nothing durable moves**: AOF, outbox, done records are unchanged by which
  run unit executes the effect — the Job is just the run unit (inference,
  grounded in Config A's rules; Config B is not specified in any source
  document).
- **A long wait should NOT be a long-running Job pod**: the wait stays a
  correlation row + a later bus event (A's rule), and a Job is created when
  compute is actually needed. If a task IS held as a long-running pod, its
  death after a node restart is recovered by pod `restartPolicy` (Jobs'
  restartPolicy is limited to `Never`/`OnFailure`) and completed-with-retries
  Jobs re-run pods up to `backoffLimit` — an extra, engine-controlled
  re-issue path that must reconcile with keyed done records
  (Kubernetes Job semantics from the kubernetes.io docs the lane cites:
  https://kubernetes.io/docs/concepts/workloads/controllers/job/ — read
  2026-10-13; the reconciliation-risk reading is our inference, see Risks 1).
- **Task code obligations are unchanged** (effect id, manifest, done record)
  plus two disposability rules: no in-process state may be assumed to
  survive an eviction, and no file beyond the pod's own filesystem/ephemeral
  volumes may be claimed (inference from Job pod semantics).

## 5. Q2 — Per-task limits and confinement (outcome 6)

Outcome 6 demands: two tasks at once with different profiles; own files only;
allowed domains only; no key in the process; over-ceiling refusal. The
comparison on exactly these five rows:

### Windmill

- **What it does itself**: job timeouts (7-day default self-host, per-step
  custom, cannot exceed the instance timeout —
  https://www.windmill.dev/docs/flows/custom_timeout, read 2026-10-13);
  optional **nsjail sandbox** with filesystem isolation to the job directory,
  resource limits (CPU seconds, `rlimit_as` defaulting to 4096 MiB for
  Python, process count), user namespace, optional network isolation —
  "Job isolation is disabled by default in Windmill. Both NSJAIL and PID
  namespace isolation must be manually configured"
  (https://www.windmill.dev/docs/advanced/security_isolation, read
  2026-10-13); nsjail default protos bind only script+args and keep the
  network namespace OFF by default (`clone_newnet: false`,
  https://github.com/windmill-labs/windmill/tree/main/backend/windmill-worker/nsjail,
  read 2026-10-13); PID-namespace isolation so jobs cannot see worker
  memory/env via /proc (same page); memory is the worker CONTAINER's limit —
  "If a job exceeds the worker's memory limit, it will be killed by the
  operating system" (https://www.windmill.dev/docs/advanced/scaling, read
  2026-10-13); one job at a time per worker process
  (https://www.windmill.dev/docs/core_concepts/dedicated_workers, read
  2026-10-13); worker recycling (`EXIT_AFTER_N_JOBS`),
  (https://www.windmill.dev/docs/advanced/security_isolation, read
  2026-10-13).
- **Secrets**: stored encrypted per workspace in the DB; scripts fetch them
  at runtime through an ephemeral per-job `WM_TOKEN` with
  `permissioned_as`-scoped visibility, audit events and log masking
  (https://www.windmill.dev/docs/core_concepts/variables_and_secrets, read
  2026-10-13). The fetch puts the secret value INTO the task process — the
  engine holds it, but the process still sees it at runtime; there is no
  egress-time injection point. External secret backends (Vault, Azure, AWS)
  are **EE-only** (same page).
- **NOT provided (absent, not found as a feature)**: per-task
  admission-time CPU/memory ceilings (refusing a task above declared
  limits) — nothing found; and a per-task DOMAIN allowlist — nsjail's
  network isolation is a toggle, a domain allowlist is not documented (lane
  findings, https://www.windmill.dev/docs/advanced/security_isolation and
  nsjail protos, read 2026-10-13).
- **EE-gated on this axis**: concurrency limits (per script/flow/step),
  dedicated workers, agent workers (network-zone separation from the DB),
  secret backends, retention beyond 30 days, audit logs, autoscaling/queue
  metrics (https://www.windmill.dev/pricing,
  https://www.windmill.dev/docs/core_concepts/agent_workers,
  https://www.windmill.dev/docs/core_concepts/concurrency_limits, read
  2026-10-13).
- **What falls to Kubernetes anyway**: worker-pod resource limits,
  NetworkPolicy, separate pods/namespaces for blast radius; worker groups
  "only require a DATABASE_URL and can thus be spawned in separate VPCs"
  (https://www.windmill.dev/docs/core_concepts/worker_groups, read
  2026-10-13).

### Temporal

- **What it does itself**: time and concurrency only. An Activity Execution
  "must have either the Start-To-Close or the Schedule-To-Close Timeout set"
  (https://docs.temporal.io/develop/typescript/activities/timeouts, read
  2026-10-13); retry policies (`maximumAttempts`,
  non-retryable types — https://docs.temporal.io/retry-policies);
  per-workflow pending ceilings (2,000 activities/children/signals/cancels)
  and payload caps (2 MB error / 256 KB warn,
  https://docs.temporal.io/workflow-execution/limits and
  https://docs.temporal.io/self-hosted-guide/defaults, read 2026-10-13);
  worker-process concurrency slots and task-queue routing to dedicated
  worker pools (https://docs.temporal.io/develop/worker-performance/configuration,
  https://docs.temporal.io/task-queues, read 2026-10-13); server-side
  rejection of oversized payloads.
- **NOT provided**: file isolation (a worker sees its host's filesystem —
  inference from the deployment model,
  https://docs.temporal.io/develop/typescript/workers/run-process), per-task
  network allowlists (none documented; an in-code interceptor could act as
  one — inference), and per-task CPU/memory limits (none found;
  https://docs.temporal.io/develop/worker-performance/configuration, all
  read 2026-10-13).
- **Secrets**: the engine holds NO task secrets; with the Payload Codec,
  "data exists unencrypted only on the Client and the Worker process, on
  hosts that you control" (https://docs.temporal.io/production-deployment/data-encryption,
  read 2026-10-13) — encryption happens in the task's own process before the
  server sees anything; there is no engine-side egress injection, and the
  model key would live in the worker process's environment by our own
  deployment choice (inference), which conflicts with the charter check.
- **What falls to Kubernetes**: pod limits per worker, NetworkPolicy,
  separate namespaces/pods — Temporal's own isolation story is logical
  (task queues + namespaces + version routing), not OS-level (lane
  inference from the security docs,
  https://docs.temporal.io/self-hosted-guide/security, read 2026-10-13).

### Our own as adopted (Config A)

- **The mechanics themselves carry queue semantics only** — the module pod
  is the confinement unit: per-destination timeouts and classes are
  build-checked manifest entries; the module's
  `terminationGracePeriodSeconds` must cover its longest declared timeout
  (single-unit check against the rendered pod field); a missing bound
  fails the build; "NO unbounded sync calls" (design "Keyed job rules",
  read 2026-10-13).
- **Confinement surfaces are all platform and already drawn**: namespace
  default-deny + named policy rows; Motor's sandboxes get no bus/store
  route and egress ONLY through the gateway as `HTTPS_PROXY` under the
  motor policy; PSA `restricted` + a Job-template
  ValidatingAdmissionPolicy requiring a zero-rights ServiceAccount, a run
  deadline from the declared Motor run limit, requests/limits REQUIRED,
  ephemeral-only volumes ("a generic ephemeral volume, so no PVC outlives
  its Job"); vault-env injects nothing that the pod spec carries, and
  model keys are Agent Vault's, one hop past the egress gateway
  (ADR-010 Q5/Q7, R5-09; design Motor block — all read 2026-10-13).
- **What outcome 6 would still have to build under A**: the per-TASK
  objects do not exist — a task inside a module process shares the module
  pod's allocation, and the sources name NO per-task CPU/memory ceiling in
  Config A (the closest existing refusal is the VAP's
  `activeDeadlineSeconds` requirement on sandbox Jobs) (lane inference from
  the sources, read 2026-10-13). Profiles, ceiling values and a refusing
  path are outcome-6 work (open points 2-4 below).

### Our own on Kubernetes Jobs (Config B)

- **Per-task limits become Kubernetes fields**: pod-level
  `resources.requests/limits` per task (kubelet-enforced), Job-level
  `activeDeadlineSeconds` as the hard time ceiling, `backoffLimit` for
  crashes (Job semantics: https://kubernetes.io/docs/concepts/workloads/controllers/job/,
  read 2026-10-13). The adopted VAP (R5-09) already requires exactly these
  fields on Motor's sandbox Job templates and can be EXTENDED to enforce
  per-profile ceiling values at admission (inference; VAP field-conditions)
  — "a task asking for more than the owner's ceilings is refused" is then
  an API-server-enforced rule, with the module's own pre-validation
  ("Motor validates the same template before submission", design Motor
  block, read 2026-10-13) as the readable-error path and the operator
  control-only (never a Job toucher).
- **File isolation**: one pod + its generic ephemeral volume per task;
  pods share nothing by default; host mounts, privileges and non-ephemeral
  volumes are refused by PSA + the VAP (R5-09 facts, read 2026-10-13).
- **Allowed domains**: three homes, to be picked at outcome-6 design: (a)
  per-task NetworkPolicy rendered with the Job (labels select the pod;
  needs an RBAC extension — `networkpolicies create` is NOT in Motor's
  current row), (b) a namespace per task (bought isolation, objects and GC
  churn multiplied), (c) a per-task allowlist at the egress gateway (which
  already "carries per-module policy"; a per-TASK policy there avoids
  per-task NetworkPolicy objects entirely) (lane inference from the
  namespace table + chokepoint section, read 2026-10-13).
- **No key in the process**: unchanged ADR-010 answer — vault-env
  daemon-mode injection (nothing in the pod spec), model keys behind Agent
  Vault at the egress gateway; whether the Bank-Vaults webhook's
  objectSelector covers Motor-created Job pods must be verified at
  outcome-6 design (open point 5), OR tasks stay credential-free by design
  (the motor-sandbox model: only proxied egress, no key, no store route —
  design Motor block, read 2026-10-13).

## 6. Q3 — Self-hosting footprint and licence

### Windmill

- **Components**: Postgres + one server-mode container + N worker-mode
  containers; optional LSP and multiplayer (EE); everything except
  Postgres is stateless (https://www.windmill.dev/docs/advanced/self_host,
  read 2026-10-13). **External dependency: Postgres only** — no
  Elasticsearch/Cassandra/ClickHouse; optional S3 for a global dependency
  cache at >20 workers (same page).
- **Sizing (vendor claims)**: "1 worker per 1 vCPU and 1-2 GB of RAM";
  default compose ships 3 workers @ 2,048 MB each + a native worker;
  workers "capable of handling up to 26 million tasks a month at 100 ms
  per task" (https://www.windmill.dev/docs/advanced/self_host,
  https://www.windmill.dev/docs/core_concepts/dedicated_workers,
  https://github.com/windmill-labs/windmill/blob/main/docker-compose.yml —
  all read 2026-10-13). No published minimum-RAM page; a
  server+workers+Postgres stack fits under 8 GB (our inference from those
  inputs, marked as such).
- **Licence**: the repository's LICENSE — "Source code in this repository
  is variously licensed under the Apache License Version 2.0, or the AGPLv3
  License, and a proprietary license for certain enterprise features"
  (https://github.com/windmill-labs/windmill/blob/main/LICENSE, read
  2026-10-13). Backend/frontend source is AGPLv3 except
  enterprise-flagged snippets (proprietary); ALL client SDKs (npm
  `windmill-client` 1.830.0, published 2026-10-09, 1,312 versions; plus
  Python/Go/Rust/React) and the OpenAPI/OpenFlow spec are Apache-2.0
  (registry.npmjs.org/windmill-client, read 2026-10-13) — **verified
  independently by the coordinator from LICENSE and the npm registry**.
- **The CE docker image / release binaries include proprietary non-public
  features** under a free-but-limited grant: "not to sell, resell, serve as
  a managed service, modify or wrap under any form without an explicit
  agreement" (LICENSE, read 2026-10-13).
- **CE self-host limits** (pricing grid,
  https://www.windmill.dev/pricing, read 2026-10-13): 3 workspaces, 50
  users, 4 groups, job-run retention ≤ 30 days, 10 GiB workspace object
  storage; NOT in CE: concurrency limits, dedicated workers, agent
  workers, audit logs, OTel/log collection, error handlers, approval
  forms, private registries/Hub, OIDC/SAML/SCIM.
- **EE self-host**: license key on the `ghcr.io/windmill-labs/windmill-ee`
  image; usage telemetry reported to Windmill (compute units = worker
  memory) (https://www.windmill.dev/docs/enterprise/plans_details, read
  2026-10-13).

### Temporal

- **Components (production)**: the Temporal server (frontend, history,
  matching + an internal worker service) in one image or split; a REQUIRED
  SQL/Cassandra persistence store (Postgres 12+ works — CNPG could host
  it); a REQUIRED visibility store (the same DB is possible; Elasticsearch
  v7/v8 / OpenSearch "recommended for any setup that spawns more than a
  few Workflow Executions", Postgres visibility supported but slower); the
  Web UI container; optional Prometheus/Grafana and archival blob storage
  (https://docs.temporal.io/self-hosted-guide/deployment,
  https://docs.temporal.io/self-hosted-guide/visibility,
  https://docs.temporal.io/temporal-service, read 2026-10-13).
- **Reference compose footprint**: postgres + elasticsearch (256 MB JVM
  heap in the sample) + the server (all services in one container) + UI;
  compose variants WITHOUT Elasticsearch exist
  (https://github.com/temporalio/samples-server/blob/main/compose/docker-compose.yml
  and .../compose/README.md, read 2026-10-13). Dev mode is a single
  binary with SQLite ("no external dependencies" —
  https://docs.temporal.io/self-hosted-guide, read 2026-10-13).
- **Minimum RAM/CPU: not verified** — no vendor-published production
  minimum found; the docs' own production checklist says to run your own
  proof-of-concept load test (https://docs.temporal.io/self-hosted-guide/production-checklist,
  read 2026-10-13). The vendor is candid about effort: the checklist lists
  scalability, management, maintenance and upgrades as each "an essential
  part of building a mission critical Temporal Service", and shard counts
  are fixed at build time (same page).
- **Licence**: server MIT (https://github.com/temporalio/temporal), TS
  SDK MIT (`@temporalio/worker|client|workflow` 1.24.0, 2026-09-15, node
  >= 20.3.0; https://github.com/temporalio/sdk-typescript/releases,
  registry.npmjs.org), Web UI MIT (https://github.com/temporalio/ui) — all
  read 2026-10-13, and the coordinator verified server+SDK licence fields
  independently.
- **What is paid**: Temporal Cloud only (per-action pricing;
  https://temporal.io/pricing, read 2026-10-13); self-hosted has no paid
  support per the official feature table
  (https://docs.temporal.io/evaluate/features/cloud-vs-self-hosted-features,
  read 2026-10-13). Nothing of what we would need is Enterprise-only.

### Our own (A and B)

- **No new component in either config.** The platform set is already
  adopted: k3s (+embedded etcd pinned by the installer), Flux, CloudNativePG,
  Traefik, OpenBao + Bank-Vaults secrets webhook, local registry, BuildKit,
  the generation operator (ADR-010 "Bad" consequences list, read
  2026-10-13). In A the "engine" is each consumer module; in B the
  additional surface is Kubernetes primitives only (Jobs, PSA,
  NetworkPolicy, ValidatingAdmissionPolicy — all in-tree k3s APIs), plus
  chart objects and a Job-creating controller inside the owning module
  (lane, read 2026-10-13).
- **Licences**, all verified 2026-10-13: Valkey **BSD-3-Clause**
  (repo-root `COPYING` on the default branch `unstable`, "Copyright (c)
  2024-present, Valkey contributors"; the `LICENSES/` directory holds only
  permissive third-party texts — the 2025 AGPL change belongs to Redis
  upstream, NOT Valkey; https://github.com/valkey-io/valkey/blob/unstable/COPYING
  — read 2026-10-13); CloudNativePG **Apache-2.0**
  (https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE);
  OpenBao **MPL-2.0** (https://github.com/openbao/openbao/blob/main/LICENSE;
  HashiCorp Vault itself is BUSL-1.1 with an MPL-2.0 change licence after 4
  years — https://github.com/hashicorp/vault/blob/main/LICENSE);
  PostgreSQL upstream PostgreSQL-Licence (BSD-like);
  k3s **Apache-2.0** (https://github.com/k3s-io/k3s/blob/main/LICENSE);
  Flux **Apache-2.0** (https://github.com/fluxcd/flux2); Kubernetes
  **Apache-2.0** (gh api repos/kubernetes/kubernetes); Bank-Vaults and
  vault-env **Apache-2.0**; workerd **Apache-2.0**
  (https://github.com/cloudflare/workerd/blob/main/LICENSE).
- **Operational burden**: whatever ADR-010 already accepted — no new
  service, no new upgrade cadence (lane, read 2026-10-13). B adds object
  churn (Job + policy per task) and a GC story, which the ADR already
  assigns to Motor's tracked cleanup ("finished Jobs deleted; an
  interrupted cleanup is re-driven from the registry", design Motor block,
  read 2026-10-13).

## 7. Q4 — Jobs surviving a module replacement

lifemodel replaces modules one by one (start-first RollingUpdate for keyed
writers, a one-replica stop-first StatefulSet for the core) and rolls back by
reverting git (ADR-010 decision 2, read 2026-10-13).

### Windmill

- **Scripts are immutable by hash** — "each deployment of a script creates
  an immutable hash that will never be overwritten ... if you refer to a
  script by its hash, its behavior is guaranteed to remain the same even if
  a new hash is deployed at the same path"
  (https://www.windmill.dev/docs/core_concepts/draft_and_deploy,
  https://www.windmill.dev/docs/core_concepts/versioning, read 2026-10-13).
  Queuing by path pins the latest deployed hash AT QUEUE TIME
  (`get_latest_deployed_hash_for_path` → `JobPayload::ScriptHash`,
  https://github.com/windmill-labs/windmill/blob/main/backend/windmill-common/src/jobs.rs,
  read 2026-10-13). Inference from the hash pins: in-flight and queued jobs
  always run the version they were pinned to; a redeploy never mutates them.
- **Flows pin a numeric version at queue time** (`JobPayload::Flow { path,
  version }`; version-pinned webhook endpoints "stable across redeploys" —
  jobs.rs and https://www.windmill.dev/docs/core_concepts/webhooks, read
  2026-10-13); each step is a fresh job read from the pinned flow, so a
  long flow survives a deployment (lane inference). "Restart deployed flows
  from any node and version" is EE (pricing grid).
- **Worker restarts are graceful**: "Windmill provides graceful exit for
  jobs in workers so it will not interrupt current jobs unless they are
  longer than docker stop hard kill timeout (30 seconds)"
  (https://www.windmill.dev/docs/advanced/self_host, read 2026-10-13);
  queued jobs wait; killed mid-flight work is recovered by the zombie
  monitor (Q1).
- **No replay/determinism constraints**: completed step results are stored
  and passed by value; failures re-run whole steps with retry params
  (https://www.windmill.dev/docs/flows/retries, read 2026-10-13). A code
  change = deploy a new version; rollback = redeploy an old one from
  History; perpetual scripts restart onto the new version
  (`restart_perpetual_runs_on_new_version`,
  https://github.com/windmill-labs/windmill/blob/main/backend/windmill-queue/src/jobs.rs,
  read 2026-10-13 — verified via the function name, semantics as named).

### Temporal

- **The strongest versioning machinery of the four, at the price of a hard
  discipline.** Workflow code must replay deterministically: "any time your
  Workflow code is executed it makes the same Workflow API calls in the same
  sequence, given the same input"; command-producing calls "must not be
  reordered, added, or removed without proper Versioning techniques";
  external I/O belongs in activities, outside the replay path
  (https://docs.temporal.io/workflow-definition#deterministic-constraints,
  read 2026-10-13).
- **Worker Versioning** (server >= 1.29.1, TS SDK >= 1.12,
  https://docs.temporal.io/worker-versioning, read 2026-10-13): versions =
  Worker Deployment Versions; per workflow type a **Versioning Behavior** —
  **Pinned** ("guaranteed to complete on a single Worker Deployment
  Version", for rainbow deploys, with sunset draining) or **Auto-Upgrade**
  (migrates to the new version and must be kept replay-safe "manually, that
  is with patching"). Rollouts have a Current and a Ramping version with a
  traffic percentage, and "**Instant rollback** when you detect that a new
  Deployment Version is broken". A Kubernetes **Temporal Worker
  Controller** automates the rainbow deploy of workers
  (https://docs.temporal.io/production-deployment/worker-deployments/kubernetes-controller,
  read 2026-10-13). The pre-2025 experimental versioning API was REMOVED
  from the server in March 2026 — a clean break to track when pinning
  versions (https://docs.temporal.io/develop/typescript/workflows/versioning,
  read 2026-10-13).
- **Patching** for in-place evolution: `patched()`/`deprecatePatch()` keyed
  by a history marker; 3-step lifecycle
  (https://docs.temporal.io/patching, read 2026-10-13).
- **Before rollout, replay testing against real recorded histories** is the
  prescribed safe-deployment phase
  (https://docs.temporal.io/develop/safe-deployments, read 2026-10-13).
  Caveat: "Eager start does not respect Worker versioning" (same page).
- **Rolling restarts do not lose work**: queued tasks persist server-side;
  workflow task executions retry with backoff; activities retry per policy
  after their timeouts fire on the dead worker (https://docs.temporal.io/retry-policies,
  https://docs.temporal.io/encyclopedia/detecting-activity-failures, read
  2026-10-13; chaining the two mechanisms is lane inference). Plain rolling
  upgrades "tend to provide lower availability than the other strategies
  and are incompatible with Worker Versioning" (worker-versioning page).

### Our own as adopted (Config A) — the ADR's own answer

- **Start-first for keyed writers**: Deployment RollingUpdate maxSurge 1 /
  maxUnavailable 0; the new pod's READINESS predicate requires the
  consumer-group join observed BEFORE Ready, so the old pod cannot be
  terminated until its group is covered; when the old pod's termination is
  CONFIRMED, its unfinished PEL entries are reclaimed immediately — "the
  confirmed termination authorizes the reclaim, the idle clock does not
  delay it" (design "Start-first sequence", R4-02, read 2026-10-13).
- **Stop-first for the core**: one-replica StatefulSet (Recreate rejected);
  the new core takes the epoch by Lua CAS after the old core's confirmed
  termination, lease revocation and the bounded drain; snapshot copies are
  taken ONLY at that point and restored only by a human in maintenance
  (design "Stop-first" section, read 2026-10-13).
- **XAUTOCLAIM min-idle sits ABOVE every module's declared
  delivery-to-result bound** — it is the CRASH-takeover trigger, never a
  live-consumer fence; a paused or parked healthy consumer is not stolen
  within its declared bounds; the exact default is an open operator
  setting (design "Keyed job rules", R4-02, operator config table, read
  2026-10-13).
- **"Jobs issued by an older version are run by the new module"** via the
  bus contract's FULL both-ways compatibility — "NO retained-image
  one-shot runners" (ADR-010 Q2 continued + design keyed rules, read
  2026-10-13). A **rollback is a git revert** to the previous generation's
  recorded FULL revision (chart + values), applied module-by-module by Flux
  on current data; re-applied commands are keyed, done records make
  re-delivery a no-op, and FULL both-ways compatibility means the reverted
  module still consumes the event shapes its (now-removed) successor
  produced during the bad window (design "Rollback and maintenance",
  read 2026-10-13).

### Our own on Kubernetes Jobs (Config B)

- **The bus layer behaves exactly as Config A**; the difference is the run
  unit. A Job created by a replaced Motor pod is NOT owned by it — Jobs are
  etcd objects that outlive their creator; a rolling Motor replacement does
  not touch them. The ADR's existing machinery covers the lifecycle: the
  tracked run registry re-drives cleanup after an interruption, ONLY
  Motor's RBAC row may delete its Jobs (the panic's `lifemodel-motor` step
  is Motor's own cleanup, run BEFORE the release scales to zero), and an
  over-long Job is bounded by its own `activeDeadlineSeconds` (design
  Motor block + panic section, read 2026-10-13; the "Job survives creator"
  reading is lane inference from Job semantics).
- **No replay/determinism question exists** — a killed Job's pod re-runs;
  idempotency comes from the keyed done record, not from code versioning.
  The Job template must remain acceptable across Motor versions; PSA + the
  VAP bound templates at admission, which caps the risk of a stale template
  (lane inference).
- **The one new danger vs Config A** is the Job controller's own re-run
  path (`backoffLimit`) outside the takeover rules — see Risks 1.

## 8. Q5 — Cost of moving the ADR-010 mechanics onto it

### Windmill

- **Replaces** (of the Valkey baseline: consumer groups, XACK-after-result,
  XAUTOCLAIM, keyed done records, `uncertain`, declared timeouts, bus-event
  waits): the claim/ack/takeover machinery → Postgres row-state transitions
  (queue → running → completed, atomic claim, UUID jobs
  https://www.windmill.dev/docs/core_concepts/jobs, monitor.rs); keyed done
  records → completed-job rows addressable by UUID with retention (~30
  days CE); declared timeouts → TIMEOUT + per-step custom timeouts; waits
  for humans/events → suspend/approval steps + sleeps; PLUS adds flows,
  retries with backoff, schedules (cron), webhooks/triggers, result
  caching, secret management with masking+audit, worker groups/priority,
  HA story, and a UI (lane, read 2026-10-13).
- **What stays with us anyway**: the `uncertain`/keyed-idempotency
  discipline does NOT transfer — Windmill has no caller-defined effect key
  carried to the destination; debouncing is EE; ambiguous concurrent
  results for one logical key are the caller's concern (lane inference
  from the jobs docs). And the bus remains for everything else in
  lifemodel — signals only on the bus (Q13), per-module ACL identity, the
  core's keyed PG appliers — so adopting Windmill creates a SECOND
  control plane for jobs, outside the AsyncAPI bus contract, with its own
  upgrade cadence, licence boundary and Postgres schema.
- **TypeScript/Node SDK**: `windmill-client` 1.830.0 (2026-10-09),
  Apache-2.0, 1,312 versions since 2023 — very active
  (registry.npmjs.org/windmill-client, read 2026-10-13).
- **What the 1-second-tick core changes**: results do NOT come back as bus
  events — Windmill has no engine-side callback to a caller URL on
  completion; the core would `runScript` (async, returns a UUID) and poll
  get-job/SSE (`/jobs_u/getupdate_sse/{id}`) or use webhooks
  (https://www.windmill.dev/docs/core_concepts/webhooks, read 2026-10-13);
  correlation ids ride job `labels` (supported by the schema, not a
  documented pattern — lane inference). The tick stays non-blocking, but
  the bus-first result path is replaced by a poll loop against a foreign
  API, and per-module egress policy/identity would have to be re-expressed
  as worker-group tags — a fit that must be designed, not assumed.

### Temporal

- **Replaces almost the whole baseline** — mapped one-to-one by the lane:
  consumer groups/XACK → server-side task queues with server-recorded
  completion; XAUTOCLAIM → automatic re-delivery/retry after
  timeouts/heartbeats; keyed done records → Workflow/Activity IDs and
  typed handle queries ("did it finish?" is a server query); `uncertain`
  → still the caller's idempotency job for external side effects; declared
  timeouts → mandatory activity timeouts; bus-event waits →
  signals/updates/condition inside the workflow (lane, all read
  2026-10-13).
- **Adds**: durable multi-step orchestration with deterministic replay;
  retries with backoff and heartbeat progress free of charge; persistent
  schedules (cron) as a server feature; visibility (Web UI + search
  attributes, needs the visibility store); versioning tooling — "the piece
  plain streams have no answer for" (lane). A real operational addition on
  a small node: server + DB (+ visibility store) to upgrade, schema
  tooling, shard planning fixed at build (Q3).
- **TypeScript/Node SDK**: `@temporalio/worker`, `@temporalio/client`,
  `@temporalio/workflow` at 1.24.0 (2026-09-15), MIT, node >= 20.3.0,
  releases in lockstep, repo pushed 2026-10-12 — very active (registry +
  releases, read 2026-10-13).
- **What the 1-second-tick core changes**: (1) a worker process
  (sidecar or in-process) polling a task queue hosts workflow+activity
  code; (2) jobs START via `client.workflow.start()`/`execute()`, each
  with a workflow ID that replaces the keyed done record; (3) side effects
  (HTTP, model calls, DB) move into activities, and workflow code obeys
  the determinism rules — no wall clock or I/O in workflow code;
  (4) results return via `handle.signal(...)`/Updates or awaiting
  `handle.result()` in a later tick — the tick stays the driver and
  `workflow.start` returns immediately (lane integration shape, inference;
  APIs documented at the cited pages). The bus-first discipline would be
  broken for job results (signals to the core come from the Temporal
  worker, not from a module stream), and the done-record/`uncertain`
  machinery — load-bearing for outcome 6's ambiguity reporting — does not
  migrate as-is.

### Our own as adopted (Config A)

- **Zero migration**: it IS the adopted baseline. What outcome 6 remains to
  BUILD (all marked open in the ADR/design, not engine choices):(a)
  per-task PROFILES as a concept in the module manifest (the sources
  parametrize `activeDeadlineSeconds` and Motor's grace by "the declared
  Motor run limit", but per-profile CPU/mem granularity is not spelled
  out); (b) the owner's ceiling registry and its admission check (the VAP
  extension); (c) the readable refusal path (module pre-check); (d)
  Motor's move off its Docker container-manager onto Job creation under
  its RBAC row — the ADR already names this and keeps the result path
  (bus event + keyed row) unchanged; (e) the TO MEASURE values the docs
  mark (egress grace 300 s target, Motor grace vs run limit, build
  budget) (ADR-010 Q5/decision 4, design Motor block + open questions,
  read 2026-10-13).

### Our own on Kubernetes Jobs (Config B)

- **What moves from our code to Kubernetes primitives**: per-task
  CPU/memory ceilings (kubelet/cgroups), the task deadline
  (`activeDeadlineSeconds` — the VAP already requires it), scheduling and
  placement of parallel tasks (one Job per task; independent pod
  scheduling), node-crash re-runs (up to `backoffLimit`), log capture
  (`kubectl logs`), pod ephemerality (lane, read 2026-10-13).
- **What remains ours**: a Job-creating controller inside the owning
  module (render the Job template + per-task network policy from a
  profile, create/watch, correlate the result as a keyed bus event into
  the run registry, tracked cleanup re-driven after a cut — "Kubernetes
  does not carry application results; the Job records only pod completion
  status"); an RBAC extension (networkpolicies create; per-module rows if
  several modules own tasks); a wider VAP (per-profile ceilings); the
  profile→template mapping; refusal UX (lane, read 2026-10-13).
- **Net**: Config B's incremental cost over Config A is small on the bus
  side (unchanged) and concentrates in per-task Kubernetes object
  lifecycle code + admission policy widening + a policy-rendering choice
  (risk 3); its benefit is native per-task pod limits/scheduling that
  Config A expresses only at module-pod granularity (lane). This is the
  shape the ADR already adopted for Motor's sandboxes (R5-09), generalized.

## 9. Risks and open points for the outcome-6 design

1. **Two completion surfaces on Config B.** A task completes in the Job's
   pod status (etcd) AND as a keyed result event on the bus. A Job that
   succeeded while its result event was lost must resolve through the
   done-record states; `backoffLimit` re-runs are an extra re-issue path
   outside the ADR's takeover rules — pin `backoffLimit` to 0 for tasks
   whose destinations are unkeyed, or justify per-Job idempotency.
   (Inference from keyed rules + Jobs API.)
2. **Task-pod identity under Valkey ACLs (open point).** "A process XADDs
   only its OWN stream" (ADR-010 Q7 identity rule). Parallel task pods —
   if they publish results themselves — need a grant; if the owning module's
   single publisher relays, the identity rule stays intact. Not drawn in
   any source; outcome-6 design must pick.
3. **Per-task domain allowlists have no settled home (open point).** Three
   options surfaced: per-task NetworkPolicy (rendered by the task-owning
   module; RBAC extension needed), per-task namespaces (churn), or a
   per-task allowlist at the egress gateway (which carries per-module
   policy today). The charter check is per TASK — finer than anything the
   sources specify.
4. **Where the owner's ceilings live (open point).** The VAP can refuse
   over-ceiling templates at admission with the module pre-check as the
   readable error; but the ceiling VALUES (max seconds, max MB, allowed
   domains per profile) need a declared home and a change story cheaper
   than a full generation change.
5. **vault-env on plain Job pods (to verify).** Whether the Bank-Vaults
   webhook's objectSelector covers Motor-created Job pods, or whether
   tasks should stay credential-free (the motor-sandbox model: no key, only
   proxied egress), is not stated. Credential-free is the simpler
   commitment and matches "the sandbox's own zero-rights service account".
6. **Windmill's licence and EE boundary.** AGPLv3 source + proprietary CE
   binaries (no wrapping/reselling) + telemetry on EE; the isolation-
   relevant features (agent workers, dedicated workers, concurrency
   limits, secret backends) are EE. Any Windmill adoption decision must
   re-run this list against the then-current pricing grid.
7. **Temporal's footprint/ops on one small node.** Server + DB (+ optional
   ES visibility store) on top of the already-adopted stack; no vendor
   minimum published; the upstream checklist is candid about the
   operational weight. Sizing on the actual node is a measured question
   the documents do not answer.
8. **The ADR's own open items persist regardless of this research**: pinned
   chart versions for Valkey/CNPG/OpenBao/k3s/Flux are not stated in the
   sources; the XAUTOCLAIM min-idle default is open ("no default yet",
   open question 2); the TO MEASURE values (egress grace 300 s, Motor
   grace, build budget on 2 CPUs, `healthFailureWindowMs`, lease
   staggering) remain unmeasured; the dev/CI walk on k3d is open question
   7.

## 10. NOT VERIFIED (explicit)

- **Windmill — per-task admission-time ceilings**: no engine feature found;
  treated as ABSENT (limiting happens at worker-container/nsjail level).
- **Windmill — per-task network/domain allowlist**: no feature found; the
  default nsjail config has `clone_newnet: false`; "optional network
  isolation" refers to nsjail-level toggles without a documented domain
  allowlist.
- **Windmill — docker-compose discrepancy**: the security_isolation page
  described PID-ns as disabled-by-default while the current top-of-repo
  compose ships `privileged: true` and `FAVOR_UNSHARE_PID=true`; the
  compose file (read 2026-10-13) taken as authoritative for the CURRENT
  default — read again at design time.
- **Windmill — suspended-flow-on-crash**: inferred from the all-Postgres
  architecture;
  no dedicated crash-recovery-of-suspensions page read.
- **Windmill — flow job payload at queue time**: verified only that
  `JobPayload::Flow{path, version}` is stored; the orchestrator reads the
  pinned version per step (inference).
- **Windmill — server/postgres containers' exact RAM floor**: not
  published.
- **Temporal — vendor minimum RAM/CPU for a production self-hosted
  server**: none published; only the compose sample's ES heap (256 MB) and
  the dev-server-for-laptops note exist.
- **Temporal — TS workflow-sandbox determinism shims** (exact built-in
  replacements for Date/random etc. inside the TS sandbox): the CONSTRAINTS
  are documented at the workflow-definition page; the sandbox's internal
  implementation was not read this pass.
- **Temporal — "Temporal Workers as a service"**: not found as a feature;
  workers run in OUR infrastructure (Temporal Cloud manages the cluster,
  not the workers).
- **Temporal — per-task CPU/memory rlimits**: none found; the lane treats
  "not provided" as its finding (inference from absence of the feature in
  the worker-performance docs).
- **Config B as a design**: NOT specified anywhere — every Config B
  statement in this document beyond ADR-010's adopted R5-09 sandbox facts
  is inference, grounded in those facts and the cited Kubernetes
  documentation.
- **Outcome-6 implementation status**: the sources are design documents
  (2026-10-12/13); what code exists today was not assessed here (not in
  scope for this research).
- **Chart-pinned versions** of Valkey/CNPG/OpenBao/k3s/Flux (which majors
  the chart would pin): not stated in the sources read.
- **Vendor performance/footprint numbers** quoted: all marked vendor
  claims (Windmill worker sizing, 26 M jobs/month; Temporal's docs'
  qualitative claims); none measured.

## 11. Sources

Local project sources (branch `design/b0r-containers-simplify` unless
stated; all read 2026-10-13):

- `docs/adr/010-container-generations.md` — ADR-010; job mechanics (Q2
  continued, ~line 631), threat model (~153), owner values (~211), Q5
  topology (~858), Q6 function engine (~1033), Q7 credentials (~1187), Q8
  (~1353), Decision outcome (~1448), Consequences (~1565).
- `docs/features/instance/containers-design.md` — containers design; keyed
  job rules (~1253), streams/bus contract (~434), rollout sequences
  (~650), rollback/maintenance (~1010), Valkey persistence (~1452),
  operator configuration (~1481).
- `docs/charters/instance-1.md` (this worktree) — outcome 6, lines 91-95.
- `src/runtime/container/types.ts` (this worktree) — Motor's Docker IPC
  and credential delivery.

External sources, grouped by lane (all read 2026-10-13):

**Windmill:**

- https://www.windmill.dev/docs/advanced/self_host
- https://www.windmill.dev/docs/core_concepts/jobs
- https://www.windmill.dev/docs/flows/architecture
- https://www.windmill.dev/docs/flows/flow_approval
- https://www.windmill.dev/docs/flows/sleep
- https://www.windmill.dev/docs/flows/custom_timeout
- https://www.windmill.dev/docs/flows/retries
- https://www.windmill.dev/docs/advanced/security_isolation
- https://www.windmill.dev/docs/advanced/scaling
- https://www.windmill.dev/docs/advanced/high_availability
- https://www.windmill.dev/docs/advanced/instance_settings
- https://www.windmill.dev/docs/core_concepts/worker_groups
- https://www.windmill.dev/docs/core_concepts/dedicated_workers
- https://www.windmill.dev/docs/core_concepts/agent_workers
- https://www.windmill.dev/docs/core_concepts/concurrency_limits
- https://www.windmill.dev/docs/core_concepts/variables_and_secrets
- https://www.windmill.dev/docs/core_concepts/workspace_secret_encryption
- https://www.windmill.dev/docs/core_concepts/versioning
- https://www.windmill.dev/docs/core_concepts/draft_and_deploy
- https://www.windmill.dev/docs/core_concepts/staging_prod
- https://www.windmill.dev/docs/core_concepts/webhooks
- https://www.windmill.dev/docs/core_concepts/caching
- https://www.windmill.dev/docs/core_concepts/critical_alerts
- https://www.windmill.dev/docs/core_concepts/job_debouncing
- https://www.windmill.dev/docs/enterprise/plans_details
- https://www.windmill.dev/pricing
- https://www.windmill.dev/docs/advanced/clients/ts_client
- https://www.windmill.dev/docs/script_editor/perpetual_scripts
- https://registry.npmjs.org/windmill-client
- https://github.com/windmill-labs/windmill (repo + api.github.com metadata)
- https://github.com/windmill-labs/windmill/blob/main/LICENSE
- https://github.com/windmill-labs/windmill/blob/main/docker-compose.yml
- https://github.com/windmill-labs/windmill/blob/main/backend/src/monitor.rs
- https://github.com/windmill-labs/windmill/blob/main/backend/src/stranded_jobs.rs
- https://github.com/windmill-labs/windmill/blob/main/backend/windmill-common/src/worker.rs
- https://github.com/windmill-labs/windmill/blob/main/backend/windmill-common/src/jobs.rs
- https://github.com/windmill-labs/windmill/blob/main/backend/windmill-queue/src/jobs.rs
- https://github.com/windmill-labs/windmill/tree/main/backend/windmill-worker/nsjail
- https://github.com/windmill-labs/windmill/blob/main/backend/windmill-worker/src/common.rs
- https://github.com/windmill-labs/windmill/blob/main/backend/windmill-worker/src/python_executor.rs

**Temporal:**

- https://docs.temporal.io/workflow-execution
- https://docs.temporal.io/workflow-execution/limits
- https://docs.temporal.io/activity-execution
- https://docs.temporal.io/retry-policies
- https://docs.temporal.io/develop/typescript/workflows/timers
- https://docs.temporal.io/develop/typescript/workflows/message-passing
- https://docs.temporal.io/develop/typescript/workflows/continue-as-new
- https://docs.temporal.io/develop/typescript/workflows/versioning
- https://docs.temporal.io/develop/typescript/activities/timeouts
- https://docs.temporal.io/develop/typescript/activities/asynchronous-activity
- https://docs.temporal.io/develop/typescript/workers/index
- https://docs.temporal.io/develop/typescript/workers/run-process
- https://docs.temporal.io/develop/worker-performance/configuration
- https://docs.temporal.io/develop/worker-performance/task-queues
- https://docs.temporal.io/develop/safe-deployments
- https://docs.temporal.io/develop/typescript/client/temporal-client
- https://docs.temporal.io/encyclopedia/detecting-activity-failures
- https://docs.temporal.io/encyclopedia/workers/task-queues
- https://docs.temporal.io/encyclopedia/workers/worker-versioning
- https://docs.temporal.io/encyclopedia/workflow/patching
- https://docs.temporal.io/encyclopedia/workflow/workflow-execution-limits
- https://docs.temporal.io/encyclopedia/retry-policies
- https://docs.temporal.io/worker-versioning
- https://docs.temporal.io/patching
- https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning/index
- https://docs.temporal.io/production-deployment/worker-deployments/kubernetes-controller
- https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers/index
- https://docs.temporal.io/production-deployment/data-encryption
- https://docs.temporal.io/self-hosted-guide
- https://docs.temporal.io/self-hosted-guide/deployment
- https://docs.temporal.io/self-hosted-guide/embedded-server
- https://docs.temporal.io/self-hosted-guide/checklist
- https://docs.temporal.io/self-hosted-guide/visibility
- https://docs.temporal.io/self-hosted-guide/defaults
- https://docs.temporal.io/self-hosted-guide/security
- https://docs.temporal.io/self-hosted-guide/production-checklist
- https://docs.temporal.io/evaluate/features/cloud-vs-self-hosted
- https://docs.temporal.io/evaluate/features/cloud-vs-self-hosted-features
- https://docs.temporal.io/temporal-service
- https://docs.temporal.io/task-queues
- https://docs.temporal.io/pricing (temporal.io/pricing)
- https://github.com/temporalio/temporal (+ releases)
- https://github.com/temporalio/sdk-typescript (+ releases)
- https://github.com/temporalio/ui (+ releases)
- https://github.com/temporalio/samples-server/blob/main/compose/docker-compose.yml
- https://github.com/temporalio/samples-server/blob/main/compose/README.md
- https://registry.npmjs.org/@temporalio/worker

**Our own / platform components (licence + docs):**

- https://github.com/valkey-io/valkey/blob/unstable/COPYING
- https://github.com/valkey-io/valkey (LICENSES/ + REUSE.toml via gh api)
- https://github.com/redis/redis (metadata, for the AGPL contrast)
- https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE
- https://github.com/openbao/openbao/blob/main/LICENSE
- https://github.com/hashicorp/vault/blob/main/LICENSE
- https://www.postgresql.org/about/licence/
- https://github.com/k3s-io/k3s/blob/main/LICENSE
- https://github.com/fluxcd/flux2
- https://github.com/kubernetes/kubernetes
- https://github.com/bank-vaults/bank-vaults
- https://github.com/bank-vaults/vault-env
- https://github.com/cloudflare/workerd/blob/main/LICENSE
- https://kubernetes.io/docs/concepts/workloads/controllers/job/
