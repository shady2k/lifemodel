# ADR-016: The logs of every module stay on the machine and are read in the loader

Date: 2026-11-07. Task: lifemodel-vbog.3 (observability-1, O1).

## Status

Proposed. The owner fixed the direction on 2026-11-07 and it is not reopened
here: Vector reads every pod's log files on the node and normalizes them;
VictoriaLogs stores them on the machine; the loader reads them through one
adapter on a logs page behind its login; every pod is collected and task pods
are marked untrusted; retention is a loader setting, 14 days or 1.5 GiB, whichever
comes first; when the volume runs low the oldest logs are displaced, with nobody
acting (the owner's decision, 2026-11-07, §5); the upstream `errorExcerpt` leaves
the logs and stays in the exchange capture; logs are read like conversations;
nothing leaves the machine.

This revision answers two model reviews: the first of 2026-11-07 (`F1`–`F15`)
and the second, the **last model review** (gpt-6.1-sol, at `cd9cc6b8`, findings
`N1`–`N11` and its evidence audit), whose findings are answered in the text that
follows. The storage decision the second review left open was then taken by the
owner — a volume of its own for logs (§5) — and that section was verified by the
coordinator against the installers and a Docker measurement, not by another model
review. The owner then asked for less disk and for new logs to displace old ones
(«просто сократи объем», «Новые логи должны вытеснять старые»), and §5 now
records that: a 3 GiB volume and a displacement CronJob, measured in the
`lifemodel-vbog.3` displacement round. Every
number below is measured unless it is marked *inherited* (taken from an existing
document or an earlier decision) or *not measured*. Measurements come from two
places, and each figure says which: the test VM's single-node k3s, where the real
platform runs and was **read only** except for the proof namespaces, and
pinned-image Docker runs for the parts that need no cluster (the store's merge
behaviour, the record contract, paging, latency and the throttle's window
accounting).
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
| 1 | A planted model failure and a restart of the failing module: found by time and conversation with no kubectl | One page query by the failure's minute and its conversation returns the gateway's line: `module=model-gateway`, `level=error`, `error_type`, `reason_check`, `reason_path`, `reason_got`; the module's replacement pod's line after the restart is in the same answer; zero shell commands. Basis: the store keeps the previous pod's lines (2,000 of 2,000 measured through a pod deletion), the failure's own level is `error` (§9 point 6) and the filters answer at 176 ms (1-hour window), 104 ms (module) and 118 ms (conversation) p95 with the adapter's real form at 5.38 GB (measured, §4) |
| 2 | Core and chat stopped: the page answers | The page's API answers from the loader pod alone. The loader has no route to the core or the web module, and the store has no route to either (its only peers are the loader and the collector, §7) |
| 3 | No login: page and API refuse | Every logs route answers 404 on any other host and refuses without a session, like the rest of the loader's table (ADR-012 §4) |
| 4 | Every module appears and each of four filters narrows | Every platform workload's pod carries a label the collector turns into `module` (§2, measured for `app.kubernetes.io/name`, `app`, `cnpg.io/cluster` and the no-label fallback); the filters are timed with the adapter's real query form (window, newest first, page size) at 5.4 GB stored: p95 176 ms for a 1-hour window, 104 ms for a module, 101 ms for module+level, 118 ms for a conversation, 81 ms for a text search (measured, §4). Coverage of every real workload is check L01 |
| 5 | A marker value in an upstream response appears nowhere in the logs and the reason reads as field and type | The value never enters the log stream at any hop: not in the gateway's own line, not in the error envelope it returns, not in the core's two error lines (§9 point 5). The failure line carries `error_type` and `reason_check`/`reason_path`/`reason_got`, promoted by the collector from a trusted namespace only (measured, §2). The marker's absence from the store is check L03, because a marker planted through the real core and gateway needs the deployed build |
| 6 | Over the bound: oldest go, the platform is not hurt | Old per-day partitions are dropped and the two last days are kept: measured with a 300 MiB byte bound, a 10-day-old canary partition and every older day of a second flood were dropped while today's 357,400 records stayed. "The platform is not hurt" now holds for log allocation by construction: logs have their own file-backed volume (§5), so what a flood fills is the log volume, not the filesystem Postgres, k3s and the loader share. Measured on that volume: a flood filled it, the store refused with 429, no panic, no restart, reads kept answering, and merges freed space again (L05) |
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
- **The platform's other stores share one filesystem; logs do not** (the log store
  has its own file-backed volume, §5). An instance's disk size is unspecified, so
  no design figure may depend on one; the volume's size is an install option.
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
- **The collector's configuration is a generated object (lifemodel-vbog.5.10).**
  The step's kustomization generates `logs-collector-config` from
  `deploy/platform/logs/config/vector.yaml`, so the generator's content hash
  suffixes the ConfigMap name and kustomize rewrites the DaemonSet's volume
  reference to it; a release that changes the configuration changes the pod
  template and replaces the collector's pods on the next reconcile. Vector runs
  with `--config /etc/vector/vector.yaml` and no `--watch-config`, so a fixed
  name would leave a running collector on the configuration it started with.
  Measured on vm-lifemodel, 2026-11-09 (WALK-LOGS-FRESH, lifemodel-vbog.5.9):
  after the stage 2 platform was applied the collector kept stage 1's
  configuration for hours and stored no heartbeat until the walk restarted it.
- **Store.** `logs-store` is a single-replica Deployment with `Recreate`
  strategy in `lifemodel-system`, the VictoriaLogs image pinned by digest, its
  own ServiceAccount, one PVC bound to a PersistentVolume of its own (§5) and one
  HTTP listener. It runs as uid **1000**, gid **1000**, with `fsGroup: 1000` — the
  `restricted` level its namespace enforces — so everything it writes into the
  volume belongs to `1000:1000` (§5 states why that number matters to the evictor).
  Requests `cpu: 200m`, `memory: 128Mi`; limits `cpu: 3`, `memory: 1Gi`. Measured
  inside that 1 GiB limit: 46 MiB after a restart with 5.3 GiB of data, 451–757 MiB
  while ingesting, and **793 MiB peak** through a full-speed realistic flood with
  three log drops beside it (no OOM, no restart); a delete task at the same limit
  was OOM-killed (§5), which is one reason it is not used.
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
- **Evictor.** `logs-evictor` is a CronJob in `lifemodel-system`, shipped in the
  `platform-logs-store` step, on the loader image with its own entry point, running
  once a minute and acting only when free space is below its threshold (§5). It is
  the only workload besides the store that mounts the log volume and the partition
  key.
- **A second platform workload in `lifemodel-system` inherits none of the
  loader's permits** (ADR-012 §4, ADR-013 D5, *inherited*): `logs-store-access`
  is its own policy and the evictor gets its own line in it, §7.


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
`* | stats by (module) count()`, cached for a minute in the adapter.

**The replacement contract, written whole (N9).** It is not "JSON plus one
endpoint". A replacement store implements five operations: the insert URL above;
`POST /select/logsql/query` for records and counts; `GET /health`; `GET /metrics`
with two named gauges (free disk space, read-only); and `GET /flags` returning the
process's effective flags. It must also answer LogsQL's range filter, field
filters, `sort by`, `offset`, `limit`, `stats by` and `count()` — the subset
listed in §4, and nothing else. Those names are the store's own, so they are
parsed in one file, `loader/src/logs-store-adapter.ts` (§4); the rest of the
loader sees a store interface with `query`, `count`, `available`,
`freeDiskSpace`, `readOnly` and `flags`.

Why this seam matters: neither side needs the other's *implementation*.
Replacing the collector is a new process that writes the same JSON; replacing the
store is a new process that answers the five operations above. The loader never
speaks the insert protocol and the collector never speaks the query protocol.


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
- **The query form and its cursor protocol (F13, N4).** A page's order is
  `_time:[start, end] <filters> | sort by (_time desc, _msg desc, pod desc) | offset N | limit <page>`,
  with `end` set at the first page, and `pod` as a further key so that two
  **different** records sharing `_time` and `_msg` still have an order (measured:
  the store accepts the three-key sort and returns the same bytes for the same
  query). A pinned event-time window is **not a snapshot**: a collector draining
  its backlog writes records whose event time is inside the window but earlier
  than the rows already read, so they enter before the offset. Measured: 500
  records in the window, page 1 of 250, then one late record inserted inside the
  window; the window's count became 501, page 2 returned 250 rows, and the late
  record appeared on **no** page of the first two — a record was repeated in its
  place. The page therefore uses a **cursor protocol, not a promise**: it reports
  the results as of the first page, and at every page it re-reads the window's
  count with one cheap query. If the count changed, the answer is marked
  `incomplete — records arrived while you were scrolling` and offers a refresh
  from the first page; the page never claims every record exactly once. Records
  that are **byte-identical** (same time, message, pod, stream) remain
  indistinguishable, which the page's help states.
