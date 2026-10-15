# ADR-011: The owner's web interface and its first module

Date: 2026-10-15.

## Status

Proposed (lifemodel-vhd design, 2026-10-15). It amends ADR-010 in the three
places named under "Amendments to ADR-010" and leaves the rest of ADR-010
unchanged. The target view it serves is
`docs/features/instance/web-interface.md`.

## Context and problem

Charter instance-1, outcome 8: behind the loader's password the owner writes
in the web chat and gets lifemodel's answer. The conversation survives a
switch of generations, with no message lost or answered twice. The web chat
is the milestone's only channel (Telegram is out, owner 2026-10-11).

lifemodel-avy left the core stateless:
- it reads owner messages from the Valkey stream `inbound`, with offsets and
  a dedup ring inside its epoch-checked snapshot;
- it commits each answer as a `send.command` on the stream `outbound`;
- after the commit it writes the assistant row into
  `core.conversation_messages` by its natural key (`eventId`), and replays
  safely after `kill -9`.

That row writer is marked as a stand-in for "the future ingress gateway send
applier". Nothing serves the owner a page yet. The loader already holds the
owner's password, a signed session cookie shared by every `*.localhost` host,
and `/_auth/verify` for Traefik ForwardAuth. Traefik routes only
`boot.localhost`, without ForwardAuth.

The problem: what the web module is, what it owns, how answers and the
creature's state reach an open tab, and how this first version stays on the
way to the target view without rework.

## Decision drivers

Outcome frame: one person, the owner, talks to their own lifemodel. A lost or
doubled message breaks trust in a "digital human", and the chat is how the
owner will ask for self-changes (outcome 7).

Quality attribute scenarios (each becomes a check, see "Checks"):

| # | Stimulus and condition | Response | Measure |
|---|---|---|---|
| S1 | The owner sends a message; the module crashes right after Valkey acknowledges the XADD | The tab shows the message as sent only after the durable append; a retry with the same client message id is not a second message | 0 duplicate rows, 0 lost messages across 100 crash-injected sends |
| S2 | The core StatefulSet rolls to a new image (deploy-branch commit) while the owner keeps sending | The module keeps accepting | 0 refused sends during the rollout; every message answered exactly once |
| S3 | The core commits an answer, or writes first on its own, while a tab is open | The row appears in the tab without a reload | p95 ≤ 2 s from row insert to render on the test VM |
| S4 | The tab's event stream drops and reconnects | The tab receives every row it missed, once | 0 gaps and 0 duplicates in the rendered transcript |
| S5 | A request without a valid session reaches any web route (page, API, events) | Denied or redirected to the loader's login; no content | 100% of routes in the route table |
| S6 | A form post comes from another origin | Refused | 403, nothing appended |
| S7 | A model answer contains HTML or a script | Rendered as text or sanitized markdown; nothing executes | the XSS fixture set renders inert; CSP forbids inline script |
| S8 | The module is down | The core keeps running and committing; answers accumulate as rows | the core's commit progress unaffected; the tab catches up on return |
| S9 | A long history (10 000 rows) | The tab opens on the latest page and loads earlier pages on scroll | first render reads one page (≤ 50 rows); scroll pages by cursor |
| S10 | Keyboard and contrast | Usable by keyboard; text contrast WCAG 2.2 AA | axe-core check passes on the chat page |

Constraints, with their sources:

- ADR-010 Q5: the owner's whole web surface terminates on the web module (the
  "ingress gateway"). Traefik guards it with ForwardAuth to the loader. The
  core holds no front route.
- ADR-010 Q4 decision 6: the web-chat delivery proof is the message row,
  inserted by key.
- The owner, 2026-10-15:
  - the core is the only writer of the conversation history;
  - the creature has one state, with no per-message thinking statuses;
  - the frontend is React and the module is its backend;
  - modules reach Valkey and Postgres only through a code-level storage
    abstraction;
  - no attachments in instance-1;
  - the web module's own role and credentials come in lifemodel-2t5, in their
    target form.
- The owner, 2026-10-15: the chat is walked against an in-cluster stub model;
  real model access arrives with lifemodel-2t5.
- No generation operator yet (lifemodel-pwe): "a switch of generations" in
  this feature is a core image change rolled through the deploy branch.

## Considered options

### D1 — who writes the conversation history

- **O1-A: the core writes every row; the web module only reads (chosen).**
  This keeps the row writer lifemodel-avy built and walked
  (`applyCommittedOutboundEvents`, natural key, offset after the write).
  - Steady state: one writer; rows are in commit order, so the table's
    `sequence` is a monotonic cursor.
  - Failure: a web module outage stops nothing in the core (S8).
  - Security: the web module needs no write grant on the core's schema.
  - Growth: a second channel whose delivery can fail (the Telegram gateway,
    lifemodel-yku) consumes `outbound` and reports its own settlement. That
    is added with it.
