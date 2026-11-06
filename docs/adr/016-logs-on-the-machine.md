# ADR-016: The logs of every module stay on the machine and are read in the loader

Date: 2026-11-07. Task: lifemodel-vbog.3 (observability-1, O1).

## Status

Proposed. The owner fixed the direction on 2026-11-07 and it is not reopened
here: Vector reads every pod's log files on the node and normalizes them;
VictoriaLogs stores them on the machine; the loader reads them through one
adapter on a logs page behind its login; every pod is collected and task pods
are marked untrusted; retention is a loader setting, 14 days or 5 GiB, whichever
comes first; the upstream `errorExcerpt` leaves the logs and stays in the
exchange capture; logs are read like conversations; nothing leaves the machine.

This record proves the direction on a throwaway k3s in one VM and states the
design. Every number below is measured there unless it is marked
*inherited* (taken from an existing document or an earlier decision) or
*not measured*. It is not deployed acceptance: no check in `tests/` and no
walk on the owner's machine has run for it yet.

Measurement host: Ubuntu 24.04 VM, 4 CPUs, 11 GiB RAM, 36 GiB free of 38 GiB,
k3s `v1.35.8+k3s1` (the version `scripts/install.sh` pins), Vector
`0.61.0` (`docker.io/timberio/vector@sha256:f6c23b5a7e16fb2838d33619ef7acf4bad2289a7cf22bc90efc2371f520c4ea2`)
and VictoriaLogs `v1.53.0` (`docker.io/victoriametrics/victoria-logs@sha256:251121fa882af99b95ba0c230a4a2f412ea602d2698c64a96c58dc9842bb755d`).
The prototype manifests are throwaway and stay outside the repository.

## Context and problem

Today a module's log is its container's stdout. `src/core/logger.ts` writes
pino to stdout and to `data/logs/agent-<timestamp>.log`; `loader/src/logger.ts`
writes one JSON line with `component: 'loader'`; the model gateway, the storage
module and the task launcher all run the loader image and therefore all say
`component: 'loader'`. A person reads a failure with `kubectl logs <pod>`, and
the lines are gone when the pod is replaced. O1 (`docs/charters/observability-1.md`)
records exactly that: "Today a failure is found by reading each pod's stdout
with kubectl, and those logs are lost when the pod restarts."

Three further problems follow from it:

- one chat message cannot be followed through the core to the gateway, because
  no log line carries the conversation: the core names it only in the
  `x-lifemodel-session` header it sends to the gateway
  (`src/config/model-endpoint.ts`), and the gateway logs `taskContext` and the
  slot but not that header;
- a refused upstream answer is diagnosed from `errorExcerpt`, the first bytes of
  a model's response body (`loader/src/model-gateway-response.ts`,
  `loader/src/model-gateway-app.ts:857,891`). That puts a model's own words into
  the platform's log stream, which is the stream that now leaves each pod
  and rests on a node's disk; the exchange capture
  (`observability.model_exchanges`, ADR-013/`deploy/platform/README.md`) already
  stores the body for as long as the owner enabled it, and it is off by default;
- the core's stdout is not JSON in the cluster. `createLogger` defaults
  `pretty: true` (`src/core/logger.ts:32`, `src/config/config-schema.ts:252`)
  and the container passes the stored setting through
  (`src/core/container.ts:590`), so `NODE_ENV=production` changes only the file
  target: the container's stdout is pino-pretty text with ANSI colour today.

## Decision drivers

The nine scenarios O1 promises (charter: "Check"), each with the measurement
this record uses. "Measured" means the prototype above; the scenario's check
runs them again on the owner's machine.

| # | Scenario | Measure of acceptance |
| --- | --- | --- |
| 1 | A planted model failure and a restart of the failing module: found by time and conversation with no kubectl | One page query by the failure's minute and its conversation returns the gateway's line: `module=model-gateway`, `level=error`, `error.type`, `reason.check`, `reason.path`, `reason.got`; the module's replacement pod's line after the restart is in the same answer; zero shell commands. Basis: the store keeps the previous pod's lines (2,000 of 2,000 measured through a pod deletion) and query latency at 5.3 GiB stored is p95 193 ms for a module and 1.72 s for a conversation (measured) |
| 2 | Core and chat stopped: the page answers | The page's API answers from the loader pod alone. The loader has no route to the core or the web module, and the store has no route to either (its only peers are the loader and the collector, §7) |
| 3 | No login: page and API refuse | Every logs route answers 404 on any other host and refuses without a session, like the rest of the loader's table (ADR-012 §4) |
| 4 | Every module appears and each of four filters narrows | Every platform workload's pod carries a label the collector turns into `module` (§2, measured for `app.kubernetes.io/name`, `app`, `cnpg.io/cluster` and the no-label fallback); each of the four filters changes the answer and is timed: a 1-hour window, one module of 20, one level of 6, one conversation of 2,000, over 4.8 M records — p95 356 ms, 193 ms, 191 ms, 1.72 s (measured) |
| 5 | A marker value in an upstream response appears nowhere in the logs and the reason reads as field and type | A marker planted in a refused upstream body is absent from a full-store text search, and the failure line carries `error.type` with `reason {check, path, got}`, where `got` is a JSON type name only (the field set is §9 point 5; the search is a check, L03) |
| 6 | Over the bound: oldest go, the platform is not hurt | Old per-day partitions are dropped; the two last days are kept; the other modules keep running. Measured: a 600 MiB flood into a 300 MiB bound dropped the 10-day-old canary partition and every older day of a second flood, kept today's 357,400 records, and the platform's pods were untouched (measured) |
| 7 | Collector or store down: modules run on, the page says unavailable, never an empty list | Writers notice nothing; no line is lost in a 5-minute store outage (945 of 945 measured) and none duplicated in a 5-minute collector outage (1,327 of 1,327 measured); the page reports the store as unavailable with its reason, never `[]` |
| 8 | Nothing leaves the machine, by observed egress | A 10-minute capture of both pods: destinations are the cluster DNS, the Kubernetes API and the store, nothing else (§8, measured) |
| 9 | A flood or forged fields from a task pod: the module comes from Kubernetes | A line that carries `module`, `level` or `untrusted` cannot set them: the stored record's `module` is the pod's label and `untrusted=true` for `lifemodel-motor` (measured); a 500,000-line, ~500 MB burst loses nothing (measured) |

