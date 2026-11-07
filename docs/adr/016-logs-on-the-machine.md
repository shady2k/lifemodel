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

This revision answers the design review of 2026-11-07 (`F1`–`F15`). Every
number below is measured unless it is marked *inherited* (taken from an existing
document or an earlier decision) or *not measured*. Measurements come from two
places, and each figure says which: a throwaway single-node k3s running the
prototype manifests, and pinned-image Docker runs for the parts that need no
cluster (the store's merge behaviour, the record contract, paging and latency).
No machine size is a product figure; an instance's disk size is unspecified.

Every design promise carries either a measurement or a named check, and a check
that cannot be run yet is listed with the stage that runs it. Nothing here is
deployed acceptance: no check in `tests/` and no walk on the owner's machine has
run yet.

Measurement host: Ubuntu 24.04, k3s `v1.35.8+k3s1` (the version
`scripts/install.sh` pins), Vector
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
  `loader/src/model-gateway-app.ts:850,886`). That puts a model's own words into
  the platform's log stream, which is the stream that now leaves each pod and
  rests on a node's disk. It is not one hop but four: the excerpt is logged, it
  is serialised into the error the caller receives (`ownedError`,
  `model-gateway-app.ts:126–144`), the core provider logs the response body and
  builds its error message from it
  (`src/plugins/providers/vercel-ai-provider.ts:950–962,1181–1196`), and
  `src/llm/provider.ts:519–528` logs that message. All four change (§9 point 5);
  the exchange capture (`observability.model_exchanges`, ADR-013) already stores
  the body when the owner enables it, and it is off by default;
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
| 1 | A planted model failure and a restart of the failing module: found by time and conversation with no kubectl | One page query by the failure's minute and its conversation returns the gateway's line: `module=model-gateway`, `level=error`, `error_type`, `reason_check`, `reason_path`, `reason_got`; the module's replacement pod's line after the restart is in the same answer; zero shell commands. Basis: the store keeps the previous pod's lines (2,000 of 2,000 measured through a pod deletion), the failure's own level is `error` (§9 point 6) and the filters answer in 101–176 ms p95 with the adapter's real form at 5.38 GB (measured, §4) |
| 2 | Core and chat stopped: the page answers | The page's API answers from the loader pod alone. The loader has no route to the core or the web module, and the store has no route to either (its only peers are the loader and the collector, §7) |
| 3 | No login: page and API refuse | Every logs route answers 404 on any other host and refuses without a session, like the rest of the loader's table (ADR-012 §4) |
| 4 | Every module appears and each of four filters narrows | Every platform workload's pod carries a label the collector turns into `module` (§2, measured for `app.kubernetes.io/name`, `app`, `cnpg.io/cluster` and the no-label fallback); the filters are timed with the adapter's real query form (window, newest first, page size) at 5.4 GB stored: p95 176 ms for a 1-hour window, 104 ms for a module, 101 ms for module+level, 118 ms for a conversation, 81 ms for a text search (measured, §4). Coverage of every real workload is check L01 |
| 5 | A marker value in an upstream response appears nowhere in the logs and the reason reads as field and type | The value never enters the log stream at any hop: not in the gateway's own line, not in the error envelope it returns, not in the core's two error lines (§9 point 5). The failure line carries `error_type` and `reason_check`/`reason_path`/`reason_got`, promoted by the collector from a trusted namespace only (measured, §2). The marker's absence from the store is check L03, because a marker planted through the real core and gateway needs the deployed build |
| 6 | Over the bound: oldest go, the platform is not hurt | Old per-day partitions are dropped and the two last days are kept: measured with a 300 MiB byte bound, a 10-day-old canary partition and every older day of a second flood were dropped while today's 357,400 records stayed. "The platform is not hurt" is not established by a prototype without the platform: what bounds the platform is the margin of §5 and the throttled untrusted namespace, and both are measured alone (§6) |
| 7 | Collector or store down: modules run on, the page says unavailable, never an empty list | Writers notice nothing in a 5-minute store outage, and the backlog arrived with no gap (945 of 945 measured); a 5-minute collector outage lost and duplicated nothing (1,327 of 1,327 measured). A pod deleted while the collector is down loses its lines (measured: 100 of 100). A crash of the collector with a full buffer is *not measured*: the one run intended for it did not reach the buffer edge (§6), so the page's freshness signal (§4) is what stands for that gap, and check L07 covers it |
| 8 | Nothing leaves the machine, by observed egress | A 10-minute capture of both pods: destinations are the cluster DNS, the Kubernetes API and the store, nothing else (§8, measured) |
| 9 | A flood or forged fields from a task pod: the module and trust come from Kubernetes | A line cannot set `module`, `namespace`, `pod` or `untrusted`: they come from the pod's labels and namespace (measured). It *can* choose its own `level` and `conversation_id`, so every task record is marked `untrusted=true` and a conversation filter's answer marks them (§2). A task pod writing as fast as it can is stored at the throttle's rate: 20,650 stored and 248,883 discarded of 300,000 written in one run, 8,444 and 291,556 in another (§6), while a trusted pod beside it kept all 300 lines (measured) |

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
- **The log store shares one filesystem with the platform's other stores** (a
  `local-path` volume is a directory on the node; §5). An instance's disk size is
  unspecified, so no design figure may depend on one.
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
  signed platform artifact. Requests `cpu: 50m`, `memory: 64Mi`; limits
  `cpu: 1`, `memory: 300Mi` (measured RSS 45–102 MiB with 26 pods and one
  150,000-line/s burst).
  It mounts `/var/log/pods` read-only and its own data directory (checkpoints)
  read-write on the node's disk, at `/var/lib/lifemodel-logs-collector`, and
  nothing else. Its container runs uid 0 with every capability dropped,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `seccompProfile: RuntimeDefault` and no `privileged` flag (§7 states why root
  and why the namespace's Pod Security is an exception).
- **Store.** `logs-store` is a single-replica Deployment with `Recreate`
  strategy in `lifemodel-system`, the VictoriaLogs image pinned by digest, its
  own ServiceAccount, one retained `local-path` PVC and one HTTP listener.
  Requests `cpu: 200m`, `memory: 128Mi`; limits `cpu: 3`, `memory: 1Gi`
  (measured 46 MiB after a restart with 5.3 GiB of data, 451–757 MiB while
  ingesting).
  is a platform module in the sense of ADR-015 S-D1: own ServiceAccount, own
  NetworkPolicy, no key of any other module, no caller-facing credential. The
  loader's keyless HTTP client is its only reader (§4); the collector is its
  only writer (§8).
- **Reconciler order.** Two new Flux steps in the same signed artifact,
  `platform-logs-store` and `platform-logs`, both with
  `dependsOn: [platform-instance]`, on nothing else, and **both with
  `wait: false`**. `wait: false` is what keeps a log pod out of the platform's
  readiness: a Kustomization that a parent applies is itself part of that
  parent's health assessment, and the platform's root runs `wait: true`
  (`deploy/root/kustomization.yaml`), so a child at `wait: true` whose pod
  cannot start would keep the root NotReady. Omitting the step from an explicit
  health-check list does not do this — the parent assesses the child object
  regardless. Check L08 measures this on the deployed build; the prototype run
  that tried to show it did not reconcile its fixtures (see "Not measured").
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
the contract: the page filters on stored fields and parses nothing. Parsing the
line happens in the collector, once, and nowhere else (F5).

| Field | Source | Rule |
| --- | --- | --- |
| `module` | Kubernetes pod label | `app.kubernetes.io/name`, else `app`, else `k8s-app`, else `cnpg.io/cluster`, else `unknown`. Never the line. Every platform workload carries one of these (*inherited*: core, web, loader, model-gateway, storage-module, zot, gitea, openbao, seaweedfs, traefik use `app.kubernetes.io/name`; valkey uses `app`; the CNPG instance's pods use `cnpg.io/cluster`, *inherited* from CNPG's convention; k3s's CoreDNS uses `k8s-app`, *inherited* from the k3s manifest) |
| `namespace`, `pod`, `container`, `node` | Kubernetes metadata | as the API gives them |
| `stream` | the kubelet's CRI stream | `stdout` or `stderr`, taken from the source's own `stream` field *before* it is defaulted; measured `stream="stderr"` and `stream="stdout"` on the stored records (the earlier `"unknown"` was a bug: the default overwrote the value) |
| `level` | the line, unified | pino numbers 10–60 → `trace`/`debug`/`info`/`warn`/`error`/`fatal`; text words `trace|debug|info|warn|warning|error|err|fatal|critical|panic` → the same set; anything else, and any line without a level, is `unknown`. Both maps are equal for structured and unstructured lines |
| `conversation_id` | the line, when present | the JSON field `conversation_id`; unset otherwise. It is a field, never a stream, so it does not multiply streams |
| `untrusted` | Kubernetes metadata | `true` for `namespace == lifemodel-motor` (ADR-014: the whole task pod is one untrusted zone), `false` otherwise |
| `error_type`, `reason_check`, `reason_path`, `reason_got` | the line, **trusted namespaces only** | promoted from a failure line's `error_type` and `reason {check, path, got}` so the page can filter on them without parsing. In the task namespace they are left inside the message: a task line cannot create a promoted field (§9 point 5) |
| `message` | the line | with ANSI escape codes stripped, so a pino-pretty line is readable as text and searchable |
| `_time` | the kubelet's CRI timestamp | the record's time; the line's own time field is left in the message text |

Measured (Docker, pinned Vector, the exact program): a trusted JSON line
`{"level":"warn","error_type":"upstream_500","reason":{"check":"status","path":"choices.0.message","got":"string"},"conversation_id":"conv_vrl_1"}`
stores `level="warn"`, `conversation_id="conv_vrl_1"`, `error_type="upstream_500"`,
`reason_check="status"`, `reason_path="choices.0.message"`, `reason_got="string"`,
`stream="stdout"`; the same shape with a camelCase `conversationId` stores **no**
`conversation_id` (which is why the core emits the snake_case name, §9 point 4);
the same line from `lifemodel-motor` stores `untrusted=true` and **no** promoted
failure fields; a coloured pino-pretty line stores its text with no escape
bytes. On the cluster, a pod writing `{"module":"forged-module","level":"error"}`
stored `module` from its label and `level` from the line; a pod labelled only
`app: valkey-like` stored `module="valkey-like"`; one labelled only
`cnpg.io/cluster: lifemodel` stored `module="lifemodel"`; one with no label
stored `module="unknown"` with its `pod` and `namespace` intact.

**What a line may still choose.** A line can set its own `level` and its own
`conversation_id`. That is accepted: the page shows `untrusted` on every task
record, and a conversation filter's answer marks the untrusted records in it, so
a task cannot pass itself off as a trusted module. It cannot set `module`,
`namespace`, `pod`, `container`, `node`, `untrusted` or any promoted failure
field.

`errorExcerpt` is not carried into any field. §9 point 5 says what replaces it.


### 3. The seam: one plain HTTP protocol, one JSON object per line

**Write side.** The collector POSTs newline-delimited JSON, gzip, to

```
POST /insert/jsonline?_stream_fields=module,namespace,level,untrusted&_msg_field=message&_time_field=timestamp
Content-Type: application/stream+json
```

`_msg_field=message` and `_time_field=timestamp` are not optional: without them
the store keeps the whole event object under `_msg` and stamps it with its own
receipt time. Batches of 2,000 events or one second, memory buffer of 500,000
events, `when_full: block`. Measured ingest: 5 GiB of records in 79.6 s
(67.5 MB/s), 6 GiB of incompressible records in 486 s (13.3 MB/s, store CPU-bound
while compressing on 4 cores). The store answers 200 on success, and 429 with
`cannot add rows into storage in read-only mode` when it stops accepting writes
(measured, §5).

**Read side.** The adapter sends LogsQL to `POST /select/logsql/query` and
reads JSON lines back. The stored record's fields are `_time`, `_msg` (the
message text), and the fields of §2 plus the store's own `_stream` and
`_stream_id`. Measured on a stored record: `_time`, `_msg`, `module`,
`namespace`, `pod`, `container`, `node`, `stream`, `level`, `conversation_id`,
`untrusted`, `error_type`, `reason_check`, `reason_path`, `reason_got`. The
adapter reads `_time` for the order and `_msg` for the body; nothing else is
store-specific.

**Modules.** The module list comes from one grouped query over the store:
`* | stats by (module) count()`, cached for a minute in the adapter. No other
endpoint and no vendor-specific API: the replacement contract is "accepts this
JSON at this URL, answers LogsQL at that URL".

Why this seam matters: neither side needs the other's API. Replacing the
collector is a new process that writes the same JSON; replacing the store is a
new process that reads the same JSON and answers the query endpoint. The loader
never speaks the insert protocol and the collector never speaks the query
protocol.


### 4. Reading: one adapter in the loader, one page on the loader's host

- **The adapter** is `loader/src/logs-query.ts`: the only code in the platform
  that builds LogsQL and the only code that calls the store. It exposes four
  filters — a time range, `module`, `level`, `conversation_id` — plus a text
  search on `_msg`, a page size and a cursor. It sends `POST /select/logsql/query`
  (JSON lines out), `GET /health` for availability and `GET /metrics` for two
  gauges (`vl_free_disk_space_bytes`, `vl_storage_is_read_only`, §5), and nothing
  else. No route passes a caller's query string through: the page's fields become
  field filters with quoted, escaped values, so the loader's login is the only
  authority and LogsQL is never an interface to the owner's browser.
- **The query form and its cursor (F13).** Every page is
  `_time:[start, end] <filters> | sort by (_time desc, _msg desc) | offset N | limit <page>`,
  and the window is fixed at the first page of a scroll: `end` is the time of
  that first query. New records therefore fall outside the window and cannot
  shift the offsets, and the order is total for distinct messages. Measured at
  5.4 GB stored: 5,000 records sharing one timestamp paged in 20 pages of 250
  came back as 5,000 distinct, 0 duplicates, 0 missing — quiet, and again while
  1.36 GB was ingested during the pass. 300 **byte-identical** lines at one
  timestamp (same `_time`, same `_msg`, same `_stream_id`) paged 300 of 300, and
  two identical page queries returned the same bytes. The order among fully
  identical lines is not defined by their content, so identical lines are
  indistinguishable to the page by design; that is stated on the page's help
  text, not worked around.
- **Unavailable is an answer, not an empty list.** If the store does not answer
  within 5 s, or answers 5xx, or answers 429 (read-only), the adapter returns
  `{state: "unavailable", reason: <code>}` — never an empty table. A 200 with
  zero rows means the store really holds no matching line.
- **Freshness (F9).** The collector emits a heartbeat record through the same
  pipeline every 30 s (`module="collector-heartbeat"`). The adapter reads the
  newest one's `_time` with one query and the page shows, above the results,
  `collection stopped N minutes ago; results may be incomplete` when that age
  passes 90 s. When the store's `vl_storage_is_read_only` is 1 the page adds
  `the store is refusing writes (read-only)`, so a reader can tell a stopped
  collector from a refusing store. *Not measured end to end:* the Docker run
  stored the heartbeats (4 in 8 s, 8 in 16 s at a 2 s interval) and the page's
  query found them, but on the cluster two runs stored 0 in every phase for a
  cause not found, so the signal's wiring is check L09.
- **The page** is `web/loader/src/Logs.tsx` behind the loader's login on
  `boot-<name>.local/logs`, reached from the settings page. It reuses the kit
  components and the i18n pattern: a filter row (time range, module, level,
  conversation, text), the newest-first list, one expanded record with every
  field, `untrusted` on every task record, the freshness line, and
  "unavailable" with the reason. "Read like conversations" is the reading shape
  of the chat's transcript: time on the left, module and level as chips, the
  message as the body, fields behind a disclosure; no raw JSON view by default.
- **Routes** are `GET /api/logs` (query), `GET /api/logs/modules` (the module
  list, §3) and `GET`/`PUT /api/logs/settings` (the retention setting, §5).
  They are added to the loader's route table exactly as ADR-012 §4's table
  requires: on `boot-<name>.local` only, the method the table names, a session on
  every route including `GET`, the CSRF token header and an exact Origin on
  `PUT`, `no-store`, CSP and `nosniff` as the existing API routes.
- **Where the code goes, given the file-size limit.** `loader/src/http.ts`
  (1,512 lines, recorded) and `web/loader/src/App.tsx` (1,310 lines, recorded)
  cannot grow by one line. The logs work therefore lands in new files —
  `loader/src/logs-query.ts`, `loader/src/logs-settings.ts`,
  `loader/src/route-table.ts` (the route table and handlers),
  `web/loader/src/Logs.tsx`, `web/loader/src/logs-i18n.ts` — and `http.ts`
  *shrinks*: its hard-coded `bootRouteAllowed` list and the `/api/*` method map
  move into `route-table.ts` (every existing route included, not only the new
  ones), so the new routes are declared where the table already is, and the
  table's check covers the existing routes' matrix too (L11). `App.tsx` gains
  the navigation text through `logs-i18n.ts` and one import, and loses as much
  as it gains; if it cannot, the logs page is reached by path and the App change
  waits for the split the O3 rule implies.

Measured query cost with the adapter's real form at 5.38 GB stored on disk,
40 queries each, 100-record pages:

| Filter | p50 | p95 | max |
| --- | --- | --- | --- |
| a 1-hour window | 144 ms | 176 ms | 209 ms |
| `module=bulk-3` (1 of 20) | 84 ms | 104 ms | 110 ms |
| `module=bulk-3 AND level=info` | 86 ms | 101 ms | 103 ms |
| `conversation_id=conv_000123` (1 of 2,000) | 101 ms | 118 ms | 119 ms |
| text search `"bulk-3"` | 62 ms | 81 ms | 926 ms |

The earlier conversation figure of 1.72 s came from a query with no time
window; with the window the form above is fast at this size. *Not measured:*
latency at the owner's module mix and at the 5 GiB bound with a full day of
data.


### 5. The setting, the disk, and the two things that bound the untrusted writer

**The setting.** `logs.retention` (`{days, maxBytes}`) is the owner's retention:
default 14 days and 5 GiB, and the byte figure is the store's data bound, not a
disk quota. It is stored in `/var/lib/loader/logs.json` with
`{version, days, maxBytes, desiredRevision, appliedRevision, appliedAt}` and
published into the platform's existing settings projection: ConfigMap
`lifemodel-system/lifemodel-logs-settings`, the same mechanism as
`lifemodel-storage-settings` (ADR-014 D6, `deploy/platform/a/loader-settings-rbac.yaml`,
*inherited*).

**One working env mapping (F3).** The store reads two keys through
VictoriaLogs's environment-flag mode, and the keys are the flags with their dots
replaced by underscores, prefixed `VL_`:

| ConfigMap key | Flag it sets |
| --- | --- |
| `VL_retentionPeriod` | `-retentionPeriod` |
| `VL_retention_maxDiskSpaceUsageBytes` | `-retention.maxDiskSpaceUsageBytes` |
| `VL_storage_minFreeDiskSpaceBytes` | `-storage.minFreeDiskSpaceBytes` (§ below) |

The store must start with `-envflag.enable -envflag.prefix=VL_`. Measured from
the process's own `/flags` endpoint in three configurations: `VL_*` keys with
`-envflag.enable` alone change **nothing**; the same keys with
`-envflag.enable -envflag.prefix=VL_` produce `-retentionPeriod="3d"` and
`-retention.maxDiskSpaceUsageBytes="123MiB"`; unprefixed keys with
`-envflag.enable` also work; and an explicit `-retentionPeriod=9d` argument wins
over the env value, so **the Deployment passes no retention argument of its
own** — a check refuses one, so no second, competing retention statement exists.
The three keys arrive through `envFrom` on a ConfigMap the loader owns, which is
why the mapping was measured through a ConfigMap rather than on a command line.

**Bootstrap order (F3).** The store must start before the loader has ever run.
The signed artifact therefore carries a defaults ConfigMap
(`lifemodel-logs-settings-defaults`, owned by Flux, never written by anyone) and
the store's `envFrom` lists the loader's ConfigMap **after** it with
`optional: true`, so on a first start the defaults apply and, once the loader
has written its own, the later entry wins. Flux owns the defaults; **Flux must
not own the loader's ConfigMap**, or a reconcile would revert the owner's
setting.

**How a change reaches the store (F7).** The loader writes `logs.json` with a new
`desiredRevision` (a counter plus a hash of the effective flags), then the
ConfigMap, then bumps the annotation `lifemodel.dev/logs-settings-revision` on the
pod template of Deployment `logs-store`; `Recreate` replaces the single pod. The
loader reports `applied` only when all three hold: the Deployment's
`status.observedGeneration` has caught up with the patched generation, a pod of
**that** template generation is Ready, and its `/flags` answers with the desired
values; until then it reports `pending` with a reason (`store_unavailable`,
`rollout_timeout`, `forbidden`, `mismatch`). At start, and after a crash between
those writes, the loader reconciles idempotently from `logs.json`: it recomputes
the ConfigMap, re-bumps only if the annotation differs, and marks `applied` only
on the same three conditions, so a crash between the ConfigMap and the annotation
cannot leave a value marked applied against the old process. Measured on a 1 GiB
store: the endpoint stops answering 2.6 s and 3.7 s after the patch, is healthy
again at 3.0 s and 4.6 s, and the store itself opens its data in 41–83 ms — the
wait is Kubernetes' delete-then-create.

**New, narrow rights.** Two, both on fixed names in `lifemodel-system`:
`get`/`update` on ConfigMap `lifemodel-logs-settings` (inside the existing
settings Role) and `get`/`patch` on Deployment `logs-store`, clamped by a
ValidatingAdmissionPolicy in A0 to `metadata.annotations` and
`spec.template.metadata.annotations` of that Deployment. The annotation is not
declared in the release manifest, so Flux's server-side apply does not own it; a
check asserts that.

**The disk: what the byte bound does not do.** The store's data lives on a
`local-path` PVC, which is a directory on the node's filesystem — the same one as
Postgres, k3s and the loader. The byte bound limits *data*, and the store stops
accepting writes when the filesystem's free space falls to
`-storage.minFreeDiskSpaceBytes`. It does **not** reserve space, and **the write
stop does not stop merges**: measured with pinned images on a Docker volume, in
two runs, the store refused writes 116 MB and 302 MB below the margin and then
free space kept falling — to **451 MB below the margin at a 4.7–5.0 GB store**,
and to **4,678 MB below** at a 13.2 GB store, over 61 s and still falling when
that run ended, with merges active and the store's own size growing while it was
read-only. A merge shows as a single-second drop: 295 MB and 304 MB respectively.
The third measurement is the cluster run of §6: 675 MB in 7 s at about 2.4 GB on
disk. So the temporary space a merge needs grows with the data being merged;
nothing in the store's flags bounds it (`-help` has `-inmemoryDataFlushInterval`,
which only bounds how long buffered data may sit, and no merge-concurrency
setting).