- **O1-B: the web module applies `cmd.send`, inserts the row by key and
  publishes `send.settled` (ADR-010 as written).** Two writers of one table.
  The core's turn settlement waits on a module that faces the browser, so a
  web module outage stalls answer settlement. For a pull channel, "delivered"
  adds nothing to "the row exists". Rejected by the owner's "the core is the
  only writer".
- **O1-C: no history rows; the tab reads the snapshot and streams (the
  assumption O1-A and O1-B share, rejected).** History would live in Valkey
  streams trimmed at 10 000 events or 30 days, so the owner would lose old
  conversation. Rejected: the history is long-lived state (ADR-010 Q4 row 6).

### D2 — how new rows and the creature's state reach an open tab

- **O2-A: Server-Sent Events from the web module (chosen).**
  - The source of truth is Postgres rows after a cursor (`sequence`). An
    XREAD BLOCK on `outbound` and on the creature-state key's stream is only
    a wake-up hint, with a 1 s fallback poll.
  - Each SSE event id is the row's `sequence`. On reconnect the browser sends
    `Last-Event-ID`, so catch-up is the same query (S4).
  - SSE is one-way, which is all the server needs to push. Sends stay plain
    POSTs with a client message id (S1).
- **O2-B: WebSocket.** Two-way, but sends already have a durable,
  idempotent POST, and a socket would need its own replay and acknowledgement
  protocol. More to build, nothing gained for S1–S4.
- **O2-C: polling only.** Simple, but S3's 2 s means polling every second
  from every tab, forever.

### D3 — the creature's state

- **O3-A: the core publishes one creature state, best effort (chosen).**
  - The state is `thinking`, `awake` or `asleep`, plus `readThrough`: the
    last inbound message id the core has taken into a turn.
  - It is written to one Valkey key, with an event on a small capped stream
    `creature` as the wake hint, at turn start and end and on a sleep
    change.
  - It is not part of the commit: losing it on a crash only delays the
    indicator to the next tick.
  - The tab shows a "•••" bubble while thinking, presence in the header, and
    "Прочитано" under the owner's last message when `readThrough` covers it.
- **O3-B: per-message statuses (accepted, thinking, answered).** Rejected by
  the owner: the creature thinks as one, not per message.

### D4 — where the module's code lives and how it reaches the stores

- **O4-A: one package in the root project (chosen).**
  - The server is `src/web/`, the React app is `web/app/` (Vite), and the
    shared storage interfaces are in `src/storage/` and `src/ports/`.
  - The server entry is bundled with esbuild into one file, so the web image
    carries only the code the server imports. The web image's digest then
    changes only when that code or the app changes.
  - The module sees narrow domain operations, never a raw client:
    `appendInbound`, `readTranscript(after|before, limit)`,
    `watchTranscript`, `readCreatureState`.
- **O4-B: npm workspaces (`packages/storage`, `packages/web`).** Cleaner
  borders, but a repository restructure that touches every build, test and
  CI path. Deferred until a second consumer outside the root project exists.
- **O4-C: a storage service in front of Valkey and Postgres.**
  - It would add a network hop to every core tick and become a single point
    of failure for all modules, and the core's atomic epoch-checked commit
    would have to move into it.
  - The operation-shaped interfaces of O4-A are the seam it would later sit
    behind. Kept as an idea, with its triggers: a module in another language,
    or the need for one access-control and audit point.

### D5 — credentials until lifemodel-2t5

- **O5-A: the web module uses the core's existing store credentials until
  lifemodel-2t5 (chosen by the owner, 2026-10-15).**
  - Its code reaches only the D4 operations.
  - lifemodel-2t5 gives it its own identity: the service account, an OpenBao
    role, and leased credentials scoped to `XADD inbound`, reads of
    `outbound` and `creature`, and `SELECT` on the transcript.
  - Risk until then: a compromised web module holds the core's full store
    rights. Mitigations: the module is reachable only through Traefik,
    behind the owner's session, on the owner's network, and the code exposes
    no raw client.
- **O5-B: a static web role now, delivered by a loader-copied Secret.**
  Safer from day one, about one stage longer, and the delivery is replaced by
  lifemodel-2t5. Declined by the owner for now.

## Decision

1. **The web module** is a new Deployment `web` in `lifemodel`:
   - RollingUpdate with `maxSurge: 1` and `maxUnavailable: 0`, so it keeps
     accepting through its own rollout;
   - its own image `ghcr.io/<owner>/lifemodel-web`, digest-pinned in the
     release seed like the core;
   - readiness means the Valkey and Postgres operations answer.
