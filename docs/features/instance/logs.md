# The logs page

Every module's lines stay on this machine and are read in the loader (ADR-016).
The page is at `https://boot-<name>.local/logs`, behind the loader's login, and
is reached from the loader's settings page (`/logs` is the non-boot host's
alias only where the loader itself serves it; the settings link is the way in).

## The list

- **Time range** — the window, newest record first. Paging keeps the window it
  was opened with, so a later page cannot mix two windows.
- **Module** — one module's records (the collector takes the pod's
  `app.kubernetes.io/name`, `app` or `k8s-app` label, `cnpg.io/cluster`, and
  falls back to `unknown`).
- **Level** — one stored level; the collector normalizes pino numbers and words
  to `trace`…`fatal`, and a line that names no level is `unknown`.
- **Conversation** — the chat conversation a turn ran for.
- **Text** — a substring of the stored message.

The record count line counts what is drawn; "Show older records" appends one
page of 200 while the window holds more. One record expands to every field, and
every task record carries `untrusted`.

A failure reads as **field and type**, never as a model's text: `error_type` and
`reason_check`/`reason_path`/`reason_got` (`got` is a JSON type name, `path` a
JSON path) where the request had a reason.

## Retention, and when a change applies

The retention card shows two numbers: **days** and the **byte bound** (MiB). The
page refuses a byte bound above the volume minus the evictor's threshold, with
the two numbers and the largest one that fits; such a bound could never be
reached, because the evictor removes a day first. Saving a change shows
`Waiting for the store` with its reason until the loader has proved the store
runs the new values; the store restarts once for it. The volume's *size* is an
installation option, not a page setting.

The store keeps at least the two newest days whatever the bound says, and new
logs displace the oldest day when the volume runs low (the evictor, once a
minute). Each drop is shown in the list as a notice naming the day, the time and
the space freed in MiB; that day's lines are gone from the store, including the
ones that would explain a flood.

## The lines above the results, and what to do

- `collection stopped N minutes ago; results may be incomplete` — the
  collector's heartbeat is older than 90 s. Check the collector's pod in
  `lifemodel-logs`; results already stored are still complete up to that point.
- `collection status unknown` — no heartbeat was ever stored: a fresh instance,
  or the wiring is broken. The page never guesses health from an empty answer.
- `the store is refusing writes (read-only)` — the volume is at its margin. The
  collector retries from its buffer; the evictor frees space once a minute. When
  `the log evictor is failing or has not run` appears beside it (its last success
  older than about two minutes), look at the evictor's Jobs and pod in
  `lifemodel-system`.
- `log volume low: N MiB above the store's margin` — the volume is close to
  refused writes; nothing to do unless it persists.
- `unavailable — <reason>` — the store did not answer; the page says why instead
  of showing an empty list.

## Task pod throttling

Above the records, the page shows discarded **events per namespace/pod and paired
6-second window**, over the chosen time range, independently of message
filters. The collector stores two counters under `module=throttle-window`:
`input` before throttling and `accepted` after it. For exactly one valid pair
with matching pod and window boundaries, discarded is `input - accepted`.
Equal counters mean no events discarded; input alone never means loss.
Missing, invalid or duplicate counters show **discarded count unknown**,
never zero. Counter records include the collector process's `collector_start`.
A window that starts before that process started is partial and unknown;
counters from different processes cannot form an exact pair. Missing whole
windows between a pod's first and last evidenced windows appear as unknown
intervals only when the collector process changed across the gap. A gap in
one collector process can simply be an idle pod and is not called loss. One unknown pair or interval makes the overall status unknown,
while valid pairs still show their own exact loss. A store failure or a
truncated counter read is unknown too.

The first page reads the counter snapshot once; older pages preserve it.
Any untrusted pod visible in the first page with no counters is shown as unknown,
including pods outside the motor namespace. The namespace and pod together
identify the quota and the displayed counter; empty identities are shown as `?`.
When neither counters nor task records are available the overall result is
unknown. Completely missing leading or trailing windows cannot be detected
without evidence; no total is inferred for them. Separate input and accepted
records can arrive at different times, and a crash can lose their in-memory
counts. These counters are not a durable audit of every event.

The limit counts events, not bytes: long lines can still use substantial disk
space. After a collector restart or outage, a task’s backlog can be partly
discarded by the limit even if the task never wrote faster than 500 lines/s,
because the limit counts lines as the collector processes them, not by their
timestamps. The page shows those lines as discarded for that processing window.
Counters are collector-owned fields, not parsed task message text.
Normalized task records always carry `untrusted` and cannot supply a counter,
even if their pod label says `throttle-window`.

## If the collector is killed hard

If the log collector is killed hard, the page can miss up to about a second of
lines written just before the kill; nothing else is lost.

## Nothing leaves the machine

The collector reads this node's pod log files, the store keeps them on a volume
of their own, and the loader reads them; no peer outside the machine receives a
stored line. The model gateway's error answers carry a code, never an upstream
body, and the exchange capture is off by default — with it on, an exchange is
kept only in Postgres for 24 hours and read by `lifemodel doctor exchange`.