- **Why the read is in two steps (L15).** Ordering by `_msg` and `pod` reads
  and compares every message the window holds. Measured through a port-forward
  against the store the eviction walk's flood had filled with 1,680,000 records
  in the last hour (2026-11-09): the order above took **4.94 s** for the first
  page, **5.98 s** with `level=info`, **5.27 s** at offset 200, and **0.02 s**
  over five minutes, while the same hour's `_time`-only sort took **0.16 s** and
  its `stats count()` **0.025 s**. So the tie-break costs an amount that grows
  with the window, and the deadline (p95 under 2.5 s) passes at about 850,000
  records in an hour — a flood, exactly when someone opens the page. The records
  are therefore read in two steps, with the order and the cursor contract above
  unchanged:
  1. the **boundary**:
     `_time:[start, end] <filters> | sort by (_time desc) | offset N+limit-1 | limit 1`
     — the cheap shape — names the `_time` T of the record the order puts in
     the page's last position;
  2. the **page**:
     `_time:[T, end] <filters> | sort by (_time desc, _msg desc, pod desc) | offset N | limit <page>`
     reads only the records at or after T.

  Every record the order puts in positions N..N+limit−1 has a time at or after
  T, and every record that ties at T is inside the range, so no tie is split and
  the page is the same bytes the single full sort returns, while the read shrinks
  to roughly the page's own reach instead of the window. The window's count is
  read first, because it decides this: fewer than N+limit records and the window
  is read as it is in one query. That last page — and a page whose offset is
  past the window — is the one read the boundary cannot shorten, because its
  last position is the window's oldest record, which bounds nothing below it;
  it pays the single sort's cost, so paging to the very end of a flood window is
  as expensive as the old form was. `tests/unit/logs-page-boundary.test.ts`
  holds the equality of the two reads on a fixture whose boundary falls inside a
  group of ties, on a later page and on a window shorter than the page reaches;
  `tests/integration/logs-paging.test.ts` holds the pinned store's recorded
  answers for every page of the 5,000-record window; `WALK-LOGS-LATENCY
  --large-window-records` plants a window that large on the VM, with no flood.
- **The adapter's internal contract, and where the vendor stays (N6, N9).** The
  adapter is split in two files: `loader/src/logs-query.ts` builds the filters and
  the cursor, and `loader/src/logs-store-adapter.ts` is the only place that knows
  the store's metric and flag names. It uses exactly these operations:
  `POST /select/logsql/query` (records and counts), `GET /health` (availability),
  `GET /metrics` (two gauges: free disk space and the read-only flag) and
  `GET /flags` (the process's effective flags, used to prove a retention change
  applied). A replacement store implements those five operations and nothing
  else; the two `vl_*` gauge names and the flag names live in the adapter, which
  is the only vendor-aware file — generic code elsewhere names none.
- **Unavailable is an answer, not an empty list.** If the store does not answer
  within 5 s, or answers 5xx, or answers 429 (read-only), the adapter returns
  `{state: "unavailable", reason: <code>}` — never an empty table. A 200 with
  zero rows means the store really holds no matching line.
- **Freshness (F9).** The collector emits a heartbeat record through the same
  pipeline every 30 s (`module="collector-heartbeat"`). The adapter reads the
  newest one's `_time` with one query — one module's records, ordered by `_time`
  alone, so the cheap shape above rather than the tie-break's — and the page
  shows, above the results,
  `collection stopped N minutes ago; results may be incomplete` when that age
  passes 90 s. When the store's `vl_storage_is_read_only` is 1 the page adds
  `the store is refusing writes (read-only)`, so a reader can tell a stopped
  collector from a refusing store. *Not measured end to end:* the Docker run
  stored the heartbeats (4 in 8 s, 8 in 16 s at a 2 s interval) and the page's
  query found them, but on the cluster two runs stored 0 in every phase for a
  cause not found, so the signal's wiring is check L14. The status is read only
  after the page's records answered and rides on that answer (one status read
  per window), so the walk that measures the page measures the status beside it
  (L15). The 2026-11-09 flood's `collection unknown` arrived with an answer,
  which makes it a heartbeat query that did not answer or a store holding no
  heartbeat — L14's signal — rather than a page that timed out.
- **The page** is `web/loader/src/Logs.tsx` behind the loader's login on
  `boot-<name>.local/logs`, reached from the settings page. It reuses the kit
  components and the i18n pattern: a filter row (time range, module, level,
  conversation, text), the newest-first list, one expanded record with every
  field, `untrusted` on every task record, the freshness line, and
  "unavailable" with the reason. "Read like conversations" is the reading shape
  of the chat's transcript: time on the left, module and level as chips, the
  message as the body, fields behind a disclosure; no raw JSON view by default.
- **Routes (N8).** The new routes are `GET /api/logs` (query),
  `GET /api/logs/modules` (the module list, §3) and `GET`/`PUT
  /api/logs/settings` (the retention setting, §5). The matrix is stated per
  route **and per authentication state**, because the loader's table already has
  public exceptions that must survive: `GET /api/state`, `POST /api/setup` and
  `POST /api/login` answer **without a session** on `boot-<name>.local` — the
  first start needs them to choose the setup or login screen. Every new logs
  route requires a session on **every** method, `GET` included; `PUT` also
  requires the CSRF header and an exact Origin; all of them carry `no-store`, CSP
  and `nosniff`, answer 404 on any other host and 405 on a wrong method. The
  extracted table keeps every existing pair, including `PUT /api/model-capture`,
  and L11 asserts the matrix by route and auth state.
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

Measured query cost with the adapter's real form — about **4.3 GB on disk when
paging ran, 5.38 GB when the latency queries ran** — 40 queries each, 100-record
pages:

| Filter | p50 | p95 | max |
| --- | --- | --- | --- |
| a 1-hour window | 144 ms | 176 ms | 209 ms |
| `module=bulk-3` (1 of 20) | 84 ms | 104 ms | 110 ms |
| `module=bulk-3 AND level=info` | 86 ms | 101 ms | 103 ms |
| `conversation_id=conv_000123` (1 of 2,000) | 101 ms | 118 ms | 119 ms |
| text search `"bulk-3"` | 62 ms | 81 ms | 926 ms |

The earlier conversation figure of 1.72 s came from a query with no time
window; with the window the form above is fast at this size. *Not measured:*
latency at the owner's module mix and at the default 1.5 GiB bound with a full
day of data.


### 5. The setting, the disk, and the two things that bound the untrusted writer

**The setting.** `logs.retention` (`{days, maxBytes}`) is the owner's retention:
default 14 days and **1.5 GiB**, and the byte figure is the store's data bound, not
a disk quota. 1.5 GiB is what fits the 3 GiB volume: the bound plus the evictor's
threshold (1.5 GiB, below) is the volume exactly, which is the largest bound the
page accepts; the old 5 GiB bound no longer fits anything the owner is willing to
give up. It is stored in `/var/lib/loader/logs.json` with
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
| `VL_storage_minFreeDiskSpaceBytes` | `-storage.minFreeDiskSpaceBytes`: not an owner setting, derived by the loader as 25 % of the PVC's capacity (§5) |

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
(`lifemodel-logs-settings-defaults`, owned by Flux, never written by anyone, and
generated so that its name carries the content hash described below) and the
store's `envFrom` lists the loader's ConfigMap **after** it with
`optional: true`, so on a first start the defaults apply and, once the loader
has written its own, the later entry wins. Flux owns the defaults; **Flux must
not own the loader's ConfigMap**, or a reconcile would revert the owner's
setting. The defaults are generated as well (lifemodel-vbog.5.10): the step's
kustomization turns `deploy/platform/logs-store/config/settings-defaults.env`
into a ConfigMap whose name carries its content hash, and the store's `envFrom`
is rewritten to that name, so a release that changes a default changes the pod
template and replaces the store's pod; the store reads `envFrom` once, at
start.

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

**New, narrow rights, and the two admission lists they need (N6).** The rights
alone are not enough: the admission clamps in
`deploy/platform/a0/admission-policies.yaml` decide which ConfigMap names may
appear in `lifemodel-system`, and the new projection is not in either list today.
So the change is three parts, all checked:
- the loader's settings Role gains `get`/`update` on ConfigMap
  `lifemodel-logs-settings` and `get`/`patch` on Deployment `logs-store` in
  `lifemodel-system`, in `deploy/platform/a/loader-settings-rbac.yaml`;
- **both** admission ConfigMap lists in `admission-policies.yaml` — the
  create-by-loader clamp and the loader-exclusive ownership list — gain
  `lifemodel-logs-settings`, and the Deployment clamp admits a patch to
  `metadata.annotations` and `spec.template.metadata.annotations` of `logs-store`
  only;
- a test asserts, from the rendered manifests, that the loader may create and
  update that ConfigMap, that another identity may not, and that the Deployment
  patch is refused for any other field.

**How "applied" is proved, with those rights.** The loader reads the Deployment
and its pod, and the store's flags through the adapter's `GET /flags`. The
predicate is: `status.observedGeneration` equal to the generation the loader
patched, `status.updatedReplicas` and `status.availableReplicas` equal to the
replica count, the pod's own `controller-revision-hash`-equivalent annotation
matching the loader's `desiredRevision`, and the flags read back from that pod
equal to the desired ones. Pod metadata does not carry a Deployment's generation,
so the loader writes the revision into the template as an annotation and reads
it back from the pod's annotations; it needs only `get` on pods in
`lifemodel-system` for that, which is added to the same Role. Until every
condition holds the page says `pending` with the reason
(`store_unavailable`, `rollout_timeout`, `forbidden`, `mismatch`).