Constraints that bound every option, with their source:

- **The page is part of the loader's own login and works when a generation is
  broken** (O1; ADR-012 §4, §6: the loader's interface is baked into the loader
  image, `boot-<name>.local` routes to the loader without ForwardAuth).
- **Nothing leaves the machine** (P2; O1 Out: "Anything that sends logs,
  traces or metrics off the machine").
- **No vendor name in generic code; registries and endpoints are loader
  settings** (P11, P12; `scripts/check-vendor-names.mjs`).
- **The platform artifact is pinned by digest and applied in ordered steps;
  a step that waits on something later deadlocks** (ADR-010;
  `deploy/platform/README.md`).
- **A module is its own process, ServiceAccount and listener, and holds its own
  credentials** (ADR-015 S-D1; `deploy/platform/README.md` step D).
- **A source or test file cannot grow past its recorded size** (observability-1
  O3, lifemodel-5zoc; `scripts/check-file-sizes.mjs`, limit 800 lines).
- **The owner's machine is one 35 GiB disk with 6.3 GiB free** (the
  coordinator's measurement on the test machine, 2026-11-07; *not measured
  here*, and the target's size is recorded nowhere in the repository).
- **An idle platform writes about 16 MB of raw log files a day: 10,928 bytes a
  minute over 150 s with 26 pods, no conversation and no task** (measured on
  the test machine, 2026-11-07). It is an idle figure; nothing is known under
  load.


## Considered options

- **Loki, or another store that fits filesystems loosely.**
  Rejected: it has no size bound to set, its filesystem store is unsupported by
  Grafana for production, it reports usage to Grafana unless configured
  otherwise, and it is AGPL (the coordinator's findings, *inherited*). The owner's direction needs a bound and needs
  nothing to leave the machine; VictoriaLogs gives both, under Apache-2.0.
- **vlagent as the collector.**
  Rejected: its transforms are not confirmed, so normalization (module, level,
  ANSI, conversation, untrusted) would move into the loader at query time. The
  page would then filter raw text and the "one shape of record" would stop at
  the store's edge. Vector's `remap` transform does the whole normalization in
  one place, at one VRL program, and is open source (*inherited*: Vector is
  MPL-2.0, VictoriaLogs Apache-2.0;
  Vector is owned by Datadog and is 0.x). The seam of one plain HTTP protocol
  between collector and store (§3) is what answers the risk of that ownership:
  either side can be replaced without the other and without the loader.
- **No store: keep the kubelet's files and read them on demand.**
  Rejected: the files are lost when a pod is deleted (measured: the same
  deletion that kept 2,000 ingested lines left nothing to read for a pod the
  collector had not yet read, §6), the kubelet keeps 5 × 10 MiB per container,
  and every page view would scan files.
- **The loader reads through the Kubernetes API with no collector.**
  Rejected: it keeps the restricted Pod Security policy, but the loader becomes
  the log system — one process must stream every pod, hold the buffers and
  serve the page — and lines are lost whenever the loader is down, which is
  exactly when the owner is repairing something (O1 scenario 2). The collector
  must be the only reader of `/var/log/pods`, and the store must be reachable
  when the loader restarts.

## Decision

### 1. What runs where: one collector per node, one store, no gate on the platform

- **Collector.** `logs-collector` is a DaemonSet of the Vector image in its own
  namespace `lifemodel-logs` (created by `platform-instance`, the only
  Kustomization that owns namespaces, ADR-012 §1), pinned by digest in the
  signed platform artifact.
  It mounts `/var/log/pods` read-only and its own data directory (checkpoints)
  read-write on the node's disk, at `/var/lib/lifemodel-logs-collector`, and
  nothing else. Its container runs uid 0 with every capability dropped,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `seccompProfile: RuntimeDefault` and no `privileged` flag (§7 states why root
  and why the namespace's Pod Security is an exception).
- **Store.** `logs-store` is a single-replica Deployment with `Recreate`
  strategy in `lifemodel-system`, the VictoriaLogs image pinned by digest, its
  own ServiceAccount, one retained `local-path` PVC and one HTTP listener. It
  is a platform module in the sense of ADR-015 S-D1: own ServiceAccount, own
  NetworkPolicy, no key of any other module, no caller-facing credential. The
  loader's keyless HTTP client is its only reader (§4); the collector is its
  only writer (§8).
- **Reconciler order.** Two new Flux steps in the same signed artifact,
  `platform-logs-store` and `platform-logs`, both with
  `dependsOn: [platform-instance]` and on nothing else. No other step depends
  on either, and the root Kustomization does not add them to its health checks.
  The store needs only a namespace that `platform-instance` already owns and
  its volume; the collector needs only its namespace and its ServiceAccount.
  Neither reads Postgres, OpenBao or the API server's CRDs, so neither can be
  held by a later step:
  - a failing store holds only its own step, which Flux retries on its
    interval; the collector step still reconciles and still collects (measured:
    the collector stayed ready and lost nothing through a 5-minute store
    outage, §6);
  - a failing collector holds only its own step; the store still serves what it
    has;
  - the loader, core, web, tasks and the installer's wait (ADR-012 §8, which
    waits only for the loader's `/api/state`) touch neither step. Putting the
    store in A or D would have made the platform's start wait for a log store,
    and putting either in a step that waits on C or D would deadlock when the
    database is being repaired — the case in which the owner most wants logs.
- **A second platform workload in `lifemodel-system` inherits none of the
  loader's permits** (ADR-012 §4, ADR-013 D5, *inherited*): `logs-store-access`
  is its own policy, §7.


### 2. One record shape, decided by the collector from Kubernetes metadata only

The collector emits one normalized record per line. The VRL program
(`remap`) runs in the collector, before the store, so the store's fields are
the contract and the page has nothing to parse.

| Field | Source | Rule |
| --- | --- | --- |
| `module` | Kubernetes pod label | `app.kubernetes.io/name`, else `app`, else `k8s-app`, else `cnpg.io/cluster`, else `unknown`. Never the line. Every platform workload carries one of these (*inherited*: core, web, loader, model-gateway, storage-module, zot, gitea, openbao, seaweedfs, traefik use `app.kubernetes.io/name`; valkey uses `app`; the CNPG instance's pods use `cnpg.io/cluster`, *inherited* from CNPG's convention and not measured here, because the prototype has no CNPG; k3s's CoreDNS uses `k8s-app`, *inherited* from the k3s manifest) |
| `namespace`, `pod`, `container`, `node`, `stream` | Kubernetes metadata | as the kubelet and the API give them |
| `level` | the line, unified | pino numbers 10–60 → `trace`/`debug`/`info`/`warn`/`error`/`fatal`; text words `trace|debug|info|warn|warning|error|err|fatal|critical|panic` → the same set; anything else, and any line without a level, is `unknown`. The numeric and word maps are equal for both structured and unstructured lines |
| `conversation_id` | the line, when present | the JSON field `conversation_id`; unset otherwise. It is a field, never a stream, so it does not multiply streams |
| `untrusted` | Kubernetes metadata | `true` for `namespace == lifemodel-motor` (ADR-014: the whole task pod is one untrusted zone), `false` otherwise |
| `message` | the line | with ANSI escape codes stripped, so a pino-pretty line is readable as text and searchable |
| `_time` | the kubelet's CRI timestamp | the record's time; the line's own time field is left in the message text |

Measured on the prototype: a pod writing `{"module":"forged-module","level":"error",...}` stores
`module="writer-forged"`, `level="error"` (from the line's level, which is
allowed) and no `module` from the line; the same pod in `lifemodel-motor` stores
`untrusted="true"` and `module="writer-task"`; a pino-numbered line stores
`level="info"`/`level="error"` for 30/50; `INFO` text stores `info`; a
`not-a-level` value stores `unknown`; a coloured pino-pretty line stores
`INFO [21:39:31.000] pretty line 477` with no escape bytes; the JSON field
`conversation_id` appears as a field. The label chain was measured too: a pod labelled
only `app: valkey-like` stores `module="valkey-like"`, one labelled only
`cnpg.io/cluster: lifemodel` stores `module="lifemodel"`, and one with no label stores
`module="unknown"` with its `pod` and `namespace` intact.

`errorExcerpt` is not carried into any field. §9 point 5 says what replaces it.

### 3. The seam: one plain HTTP protocol, one JSON object per line

The collector POSTs newline-delimited JSON to the store's
`/insert/jsonline?_stream_fields=module,namespace,level,untrusted` with gzip and
`Content-Type: application/stream+json`; batches of 2,000 events or one second,
memory buffer. Measured ingest through that path: 5 GiB of records in 79.6 s (67.5 MB/s) and 6 GiB of incompressible records in 486 s (13.3 MB/s,
store CPU-bound while compressing on 4 cores). The store answers 200 on
success and 429 when it is in read-only mode (§6).

Why this seam matters: neither side needs the other's API. Replacing the
collector is a new process that writes the same JSON; replacing the store is a
new process that reads the same JSON and answers the two query endpoints below.
The loader never speaks the insert protocol and the collector never speaks the
query protocol.

### 4. Reading: one adapter in the loader, one page on the loader's host

- **The adapter** is `loader/src/logs-query.ts`: the only code in the platform
  that builds LogsQL and the only code that calls the store. It exposes four
  filters — a time range, `module`, `level`, `conversation_id` — plus a text
  search on `message`, a bounded page size and a cursor on `_time`. It sends
  `POST /select/logsql/query` (JSON lines out), `GET /health` for availability
  and `GET /metrics` for one gauge (`vl_free_disk_space_bytes`, §5), and
  nothing else. No route passes a caller's
  query string through: the page's fields become field filters with quoted,
  escaped values, so the loader's login is the only authority and LogsQL is
  never an interface to the owner's browser.
- **Unavailable is an answer, not an empty list.** If the store does not answer
  within 5 s, or answers 5xx, the adapter returns
  `{state: "unavailable", reason: <code>}` (measured reasons in the prototype:
  connection refused during a rollout, 429 while read-only, 200 with 0 rows
  only when the store really holds no matching line). The page shows the
  reason; it never renders an empty table for a failed query.
- **The page** is `web/loader/src/Logs.tsx` behind the loader's login on
  `boot-<name>.local/logs`, reached from the settings page. It reuses the kit
  components and the i18n pattern: a filter row (time range, module, level,
  conversation, text), the newest-first list, one expanded record with every
  field, and "unavailable" with the reason. "Read like conversations" is the
  reading shape of the chat's transcript: time on the left, module and level as
  chips, the message as the body, fields behind a disclosure; no raw JSON view
  by default.
- **Routes** are `GET /api/logs` (query), `GET /api/logs/modules` (the module
  list for the filter, from the store's `module` values) and
  `GET`/`PUT /api/logs/settings` (the retention setting, §5). They are added to
  the loader's route table exactly as ADR-012 §4's table requires: on
  `boot-<name>.local` only, `GET` and `PUT` only, `PUT` with a session, the CSRF
  token header and an exact Origin, `no-store`, CSP and `nosniff` as the
  existing API routes.
- **Where the code goes, given the file-size limit.** `loader/src/http.ts`
  (1,512 lines, recorded) and `web/loader/src/App.tsx` (1,310 lines, recorded)
  cannot grow by one line. The logs work therefore lands in new files —
  `loader/src/logs-query.ts`, `loader/src/logs-settings.ts`,
  `loader/src/logs-routes.ts` (the route table and handlers),
  `web/loader/src/Logs.tsx`, `web/loader/src/logs-i18n.ts` — and `http.ts`
  *shrinks*: its hard-coded `bootRouteAllowed` list and the `/api/*` method map
  move into `logs-routes.ts`'s table (other routes included), so the new routes
  are declared where the table already is. `App.tsx` gains the navigation text
  through `logs-i18n.ts` and one import, and loses as much as it gains; if it
  cannot, the logs page is reached by path and the App change waits for the
  split the O3 rule implies.

Measured query cost at 5.3 GiB stored (4,800,923 records), 40 queries per
filter through the same HTTP client the adapter uses:

| Filter | p50 | p95 | max |
| --- | --- | --- | --- |
| a 1-hour window of 14 days | 304 ms | 356 ms | 432 ms |
| `module=gateway` (1 of 20) | 170 ms | 193 ms | 241 ms |
| `module=gateway AND level=error` | 157 ms | 191 ms | 198 ms |
| `conversation_id=conv_000123` (1 of 2,000) | 1,294 ms | 1,721 ms | 1,919 ms |

The conversation filter is the slowest because `conversation_id` is neither a
stream field nor a small set; at 5 GiB it scans. It is inside the page's 5 s
deadline, and it is the number to watch when the store grows. Making it a
stream field would cut it and multiply streams by the number of conversations —
not worth it. *Not measured:* latency at the 5 GiB bound with the owner's mix
of modules; the figure above is a synthetic distribution.


### 5. The setting: 14 days or 5 GiB, owned by the loader

The setting is `logs.retention` (`{days, maxBytes}`), stored in
`/var/lib/loader/logs.json` with `{version, days, maxBytes, appliedAt}` and
published into the platform's existing settings projection: ConfigMap
`lifemodel-system/lifemodel-logs-settings`, the same mechanism as
`lifemodel-storage-settings` (ADR-014 D6, `deploy/platform/a/loader-settings-rbac.yaml`,
*inherited*: `get`/`update` on that one name, `create` clamped by A0 admission
to the fixed names). Two keys: `VL_retentionPeriod` and
`VL_retention_maxDiskSpaceUsageBytes`.

The store reads them through VictoriaLogs's environment-flag mode, measured:
with `-envflag.enable`, env `retentionPeriod=3d` and
`retention_maxDiskSpaceUsageBytes=123MiB` produce `-retentionPeriod="3d"` and
`-retention.maxDiskSpaceUsageBytes="123MiB"` in the process's own flag dump.
The underscore stands for the dot, and the flags are still startup flags.

**How a change reaches the store.** The loader writes `logs.json`, then the
ConfigMap, then bumps the annotation
`lifemodel.dev/logs-settings-revision` on the pod template of
Deployment `logs-store`; `Recreate` replaces the single pod, which starts with
the new flags. The loader reports "applied" only when the new pod is Ready and
its `/health` answers, and "pending" otherwise, so the page never shows a value
the store is not running. Measured on a 1 GiB store: the pod stops answering
2.6 s and 3.7 s after the patch in two runs, is Ready again at 3.0 s and
4.6 s, and the store itself opened its data in 0.041 s and 0.083 s — the wait
is Kubernetes' delete-then-create, not the store's recovery. A shrinking
`retentionPeriod` also evicts on the next start (measured: 962 MB → 663 MB when
14 d became 7 d).

**New, narrow rights.** Two, both on fixed names in `lifemodel-system`:
`get`/`update` on ConfigMap `lifemodel-logs-settings` (inside the existing
settings Role) and `get`/`patch` on Deployment `logs-store` — the patch exists
only to set that one annotation, so a ValidatingAdmissionPolicy in A0 clamps the
patch to `metadata.annotations` and `spec.template.metadata.annotations` of
that Deployment and refuses any other field. Nothing else: the loader cannot
read the store's data, write its volume, or change its image. The annotation is
deliberately *not* declared in the release manifest, so Flux's server-side
apply does not own it and does not revert the loader's bump; a check asserts the
manifest does not declare it.

**What happens when the loader is down or the change is refused.** Collection,
storage and the last applied retention keep working; nothing in the store waits
for the loader. A stored `logs.json` whose apply did not finish is reconciled at
the loader's next start, and the page shows "pending" with the reason
(`store_unavailable`, `rollout_timeout`, `forbidden`). The setting is never
applied from the owner's browser directly: the page writes the loader's file,
the loader writes the cluster.

**The default and the risk on a small disk.** The default is 14 days and
5 GiB, as the owner set it. The store's byte bound is not a quota: measured, a
300 MiB bound let the store reach 491 MiB because VictoriaLogs keeps at least
the two last days whatever the bound says (its documentation states the same,
and that the disk can reach 100 % between two checks). A store whose filesystem
fills up panics on the first write it cannot complete (measured:
`FATAL: cannot write ... no space left on device`, exit code 2, restart) and
then serves reads and refuses writes with `429 cannot add rows into storage in
read-only mode` (measured) until space is freed — it does not evict to recover.

On the owner's machine, 6.3 GiB are free and the bound defaults to 5 GiB. The
answer in this design is threefold and it is a requirement, not advice:

1. the bound is a loader setting whose default the owner can lower from the
   page before the first heavy day;
2. the loader computes the setting it publishes as
   `min(maxBytes, free_space_on_the_store_volume − 2 GiB)` at apply time,
   states the effective value in the page next to the chosen one, and says
   `disk_headroom_low` when the effective bound is below the chosen one. It
   asks the store's volume for its free bytes through the store's own
   `/metrics` (`vl_free_disk_space_bytes`, measured present), one of the three
   calls the adapter makes (§4), so no new right or component is added;
3. a check on the test machine fills the store past its bound with the
   machine's own free space and requires the platform's other modules to keep
   running and the page to keep answering (scenario 6).

The risk that remains, stated plainly: **the 5 GiB default is not a hard disk
quota, and on a machine with 6.3 GiB free the newest two days of logs plus the
platform's other stores can fill the filesystem before retention reclaims
anything.** Nothing in this design prevents that; the read-only mode and the
headroom rule detect and bound it.

### 6. Bounds and failure behaviour, measured

| Event | What was measured |
| --- | --- |
| Bound passed within the last two days | No eviction. 600 MiB of today's records into a 300 MiB bound: usage 444 MiB, every record kept |
| Bound passed with older partitions present | Oldest partitions dropped: the canary partition from 10 days ago and every day of a second flood older than the newest survived day were dropped (38,277 records left of a 10-day flood), today's 357,400 untouched, usage 491 MiB |
| Volume full (574 MiB, 1.5 GiB offered) | `panic: FATAL: cannot write ... no space left on device`, container exit 2, restart; after restart: 423,500 rows readable, writes refused with 429 read-only. After the volume was grown: restart, all 423,500 rows kept, writes accepted (200) |
| Store down 5 minutes | Writers unaffected; Vector stayed ready, memory 73 → 80 MiB for the 700 buffered records; after the store returned the backlog was in the store within ~10 s; 945 of 945 lines present, no gap |
| Collector down 5 minutes | 1,327 of 1,327 lines present after restart, no gap, no duplicate (checkpoints on the node's disk); a pod deleted during the outage lost all 100 of its lines because the kubelet removed its directory before the collector returned |
| A module restarted (pod replaced) | The previous pod's lines stay; a new pod's lines appear under the same `module` |
| A 500,000-line burst (~500 MB in ~25 s, two kubelet rotations) | 500,000 records stored, none missing |
| Store restart on a retention change, 1 GiB store | 2.6 s / 3.7 s without an answering endpoint; healthy at 3.0 s / 4.6 s |

The collector's buffer is a memory buffer of 500,000 events; the 5-minute
outage above never came near it (about 700 events). **Not measured:** behaviour
at the buffer's bound, and what the sink does when the buffer is full — the
configuration says `when_full: block`, which back-pressures the file readers
and, with kubelet's 5 × 10 MiB per container, loses the oldest lines rather
than blocking the pod. The check for scenario 7 must reach it with a bounded
fixture (see L07 below) or say it did not.


### 7. Network and the one Pod Security exception

- **Collector namespace `lifemodel-logs`**: default-deny ingress and egress as
  its own object, plus one permit list: DNS to kube-dns (UDP and TCP 53), the
  Kubernetes API on TCP 6443 (the platform's any-address exception, ADR-010:
  k3s DNATs the API Service to the node address, and Vector reads Pods and
  Nodes for metadata), and TCP 9428 to `logs-store`'s pods in
  `lifemodel-system`. No ingress at all — the kubelet's probes come from the
  node, not through pod networking. The ServiceAccount is read-only —
  `get`/`list`/`watch` on `pods`, `namespaces` and `nodes`, and nothing else
  (measured: `kubernetes_logs` needs all three; without `nodes` it logs
  `cannot list resource "nodes"` and fails to annotate every event).
- **Store**: `logs-store-access` admits 9428 from the collector's pods and from
  the loader's pods, and nothing else; `logs-store-deny` denies the rest. Its
  egress is empty — measured: VictoriaLogs connects to nothing, and the deny
  policy changes nothing about ingestion or queries (the store answers both
  through its listener with all egress denied).
- **The loader's own policy** gains one destination: TCP 9428 to
  `logs-store`'s pods (*inherited* from `loader-access`, ADR-012: a second
  platform workload inherits none of it, so the store gets its own policy and
  the loader gets one more line).
- **Pod Security is an exception, stated.** The collector's namespace enforces
  the `privileged` level. Measured reasons, in this order:
  - `restricted` rejects the pod three times over: `runAsNonRoot != true`,
    `runAsUser=0`, and a `hostPath` volume (restricted volume types);
  - `baseline` rejects it too: `hostPath volumes (volume "logs")` and
    `non-default capabilities (container ... must not include "DAC_READ_SEARCH")`.
    A `hostPath` volume is forbidden at `baseline`, so *no* level below
    `privileged` can mount `/var/log/pods`;
  - the least-privilege alternative, a non-root user with
    `CAP_DAC_READ_SEARCH`, does not work: measured `CapBnd=0x4` but
    `CapPrm=CapEff=CapAmb=0` after exec, so `ls /var/log/pods` is
    `Permission denied`. The capability is not ambient across `exec` in
    Kubernetes' default (`containerd` sets no ambient set).
  - what does work is uid 0 with every capability dropped: measured
    `CapInh=CapPrm=CapEff=CapBnd=CapAmb=0`, `/var/log/pods` `0750 root:root`
    and `0.log` `0640 root:root` both readable, because root owns the files.
    The pod keeps `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`,
    `seccompProfile: RuntimeDefault`, a read-only `/var/log/pods` mount, and
    exactly one writable path: its checkpoint directory on the node.
  What this exception is *not*: no `privileged: true`, no added capability, no
  host network, no host PID, no Docker socket. The namespace holds one
  workload, and any pod in it is already able to read every line on the node,
  so the exception is bounded by the namespace's single permit list, not by
  the level's name. A `local` PV with a PVC would satisfy `baseline`'s volume
  rule but expose the same node directory to the same uid 0; it adds PV
  provisioning and node affinity for no security gain, so it is not taken.


### 8. Nothing leaves the machine: the observed destinations

`tcpdump` on the node captured every packet of the collector's pod and the
store's pod for 10 minutes with no egress policy in place (the guards came
after, §7). Destinations, by name:

- **the cluster DNS**: `10.43.0.10:53` (the Service) answered by CoreDNS at
  `10.42.0.3:53`. The only questions in the capture were
  `victoria-logs.lifemodel-logs-store.svc.cluster.local` and the resolver's
  search-domain forms of it; the answer was the store's Service address;
- **the Kubernetes API**: `10.43.0.1:443` (the Service) answered from the node's
  address `192.168.5.15:6443`; the ServiceAccount's projected environment
  carries the address, so the API produces no DNS query (measured);
- **the store**: the Service address `10.43.216.105:9428`, DNATed to the store
  pod `10.42.0.39:9428`.

The store pod made no outbound connection at all in the 10 minutes. The capture
also contains the node's own kubelet readiness probes and the VM's
`kubectl port-forward` connections, which come from the node (`10.42.0.1`) and
are not pod egress. A pod without a permit was refused once the deny policies
of §7 were applied (measured: a busybox pod in `default` got `connection
refused` from the store's Service).

That is the whole list: cluster DNS, the Kubernetes API and the store. There is
no public address, no vendor endpoint, no clock service and no telemetry. The
capture is the evidence for scenario 8; the deny policies of §7 then remove
even the possibility of an accidental new destination, since a pod may reach
only those three peers.


### 9. Every module's logging changes

The collector's normalization (§2) fixes the *shape*. Five changes are needed
in the modules themselves so that the shape carries meaning:

1. **The loader image stops saying `component: 'loader'`.** `createStdoutLogger`
   (`loader/src/logger.ts`) and the fatal JSON line in `loader/src/main.ts`
   write `component: 'loader'`; the model gateway, the storage module and the
   task launcher all run the same image (`deploy/platform/README.md`: "the
   loader image with its command overridden"), so today all four claim to be
   the loader. The field is removed from both writers and the module identity
   is the pod's `app.kubernetes.io/name` (§2), which the platform already sets
   per Deployment. A reader's "module" then names the thing that logged, and a
   grep for `component: 'loader'` finds nothing.
2. **The core's stdout becomes JSON in the cluster.** `logging.pretty` defaults
   to `true` (`src/config/config-schema.ts:252`) and reaches `createLogger`
   (`src/core/container.ts:590`), so the container's stdout is coloured
   pino-pretty text. The default becomes `false`; pretty output stays a
   development choice (`LOG_PRETTY`/the stored setting in a non-cluster start).
   The collector no longer has to undo a format for the core
   (`strip_ansi_escape_codes` remains for the pretty lines a *module* may still
   print, measured working, §2).
3. **`conversation_id` reaches the gateway's failure lines through the existing
   `x-lifemodel-session` header.** The gateway already parses it (it fills a
   slot's `{session}` placeholder, ADR-013), so the two failure lines at
   `loader/src/model-gateway-app.ts:857` and `:891` gain
   `conversation_id: <the header value, or absent>`. No new header, no new
   field on the wire.
4. **`conversation_id` reaches the core's turn lines through the turn's trace
   context.** `TraceContext` (`src/core/trace-context.ts`) gains
   `conversationId`, set where a turn's signal is claimed (the conversation is
   the signal's `recipientId`, the same `chatId` the core already passes as
   `sessionId` to the model call), and `createTraceMixin`
   (`src/core/logger.ts:109`) adds it to the keys it copies onto every line.
   One assignment puts the id on the turn's model calls, tool results, warnings
   and outcome lines without editing each call site, and a tick-level context
   has none — the same rule `triggerType` already follows.
5. **`errorExcerpt` leaves the log lines and stays in the exchange capture.**
   The gateway's two failure log lines drop `errorExcerpt`; the field itself
   stays on `GatewayError` for the captured exchange
   (`observability.model_exchanges`, ADR-013) and for nothing else. In its
   place the line carries OpenTelemetry's stable `error.type` — the error's
   code (`bad_response`, `timeout`, `upstream_5xx`, …) — beside the existing
   `reason: RejectReason {check, path, got}` (`loader/src/model-gateway-response.ts`),
   where `got` is a JSON type name and `path` is a JSON path with array
   indexes. A failure therefore reads as "field and type", exactly O1's words,
   and never carries a model's text.


## Consequences

- The owner opens `https://boot-<name>.local/logs` and reads what a module did
  and why, by time, module, level and conversation, with the core and the chat
  stopped, and without a shell. A failure survives the failing module's
  restart: the store holds the previous pod's lines under the same `module`
  (measured).
- `kubectl logs` stops being the way a failure is found. `kubectl` stays the way
  to repair the cluster, and `lifemodel doctor` keeps its own path.
- Logs are kept on the machine by the collector and the store, both pinned in
  the signed artifact. Nothing leaves; §8's capture is the evidence and §7's
  policies are the guard.
- The platform's trusted base grows by one workload that reads every pod's log
  files on the node (`lifemodel-logs`, uid 0, no capabilities, `privileged`
  Pod Security — §7) and by one store pod that has no credential of any other
  module.
- A new failure domain exists that gates nothing: the platform starts, the
  loader answers, and the modules run while either pod is down (§1, §6). In
  exchange, a broken store is invisible to the platform's health *except* on
  the logs page, which says "unavailable" with a reason.
- Measured cost on the test machine: collector 73–82 MiB RSS (26 pods, one
  5-minute outage buffered); store 45 MiB RSS right after a start with 5.3 GiB
  of data, 451–757 MiB while ingesting (observed range), 46 MiB again after a
  restart with the same data (`kubectl top`; up to 3.2 cores while merging on
  4 CPUs). Disk: 5.3 GiB stored
  for 7 GiB of raw JSON records (random text, incompressible), about 0.76
  bytes on disk per byte of raw record — with real log text, which compresses
  better, the same bound holds far more lines (the 5 GiB of highly repetitive
  test records took 4.3 MB).
- The exchange capture is the only place an upstream body is kept, it is off by
  default, it is time-limited and redacted, and it lives in Postgres (ADR-013).
  A failure that needs the body now needs the owner to have enabled the
  capture; that is the price of taking model text out of the log stream.
- The logs page's slowest path is the conversation filter at large volumes
  (p95 1.72 s at 5.3 GiB, measured). If it grows past the page's deadline, the
  fix is a different store or a narrower time window, not a new index in the
  page.
- The gateway, storage module and task launcher lose a field that used to make
  their lines distinguishable in `docker logs`; the pod's own metadata replaces
  it, which is only visible where Kubernetes metadata is joined — i.e. in the
  cluster, not from a bare `docker run`.

## Assumptions, and what would invalidate them

| Assumption | Would be invalidated by |
| --- | --- |
| The kubelet's log files are CRI-framed and survive a pod's deletion long enough to be read; rotated files are kept 5 × 10 MiB per container (`containerLogMaxSize: 10Mi`, `containerLogMaxFiles: 5`, `containerLogMonitorInterval: 10s`, measured) | a k3s or kubelet change to `containerLogMax*`, or a runtime that writes another framing. Check L01/L07 fail |
| The collector can keep up with what the platform writes: 500,000 records in a ~500 MB burst were stored without loss, and idle ingest is ~16 MB a day | a module that writes more per second than the collector reads for longer than the kubelet keeps; then lines are lost at rotation and the buffer bound is reached. L07's burst fixture and L05's bound are the two measurable edges |
| Vector's `kubernetes_logs` keeps its field names (`kubernetes.pod_labels`, `pod_namespace`, …) and its CRI decoder | an upgrade that renames them; the VRL program is one file and the record shape is the contract (L02 fails loudly, not silently: a missing label yields `module=unknown`) |
| VictoriaLogs's retention semantics: at least the two last days are kept whatever the bound says; the bound is checked periodically; a full volume panics and then serves read-only | a version change to those semantics. The pin is a digest; L05/L06 are the checks that fail if the semantics move |
| A `local-path` PVC is a directory on the node's filesystem and does not reserve its size | a storage class that enforces quotas, or a machine where `/var/lib/rancher/k3s/storage` is a separate volume. Then the headroom rule of §5 measures the wrong filesystem and the check must name the right one |
| The store's own free-space metric (`vl_free_disk_space_bytes`) reports the filesystem the store writes to | a deployment where the data path is a bind mount of another filesystem. Then the headroom rule must read the volume, not the store |
| The machine is one disk: 35 GiB with 6.3 GiB free on the test machine, and the target's size is recorded nowhere | a target with more free space (the risk shrinks) or less (the 5 GiB default must be lowered before the first heavy day; L06 fails) |
| The gateway's `x-lifemodel-session` header carries the conversation on every model call the core makes | a new caller of the gateway that sends none; its failures then have no conversation, which is what the current code already does |


## Constraints (closed, each with its check and its fixture)

L01–L12 are the complete additional requirements of this design. A named check
is the target; some of it is repository work still to be written, and the VM
walks run on the test machine from a clean snapshot.

| ID | Requirement / origin | Check and fixture |
| --- | --- | --- |
| L01 | Every pod on the node is collected, including the pods of the platform's own new workloads; a pod without a metadata label is still visible (`module=unknown`, its `pod` and `namespace` named) | VM walk `WALK-LOGS-ALL`: after one idle day, one record from every namespace that has a workload; **26 pods** (*inherited*: measured idle count on the test machine). Repository: the collector's ServiceAccount grants only `get/list/watch` on pods, namespaces and nodes, and the VRL's label chain is asserted in order |
| L02 | The record shape of §2: `module` from Kubernetes metadata only, `level` unified, ANSI stripped, `conversation_id` when present, `untrusted` for `lifemodel-motor` | `tests/unit/logs-record-shape.test.ts` on the artifact's collector config (field list, label chain order, the line-parsed fields are exactly `level`, `conversation_id`, `message`) with **6 sample lines** (pino 30, pino 50 + conversation, plain `WARN`, coloured pretty line, forged `module`/`level`, motor-namespace line). VM walk `WALK-LOGS-SHAPE` stores those 6 and asserts the 6 records |
| L03 | A refused upstream answer puts no value from the body in the logs: the line carries `error.type` and `reason {check, path, got}` only, and the exchange capture holds the body | `WALK-LOGS-MARKER`: a planted **32-character marker** in a model's response body that fails a gateway check; the page's error line names the check, path and JSON type; a text search for the marker over the whole store (**5.3 GiB, 4,800,923 records** in the prototype) returns nothing; `lifemodel doctor exchange <call_id>` shows the body when capture was enabled. Repository: `tests/unit/model-gateway.test.ts` asserts the logged fields and the absence of the excerpt |
| L04 | The page and the API refuse without the loader's login, and the logs routes exist only on the loader's host | `tests/unit/loader-logs-routes.test.ts`: the route matrix — other hosts 404, no session 401, `PUT /api/logs/settings` without CSRF or with a wrong Origin refused, `GET` only where the table says. **3 routes × 5 cases** |
| L05 | The byte bound drops the oldest per-day partitions first, keeps the two last days, and can therefore be exceeded by them; `-retentionPeriod` applies independently | `WALK-LOGS-BOUND`: **300 MiB bound, 600 MiB of today, a 200-record canary 10 days old, a 0.7 GiB flood across 10 days**; assert today's records survive, the canary and older days are gone, the platform's other pods are running, and the usage is reported against the bound |
| L06 | A full volume does not corrupt the store and does not take the platform down: writes are refused, reads continue, and growing the volume recovers every stored row | `WALK-LOGS-FULL`: **574 MiB volume, 1.5 GiB offered, 423,500 rows**; assert the read-only refusal, the row count unchanged, and recovery after the volume grows |
| L07 | A store outage of 5 minutes loses nothing, a collector outage of 5 minutes loses nothing and duplicates nothing, and a pod deleted while the collector is down loses its lines (stated, not prevented) | `WALK-LOGS-OUTAGE`: **5 min store down, 945 lines; 5 min collector down, 1,327 lines; one pod with 100 lines deleted during the collector outage**; assert gap-free line sequences, no duplicates, and the deleted pod's 100 lines absent. Plus one burst: **500,000 lines, ~500 MB**, none missing |
| L08 | The retention setting applies from the loader with the two narrow rights, reports `applied` only after the store runs it, and its page keeps answering while it applies | `WALK-LOGS-SETTING`: **1 GiB store**; change 14 d → 7 d, 7 d → 14 d, 14 d → 10 d; assert the store's own flag dump holds the new value, the page reports `applied`, the unavailability is below 10 s, and a shrinking period evicts on the next start. Repository: the admission clamp on the Deployment patch refuses any field but the two annotation maps |
| L09 | Nothing leaves the machine: the collector and the store reach only DNS, the Kubernetes API and each other | `WALK-LOGS-EGRESS`: a **10-minute** capture with no egress policy, then the deny policies applied and the same capture repeated; assert the destination set is exactly those three and ingest and queries still work under the deny |
| L10 | The page's four filters answer at the store's default bound | `WALK-LOGS-LATENCY`: **5.3 GiB stored, 4.8 M records, 40 queries per filter**; assert p95 below 2.5 s for the conversation filter and below 500 ms for the other three (the prototype's measured values are the baseline, not the limit) |
| L11 | No listed file grows: `loader/src/http.ts` ≤ 1,512 and `web/loader/src/App.tsx` ≤ 1,310 lines, and every new file starts under 800 | `npm run check:file-sizes`; the check is the recorded counts themselves |
| L12 | The collector's namespace is the only `privileged` one, it holds only the collector, and it is stated where a reviewer looks | `tests/unit/platform-pod-security.test.ts`: every namespace manifest in `deploy/platform` is `baseline` or `restricted` except `lifemodel-logs`, which is `privileged` and holds exactly the DaemonSet; the collector's container has no `privileged`, no added capability, `readOnlyRootFilesystem`, and one host path |

## The principles this serves

- **P2 — one owner, his own machine, nothing personal leaves it.** Logs are the
  most personal artefact the platform produces: model prompts, tool output and
  the owner's conversation. They now rest on his disk and nowhere else; §8 is
  the measurement, §7 the guard.
- **P11 — replaceable parts behind a seam; generic code names no vendor.** The
  seam is one plain HTTP protocol with one JSON record shape (§3); the collector
  and the store are each replaceable alone. The loader's adapter and page name
  no vendor: `loader/src/logs-query.ts` speaks "a store" with an endpoint from
  the loader's settings (P12), and the one place a vendor's name may appear is
  the pinned image in the platform artifact — the same rule
  `scripts/check-vendor-names.mjs` already enforces.
- **P12 — registries and endpoints are loader settings.** The store's address
  is a setting, not a constant in the page's code, and retention is the loader's
  setting reached from its own page (§5).
- **P13 — declare the untrusted zone and guard its edge.** The task namespace is
  the untrusted zone; its lines are collected like everything else and marked
  `untrusted=true`, its `module`, `level` and `untrusted` cannot be set from the
  line (§2, measured), and nothing about a task's line grants it anything: the
  page is the loader's, behind its login.

## What it extends and replaces

- **Replaces** the platform's logging surface: today's "a module's log is its
  container's stdout, read with kubectl, gone when the pod is replaced" becomes
  a kept, normalized, queryable stream. The core's `data/logs/agent-*.log` file
  target stays as a local development artefact and is *not* the platform's log
  store; in the cluster the container's stdout is JSON and that is what is kept.
- **Extends ADR-010** (the signed artifact and its ordered steps) with the two
  steps of §1, and its pinning rule with two more digests.
- **Extends ADR-012** (the loader's interface and login) with one page, three
  API routes and one egress line; the page is on the loader's own host behind
  its own session, so a broken generation cannot take it away.
- **Extends ADR-015** (a platform module's shape) with the store's own
  ServiceAccount, NetworkPolicy and volume, and no caller credential.
- **Extends ADR-013** (the model gateway) by removing `errorExcerpt` from its
  log lines and leaving the body in the exchange capture alone.
- **Narrows O2's trace work**: the logs carry the same `conversation_id` the
  trace will carry, and the gateway's failure line is joinable to a call
  without a timestamp guess.


## Acceptance

On the test machine from a clean snapshot, in real browsers (PRA-001):

- **WALK-LOGS-PAGE** — the owner opens `https://boot-<name>.local/logs` in
  Chromium and Firefox, in English and Russian, in both themes, axe-clean: every
  module in the filter, each of the four filters narrowing, one record expanded,
  a range with no match showing an empty answer, and the store stopped showing
  `unavailable` with its reason and never an empty list.
- **WALK-LOGS-FAILURE** (scenario 1) — plant a model failure through the chat,
  restart the failing module, then find the line by the minute and the
  conversation: `module=model-gateway`, `level=error`, `error.type`,
  `reason.check/path/got`, and the module's new pod's line beside it. No
  `kubectl`, no probe.
- **WALK-LOGS-OFF** (scenario 2) — stop the core and the chat; the page still
  answers; without a session it refuses (scenario 3).
- **WALK-LOGS-MARKER** (scenario 5), **WALK-LOGS-BOUND** (6),
  **WALK-LOGS-OUTAGE** (7), **WALK-LOGS-EGRESS** (8), **WALK-LOGS-SHAPE** (9) —
  as the L-table above states them, on the machine, with the fixture sizes
  given.
- **WALK-LOGS-SETTING** — the owner lowers the bound from the page before a
  heavy run, sees `applied`, and the store's own flag dump agrees.

## Open, and what this record does not decide

- **The 5 GiB default on a machine with 6.3 GiB free is the owner's decision
  kept as given.** This record adds the headroom rule and the read-only
  behaviour of §5; whether the default should be lower on a small machine is the
  owner's call, made with the page in front of him.
- **Not measured**, and named so the acceptance does not imply otherwise:
  behaviour at the collector's 500,000-event buffer bound; the page's latency at
  the owner's real module mix; the store's behaviour when its volume fills
  *while the loader is serving a query* (only while writing was measured); the
  memory of the collector under a sustained multi-module burst; and the
  retention change with the store's data exactly at the bound.
- The exact LogsQL the adapter builds is implementation detail; the record
  shape, the four filters and the unavailable-with-reason rule are the
  contract.


## Appendix: how each measured value was produced

All commands ran on the throwaway VM described at the top; throwaway manifests
are under `/work/prototype`, never in the repository.

| Value | Command (shape) |
| --- | --- |
| Pod Security verdicts, capability sets, file permissions | `kubectl apply` of one probe pod per level; `grep -E 'Cap(Inh\|Prm\|Eff\|Bnd\|Amb)' /proc/self/status`; `ls -ld /var/log/pods`; the API server's rejection message |
| CRI decoding, a 20 KB line, rotation, deletion, restart duplicates | one pod writing numbered records; `POST /select/logsql/query` with `conversation_id:"..." \| count()`; `ls -la /var/log/pods/<pod>/<container>/`; `kubectl delete pod`; `kubectl delete pod -l app.kubernetes.io/name=vector` |
| Record shape, forged fields, label chain | six writer pods; the stored records read back with `POST /select/logsql/query`; the VRL program checked in `vector vrl -q -o -i samples.jsonl -p normalize.vrl` before deploying |
| Ingest throughput and query latency | `python3 loadgen.py 6` (6 GiB of random JSON records through `/insert/jsonline`); `python3 latency.py http://127.0.0.1:9428 40` (40 queries per filter, p50/p95/max) |
| Bound and eviction | a store started with `-retention.maxDiskSpaceUsageBytes=300MiB`; `python3 flood.py` (0.6 GiB today, then 0.7 GiB across 10 days); `du -sh /var/lib/vl-bound`; per-day `stats by (_time:1d)` |
| Full volume | a 574 MiB ext4 loop device as the store's volume; `python3 flood.py` until the store writes fail; `kubectl logs --previous` for the panic; `truncate` + `resize2fs` for recovery |
| Store and collector outages | `kubectl scale deploy/victoria-logs --replicas=0` for 5 minutes; `kubectl patch ds/vector` with a node selector that matches no node for 5 minutes; line-set comparison against the pod's own numbering |
| Egress | `tcpdump -i any -n -vv -s0 -w egress2.pcap '(host <collector-pod-ip> or host <store-pod-ip>)'` for 10 minutes; `tcpdump -r ... \| grep 'IP <pod-ip>...[0-9]+ > '` for destinations, and the DNS question lines for names |
| Retention change | `kubectl patch deploy/vl-1g` (the retention argument), health polled at 20 Hz through the Service's ClusterIP, and the process's own flag dump in its startup log |
| Memory | `kubectl top pod` for the store and the collector; the container's `memory.current` for the collector during the outage |
| Env-flag mode | `docker run ... -envflag.enable` with `retentionPeriod=3d` and `retention_maxDiskSpaceUsageBytes=123MiB`, then the startup log's `command-line flags` block |
| kubelet log policy | `kubectl get --raw /api/v1/nodes/<node>/proxy/configz` |