**The margin, and its basis.** The store therefore runs with a margin, and the
default is **2.5 GiB**:

| Measured store | deepest free below the margin | as a share of store size |
| --- | --- | --- |
| 0.63 GB (cluster run) | 41 MB | 6.5 % |
| 4.7–5.0 GB (Docker) | 451 MB | 9.6 % |
| 13.2 GB (Docker) | 4,678 MB | 35 %, still falling when the run ended |

A margin of half the byte bound (2.5 GiB beside the 5 GiB default) covers the
35 % case with room, and covers the 5 GiB case many times over. This is a
**hypothesis from two sizes, the larger one not at its floor**, and the check
that verifies it (L05) re-measures at the sizes the owner runs. What it means in
plain terms: with the 5 GiB default, the store may need about 2.5 GiB of free
space beside it while it merges; the margin is what keeps that from landing on
Postgres. **It is a probability, not a guarantee**: a merge larger than the
margin takes free space below it, and everything that shares that filesystem
then writes into a shrinking disk. The design does not add a new mechanism for
this; it makes the store the first to stop, the page say so, and the alarm
below fire.

**The alarm.** The page shows, above the results and on the settings page,
`disk space low: N MiB above the store's margin` when the store's
`vl_free_disk_space_bytes` is within 512 MiB of the margin, and
`the store is refusing writes (read-only)` when `vl_storage_is_read_only` is 1.
Both numbers come from the two gauges the adapter already reads.