**Logs live on a volume of their own (N1, owner's decision).** The store's data
does not sit on the filesystem it shares with Postgres, k3s and the loader. It
sits on a **file-backed ext4 filesystem on the node**, mounted at
`/var/lib/lifemodel-logs`, created and mounted by the host, and reached by the
store through a `local` PersistentVolume. Nothing about the store's pod changes
for Pod Security: the volume is what the store mounts, not a `hostPath`, so the
store's namespace keeps its level and only the collector's namespace needs the
`privileged` exception (§7).

*How the host creates it, in both installers:*
- `deploy/nixos/default.nix` gains `services.lifemodel.logsVolumeSize` (default
  `"3G"`) and a `fileSystems."/var/lib/lifemodel-logs"` entry whose device is the
  image file with the `loop` and **`nofail`** options — a log volume must never
  keep the machine from booting — plus a `systemd.services` unit ordered before
  that mount which creates the image with `fallocate -l <size>`, formats it once
  with `mkfs.ext4`, mounts nothing itself and leaves an existing image alone. The
  unit also creates `/var/lib/lifemodel-logs/data` (the PV's path, § above) owned by
  **`1000:1000`, mode 0750** — the uid the store and the evictor run as (§5), so a
  fresh volume is writable without relying on the kubelet's `fsGroup` handling of
  a `local` volume. It is
  ordered `before = [ "k3s.service" ]` only as a best effort: with `nofail`,
  k3s starts whether or not the mount succeeded, and the store pod waits in
  `ContainerCreating` instead of the host waiting in boot. `e2fsprogs` and
  `util-linux` are in the unit's `path` (`check-k3s-commands.mjs` covers that
  list, as it already does for the resolv and DNS units).
- `scripts/install.sh` does the same steps (`fallocate`, `mkfs.ext4`,
  `mount -o loop`, `install -d -o 1000 -g 1000 -m 0750 data`) and installs the
  same unit with
  `--logs-volume-size SIZE` (default `3G`); `--render-only DIR` prints the unit
  and the systemd fragments it would install, which is the mode `flake check`
  renders. On a machine **already installed**, the same command is a no-op for
  k3s and the platform and adds the volume: it creates the image if absent,
  mounts it, and the store's pod binds on its next retry. After a reboot the unit
  runs before the mount and the mount's `nofail` keeps a broken volume from
  blocking boot; nothing has to be re-run by hand. **An upgrade of an existing
  instance adds the volume with no compatibility code**: the artifact's PV is new,
  the PVC is new, and the volume directory starts empty, so a store that had never
  run simply begins with no history.
- `flake check` gains an assertion on both rendered outputs: the mount point, the
  `data` subdirectory (mode 0750, owner 1000:1000), the image path, `nofail`, the
  size option reaching both, the unit's binary list, and a size below 2 GiB
  refused.

*The file is a reservation, not a sparse claim.* `fallocate` allocates the blocks
up front, so the host's free space really drops by the size of the volume; a
sparse file would let the host run out from under it, which is the failure this
design is removing. The owner gives up exactly that much host disk, once.

*When the disk has not got the room*, the installer does not shrink silently and
does not continue: it prints the size asked for, the free space it found, and
stops before creating anything (`--logs-volume-size` is how it is changed). On
NixOS the unit fails with the same sentence and the mount never appears, so the
platform starts without logs rather than with a half-made volume.

*The smallest volume is 2 GiB, and both installers refuse less.* The evictor's
threshold is the margin plus 768 MiB (§5), so a 3 GiB volume keeps at most 1.5 GiB
of logs, a 2 GiB volume at most 0.75 GiB — and at 1 GiB the threshold would be the
whole volume, so every run would remove everything and keep nothing. The
installer prints the size, the minimum and stops, and `flake check` asserts the
refusal on both rendered outputs.

*The volume's owner.* The PV is a cluster-scoped `local` volume created by the
signed artifact's `platform-logs-store` step, bound to the store's PVC by
`volumeName` with `storageClassName: ""` and a node affinity on the node's name.
Flux owns the object and prunes it with the step; the *data* is a file on the
host, so a pruned and re-applied PV rebinds to the same directory and no log line
is lost by a reconcile. The storage module (ADR-015) never sees it: its custody
is SeaweedFS and nothing here touches it, and the PV carries no key, no
credential and no secret.

*Raising the size is an installation step, not a page setting.* The page can
change retention; it cannot grow the volume. The owner raises the size with the
installer option, or on NixOS by changing the option, and the installer grows the
image and the filesystem. That is stated on the page next to the retention
fields.

*The guarantee cannot vanish silently (the failure this section exists to
prevent).* The PV object is in the signed artifact, so a PVC created against it
**binds even when the host never mounted anything** — and then the store would
start, write to an ordinary directory on the root filesystem, and fill the disk it
shares with Postgres while reporting nothing wrong. The PV's path is therefore a
**subdirectory that only exists inside the mounted filesystem**,
`/var/lib/lifemodel-logs/data`, created by the host unit *after* it creates the
filesystem and mounts it. With no mount, kubelet cannot mount the volume, the store
pod stays in `ContainerCreating`, and **not one byte** reaches the root filesystem.
What the page says then: `unavailable — the log store's volume is not mounted` (the
store never answers `/health`), with the freshness line above the results (§4), and
nothing else about the platform changes: both log steps run at `wait: false` (§1)
and the platform starts. The collector keeps running with its checkpoint on the
host; when the unit mounts the volume, kubelet retries the mount, the pod starts,
and the buffered lines arrive with no restart of anything else.

*The PV is retained, and a released PV does not rebind by itself.* The PV sets
`persistentVolumeReclaimPolicy: Retain`, so deleting the claim never deletes the
data. But a `Retain` volume whose claim is gone goes to `Released` and stays
bound to the old claim's UID; re-applying the same manifest does **not** rebind
it. The design therefore handles it rather than assuming it: the store's PVC names
the PV by `volumeName`, and the artifact's step is applied through a small
pre-flight in the loader's first-start plan that, when the PV is `Released` and
no claim of the current generation exists, clears the stale
`spec.claimRef` — the one supported way to make a retained volume claimable
again — and then lets the claim bind. Without that, a re-install would leave the
store Pending forever, which is the state the page names.

**The bound, the volume and what a flood reaches.** The retention byte bound
(`maxBytes`) and the volume are two different limits, and the page keeps them
consistent with one rule it can actually evaluate: it **refuses a byte bound that
exceeds the volume minus the evictor's threshold** — 1.5 GiB at the 3 GiB default
— and says which numbers do not fit. The evictor keeps free space at or above the
threshold, so a bound above `volume − threshold` could never be reached: accepting
it would tell the owner that their bound does something when the evictor removes
the day first. It cannot predict the two-day floor either — that is the store
keeping the newest two days whatever the bound says — so the floor can still take
usage above the bound, and then the volume is what holds it, not the setting. The
store keeps at least the two newest days whatever the bound says (measured: a
300 MiB bound let usage reach 444 MiB), so **the volume, not the byte bound, is
the limit a flood actually reaches**: today's incompressible flood fills the
volume, not the bound. That is the point of giving logs their own filesystem — the
flood spends its own space, and displacement gives it back without touching the
rest of the machine (below).

**The margin inside the volume, and the evidence for it.** The store runs with
`-storage.minFreeDiskSpaceBytes` as a **share of the volume**, default 25 %, so a
merge still has room to finish inside its own filesystem. Measured in Docker on
loop-mounted ext4 images of exactly this shape, incompressible flood at full
speed (pinned images):

| Volume | Byte bound | Margin (25 %) | First refusal | Deepest free space below the margin | Outcome |
| --- | --- | --- | --- | --- | --- |
| 3 GiB | 2 GiB | 768 MiB | 1.5 GB accepted | 149 MB below (656 MB free, 4.9 % of the volume) | no panic, no restart; 429 read-only; 907,600 rows still readable; store `running` |
| 6 GiB | 5 GiB | 1.5 GiB | 5.5 GB accepted in 178 s | 548 MB below (1.06 GB free, 8.9 % of the volume) | no panic, no restart; reads fine (1,776,800 rows); merges freed space from 1.06 GB back to 1.49 GB while read-only |
| **3 GiB (the new default)** | none set in this run (1.5 GiB is the default, and the two-day floor dominates at this size) | 768 MiB | 2.12 GB accepted in 33.5 s | **694 MB below** (111 MB free by `statvfs`, 3.5 % of the volume; the store's own gauge read 839 MB at that same sample — the two disagree while merges hold reservations) | no panic, no restart; 429 read-only; 1,678,600 rows readable; store `running` |

The 3 GiB row is the `lifemodel-vbog.3` displacement round (3 GiB loop-mounted
ext4, `-storage.minFreeDiskSpaceBytes=805306368`, incompressible flood, 1 s
samples). It shows the margin is not comfortably wide: one round used 90 % of it.
At 1 GiB the same shape held — first refusal after 997 MB in 15.9 s, deepest free
222.7 MB, 45.8 MB below the margin, no panic, no restart, 561 500 rows readable —
but it stored only 842 MB, which is why 1 GiB is not offered as a size.

So on a dedicated filesystem the store **refuses cleanly**, and in these runs
at these sizes a merge did not hit ENOSPC: merges freed space, and the store
answered again once space returned — the flood stopped, or a day was removed.
**What separates these runs from the first
round's panic is the margin, not the volume.** The first round did use a volume of
its own — a 574 MiB ext4 loop device, 1.5 GiB offered — and it panicked with
`FATAL: cannot write ... no space left on device` because nothing stopped the
writes before the filesystem filled; the store then restarted and served reads
with 429 writes. The volume alone is not the guarantee; the margin inside it is
what makes the stop clean. The 25 % share is a hypothesis from these three runs (about 3× room at 6 GiB,
about 1.1× at 3 GiB in the last round), and L05 re-measures at the owner's size.

**Why 3 GiB by default.** The owner asked for less disk («просто сократи объем»).
The default bound (1.5 GiB) plus the evictor's threshold (1.5 GiB = the 25 %
margin, 768 MiB, plus 768 MiB of flood headroom) is exactly 3 GiB, and the room a
merge needs (measured 450 MB at a 5 GiB store in the shared run, less at this
size) comes out of the margin inside the threshold. It is the size the owner gives
up on the host, and it is an install option, not a constant in code. The volume is
small on purpose: displacement, not size, is what keeps it working.

**The alarm.** The page shows, above the results and on the settings page,
`log volume low: N MiB above the store's margin` when the store's
`vl_free_disk_space_bytes` is within 512 MiB of the margin,
`the store is refusing writes (read-only)` when `vl_storage_is_read_only` is 1 —
adding `the log evictor is failing or has not run` and the age of its last
successful run **only when that run is older than about two minutes**, so a
one-minute refusal between runs does not blame a working evictor — and
`retention does not fit this volume` when the byte bound exceeds the volume minus
the evictor's threshold. The settings form refuses such a bound with the two
numbers and the largest one that fits. All of it comes from the two gauges, the
volume size the adapter already knows, and the evictor's own records.

**What stays on the shared filesystem, and what bounds it.** Two things remain
outside the volume, and both are the kubelet's: the container log files the
collector reads (`/var/log/pods`) and the collector's own checkpoint directory.
Kubelet bounds the first by rotation — `containerLogMaxSize: 10Mi` and
`containerLogMaxFiles: 5` per container (measured on the node), so at most 50 MiB
of live log per container, plus the 10 s rotation check leaving a fast writer
overshoot its file (measured: a 67 MB `0.log`) — and nothing bounds the second
beyond its own size, which is one checkpoint file per log file (measured 12 KB
for 20,000 lines). Kubelet's image GC (unused images removed at 85 % used,
floored) still shares that filesystem, but it is no longer the log store's
neighbour: with logs on their own volume the store's write stop and the GC
threshold have nothing to do with each other, and the store's section states no
rule about the GC. What the collector's own usage costs on the host is a small
directory of checkpoints and the rotated log files the kubelet already kept.