2. **Traefik routes** host `localhost` to the module, with a ForwardAuth
   Middleware to the loader's `/_auth/verify`.
   - The loader's own `boot.localhost` route gets the same Middleware, so the
     loader's pages are guarded at the edge as well as by the loader itself.
   - Network policies: Traefik → web; web → Valkey and Postgres; web → DNS.
3. **The HTTP surface** of the module:

   | Route | Purpose |
   |---|---|
   | `GET /` and the app's static assets | serves the built React app |
   | `POST /api/messages` | body `{ id, text }`; `id` is a client UUID |
   | `GET /api/transcript?before=<seq>&limit=50` | history pages, newest first |
   | `GET /api/events` | SSE: `message` (rows after the cursor), `state` (the creature state); event id is the row `sequence` |
   | `GET /api/state` | the creature state now |

   - `POST /api/messages` appends `inbound.message` to `inbound`, with
     `messageId = id` and the owner's web recipient. It answers 202 only
     after Valkey acknowledges the XADD (AOF `appendfsync always`). A repeat
     with the same `id` is absorbed by the core's dedup ring.
   - Every POST checks the Origin header. Responses carry a strict CSP: no
     inline script, `connect-src 'self'`.
4. **The owner's recipient:**
   - one recipient, channel `web`, in the recipient registry. The core's
     answers and its own first messages go to it;
   - the row key of an owner message is its client `id`, so the tab matches
     its optimistic bubble to the row;
   - the `outbound` stream stays as the core's committed-send log for later
     channels. The in-process delivery stand-in logs `web` as a pull channel
     and keeps no delivery cursor for it.
5. **The core** publishes the creature state (D3) and stays the only writer
   of `core.conversation_messages` (D1).
6. **The frontend:**
   - React, TypeScript and Vite, TanStack Query for reads, and an
     EventSource for live events;
   - react-markdown without raw HTML for answer text;
   - CSS custom properties as design tokens;
   - layout per the target view: left navigation (Разговор, Система), the
     conversation in the middle, the "Сейчас" panel on the right with the
     creature state only, and one column on narrow screens.

## Amendments to ADR-010

1. **The ingress gateway's send applier, `cmd.send` → INSERT-by-key →
   `send.settled`, is withdrawn for the web channel.**
   - The core inserts the row (D1).
   - The web module's matrix row in Q7 becomes: produce `inbound`; read
     `outbound` and `creature`; SELECT the transcript. There is no INSERT
     grant and no `send.settled`.
   - `send.settled` returns with the first channel whose delivery can fail
     (lifemodel-yku).
2. **The core's produce row in Q7 adds the `creature` stream and its state
   key** (D3).
3. **The `outbound` stream** is lifemodel-avy's name for what ADR-010 calls
   `cmd.send`; this ADR keeps `outbound`.

## Consequences

Good:

- One writer of the history. The web module failing never stalls the core
  (S8).
- Catch-up and live updates are one query, keyed by a monotonic cursor (S4).
- The module sees operations, not clients, so the role from lifemodel-2t5 and
  a later storage service fit behind the same seam.

Bad:

- Until lifemodel-2t5 the web module holds the core's full store credentials
  (D5).
- The owner's own message shows in history only once the core has taken it.
  Until then the tab shows it from its own memory, and a closed tab before
  that shows it only after the core runs.
- `sequence` is monotonic in commit order only while the core is the one
  writer. A second writer breaks the cursor, which is one more reason for
  D1.

## Assumptions (each with what invalidates it)

- **One writer:** the core is the only writer of
  `core.conversation_messages`. A second writer invalidates the `sequence`
  cursor.
- **One user:** there is one owner and one recipient. A second user needs
  per-user routes, sessions and recipients.
- **The network:** the owner reaches the VM from their network over HTTP. A
  phone or Internet access needs HTTPS, which is the PWA feature.

## Checks (scenarios become checks)

- **S1:** an integration test against the launcher's Valkey and Postgres:
  crash between the XADD acknowledgement and the response, retry with the
  same id, and the core processes one message.
- **S2:** a VM walk. Roll the core's image through the deploy branch while a
  script sends a message every 2 s, and assert 0 refused sends and exactly
  one answer row per message.
- **S3 and S4:** an integration test: an SSE client, rows inserted, the
  connection cut mid-stream, reconnect with `Last-Event-ID`, and no gaps or
  duplicates. S3's 2 s is measured on the VM walk.
- **S5:** a route-table test: every route from the module's router list,
  requested without a session through a ForwardAuth stub, is denied. Then
  the same on the VM through Traefik.
- **S6 and S7:** unit tests on the POST guard and on the markdown renderer
  with an XSS fixture set; the CSP header is asserted.
- **S8:** an integration test: with the web module stopped, the core commits
  and writes rows.
- **S9:** a unit test on the transcript paging query.
- **S10:** an axe-core run on the rendered chat page in the frontend tests.
  Visual layout is the owner's judgement on the VM.