**The kubelet's image GC sits on the same filesystem.** kubelet removes unused
images when the node's usage reaches 85 % — floored, so it fires below 16 % free
— and that is a product fact on any machine with the default settings: a margin
below that threshold means the kubelet deletes images *before* the store stops,
which on a machine that must not pull images again is worse than a stopped store.
A cluster run showed exactly that (three unused images removed at 16 % free). The
margin must therefore be chosen so the store stops above the kubelet's threshold;
2.5 GiB is stated against the store, and where a disk is small enough that 2.5
GiB sits below 16 % of it, the byte bound is what the owner lowers first.

**The untrusted writer is also throttled (F1).** Independent of the disk, the
collector rate-limits the untrusted namespace per pod with a `throttle` transform
(`threshold: 500`, `window_secs: 1`, `key_field` the pod name); trusted
namespaces are not limited. The rate's basis: a task's legitimate output is
progress lines at a few per second, so 500/s allows a 100× burst for several
seconds while capping a runaway flood at about 100 KB/s per pod. Measured: a task
pod writing 300,000 lines in about 2 s stored 20,650 and discarded 248,883
(another run: 8,444 and 291,556 — exactly 300,000), with the collector at 102 MiB
and no restarts; a trusted pod beside it kept all 300 of its lines. A discarded
line is counted per pod and written to the store as a window record
(`module="collector-window"`, `seen=<n>`, `gap_pod`), so the page can show the
gap for that pod: Measured window records of 65,145, 74,290 and 59,608 lines for
the flooding pod. The count is a window count, not a per-line log line, and a
pod whose window is still open has no record yet.