**The boundary, stated exactly.** The volume is a real allocation limit: the
store's data and its merge temporary space cannot leave it, and the host has
already given up that space, so a flood of logs cannot take space that Postgres,
k3s or the loader need. That is the whole claim, and it is now true by
construction rather than by a probability. What the volume does not do: it does
not stop the store from filling *its own* volume (that is what it is for), it
does not protect the kubelet's rotated log files and the collector's checkpoint
on the host (bounded above), and it does not bound a merge *inside* the volume —
that is the margin's job, and if a merge there ever exceeds it, the store stops
and the page says so.

**Displacement of the oldest logs, with nobody acting (the owner's decision).**
«Новые логи должны вытеснять старые.» The store keeps the two newest days whatever
the byte bound says, so retention alone cannot free space while the volume holds
only today's and yesterday's partitions. That case is answered by a Kubernetes
**CronJob in the store's namespace**, `logs-evictor`, not by a person and not by a
container beside the store: k3s already runs Jobs, and a run that fails is an
object the owner and the platform can see.

*The CronJob.* `schedule: "* * * * *"` (every minute, the smallest a CronJob
allows), `concurrencyPolicy: Forbid`, `activeDeadlineSeconds: 60`,
`startingDeadlineSeconds: 55`, `backoffLimit: 0`, `successfulJobsHistoryLimit: 1`,
`failedJobsHistoryLimit: 1` — one readable success and one readable failure, never
a retry storm. `startingDeadlineSeconds` is what keeps the schedule alive: with
`Forbid` and no deadline a missed start is counted, and after 100 of them the
controller stops creating Jobs for that CronJob ("too many missed start times");
with the deadline it looks only at the most recent minute, so a stuck run or a
suspended cluster does not wedge it. The pod runs
on the loader image with its own entry point
(`command: ['node', '/opt/lifemodel/loader/dist/log-evictor.js']`, the same pattern
as the storage module), so it is pinned by the same release digest as the loader
and needs no new vendor image for twenty lines of `statvfs`, one HTTP call and one
`rm`. It mounts the log volume **read-write**: the PV is `ReadWriteOnce`, and on a
single node the store's mount and the job's do not conflict, because one node's
kubelet serves both pods.

*What a run does.* It reads the volume's free space; when it is below the
threshold it reads `POST /internal/partition/list` and, if the oldest day is
attached, calls `POST /internal/partition/detach` on the store through its Service,
then removes `partitions/YYYYMMDD` from the volume, then looks
again and repeats until free space is above the threshold. It always takes the
**oldest partition present** — every day the retention bound keeps goes before a
newer one, and today's partition only when nothing older is left.
`/internal/partition/detach` returns only after the queries reading that partition
have stopped, and a restart re-attaches a directory that is still on disk, so
**removal directly follows detach in the same run** and the pod does not exit
before the directory is gone; **removal happens only after `detach` returned
200 or the attached list confirms the day is already detached**, because removing
a directory the store still has open is unsafe. The latter finishes a lost detach
answer or a run killed before removal on its next run, logging the usual drop
with `alreadyDetached: true` and without another detach. Measured:
detach + `rm` took 0.05, 0.12 and 0.13 s for three drops. When no partition is left
and free space is still below the threshold — the volume holds something else —
the run removes nothing and exits non-zero, so the state is a visible failed Job
and not a silent loop.

*The threshold is derived from the volume, and it is a hypothesis the check
re-measures (L16).* The threshold is **the margin (25 % of the volume) plus
768 MiB**: 1.5 GiB at the 3 GiB default, 1.25 GiB at 2 GiB, 1.75 GiB at 4 GiB. The
fixed 768 MiB is one minute of a realistic flood on disk plus slack: measured
**7 MB/s** (420 MB a minute, 13 % of a 3 GiB volume — pino-like JSON lines,
564-byte records, 6.49× compression, 1.29 GB on disk from 6.41 GB of body in
178 s), and a CronJob may start up to a minute after it was due. Below the
threshold nothing is removed. An **incompressible** flood writes about 63 MB/s
(2.12 GB in 33.5 s, measured), so from the threshold it reaches the write stop in
about 24 s and waits there until the next run: **a refusal of up to about one
minute is expected in that case even when the evictor works**, and the collector
retries it from its buffer (§6).

*What it costs, stated plainly.* When one day fills the volume, **all of that day's
logs so far are removed at once**, including the lines that would explain the
flood; under a sustained flood what remains is only what arrived after the last
drop (measured at full speed on 3 GiB with the store at its 1 GiB limit: three
drops in 300 s, 23 845 600 rows accepted, 1 886 400 retained, no refused post, no
restart). A drop also loses what is acknowledged between `detach` and `rm`: **16 200
rows of 23 845 600 across those three drops** (2 800 + 7 500 + 6 000 acknowledged
in the window; 100 more of the last window belonged to a batch acknowledged before
the detach). A job pod runs once a minute: one Node start, one HTTP call and one
`rm` — its start time is *not measured* here (the loader image is not pullable
from the measurement environment); it requests `cpu: 20m`, `memory: 32Mi`, mounts
no other volume, writes nothing to the log volume, and writes to stdout **only
when it acts or fails**, so the collector stores one short line per drop and
nothing per idle run.

*The image, its rights and its key.* The CronJob runs as uid **1000**, gid
**1000**, `fsGroup: 1000` (the image's `loader` user) with `runAsNonRoot`,
`readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, every capability
dropped and `seccompProfile: RuntimeDefault` — the `restricted` level, which this
namespace enforces (only the collector's namespace is `privileged`, §7). No
ServiceAccount token is mounted: it calls no API, and its NetworkPolicy (§7) names
the store's port and cluster DNS and nothing else.

*The same owner on both sides.* The store runs as 1000:1000 too, and the host unit
creates the volume's data directory as 1000:1000, so the job can remove what the
store wrote. Measured on the pinned image: with the volume's root owned by
1000:1000 and the store started with `--user 1000:1000`, it created
`partitions/20261107` as `drwxr-xr-x 1000 1000`; after `detach`, the same uid
removed that directory successfully. `fsGroup: 1000` is set on both pods for the
same reason but is not relied on: the ownership comes from the host directory, not
from the kubelet's handling of a `local` volume.

*The key, and how it travels.* The partition key lives in Secret
`lifemodel-logs-partition-key` in `lifemodel-system`; **only the store and this
CronJob mount it** — the store as a file, read with
`-partitionManageAuthKey=file:///etc/vl/partition-key` (`-help` documents `file://`
for that flag, and it was measured on the pinned image: the store accepted
`/internal/partition/list` with the key read from that file and answered
`Expected to receive non-empty authKey when -partitionManageAuthKey is set`
without it) — and the job as a `secretKeyRef`. No other workload holds it and it
never appears in a manifest. Every partition call sends `authKey` (and `name`
for detach) in an `application/x-www-form-urlencoded` POST body, never a URL:
v1.53.0's `app/vlstorage/main.go` partition handlers and its vendored
`lib/httpserver/httpserver.go` `CheckAuthFlag` read `r.FormValue`, which accepts
these bodies. Error logging masks form keys but not URL query keys, so the prior
successful-detach measurement did not establish safety for an error. The job's own
line carries only the day, the bytes freed, the reason and, when applicable, the
already-detached marker. A roll of the key is a Secret update plus a store restart through the
existing revision path (§ above).

**The first key is the loader's to write.** The artifact ships the Secret empty,
so a store that starts before a key exists requires no `authKey` and answers
every partition call in `lifemodel-system`. In front of its first-start phase
plan - on every bootstrap attempt, beside the released-volume pre-flight - the
loader reads that Secret and, when the value is empty or absent from the data,
writes one key of 32 bytes from `crypto.randomBytes`, base64url so the store
reads the file as one token, in one patch with the revision
`lifemodel.dev/logs-partition-key-revision`. A key that is already there is
never replaced; a key written by hand without a revision only gets the revision,
whose random suffix is never the key and never a hash of it. The restart is the
retention setting's own path: the loader patches that annotation onto both maps
of the store's Deployment, leaves `lifemodel.dev/logs-settings-revision`
untouched and keeps its applied predicate intact, and calls the store proved to
run the key only when the Deployment's observed generation has caught up, every
replica is updated and available, and a pod of that template carries the
annotation. The key is never read back out of the store, and it reaches no log
line, no loader answer and no error message. A refusal is one warning: the next
attempt reads the same state, so a crash between the Secret write and the
restart requests that same restart again. The loader's only new right is `get`
and `patch`, by name, on that one Secret in `loader-logs-settings`; the A0
Deployment clamp admits the second annotation pair as it admits the settings
pair and still refuses every other field of that object. The evictor needs no
change: its next run reads the Secret through its `secretKeyRef`.

*If it crashes or stays down, or its image cannot start.* Nothing else is hurt:
the volume fills, the store answers 429 and keeps serving reads, the collector
retries from its in-memory buffer (§6), and the page says `the store is refusing
writes (read-only)` and names the evictor's last successful run. A missed or
failed run is also a Job object (`kubectl get jobs -n lifemodel-system`). If the
store's Deployment is rolling or the store is down when a run starts, `detach`
or the attached-list read fails (connection refused or an HTTP refusal), the run removes
nothing and exits non-zero, and the next minute's run tries again. A pod's network
policy reaches it only after the policy controller syncs it — measured on the
owner's machine on 2026-11-09: the evictor's pod got `ECONNREFUSED` for its first
second and 200 every second after — so a detach that no connection answered
(refused, reset or timed out) is retried with a short backoff for at most 20 s,
inside the Job's 60 s deadline, before the run logs `the log evictor removed
nothing`; an HTTP answer, whatever its status, is the store's verdict and is not
retried.

**Read-only has two causes, and the page tells them apart.** One is the evictor
failing or not running. The other is an **incompressible flood**: writes are
refused for up to about a minute between two runs even while the evictor works,
because one run cannot start sooner (§ above). So the page always shows `the store
is refusing writes (read-only)` when `vl_storage_is_read_only` is 1, and adds
`the log evictor is failing or has not run` **only when its last successful run is
older than about two minutes** — two intervals, so a refusal between runs does not
blame a working evictor. The collector's 429 retry covers both windows: proved
against a stub (Vector 0.61.0 with forced 429s: eight refusals retried with
0.2-7.4 s backoff, all 1 000 lines delivered exactly once); **not yet proved
against the real collector and store** — that part is L16.

*What the owner sees.* Each drop writes one structured line from the evictor
(`module=logs-evictor`, the day, the bytes freed, the reason) and the logs page
shows it as a **visible notice with the removed day and time**, above the results
for that day and once on the settings page, so the page never looks as though
those logs never existed.

**The deletion API is rejected, and stays off.** The API does exist:
`POST /delete/run_task?filter=<logsql>`, `/delete/active_tasks` and
`/delete/stop_task` behind `-delete.enable`, with `-deleteAuthKey` from v1.53.0 —
documented and measured here. The earlier statement that no API exists was wrong:
it came from the `/delete` path answering `unsupported path requested: "/delete"`
(measured), which is the wrong path. It is still not used, because at the store's
designed limit it is unsafe and it does not fit the case:

- **it kills the store at the designed memory limit.** With `--memory=1g` (the
  Deployment's limit) a delete task OOM-killed the store during the flood that
  needed it (exit 137, `OOMKilled`), and a delete that removed every row
  OOM-killed it at `--memory=2g` too, on a 210 MB partition;
- **the kill repeats.** The task is persisted in `delete_tasks.json`, so the next
  start reloads it and dies again within about a second (two restarts measured):
  with `restartPolicy: Always` that is a crash loop on the one pod that serves
  reads;
- **it cannot start when the space is needed.** It only runs when free space is at
  least the parts it rewrites: at 40 % free (1.28 GB free, a 1.64 GB partition)
  even a cutoff that matched 2 % of the rows answered `cannot proceed … retrying
  later` every second for 159 s and deleted nothing. When it does run it took
  14-18 s to free less than a detach-and-remove frees in 0.05-0.13 s;
- **it leaves blank rows**: 2 509 rows with only `_time`, `_stream` and
  `_stream_id` survived one completed delete (upstream #1798), invisible to a
  stream-only query but still there.

So the store's `-delete.enable` is never set, and the only mutation of stored logs
is retention plus the evictor's detach-and-remove.

**The untrusted writer is limited by an event count, and that is all it is (N3,
N5).** The collector applies a `throttle` transform to the untrusted namespace,
per pod, `threshold: 500` events per `window_secs: 1`, with the pod name as the
key. This is an **event-count limit** and nothing more:

- it does not bound bytes. 500 lines of 20 KB is about 10 MB/s, and the collector
  still reads, decodes and evaluates every line it discards, so a task writing
  large lines gets both throughput and collector work out of proportion to the
  count. That case is stated, not covered: a line larger than the collector's
  `max_line_bytes` is truncated, and there is no byte budget;
- it does not bound the day's total disk use: the volume is what bounds that
  (below), and the throttle has nothing to do with it;
- the rate's basis is a task's legitimate output, which is progress lines at a
  few per second; 500/s is a ceiling on events, chosen so a runaway task cannot
  hold a core busy forever, not a size guarantee.

Measured: a task pod writing 300,000 lines in about 2 s stored 20,650 and left
248,883 discarded (another run: 8,444 and 291,556 — exactly 300,000), with the
collector at 102 MiB and no restarts. The trusted pod beside it kept all 300 of
its lines, but the two writers did **not** overlap: the trusted writer finished
before the task burst began, so this measures unthrottled collection, not
simultaneous fairness under attack. The check L05 now runs both at once and adds
large records.

**What the page can say about a throttled pod (N5).** Two window counters per pod
are computed in the collector and written to the store as one record each
(`module="throttle-window"`): `input` (everything the pod wrote, counted before
the throttle) and `accepted` (what the throttle passed). `input` alone is not
loss — a pod under the limit has `input == accepted`. Measured in Docker: a
50/s writer under a 100/s threshold produced windows of 299 and 300 input with
299 and 300 accepted (nothing discarded); a 50/s writer under a 10/s threshold
produced windows of 300 input with 69 accepted, and 299 with 60. So
`discarded = input − accepted` **per pod and per window**. `discarded = input − accepted`
is exact only inside one window pair; the two counters are separate windows, so a
pod whose two windows do not both exist, whose records were dropped by their own
sink, or whose count has not arrived yet is shown as `unknown`, never as zero.
The record carries only the pod, the two counters and the window's start and end
time — no message text, no metadata — so a flood cannot inflate it.

### 6. Bounds and failure behaviour, measured

Figures are from the test VM's cluster (the real platform running beside the
proof namespaces, read only there) and from Docker runs of the pinned images.
Each says which, and each is labelled with the limit the raw output supports.

| Event | What was measured |
| --- | --- |
| Bound passed within the last two days | No eviction by retention. 600 MiB of today's records into a 300 MiB byte bound: usage 444 MiB, every record kept. Retention cannot free anything inside the two-day floor; the evictor is what acts there (§5) |
| Bound passed with older partitions present | Oldest partitions dropped first: the canary partition from 10 days ago and every older day of a second flood were dropped, today's 357,400 records stayed, usage 491 MiB |
| The write stop at a margin, on a shared filesystem (cluster) | One filesystem holding a Postgres pod and the store with an 8 GB margin: Postgres 0 → 913 rows and no failed insert was recorded (`pgfail` empty) — narrower than "no commit can fail"; the store stopped accepting writes with the lowest 1 s sample **41 MB under the margin** (7,959,154,688 against 8,000,000,000) at a store of **629,470,627 bytes**, with **46 samples** under the margin (not 46 elapsed seconds: the sampler lost time), then accepted again (`insert=200`, restarts=0) after a 256 MiB filler was deleted. Reads kept answering (252,400 rows). The flood's 235 "refusals" are **broken-pipe outcomes** of a store that answers 429 and closes without reading the body, not 235 observed HTTP 429 responses; the 429 text itself comes from the store's own log. At the minimum sample `active_merges` was 0, so that minimum is not attributable to merge space |
| What the write stop does not stop (Docker, pinned store) | At a **4.7–5.0 GB** store the deepest sampled free space was **450,441,216 bytes below** the margin (first sampled read-only deficit 115,757,056; largest one-second drop 295,325,696; merges active in 3 of 42 read-only samples). At a **13.2 GB** store (final size 13,202,649,343) it was **4,678,209,536 bytes below** the margin (first sampled read-only deficit 302,399,488; largest one-second drop 303,562,752; merges active in **52 of 52** read-only samples; 60 s from first sampled read-only to the last sample, and the run ended before the merge did; a lower free-space reading of 5,047,037,376 below the margin appears near the log's end without paired merge metrics, so 4.68 GB is the sampled minimum, not the deepest point). §5 |
| A drop on the cluster (wrapper account) | Run 2 shows 6,222,786,560 → 5,547,610,112 bytes (675,176,448) at the end of an interrupted run; the seven-second timing comes from the wrapper's account, and the later sample has no merge metrics, so the drop is consistent with a merge, not correlated with one. The 3,236,528,890 figure is accepted input bytes, not disk bytes |
| Store down 5 minutes | Writers unaffected; the collector stayed ready at 73 → 80 MiB for the ~700 buffered records; after the store returned the backlog was in it within ~10 s; 945 of 945 lines present |
| Collector restarted after 5 minutes down | 1,327 of 1,327 lines present, no duplicate (checkpoint on the node's disk); a pod deleted during the outage lost all 100 of its lines because the kubelet removed its directory first |
| A collector killed with its buffer full | **Not measured.** The run intended for it never reached the buffer edge: the buffer's size gauge read 0 while 20,000 lines had been received, and the pid it read was 1. What the mechanism implies: `acknowledgements` is inert here (kubernetes_logs does not support end-to-end acknowledgements — measured: Vector warns and ignores it), the checkpoint advances on delivery only, so a crash re-reads from the last delivered line and loses only what the kubelet has already rotated away, plus whatever was in memory. L07 sets the saturated state and the acceptable loss |
| A module restarted (pod replaced) | The previous pod's lines stay; a new pod's lines appear under the same `module` |
| A 500,000-line burst (~500 MB in ~25 s, two kubelet rotations) | 500,000 records stored, none missing (measured before the throttle existed; the throttle applies to the task namespace only) |
| A task pod at full speed, throttled (cluster) | 300,000 lines written in about 2 s: **20,650 stored + 248,883 discarded** in one run (**30,467 unaccounted at sampling** — the two counters were read at different times while the buffer still held records, so this is not a reconciled total), and **8,444 + 291,556 = 300,000 exactly** in another. Collector 102 MiB, 588 m CPU, no restart. The trusted pod kept 300 of 300, but wrote **before** the burst, so this is not simultaneous fairness. The measured sink buffer was 100,000 events, not the 500,000 of §3, so 102 MiB is not that buffer's worst case |
| Store restart on a retention change, 1 GiB store | 2.6 s / 3.7 s without an answering endpoint; healthy at 3.0 s / 4.6 s |
| Displacement at full speed, 3 GiB volume, store at its 1 GiB limit (Docker, pinned store) | Realistic pino-like lines (564-byte records, 6.49× compression, 7 MB/s on disk) filling the volume: the evictor dropped 3 days in 300 s (detach + `rm` in 0.05, 0.12, 0.13 s); **238 456 posts answered 200, longest 429 window 0 s**; 23 845 600 rows accepted, 1 886 400 retained; deepest free 1.70 GB against a 768 MiB margin; store **793 MiB RSS**, no OOM, no restart; **16 200 acknowledged rows of 23 845 600** were lost inside the three detach-to-remove windows |
| A delete task at the designed limit (Docker, pinned store) | At `--memory=1g`: one delete of the older half of a 988 MB partition finished in 13.9 s (peak RSS 228 868 kB, rows 11.23 M → 5.62 M, free 1.93 → 2.43 GB) and left **2 509 blank rows**; at 40 % free the same task never started (free 1.28 GB below the 1.64 GB partition; `cannot proceed … retrying later` every second for 159 s, nothing deleted); under a flood a delete OOM-killed the store (exit 137, `OOMKilled`), and at `--memory=2g` a delete that matched every row of a 210 MB partition OOM-killed it too; the task survives in `delete_tasks.json`, so two restarts reloaded it and died again within about a second (§5) |
| The heartbeat through the collector's pipeline | Docker: stored and found by the page's query (4 in 8 s, 8 in 16 s at a 2 s interval; author-reported from the Docker run). On the cluster: **0 in every phase, cause not found**; check L14 |


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
- **Store**: `logs-store-access` admits 9428 from the collector's pods, from the
  loader's pods and from the evictor's job pods; `logs-store-deny` denies the
  rest. Its egress is empty — measured: VictoriaLogs connects to nothing, and the
  deny policy changes nothing about ingestion or queries.
- **Evictor**: the job pods carry `app.kubernetes.io/name: logs-evictor` and get
  their own policy in `lifemodel-system`: egress is TCP 9428 to `logs-store`'s
  pods and DNS to kube-dns (the Service name must resolve), **nothing else**;
  ingress is none — it is a client only, reached by nothing, and it mounts no
  host path and no Secret but the partition key (§5).
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
    checkpoint directory `/var/lib/lifemodel-logs-collector` read-write (L13
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

The evictor adds no destination outside the cluster: its only peers are the
store's Service (9428, DNATed to the store's pod) and cluster DNS, both in-cluster,
and its network policy names exactly those two (§7). It has no ServiceAccount
token mounted and calls no API: it reads the volume and the store's HTTP API, and
that is all it can do.


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
4. **`conversation_id` reaches the core's turn lines, as that exact name (N11).**
   The mixin at `src/core/logger.ts:109` copies context keys onto every line
   unchanged, so adding `conversationId` would emit `conversationId` — a field
   the collector does not read (measured: a camelCase `conversationId` produces
   no `conversation_id`). The change is explicit: `TraceContext`
   (`src/core/trace-context.ts`) gains `conversationId`, and the mixin maps it to
   the emitted key **`conversation_id`**. Which conversation: **the one cognition
   runs the turn for**, resolved by the same rule cognition uses, not the raw
   signal recipient. A reply carries its recipient, but a proactive signal
   (`thought`, `contact_urge`, a reminder) has none, and
   `src/layers/cognition/processor.ts` then falls back to the primary recipient.
   The id is therefore set where the turn's recipient is settled and the trace
   context is established, before the turn's work, so a recipient-less turn is
   logged under the same conversation the chat shows. L02 includes a
   recipient-less, non-user trigger so the two rules cannot drift apart. One assignment puts it on the turn's model calls, tool results,
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
6. **Severity comes from the request's outcome, not from the slot's position
   (F6, N7).** The gateway decides `error` or `warn` **after** it knows whether
   the request is over: retry eligibility (the code's class, `signal.aborted`)
   and reserve availability are settled first, and one **final gateway record**
   is written for the request with the outcome's level — `error` when the request
   ends in failure at any slot, `warn` only for an attempt that will really be
   retried on another slot. That replaces "the per-slot line is `error` when the
   loop has no slot left", which misclassified two real cases: primary returns a
   non-retryable 400 while a reserve is configured (logged `warn`, then thrown
   without retry), and primary returns 500 with **no** reserve configured (the
   loop breaks, and the outer catch suppresses its own line because the failure
   was already logged). The terminal record is written even when the same
   failure was already logged as a retried attempt, so a request that ends is
   always findable by `level=error`. The core's own `'🤖 LLM request failed'`
   line (`src/llm/provider.ts:519`) is already `error` and stays so. L04 covers
   both cases above and asserts the final gateway record, not only the core's.


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
- **Logs have a disk of their own, and the owner gives that disk up once.** The
  store's data and its merges cannot leave the file-backed volume (§5): **3 GiB by
  default**, an install option, preallocated so the host really loses the space.
  Inside the volume the margin stops writes and merges recover it; outside it,
  the kubelet's rotated log files and the collector's checkpoint stay on the
  host, bounded by kubelet's rotation (50 MiB per container plus the 10 s check's
  overshoot). Nothing on the host's shared filesystem is left to a log flood.
- **New logs displace old ones, and the oldest day goes whole.** When the volume
  runs low, `logs-evictor` removes the oldest partition — yesterday's, then
  today's — once a minute at most (§5). A day that fills the volume is removed
  entire, including the lines that would explain the flood, and after a sustained
  flood only what arrived after the last drop remains. The page shows each drop
  as a notice with its day and time. That is the cost of a 3 GiB volume; the
  alternative the design rejected, the store's deletion API, can kill the store
  and is off.
- **The throttle is an event count, and a throttled pod's loss is reported as
  `input` and `accepted` per window, or `unknown`.** It does not bound bytes: a
  task writing large lines is not held to any size, and the collector still reads
  each discarded line. A trusted module is not throttled at all, so a fast
  trusted writer fills the disk as fast as the collector can store. Neither the
  throttle nor the margin is containment; the disk is the owner's decision.
- Measured cost: collector 45–102 MiB RSS (26 pods idle; 102 MiB through a
  150,000-line/s burst); store 46 MiB right after a start with 5.3 GiB of data,
  451–757 MiB while ingesting, up to 3.2 cores while merging on 4 CPUs. Disk: 5.3
  GiB stored for 7 GiB of raw JSON records of random text (about 0.76 bytes per
  byte); real log text compresses far better — pino-like JSON lines measured
  **6.49×** (6.41 GB of body to 988 MB on disk), and 5 GiB of repetitive test
  records took 4.3 MB — so the byte bound holds many more lines in practice.
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
| The host creates the log volume as a preallocated file and mounts it before the store starts | a host that cannot loop-mount, or an image left sparse; then the host's free space is not really reserved and the installer must refuse or convert it |
| The store's `vl_free_disk_space_bytes` and `vl_storage_is_read_only` describe the filesystem the store writes to | a deployment where the data path is a bind mount of another filesystem. Then the margin and the page's gauges must read the volume |
| A file-backed ext4 volume mounted with the `loop` option behaves like a block device of its size: free space never exceeds the file, and the store's writes and merges stay inside it | a filesystem that reports more free space than the file holds (a sparse image), or a host that reflinks it. Measured on two such images (§5); L05 re-measures at the owner's size |
| An instance's disk size is unspecified, and the log volume's size is an install option (**3 GiB by default**) rather than a figure in this design | an instance where the installer refuses the default for want of room; the owner then sets a smaller `--logs-volume-size` and a smaller retention bound to match |
| The log volume is one node's file and its PV is `ReadWriteOnce`: the store's pod and the evictor's job pod **mount it at the same time on that node**, which a single-node `ReadWriteOnce` allows (the restriction is across nodes, not across pods) | a multi-node cluster where the job lands on another node; then the job must pin to the store's node (`nodeAffinity` on the PV's node) or the volume needs `ReadWriteMany`, and L16 asserts the concurrent mount on a deployed build |
| The evictor's threshold (the margin plus 768 MiB — 1.5 GiB at the default volume) keeps free space above the 25 % margin between two runs, at 7 MB/s of realistic flood | a realistic flood faster than about 12 MB/s on disk, or a run that starts a minute late; then the store refuses for a moment and L16 re-measures the threshold. An incompressible flood is expected to refuse for up to a minute (63 MB/s) |
| The partition key in `lifemodel-logs-partition-key` is mounted only by the store and the evictor, and never logged | a manifest or a script that mounts it elsewhere, or a job that prints its arguments or environment; L16 and the manifest test assert the mounts |
| The gateway's `x-lifemodel-session` header carries the conversation on every model call the core makes | a new caller of the gateway that sends none; its failures then have no conversation, which is what the current code already does |


## Constraints (closed, each with its check and its fixture)

L01–L16 are the complete additional requirements of this design. Each has a
check that can fail for the stated reason. Some are repository work still to be
written; the walks run on a deployed build from a clean snapshot, and the stage
that runs each is named. No check may pass on a fixture that cannot fail.

| ID | Requirement / origin | Check and fixture |
| --- | --- | --- |
| L01 | Every workload and container on the node is collected, including the new log workloads and the platform's own; a pod with no metadata label is visible as `module=unknown` with its `pod` and `namespace` (F14) | `WALK-LOGS-ALL`: build the expected inventory from the cluster (`kubectl get pods -o jsonpath` over every namespace, plus the collectors and the store themselves), plant one identifiable line per container, then compare **by name** — every expected pod/container has its record, every record names an expected one, and `module` matches the label chain. A namespace-count check is kept as an additional check, never the oracle. Repository part: the ServiceAccount grants only `get/list/watch` on pods, namespaces and nodes |
| L02 | The record contract of §2, sent through the **real** logger and the **real** VRL (F4, F5, N11) | `tests/unit/logs-record-shape.test.ts`: run a pino logger built by `createLogger` through the real turn path, feed its stdout line into the collector's VRL with the pinned `vrl` binary, and assert `conversation_id`, `module`, `level`, `stream`, `untrusted` and the promoted `error_type`/`reason_*`. Fixtures: a reply trigger **and a recipient-less, non-user trigger** (`thought`), which must log under the primary recipient's conversation id — the same rule cognition uses; every level (pino 10–60 and the words incl. `err`), a coloured pretty line, a malformed JSON line, a line with no level, a forged `module`/`level`, a `lifemodel-motor` line (no promoted fields) |
| L03 | No value from an upstream response body reaches any stored log (F2) | `WALK-LOGS-MARKER`: a 32-character marker in a non-2xx response body and another in a refused 2xx body, driven through the **real core and gateway**, with the exchange capture **off** and then **on**; then a text search for each marker over the whole store, and the same search over every module's records. Assert: absent with the capture off, present only in the capture with it on, and the failure line carries `error_type` with `reason_check/path/got`. Repository part: `tests/unit/model-gateway.test.ts` asserts the response envelope has no `message`, and that the core's provider logs and errors carry no body text |
| L04 | A request that ends in failure is stored as `error`, an attempt that will be retried as `warn` (F6, N7) | `WALK-LOGS-LEVEL` and `tests/unit/model-gateway.test.ts`, four cases: primary 500 with **no reserve** (must end in a final `error` record); primary 400 with a **reserve configured** (non-retryable, must end in `error`, not `warn`); primary 500 with a reserve that succeeds (the attempt is `warn`, and there is **no** terminal error record); primary 500 with a reserve that also fails (terminal `error`). Each asserts the final gateway record for the request, not merely the core's |
| L05 | The log volume holds what a flood can do: a full volume with Postgres committing beside it, the store refusing cleanly, and the platform unharmed (F1, F8, N1, N3) | `WALK-LOGS-VOLUME`, on a deployed build with the volume at its install size: a Postgres pod committing every 200 ms on the host's *shared* filesystem and the log volume filled by an incompressible flood at full speed. Assert: the volume's busy percentage is reported and the host's shared filesystem never loses a byte to it; the store answers 429 read from the response, with no panic and no restart; reads keep answering; the store's free space never falls more than **10 % of the volume** below the margin, with the merge counters beside it; the page shows `log volume low` then `read-only`; retention or the evictor frees space and writes accept again without a restart; and the Postgres commits and the loader's page both continue. Then the throttle part: a task pod at full speed **concurrently with a trusted writer**, plus a task pod writing **20 KB lines**; the trusted writer loses nothing, the throttled pods' `input`/`accepted` windows reconcile, and the event rate is reported as the limit it is. One failure case belongs to the same walk: **with the host unit disabled so nothing is mounted**, the store must not start (its pod stays `ContainerCreating`), nothing must appear under `/var/lib/lifemodel-logs` on the root filesystem, the page must say the volume is not mounted, and enabling the unit must bring the store up with no other restart. A full volume is L16's case, not this walk's. The test VM has about 6 GiB free, so its volume size is an option there, not the default. Measured here on loop-mounted images: 3 GiB volume — 149 MB below a 768 MiB margin, no panic, 907,600 rows readable; 3 GiB volume in the displacement round — 694 MB below the same margin, no panic, 1,678,600 rows readable; 6 GiB volume — 548 MB below a 1.5 GiB margin, no panic, space recovered by merges |
| L06 | Retention: the byte bound drops oldest day partitions first, the age bound applies independently, and a bound above `volume − threshold` is refused (it could never be reached, because the evictor removes a day first); inside the two-day floor retention drops nothing and the evictor acts (L16) | `WALK-LOGS-BOUND`: 300 MiB byte bound, 600 MiB of today (no eviction), a 200-record canary 10 days old, a 0.7 GiB flood across 10 days (canary and older days gone, today kept); then a *separate* run with only `retentionPeriod` shortened and no byte pressure (the older day is gone and nothing else); then the page asked for a byte bound larger than the volume minus the evictor's threshold, which is **refused with the numbers**, and one that fits (`volume − threshold`, and one 1 MiB below it), which is accepted. Measured on the prototype for the first three; the two-day floor above the bound was measured as a 300 MiB bound reaching 444 MiB |

| L07 | What a collector crash loses, at the buffer's edge (F10, N10) | `WALK-LOGS-CRASH`: with the store down, write numbered lines **until the sink's buffer is at its configured maximum** (the run waits for `vector_buffer_size_events` to reach `vector_buffer_max_size_events`, with enough input to fill it and the source's received counter well above it); if that state is not reached the run prints `TEST NOT VALID` and **fails**. Then `kill -9` the **vector process** by its host pid (`k3s crictl inspect` — pid 1 means nothing was killed, which also fails), recover, and count missing and duplicate lines and the restart count. The acceptable outcome is stated, not judged afterwards: every line not yet rotated away by the kubelet is delivered **at least once** and no line is lost that was still in `/var/log/pods`; lines the kubelet has rotated away may be lost, and duplicates are allowed. If a run loses a line that was still in the kubelet's files, the guarantee changes to "delivered lines are never corrupted" and the design does not claim more. An unsaturated crash is a separate, informative case, never a substitute |
| L08 | The setting applies through the ConfigMap mapping, a durable desired revision, idempotent reconcile, and the admission lists (F3, F7, N6) | `WALK-LOGS-SETTING`: change 14 d → 7 d, 7 d → 14 d, crash the loader after the ConfigMap write and before the annotation (both orders), and repeat an identical PUT. Assert: `GET /flags` through the adapter holds the desired values (which requires `-envflag.prefix=VL_`); `applied` only when the Deployment's `observedGeneration` has caught up, `updatedReplicas`/`availableReplicas` equal the replicas, the pod's revision annotation equals `desiredRevision`, and the flags agree — `pending` with a reason otherwise; a first install boots from the defaults ConfigMap with the loader's ConfigMap absent (`optional: true`). Rendered-manifest tests assert both admission ConfigMap lists admit `lifemodel-logs-settings` for the loader's create **and** update and that another identity is refused, that the Deployment patch is clamped to the two annotation maps, that the Deployment declares no retention argument, and that the release manifest does not declare the revision annotation. The same unit and rendered-manifest tests cover the partition key at first start: an empty Secret is written once with one random key and the store restart is requested through its own template annotation, a non-empty key is untouched with no restart, a crash between the two writes requests the same restart again, the loader's new right is `get` and `patch` on that one Secret by name, and the Deployment clamp admits that second annotation pair while still refusing every other field. Measured on the prototype: the env mapping alone (`/flags` in three configurations) and 2.6/3.7 s without an endpoint, healthy at 3.0/4.6 s |
| L09 | A log step does not gate the platform's readiness (F11) | `WALK-LOGS-WAIT`: on the deployed build, a root Kustomization at `wait: true` over a child at `wait: false` whose pod cannot start (a bad image) and one healthy neighbour child; assert the root is Ready and the page shows the failure, and that the same fixture at `wait: true` keeps the root NotReady. **Not measured**: the prototype's own Flux fixture did not reconcile its children (`ReconciliationFailed` on all three, with the source itself `Ready`), so `wait: false` is unproven. The fixture mistake is named in the report; this check runs in the first stage that deploys the collector |
| L10 | The permitted egress set is exactly DNS, TCP 6443 to any address, and the store (F12) | `WALK-LOGS-EGRESS`: a probe pod carrying the collector's labels, a witness pod outside the policy, and listeners on another namespace's pod. Assert open: the store's 9428, DNS 53, the API Service 443, the node address 6443, **and another namespace's pod on 6443**; assert refused: that pod on 8080 and 443, a public resolver on 53, a public host on 443. Measured on the prototype exactly as asserted |
| L11 | Every route keeps its matrix, stated per route and authentication state, and every new logs route needs a session (F-route, GET auth, N8) | `tests/unit/loader-routes.test.ts`: the table names every method/path pair — `GET /api/state`, `GET /api/model`, `GET /api/model-status`, `GET|PUT /api/model-capture`, `GET|PUT /api/workbench-source`, `GET /api/workbench-status`, `PUT /api/model/primary`, `PUT|DELETE /api/model/reserve`, `GET /api/settings`, `PUT /api/settings/<key>`, `POST /api/setup|login|password|logout|onboarding/device`, `GET /logs`, `GET /api/logs`, `GET /api/logs/modules`, `GET|PUT /api/logs/settings` — with the authentication state each one allows: `GET /api/state`, `POST /api/setup` and `POST /api/login` answer **without** a session (first start), everything else under `/api/` requires one, and **every logs route requires one on every method, `GET` included**. For every pair: another host 404, wrong method 405, `PUT` without CSRF or with a wrong Origin 403, `no-store`/CSP/`nosniff` present. An unauthenticated bootstrap (state → setup or login) is asserted to keep working |
| L12 | No listed file grows | `npm run check:file-sizes`: `loader/src/http.ts` ≤ 1,512 lines and `web/loader/src/App.tsx` ≤ 1,310, every new file under 800 |
| L13 | The collector's namespace is the only `privileged` one, it holds exactly the collector, and its mounts are exactly the two named paths with their modes (F15) | `tests/unit/platform-pod-security.test.ts`: every namespace manifest in `deploy/platform` is `baseline` or `restricted` except `lifemodel-logs`, which is `privileged` and holds exactly the DaemonSet; the collector container has no `privileged`, no added capability, `readOnlyRootFilesystem`, `runAsUser: 0`, all capabilities dropped, and exactly two `hostPath` volumes — `/var/log/pods` read-only and `/var/lib/lifemodel-logs-collector` read-write. A persistent checkpoint is required, so a check that would remove it fails |
| L14 | The page never shows a healthy page for a stopped collector, and says when it does not know (F9) | `WALK-LOGS-FRESH`: stop the collector with the store healthy, then make the store read-only. Assert: within 90 s the page shows `collection stopped N minutes ago; results may be incomplete` above the results, and names `read-only` in the store case; restarting the collector returns the age below the threshold within one heartbeat period. Also assert the state **before any heartbeat has ever been stored**: the page shows `collection status unknown` rather than a healthy or an empty answer; and that a stalled pod-log collection with a healthy heartbeat is visible — the heartbeat is per collector, so the check kills the file source's reading (an unreadable `/var/log/pods` mount for one run) and asserts the page still says the results may be incomplete. **Not measured end to end**: Docker stored the heartbeats and the page's query found them; on the cluster two runs stored 0 in every phase, for a cause not found. This check runs in the first stage that deploys the collector |
| L15 | Paging is total and latency is inside the page's deadline (F13) | `tests/unit/logs-page-boundary.test.ts`, `tests/integration/logs-paging.test.ts` and `WALK-LOGS-LATENCY`. The equality the two-step read rests on: `logs-page-boundary.test.ts` asks the loader for pages of a window whose boundary falls inside a group of ties — first page, later page, a window shorter than the page reaches, an offset past the end — and asserts each page is the records one full three-key sort returns, with the boundary query's shape and order (`sort by (_time desc) | offset N+limit-1 | limit 1`), and that a small window is still one ordered read. `logs-paging.test.ts` pages the recorded pinned store (5,000 records at one timestamp, 300 byte-identical lines at another) in 250-record pages through the adapter, quiet and after one late record; assert every record exactly once, no duplicate, each page read at its own offset after its boundary, and the same page twice returns the same bytes. `WALK-LOGS-LATENCY` then measures 40 queries per filter — time, `module`, `level`, `conversation_id`, text, every other one the page after the first — and 40 status requests (the first page's `status=1`) with the real form, p95 under 2.5 s; `--large-window-records N` plants N records in every measured window so this can be measured at 1.5 million records without a flood (measured before the two-step read: 4.94 s for the ordered query over 1.68 million records in an hour against 0.16 s for the `_time`-only sort and 0.025 s for the count; measured on the prototype at 5.38 GB, the filters were 62–176 ms p95). The VM figure at 1.5 million records is the owner's to take with the walk |
| L16 | New logs displace the oldest ones on a deployed build: with the volume holding only today's and yesterday's partitions, the evictor frees space with nobody acting, and below its threshold it removes nothing (the owner's direction, 2026-11-07; F8, N1) | `WALK-LOGS-EVICT`, on a deployed build with the volume at its install size (3 GiB on the owner's machine; an option on the test VM): fill with today's and yesterday's records until free space passes the evictor's threshold, then keep writing at full speed for five minutes. Assert: the store does not restart (`restartCount` unchanged) and its log has no panic; each drop is one `module=logs-evictor` line naming the day and the bytes freed, and a notice with the day and time appears on the page; the oldest remaining row moves forward at each drop and what the collector accepted is still found (numbered and counted per window), except the rows acknowledged inside a detach-to-remove window, which are counted and reported; writes keep being accepted and any 429 window is shorter than two eviction intervals; and in a quiet period below the threshold two consecutive runs remove nothing and log nothing. The **real collector's** loss during a refusal is asserted here, not on the stub: stop the evictor for two minutes, let the store refuse, count the lines written in the window against those found after it. Three more assertions belong to this walk: the job's pod mounts the volume **while the store's pod has it mounted** (same node) and its `rm` succeeds as uid 1000:1000 on files the store created (the ownership arrangement of §5, checked with `ls -ln` on the volume); during an incompressible flood the page shows `the store is refusing writes (read-only)` **without** `the log evictor is failing or has not run`; and after stopping the evictor for more than two minutes the page adds that line. Measured here on loop-mounted images at 3 GiB with the store at its 1 GiB limit: three drops in 300 s, 23 845 600 rows accepted and 1 886 400 retained, no refused post, no restart, 793 MiB peak, 16 200 rows lost in the three detach windows |

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
  and a conversation filter's answer marks them. Its write rate is limited per pod
  by an event count (§5) — an event count, which does not bound bytes, and does
  not bound the disk. Nothing about a task's line grants it anything: the page is
  the loader's, behind its login.

## What it extends and replaces

- **Replaces** the platform's logging surface: today's "a module's log is its
  container's stdout, read with kubectl, gone when the pod is replaced" becomes
  a kept, normalized, queryable stream. The core's `data/logs/agent-*.log` file
  target stays as a local development artefact and is *not* the platform's log
  store; in the cluster the container's stdout is JSON and that is what is kept.
- **Extends ADR-010** (the signed artifact and its ordered steps) with the two
  steps of §1, both at `wait: false`, its pinning rule with two more digests, and
  one cluster-scoped `local` PV in the store's step.
- **Changes both installers** (`deploy/nixos/default.nix`, `scripts/install.sh`):
  a new option (`services.lifemodel.logsVolumeSize` / `--logs-volume-size`,
  default `3G`), one unit that creates and mounts the file-backed ext4 volume at
  `/var/lib/lifemodel-logs`, the `fileSystems` entry on NixOS, the same steps in
  the shell installer, and `flake check` assertions on both rendered outputs
  (mount point, image path, size, the unit's binary list). The installer refuses
  a size the disk cannot hold, with the figures. `deploy/nixos/README.md` and the
  install guides gain the option and one paragraph on what the owner gives up.
- **Touches no storage module**: the volume is not SeaweedFS custody, carries no
  credential, and ADR-015's store is unchanged.
- **Extends ADR-012** (the loader's interface and login) with one page, three
  API routes, one egress line and one route-table extraction; the page is on the
  loader's own host behind its own session, so a broken generation cannot take
  it away.
- **Extends ADR-015** (a platform module's shape) with the store's own
  ServiceAccount, NetworkPolicy and volume, and no caller credential; and with the
  evictor's CronJob, its own NetworkPolicy line and the one Secret it shares with
  the store.
- **Replaces the refusal on a full volume** with displacement: the store's own
  deletion API is rejected (it can kill the store at its limit), the
  `lifemodel doctor logs drop-partition` command is withdrawn, and the oldest day
  is removed by the evictor with nobody acting (§5).
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
  (L15), **WALK-LOGS-EVICT** (L16), **WALK-LOGS-MARKER** (L03),
  **WALK-LOGS-ALL** (L01), **WALK-LOGS-SHAPE** (L02), **WALK-LOGS-LEVEL** (L04) —
  as the L-table states them, with the fixtures given.
- **WALK-LOGS-SETTING-WALK** — the owner lowers the byte bound from the page
  before a heavy day, sees `applied`, and the store's own `/flags` agrees.

## Open, and what this record does not decide

- **The storage boundary is decided: a volume of its own, 3 GiB by default.** The
  owner chose a separate bounded volume («Отдельный том») and asked for less disk
  («просто сократи объем»), with the installers creating it and a size change
  going through installation rather than the page (§5). Two things follow and are
  not hidden: the host gives up the volume's space up front, and a store that
  fills that volume keeps answering reads while refusing writes until the evictor
  removes a day or the volume grows.
- **The 25 % margin inside the volume is a hypothesis from three runs** (3 GiB
  twice and 6 GiB once), where the deepest undershoot was 149 MB, 694 MB and 548 MB
  against margins of 768 MiB, 768 MiB and 1.5 GiB. L05 re-measures at the owner's
  size; if a merge exceeds the margin there the store stops, the page says so, and
  nothing outside the volume is harmed.
- **Displacement is the answer to a full volume, and its thresholds are
  hypotheses.** The evictor's one-minute cadence and its threshold (the 25 %
  margin plus 768 MiB — 1.5 GiB at the default volume) are arithmetic from measured
  rates (7 MB/s realistic, 63 MB/s incompressible), not a measurement of the
  deployed loop; L16 re-measures both, and a refusal of up to
  about a minute under an incompressible flood is expected. What is decided: the
  oldest day goes whole, today's last, and no deletion API is enabled.
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

Two places. On the test VM's single-node k3s — the real platform running, read
only outside the proof namespaces — the proof manifests live in
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
| Displacement, and why the deletion API is rejected | loop-mounted ext4 images (3 GiB, 1 GiB), the pinned store at `--memory=1g` and `2g`; pino-like JSON lines (564-byte records, 6.49× compression); a 1 s sampler of `statvfs` free space, the container's RSS and `vl_storage_is_read_only`; `POST /internal/partition/detach?name=…&authKey=…` followed by `rm -rf partitions/<day>`; `POST /delete/run_task` with cutoffs chosen from `stats by (_time:1m)`/`(_time:10s) count()`, `docker inspect` for `RestartCount`/`OOMKilled`, and a `seq` field counted with `seq:range[lo,hi]` for what is acknowledged between detach and remove |
| The throttle and its per-pod gap | a task pod writing 300,000 lines at full speed, a trusted pod beside it; `vector_component_discarded_events_total{component_id="throttle"}`; a `reduce` window per pod written to the store as `module="collector-window"` |
| The env mapping | the same ConfigMap through `envFrom` in three configurations, read from the process's own `/flags` endpoint |
| Egress: observed and permitted | `tcpdump` on the node for 10 minutes without a policy; then the permit list applied, a witness pod outside it, and a probe pod carrying the collector's labels |
| Paging with tied timestamps | 5,000 records at one timestamp and 300 byte-identical lines, paged with the adapter's query form in 250-record pages, quiet and with ingest running |
| Memory | `kubectl top pod` and the container's own metrics |
| kubelet log policy | `kubectl get --raw /api/v1/nodes/<node>/proxy/configz` |