### 6. Bounds and failure behaviour, measured

| Event | What was measured |
| --- | --- |
| Bound passed within the last two days | No eviction. 600 MiB of today's records into a 300 MiB byte bound: usage 444 MiB, every record kept |
| Bound passed with older partitions present | Oldest partitions dropped first: the canary partition from 10 days ago and every older day of a second flood were dropped, today's 357,400 records stayed, usage 491 MiB |
| The write stop at a margin, on a shared filesystem | One filesystem holding a Postgres pod and the store with an 8 GB margin: Postgres committed 0 → 913 rows throughout with no failed insert; the store refused writes (429, 235 refusals) with the lowest free 41 MB under the margin at a store of 0.63 GB, 46 s under it; reads kept answering (252,400 rows); deleting a 256 MiB filler made writes resume (`insert=200`) with restarts=0 |
| What the write stop does not stop | Merges: 451 MB below the margin at a 4.7–5.0 GB store and 4,678 MB below at 13.2 GB, still falling, both with merges active under read-only; 675 MB in 7 s at a 2.4 GB store on the cluster. §5 |
| Store down 5 minutes | Writers unaffected; the collector stayed ready at 73 → 80 MiB for the ~700 buffered records; after the store returned the backlog was in it within ~10 s; 945 of 945 lines present |
| Collector restarted after 5 minutes down | 1,327 of 1,327 lines present, no duplicate (checkpoint on the node's disk); a pod deleted during the outage lost all 100 of its lines because the kubelet removed its directory first |
| A collector killed with its buffer full | **Not measured.** The run intended for it never reached the buffer edge: the sink had been down long enough that the buffer's size gauge read 0 while 20,000 lines had been received, and the pid the run read was not the process. What the mechanism implies: with `acknowledgements: {enabled: false}` (kubernetes_logs does not support end-to-end acknowledgements — measured: Vector warns and ignores the setting), the checkpoint advances on delivery only, so a crash re-reads from the last delivered line and loses only what the kubelet has already rotated away; what it buffered in memory is lost with the process. Check L07 measures the loss at the buffer's edge |
| A module restarted (pod replaced) | The previous pod's lines stay; a new pod's lines appear under the same `module` |
| A 500,000-line burst (~500 MB in ~25 s, two kubelet rotations) | 500,000 records stored, none missing (before the throttle was added; the throttle now applies to the task namespace only) |
| A task pod at full speed, throttled | 300,000 lines written in ~2 s: 20,650 stored + 248,883 discarded in one run, 8,444 + 291,556 in another, collector 102 MiB, no restart; the trusted pod beside it kept 300 of 300 |
| Store restart on a retention change, 1 GiB store | 2.6 s / 3.7 s without an answering endpoint; healthy at 3.0 s / 4.6 s |
| The heartbeat through the collector's pipeline | Docker: stored (4 in 8 s, 8 in 16 s) and found by the page's query. Cluster: **0 in every phase, cause not found**; check L09 |

**Ingest is `glob_minimum_cooldown_ms: 1000` and this is a product setting.** The
source rescans for new files once a second; that delay is also how long a new
pod's lines wait before they are read, and a pod that lives shorter than the
window may never be read. Measured: a pod that lived about 2 s was collected (2
records), at `1000`. A shorter-lived pod is not guaranteed to be collected, which
is stated rather than fixed.


### 7. Network: what the policy enforces and what it only observes

- **Collector namespace `lifemodel-logs`**: one default-deny ingress and egress
  object, plus one permit list: DNS to kube-dns (UDP and TCP 53), **TCP 6443 to
  any address** (the platform's inherited exception: k3s DNATs the API Service to
  a node address, so the policy cannot name the API's address), and TCP 9428 to
  `logs-store`'s pods in `lifemodel-system`. No ingress — the kubelet's probes
  come from the node, not through pod networking. The ServiceAccount is
  read-only: `get`/`list`/`watch` on `pods`, `namespaces` and `nodes`, and
  nothing else (measured: `kubernetes_logs` needs all three; without `nodes` it
  logs `cannot list resource "nodes"` and fails to annotate every event).
- **What that permits, measured** (check L10, §8): a pod holding the collector's
  labels reached the store on 9428, cluster DNS on 53, the API Service on 443 and
  the node address on 6443; a pod in another namespace on 8080 was refused and on
  443 was refused; a public resolver and a public host were refused. **Any
  address on TCP 6443 is reachable**: the probe reached a *foreign pod* in
  another namespace on 6443, not the API. That is the threat this exception
  leaves open — a compromised collector can open a TCP connection to any address
  on port 6443 and send bytes over it, and DNS queries can leave the machine
  through cluster DNS. The policy is a narrowing, not a confinement theorem.
- **Store**: `logs-store-access` admits 9428 from the collector's pods and from
  the loader's pods; `logs-store-deny` denies the rest. Its egress is empty —
  measured: VictoriaLogs connects to nothing, and the deny policy changes nothing
  about ingestion or queries.
- **The loader's own policy** gains one destination: TCP 9428 to `logs-store`'s
  pods (*inherited* from `loader-access`, ADR-012: a second platform workload
  inherits none of it, so the store gets its own policy and the loader gets one
  more line).
- **Reader and writer are roles, not a boundary.** The collector and the loader
  reach the same unauthenticated listener on 9428: the policy cannot say "only
  reads" or "only writes", and neither can the store. The split is a convention
  in the two clients. Anyone who can reach that port can read every stored line —
  which is why the permit list names exactly those two workloads and no other.
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
    Kubernetes' default.
  - what does work is uid 0 with every capability dropped: measured
    `CapInh=CapPrm=CapEff=CapBnd=CapAmb=0`, `/var/log/pods` `0750 root:root`
    and `0.log` `0640 root:root` both readable, because root owns the files.
    The pod keeps `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`,
    `seccompProfile: RuntimeDefault`, a read-only `/var/log/pods` mount, and
    exactly **two** writable/host mounts: `/var/log/pods` read-only and the
    checkpoint directory `/var/lib/lifemodel-logs-collector` read-write (L12
    asserts both, with their modes).
  What this exception is *not*: no `privileged: true`, no added capability, no
  host network, no host PID, no Docker socket. The namespace holds one workload,
  and any pod in it can already read every line on the node, so the exception is
  bounded by the namespace's single permit list, not by the level's name. What it
  *does* mean: the permit list limits networking, not host mounts or workload
  creation, so the trust placed in whoever may create a pod in
  `lifemodel-logs` is the trust placed in the signed artifact.


### 8. Nothing leaves the machine: observed traffic, and the permitted set

Two different things, stated apart. What was *observed*: `tcpdump` on the node
captured every packet of the collector's pod and the store's pod for 10 minutes
with no egress policy in place. Destinations, by name: **the cluster DNS**
(`10.43.0.10:53`, answered by CoreDNS, the only questions being the store's
name), **the Kubernetes API** (`10.43.0.1:443`, answered from the node's
address on 6443; the projected ServiceAccount environment carries the address, so
the API produces no DNS query), and **the store** (its Service address,
DNATed to its pod on 9428). The store pod made no outbound connection at all.
The capture also holds the kubelet's probes and the operator's `port-forward`,
which are node traffic. This is evidence of what happened, not of what is
possible.

What is *enforced*, measured with the permit list applied and a probe pod
carrying the collector's labels (a witness pod outside the policy first fetched
from each listener, so a refusal is the policy's doing):

| Destination | Result | Why |
| --- | --- | --- |
| the store's pod, 9428 | open | permitted by name |
| cluster DNS, 53 | open | permitted by name |
| the API Service, 443 | open | permitted by name |
| the node address, 6443 | open | the 6443 rule |
| **a foreign pod, 6443** | **open** | **the 6443 rule is any address, not the API's** |
| a foreign pod, 8080 | refused | no rule |
| a foreign pod, 443 | refused | no rule |
| a public resolver 53, a public host 443 | refused | no rule |

So the honest statement is: the collector's traffic in a 10-minute window went
only to those three peers, and the policy now permits exactly DNS, TCP 6443 to any
address, and the store. **The 6443 exception is a real hole in "nothing leaves
the machine"**: a compromised collector can connect to any host on port 6443 and
send what it read, and DNS questions can be used as a channel across the boundary
(ADR-014 already records DNS as such a channel). Closing it needs an API address
the policy can name, which k3s does not provide today; it is recorded as a risk,
not fixed here. Check L10 asserts exactly the permitted set above.


### 9. Every module's logging changes

The collector's normalization (§2) fixes the *shape*. Six changes are needed in
the modules themselves so that the shape carries meaning.

1. **The loader image stops saying `component: 'loader'`.** `createStdoutLogger`
   (`loader/src/logger.ts`) and the fatal JSON line in `loader/src/main.ts`
   write `component: 'loader'`; the model gateway, the storage module and the
   task launcher all run the same image, so today all four claim to be the
   loader. The field is removed from both writers and the module identity is the
   pod's `app.kubernetes.io/name` (§2), which the platform already sets per
   Deployment.
2. **The core's stdout becomes JSON in the cluster.** `logging.pretty` defaults
   to `true` (`src/config/config-schema.ts:252`) and reaches `createLogger`
   (`src/core/container.ts:590`), so the container's stdout is coloured
   pino-pretty text. The default becomes `false`; pretty output stays a
   development choice. The collector no longer has to undo a format for the core
   (`strip_ansi_escape_codes` remains for a module that still prints colour).
3. **`conversation_id` reaches the gateway's failure lines through the existing
   `x-lifemodel-session` header.** The gateway already parses it (it fills a
   slot's `{session}` placeholder, ADR-013), so the two failure lines at
   `loader/src/model-gateway-app.ts:850` and `:886` gain
   `conversation_id: <the header value, or absent>`. No new header on the wire.
4. **`conversation_id` reaches the core's turn lines, as that exact name.** The
   mixin at `src/core/logger.ts:109` copies context keys onto every line
   unchanged, so adding `conversationId` would emit `conversationId` — a field
   the collector does not read (measured: a camelCase `conversationId` produces
   no `conversation_id`). The change is therefore explicit: `TraceContext`
   (`src/core/trace-context.ts`) gains `conversationId`, set where a turn's
   signal is claimed (the conversation is the signal's `recipientId`), and the
   mixin maps it to the emitted key **`conversation_id`**, beside its other
   keys. One assignment puts it on the turn's model calls, tool results,
   warnings and outcome lines; a tick-level context has none, the same rule
   `triggerType` already follows. The check sends real logger output through the
   collector's VRL (L02), not six hand-written lines.
5. **`errorExcerpt` leaves the whole path, not only the log lines.** Three
   places carry it and all three change:
   - the gateway's two failure log lines (`model-gateway-app.ts:850`, `:886`)
     drop the field and log `error_type` instead;
   - `ownedError` (`model-gateway-app.ts:126–144`) stops serialising it: the
     response body becomes `{error: {type: "gateway_error", code}}` and nothing
     else. A caller therefore receives a code, not a model's text;
   - the core stops putting a response body into its own logs and errors:
     `vercel-ai-provider.ts:950–962` logs `responseBody.slice(0,1000)` and
     `:1181–1196` builds an error message from the body,
     and `src/llm/provider.ts:519–528` logs `error.message`. The body is removed
     from those log fields, and the message keeps the status and the provider's
     error *type* (`error.statusCode`, `error.name`, `LLMError.code`), not the
     body text. What a caller loses: the upstream's own words. It keeps the
     status code, the error type, the request id and the retryability, which is
     what the page shows; the body remains in the exchange capture when the
     owner has enabled it (`observability.model_exchanges`, ADR-013). The
     existing provider error classes, their codes and their retry semantics are
     unchanged, so no caller logic changes.
   In place of the excerpt the failure line carries OpenTelemetry's stable
   `error_type` — the error's code (`bad_response`, `timeout`, `upstream_5xx`,
   …) — beside the existing `reason: RejectReason {check, path, got}`
   (`loader/src/model-gateway-response.ts`), where `got` is a JSON type name and
   `path` is a JSON path with array indexes. A failure reads as "field and
   type", exactly O1's words, and never carries a model's text. Check L03 runs a
   non-2xx marker and a refused 2xx marker through the real core and gateway,
   with the capture on and off, and searches every stored log.
6. **Terminal failure is `error`; a retried attempt stays `warn` (F6).** The two
   gateway failure statements call `logger.warn` today
   (`model-gateway-app.ts:850`, `:886`), so a failure that ended the request
   would be stored as `warn` and the owner's `level=error` filter would miss it.
   The change is at those call sites: the line logged when **no retry remains**
   — the one after the failover loop for a final slot failure, and the one in
   the outer catch that returns the caller's error — becomes `error`; a line
   logged for an attempt that will be retried on another slot stays `warn`. The
   two statements are reachable from three paths — the per-slot failure in the
   loop, the outer catch for a non-retryable code (401/403/4xx other than 429),
   and the task-authorization refusal — and the first two end the request. The
   per-slot line is `error` when the loop has no slot left after it and `warn`
   otherwise; the core's own `'🤖 LLM request failed'` line (`src/llm/provider.ts:519`)
   is already `error` and stays so. Check L04 asserts the level at these call
   sites with an exact failure scenario.


## Consequences

- The owner opens `https://boot-<name>.local/logs` and reads what a module did
  and why, by time, module, level and conversation, with the core and the chat
  stopped, and without a shell. A failure survives the failing module's restart:
  the store holds the previous pod's lines under the same `module` (measured).
- `kubectl logs` stops being the way a failure is found. `kubectl` stays the way
  to repair the cluster, and `lifemodel doctor` keeps its own path.
- Logs are kept on the machine by the collector and the store, both pinned in
  the signed artifact. The observed egress is three peers (§8); the permitted set
  is wider than that on one port, and it is stated.
- The platform's trusted base grows by one workload that reads every pod's log
  files on the node (`lifemodel-logs`, uid 0, no capabilities, `privileged` Pod
  Security — §7) and by one store pod that has no credential of any other
  module. A compromised collector could read everything and, over TCP 6443 to any
  address, try to send it.
- A new failure domain exists that gates nothing: the platform starts, the
  loader answers, and the modules run while either pod is down (§1, §6). A broken
  store is invisible to the platform's health except on the logs page, which says
  "unavailable" with a reason.
- **The disk is a shared budget, and the margin is a probability.** The store's
  data is capped by the byte bound; a merge's temporary space is not, and the
  write stop does not stop merges (§5). With the 5 GiB default the design
  reserves 2.5 GiB beside it; below that, a merge can take free space below the
  margin and Postgres then writes into a shrinking disk. The store stops first,
  the page says so, and the alarm fires near the margin — that is the whole
  containment.
- **A task pod cannot exceed the throttle, and a throttled line is a gap the page
  shows.** A trusted module is never throttled: a fast trusted writer can still
  fill the disk as fast as the collector can store, which is why the margin is
  the second line and not the throttle.
- Measured cost: collector 45–102 MiB RSS (26 pods idle; 102 MiB through a
  150,000-line/s burst); store 46 MiB right after a start with 5.3 GiB of data,
  451–757 MiB while ingesting, up to 3.2 cores while merging on 4 CPUs. Disk: 5.3
  GiB stored for 7 GiB of raw JSON records of random text (about 0.76 bytes per
  byte); real log text compresses far better (5 GiB of repetitive test records
  took 4.3 MB), so the byte bound holds many more lines in practice.
- The exchange capture is the only place an upstream body is kept: off by
  default, time-limited and redacted, in Postgres (ADR-013). A failure that needs
  the body now needs the owner to have enabled the capture; that is the price of
  taking model text out of the log stream, and it holds on every hop, including
  the core's own error lines.
- Two behaviours the owner will notice and should know: a discarded line under
  the throttle appears as a gap in that pod's window record, not as a line that
  vanished silently; and a pod that lives shorter than the collector's one-second
  rescan may not be collected at all (§6).
- The gateway, storage module and task launcher lose a field that used to make
  their lines distinguishable in `docker logs`; the pod's own metadata replaces
  it, which is only visible where Kubernetes metadata is joined.


## Assumptions, and what would invalidate them

| Assumption | Would be invalidated by |
| --- | --- |
| The kubelet's log files are CRI-framed and survive a pod's deletion long enough to be read; rotated files are kept 5 × 10 MiB per container (`containerLogMaxSize: 10Mi`, `containerLogMaxFiles: 5`, `containerLogMonitorInterval: 10s`, measured) | a k3s or kubelet change to `containerLogMax*`, or a runtime that writes another framing. L01/L07 fail |
| The collector can keep up with what the platform writes: 500,000 records in a ~500 MB burst stored without loss, and idle ingest is ~16 MB a day | a module writing more per second than the collector reads for longer than the kubelet keeps; lines are then lost at rotation. L07 is the edge |
| Vector's `kubernetes_logs` keeps its field names (`kubernetes.pod_labels`, `pod_namespace`, `stream`, …) and its CRI decoder | an upgrade that renames them; the record shape is the contract (L02 fails loudly, not silently: a missing label yields `module=unknown`) |
| VictoriaLogs's retention and read-only semantics: at least the two last days are kept whatever the byte bound says; a full filesystem stops writes with 429 and the store keeps serving reads; merges keep running and need temporary space | a version change to those semantics. The pin is a digest; L05/L06 fail if they move |
| A `local-path` PVC is a directory on the node's filesystem and reserves nothing | a storage class that enforces quotas, or a node where the storage path is a separate filesystem. Then L05's margin measures the wrong filesystem |
| The store's `vl_free_disk_space_bytes` and `vl_storage_is_read_only` describe the filesystem the store writes to | a deployment where the data path is a bind mount of another filesystem. Then the margin and the page's gauges must read the volume |
| An instance's disk size is unspecified, so the margin (2.5 GiB) is a default the owner can raise from the settings page | a disk small enough that 2.5 GiB sits below kubelet's 16 % GC threshold; then images are collected before the store stops (§5), and the byte bound is what to lower first |
| The gateway's `x-lifemodel-session` header carries the conversation on every model call the core makes | a new caller of the gateway that sends none; its failures then have no conversation, which is what the current code already does |


## Constraints (closed, each with its check and its fixture)

L01–L15 are the complete additional requirements of this design. Each has a
check that can fail for the stated reason. Some are repository work still to be
written; the walks run on a deployed build from a clean snapshot, and the stage
that runs each is named. No check may pass on a fixture that cannot fail.

| ID | Requirement / origin | Check and fixture |
| --- | --- | --- |
| L01 | Every workload and container on the node is collected, including the new log workloads and the platform's own; a pod with no metadata label is visible as `module=unknown` with its `pod` and `namespace` (F14) | `WALK-LOGS-ALL`: build the expected inventory from the cluster (`kubectl get pods -o jsonpath` over every namespace, plus the collectors and the store themselves), plant one identifiable line per container, then compare **by name** — every expected pod/container has its record, every record names an expected one, and `module` matches the label chain. A namespace-count check is kept as an additional check, never the oracle. Repository part: the ServiceAccount grants only `get/list/watch` on pods, namespaces and nodes |
| L02 | The record contract of §2, sent through the **real** logger and the **real** VRL (F4, F5) | `tests/unit/logs-record-shape.test.ts`: run a pino logger built by `createLogger` with a trace context carrying `conversationId`, feed its stdout line into the collector's VRL with the pinned `vrl` binary, and assert `conversation_id`, `module`, `level`, `stream`, `untrusted` and the promoted `error_type`/`reason_*`. Fixtures cover every level (pino 10–60 and the words incl. `err`), a coloured pretty line, a malformed JSON line, a line with no level, a forged `module`/`level`, and a `lifemodel-motor` line (no promoted fields). Passing here requires the snake_case mapping of §9 point 4 |
| L03 | No value from an upstream response body reaches any stored log (F2) | `WALK-LOGS-MARKER`: a 32-character marker in a non-2xx response body and another in a refused 2xx body, driven through the **real core and gateway**, with the exchange capture **off** and then **on**; then a text search for each marker over the whole store, and the same search over every module's records. Assert: absent with the capture off, present only in the capture with it on, and the failure line carries `error_type` with `reason_check/path/got`. Repository part: `tests/unit/model-gateway.test.ts` asserts the response envelope has no `message`, and that the core's provider logs and errors carry no body text |
| L04 | A terminal gateway failure is stored as `error`, a retried attempt as `warn` (F6) | `WALK-LOGS-LEVEL`: force a non-retryable 4xx and a final 5xx with a second slot configured, then assert the stored record for the request that ended is `level=error` and the record for the attempt that failed over is `warn`. Repository part: `tests/unit/model-gateway.test.ts` asserts the level of the exact call sites of §9 point 6 |
| L05 | The write stop holds at the margin on the **shared** filesystem, with another store committing through it, and writes resume without a restart (F1, F8) | `WALK-LOGS-MARGIN`: one filesystem, a Postgres pod committing every 200 ms, the store with the default margin, then an incompressible flood until refusals. Assert: no failed commit; refusals are 429 with no panic and no restart; reads keep answering; the lowest free space (1 s samples) is reported and the deepest point below the margin is inside the stated figure for the store's size; deleting an unrelated filler file makes writes accept again with no restart. Measured on the prototype: 41 MB under the margin at a 0.63 GB store, 46 s under, resume `insert=200`, restarts 0, Postgres 0 → 913 rows |
| L06 | Retention: the byte bound drops oldest day partitions first, and the age bound applies independently | `WALK-LOGS-BOUND`: 300 MiB byte bound, 600 MiB of today (no eviction), a 200-record canary 10 days old, a 0.7 GiB flood across 10 days (canary and older days gone, today kept), then a *separate* run with only `retentionPeriod` shortened and no byte pressure (the older day is gone and nothing else). Measured on the prototype for the first three |
| L07 | What a collector crash loses (F10) | `WALK-LOGS-CRASH`: with the store down, 20,000 numbered lines, the checkpoint on the node; then `kill -9` the **vector process** by its host pid (`k3s crictl inspect`) while the buffer's size gauge is non-zero and the source's received counter is above zero — if either is zero the run prints `TEST NOT VALID` and fails rather than pass. Then recovery, and count missing and duplicate lines, and the container's restart count. **Not measured yet**: the run that tried it never reached the buffer edge, so the ADR states only the mechanism (checkpoint advances on delivery; memory buffer lost) |
| L08 | The setting applies through the ConfigMap mapping, a durable desired revision, and idempotent reconcile (F3, F7) | `WALK-LOGS-SETTING`: change 14 d → 7 d, 7 d → 14 d, then crash the loader after the ConfigMap write and before the annotation (both orders), and a repeated identical PUT. Assert: the store's `/flags` holds the desired values (which requires `-envflag.prefix=VL_`); the page says `applied` only when `observedGeneration` and a Ready pod of that template and `/flags` all agree, `pending` otherwise, and the revision in the store matches `logs.json`; a first install boots from the defaults ConfigMap with the loader's ConfigMap absent (`optional: true`); a check asserts the Deployment declares no retention argument and the release manifest does not declare the revision annotation. Measured on the prototype: env mapping (`/flags` in three configurations), and 2.6/3.7 s without an endpoint, healthy at 3.0/4.6 s |
| L09 | A log step does not gate the platform's readiness (F11) | `WALK-LOGS-WAIT`: on the deployed build, a root Kustomization at `wait: true` over a child at `wait: false` whose pod cannot start (a bad image) and one healthy neighbour child; assert the root is Ready and the page shows the failure, and that the same fixture at `wait: true` keeps the root NotReady. **Not measured**: the prototype's own Flux fixture did not reconcile its children (`ReconciliationFailed` on all three, with the source itself `Ready`), so `wait: false` is unproven. The fixture mistake is named in the report; this check runs in the first stage that deploys the collector |
| L10 | The permitted egress set is exactly DNS, TCP 6443 to any address, and the store (F12) | `WALK-LOGS-EGRESS`: a probe pod carrying the collector's labels, a witness pod outside the policy, and listeners on another namespace's pod. Assert open: the store's 9428, DNS 53, the API Service 443, the node address 6443, **and another namespace's pod on 6443**; assert refused: that pod on 8080 and 443, a public resolver on 53, a public host on 443. Measured on the prototype exactly as asserted |
| L11 | The logs routes refuse without a session and exist only on the loader's host — and the existing routes keep their matrix (F-route, GET auth) | `tests/unit/loader-routes.test.ts`: the table names every method/path pair — `GET /api/state`, `GET /api/model`, `GET /api/model-status`, `GET /api/model-capture`, `GET|PUT /api/workbench-source`, `GET /api/workbench-status`, `PUT /api/model/primary`, `PUT|DELETE /api/model/reserve`, `GET /api/settings`, `PUT /api/settings/<key>`, `POST /api/setup|login|password|logout|onboarding/device`, `GET /logs`, `GET /api/logs`, `GET /api/logs/modules`, `GET|PUT /api/logs/settings` — and for each: another host 404, wrong method 405, **no session refused on GET too**, `PUT` without CSRF or with a wrong Origin 403, `no-store`/CSP/`nosniff` present. The matrix must cover the routes that exist today, not only the new ones |
| L12 | No listed file grows | `npm run check:file-sizes`: `loader/src/http.ts` ≤ 1,512 lines and `web/loader/src/App.tsx` ≤ 1,310, every new file under 800 |
| L13 | The collector's namespace is the only `privileged` one, it holds exactly the collector, and its mounts are exactly the two named paths with their modes (F15) | `tests/unit/platform-pod-security.test.ts`: every namespace manifest in `deploy/platform` is `baseline` or `restricted` except `lifemodel-logs`, which is `privileged` and holds exactly the DaemonSet; the collector container has no `privileged`, no added capability, `readOnlyRootFilesystem`, `runAsUser: 0`, all capabilities dropped, and exactly two `hostPath` volumes — `/var/log/pods` read-only and `/var/lib/lifemodel-logs-collector` read-write. A persistent checkpoint is required, so a check that would remove it fails |
| L14 | The page never shows a healthy page for a stopped collector (F9) | `WALK-LOGS-FRESH`: stop the collector with the store healthy, then make the store read-only. Assert: within 90 s the page shows `collection stopped N minutes ago; results may be incomplete` above the results, and names `read-only` in the store case; restarting the collector returns the age below the threshold within one heartbeat period. **Not measured end to end**: Docker stored the heartbeats and the page's query found them; on the cluster two runs stored 0 in every phase, for a cause not found. This check runs in the first stage that deploys the collector |
| L15 | Paging is total and latency is inside the page's deadline (F13) | `tests/integration/logs-paging.test.ts` and `WALK-LOGS-LATENCY`: a fixture with 5,000 records at one timestamp and 300 byte-identical lines at another, paged in 250-record pages through the adapter, quiet and with ingest running; assert every record exactly once, no duplicate, and the same page twice returns the same bytes; then 40 queries per filter with the real form at the store's bound, p95 under 2.5 s (measured: 81–176 ms at 5.38 GB) |

## The principles this serves

- **P2 — one owner, their own machine, nothing personal leaves it.** Logs are
  the most personal artefact the platform produces: model prompts, tool output and
  the owner's conversation. They rest on their disk and nowhere else. §8 states
  both halves honestly: what was observed, and the one port where the policy
  cannot rule an outside address out.
- **P11 — replaceable parts behind a seam; generic code names no vendor.** The
  seam is one plain HTTP write protocol, one JSON record shape and one query
  endpoint (§3); the collector and the store are each replaceable alone, and the
  replacement contract is written down rather than implied. The loader's adapter
  and page name no vendor. `scripts/vendor-names.json` gains two entries with
  their allowed places — the collector's and the store's names appear only in
  their own manifests under `deploy/platform/a/`, in the ADR and in the check
  fixtures for those manifests; no code under `src/`, `loader/` or `web/` names
  either.
- **P12 — registries and endpoints are loader settings.** The store's address is
  a setting, not a constant in the page's code, and retention is the loader's
  setting reached from its own page (§5).
- **P13 — declare the untrusted zone and guard its edge.** The task namespace is
  the untrusted zone; its lines are collected like everything else and marked
  `untrusted=true`. Its `module`, `namespace`, `pod` and `untrusted` cannot be set
  from the line, and it cannot create a promoted failure field (§2, measured). It
  *can* choose its `level` and `conversation_id`, so every task record is marked
  and a conversation filter's answer marks them; and it is rate-limited per pod so
  a flood cannot take the shared filesystem (§5). Nothing about a task's line
  grants it anything: the page is the loader's, behind its login.

## What it extends and replaces

- **Replaces** the platform's logging surface: today's "a module's log is its
  container's stdout, read with kubectl, gone when the pod is replaced" becomes
  a kept, normalized, queryable stream. The core's `data/logs/agent-*.log` file
  target stays as a local development artefact and is *not* the platform's log
  store; in the cluster the container's stdout is JSON and that is what is kept.
- **Extends ADR-010** (the signed artifact and its ordered steps) with the two
  steps of §1, both at `wait: false`, and its pinning rule with two more digests.
- **Extends ADR-012** (the loader's interface and login) with one page, three
  API routes, one egress line and one route-table extraction; the page is on the
  loader's own host behind its own session, so a broken generation cannot take
  it away.
- **Extends ADR-015** (a platform module's shape) with the store's own
  ServiceAccount, NetworkPolicy and volume, and no caller credential.
- **Extends ADR-013** (the model gateway) by removing `errorExcerpt` from its
  log lines *and* from the error envelope it returns, leaving the body in the
  exchange capture alone; and by promoting a terminal failure's level to `error`.
- **Extends the core's logging** with one trace-context field mapped to
  `conversation_id`, and by removing response bodies from the provider's logs and
  error messages (§9 points 4 and 5).
- **Narrows O2's trace work**: the logs carry the same `conversation_id` the
  trace will carry, and the gateway's failure line is joinable to a call
  without a timestamp guess.


## Acceptance

On a deployed build from a clean snapshot, in real browsers (PRA-001), in the
stage that first deploys the collector:

- **WALK-LOGS-PAGE** — the owner opens `https://boot-<name>.local/logs` in
  Chromium and Firefox, in English and Russian, in both themes, axe-clean: every
  module in the filter, each of the four filters narrowing, one record expanded,
  one task record showing `untrusted`, a range with no match showing an empty
  answer, the store stopped showing `unavailable` with its reason and never an
  empty list, and the freshness line (L14).
- **WALK-LOGS-FAILURE** (scenario 1) — plant a model failure through the chat,
  restart the failing module, then find the line by the minute and the
  conversation: `module=model-gateway`, `level=error`, `error_type`,
  `reason_check/path/got`, the `untrusted` flag where it applies, and the
  module's new pod's line beside it. No `kubectl`.
- **WALK-LOGS-OFF** (scenario 2) — stop the core and the chat; the page still
  answers; without a session it refuses (scenario 3, L11).
- **WALK-LOGS-MARGIN** (L05), **WALK-LOGS-BOUND** (L06), **WALK-LOGS-CRASH**
  (L07), **WALK-LOGS-SETTING** (L08), **WALK-LOGS-WAIT** (L09),
  **WALK-LOGS-EGRESS** (L10), **WALK-LOGS-FRESH** (L14), **WALK-LOGS-LATENCY**
  (L15), **WALK-LOGS-MARKER** (L03), **WALK-LOGS-ALL** (L01),
  **WALK-LOGS-SHAPE** (L02), **WALK-LOGS-LEVEL** (L04) — as the L-table states
  them, with the fixtures given.
- **WALK-LOGS-SETTING-WALK** — the owner lowers the byte bound from the page
  before a heavy day, sees `applied`, and the store's own `/flags` agrees.

## Open, and what this record does not decide

- **The 5 GiB byte bound's safety is the owner's decision.** The design reserves
  a 2.5 GiB margin beside it (§5), and states what is left unprotected: a merge
  larger than the margin takes the shared filesystem below it, and the other
  stores on it then write into a shrinking disk. If an instance's disk cannot
  spare 2.5 GiB, the byte bound is the thing to lower, and that choice is theirs.
- **The merge margin is a hypothesis from two store sizes**, the larger of which
  was still falling when its run ended. L05 re-measures it; if a third size
  exceeds half the bound, the number changes and the design does not.
- **Not measured, and named so acceptance does not imply otherwise:** what a
  collector crash loses at the buffer edge (L07); the freshness signal end to
  end on a cluster (L14, where two runs stored no heartbeat for a cause not
  found, while Docker stored them); `wait: false` keeping a broken log pod out of
  a root's readiness (L09 — the prototype's Flux fixture did not reconcile its
  children); the page's latency at the owner's real module mix; the store filling
  while a query is in flight; and the retention change with the store exactly at
  its bound.
- **The exact LogsQL the adapter builds is implementation detail**; the record
  shape, the four filters, the total order with its pinned window, the
  unavailable-with-reason rule and the freshness line are the contract.

## Appendix: how each measured value was produced

Two places. On a throwaway single-node k3s, the proof manifests live in
`/var/lib/logs-proof/<name>` during a run and are thrown away; the scripts that
produce them are collected beside this design, not in the repository, and this
record refers to the checks, not to them. The parts that need no cluster ran in
Docker with the same pinned images on a named volume on a real disk.

| Value | How it was produced |
| --- | --- |
| Pod Security verdicts, capability sets, file permissions | one probe pod per level; `grep -E 'Cap(Inh\|Prm\|Eff\|Bnd\|Amb)' /proc/self/status`; `ls -ld /var/log/pods`; the API server's rejection message |
| CRI decoding, a 20 KB line, rotation, deletion, restart duplicates | one pod writing numbered records; `POST /select/logsql/query` with `conversation_id:"..." \| count()`; `ls -la /var/log/pods/<pod>/<container>/`; deleting a pod; restarting the collector |
| Record shape, forged fields, label chain, promoted failure fields, `stream` | the collector's own VRL run with the pinned `vrl` binary in Docker over sample lines, then the same program deployed and the stored records read back |
| Ingest throughput and query latency | 6 GiB of random JSON records through `/insert/jsonline`; 40 queries per filter with the adapter's real form (window, newest first, `limit 100`) |
| The margin and what a merge does to it | a store with `-storage.minFreeDiskSpaceBytes` set from the filesystem's free space, an incompressible flood, 1 s samples of free space plus `vl_active_merges`, `vl_merges_total`, `vl_pending_rows`, `vl_storage_rows`, and the store's size on disk every 5 s; on the cluster, a real Postgres pod committing every 200 ms on the same filesystem |
| Retention: byte bound, day partitions, canary | a store with a 300 MiB byte bound; a flood of today's records; a 200-record canary 10 days old; per-day `stats by (_time:1d)` |
| The throttle and its per-pod gap | a task pod writing 300,000 lines at full speed, a trusted pod beside it; `vector_component_discarded_events_total{component_id="throttle"}`; a `reduce` window per pod written to the store as `module="collector-window"` |
| The env mapping | the same ConfigMap through `envFrom` in three configurations, read from the process's own `/flags` endpoint |
| Egress: observed and permitted | `tcpdump` on the node for 10 minutes without a policy; then the permit list applied, a witness pod outside it, and a probe pod carrying the collector's labels |
| Paging with tied timestamps | 5,000 records at one timestamp and 300 byte-identical lines, paged with the adapter's query form in 250-record pages, quiet and with ingest running |
| Memory | `kubectl top pod` and the container's own metrics |
| kubelet log policy | `kubectl get --raw /api/v1/nodes/<node>/proxy/configz` |
