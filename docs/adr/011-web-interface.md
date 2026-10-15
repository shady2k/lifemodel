# ADR-011: The owner's web interface and its first module

Date: 2026-10-15.

## Status

Proposed (lifemodel-vhd design, 2026-10-15). Reviewed by gpt-6.1-sol in
ATAM manner, two rounds:

- the first round's VHD-01 to VHD-05 were blocking, and VHD-06 to VHD-12
  are taken in;
- the confirmation round closed VHD-01, VHD-03 and VHD-04 and the freshness
  part of VHD-05;
- it left VHD-02 (an expired receipt) and the read semantics of VHD-05 open.
  Both are fixed in this revision on their own diff: the server-side id age
  check (Decision 2) and the owner's meaning of "Прочитано" (D3). By the
  review's convergence rule there is no third round.

It amends ADR-010 in the places named under "Amendments to ADR-010" and
leaves the rest of ADR-010 unchanged. The target view it serves is
`docs/features/instance/web-interface.md`.

## Context and problem

Charter instance-1, outcome 8: behind the loader's password the owner writes
in the web chat and gets lifemodel's answer. The conversation survives a
switch of generations, with no message lost or answered twice. The web chat
is the milestone's only channel (Telegram is out, owner 2026-10-11).

**What lifemodel-avy left.**

- The core is stateless. It reads owner messages from the Valkey stream
  `inbound`, with offsets, pending inputs and a dedup ring of 1,000 ids
  inside its epoch-checked snapshot.
- It writes the owner's row into `core.conversation_messages` while
  normalizing the input, keyed `inbound:<signal.id>`. That happens before the
  snapshot commit; a replay writes the same key again, which changes nothing.
- It commits each answer as a `send.command` on the stream `outbound`, then
  writes the assistant row by its natural key (`channel:<channel>:<eventId>`)
  after the commit. Both writes take a per-recipient advisory lock held
  through COMMIT (`PostgresConversationStore.save`).
- The outbound row writer is marked as a stand-in for "the future ingress
  gateway send applier".

**What the platform has.**

- The loader holds the owner's password, a signed 30-day HttpOnly
  SameSite=Lax session cookie shared by every `*.localhost` host, and
  `/_auth/verify` for Traefik ForwardAuth. The verify route checks the
  request's own Host against `localhost`, `boot.localhost` and
  `vault.localhost`.
- Traefik routes only `boot.localhost`, without ForwardAuth.
- The core's primary recipient comes only from a Telegram chat id, which is
  null now, so the core cannot write first to anyone.

**The problem.** What the web module is and what it owns; how an owner
message gets one identity from the tab to the history row; how answers,
lifemodel's own first messages and the creature's state reach an open tab;
and how this first version stays on the way to the target view without
rework.

## Decision drivers

Outcome frame: one person, the owner, talks to their own lifemodel. A lost or
doubled message breaks trust in a "digital human", and the chat is how the
owner will ask for self-changes (outcome 7).

Quality attribute scenarios (each becomes a check, see "Checks"):

| # | Stimulus and condition | Response | Measure |
|---|---|---|---|
| S1 | The owner sends a message; the module crashes after the durable append and before the response; the tab retries with the same client id, now or up to 7 days later, from any replica | One logical input; the retry gets the original acceptance; the same id with different text is refused | 0 duplicate inputs and 0 lost messages across 100 crash-injected sends, including retries after 1,001 later messages |
| S2 | The core StatefulSet rolls to a new image through the deploy branch while the owner keeps sending; stores and the loader are healthy | The module keeps accepting; every accepted input reaches a committed outcome; every send effect is one visible row | 0 refused sends; 0 inputs without outcome; 0 duplicate visible rows |
| S3 | The core commits an answer, or writes first on its own, while a tab is open | The row appears in the tab without a reload | p95 ≤ 2 s from row insert to render on the test VM |
| S4 | The tab's event stream drops, or the page reloads, or a row is inserted between the page read and the subscription | The tab shows every visible row once | 0 gaps and 0 duplicates in the rendered transcript |
| S5 | A request without a valid session reaches any private route (app, assets, API, events) | Denied or redirected to the loader's login; no content | 100% of the route table, through real Traefik |
| S6 | A state-changing request comes from another origin, or has no or a malformed Origin | Refused | 403, nothing appended |
| S7 | A model answer contains HTML, script, `javascript:` or `data:` links, or remote images | Rendered inert; nothing executes or loads | the XSS fixture set renders inert; the CSP header matches the policy |
| S8 | The module is down, then comes back | The core keeps running and committing; the tab catches up on return | the core's commit progress unaffected; catch-up shows every row once |
| S9 | A long history (10,000 rows) | The tab opens on the latest page and loads earlier pages on scroll | first render reads one page (≤ 50 rows), the stream included; earlier pages by cursor |
| S10 | The owner uses the keyboard or a screen reader, or a narrow screen | Every control is reachable and named; live updates do not steal focus or scroll | axe-core passes; the keyboard and screen-reader checklist passes; WCAG 2.2 AA contrast |
| S11 | The core crashes while "thinking", or stops publishing | The tab never shows a stale state as current | the state shown is at most 15 s old, or the tab shows "нет связи" |
| S12 | lifemodel decides to write first, with no owner message before | The message reaches the owner's conversation | the proactive path writes a row for the web recipient; the same recipient after a restart |
| S13 | The owner answers a specific earlier message ("↩ Ответить") | lifemodel's turn sees which message is answered; the history shows the quote | the turn's context carries the quoted message; the row and the DTO carry `replyTo` |

Constraints, with their sources:

- ADR-010 Q5: the owner's whole web surface terminates on the web module (the
  "ingress gateway"). Traefik guards it with ForwardAuth to the loader. The
  core holds no front route. Ingress routes and middlewares are
  platform-owned; generations own Deployments, Services and ConfigMaps
  (ADR-010 R7-01).
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
    target form;
  - the chat is walked against an in-cluster stub model, and real model
    access arrives with lifemodel-2t5;
  - the owner never writes to a task; a message is bound to a matter by
    inference, by "↩ Ответить" or by "@". This feature builds "↩ Ответить"
    on messages;
  - "Прочитано" means lifemodel has received the message and written it into
    its history.
- No generation operator yet (lifemodel-pwe): "a switch of generations" in
  this feature is a core image change rolled through the deploy branch.

## Considered options

### D1 — who writes the conversation history

- **O1-A: the core writes every row; the web module only reads (chosen).**
  This keeps the row writer lifemodel-avy built and walked.
  - Steady state: one writer. Inserts for one recipient are serialized by
    the per-recipient advisory lock held through COMMIT, so for that
    recipient a lower `sequence` never becomes visible after a higher one.
    Gaps from rollbacks and conflicts are harmless for
    `WHERE sequence > cursor`.
  - Failure: a web module outage stops nothing in the core (S8).
  - Security: the web module needs no write grant on the core's schema.
  - Growth: a second channel whose delivery can fail (the Telegram gateway,
    lifemodel-yku) consumes `outbound` and reports its own settlement. That
    is added with it.
- **O1-B: the web module applies `cmd.send`, inserts the row by key and
  publishes `send.settled` (ADR-010 as written).** Two writers of one table.
  The core's turn settlement would wait on a module that faces the browser,
  so a web module outage would stall answer settlement. For a pull channel,
  "delivered" adds nothing to "the row exists". Rejected by the owner's "the
  core is the only writer".
- **O1-C: no history rows; the tab reads the snapshot and streams (the
  assumption O1-A and O1-B share, rejected).** History would live in Valkey
  streams trimmed at 10,000 events or 30 days, so the owner would lose old
  conversation. Rejected: the history is long-lived state (ADR-010 Q4 row 6).

### D2 — how new rows and the creature's state reach an open tab

- **O2-A: Server-Sent Events from the web module (chosen).**
  - The source of truth is Postgres rows after a cursor.
  - An XREAD BLOCK on `outbound` is only a wake hint, with a 1 s fallback
    poll: an owner row has no outbound event, and an answer's event can
    precede its row.
  - Sends stay plain POSTs with a client id (S1).
- **O2-B: WebSocket.** Two-way, but sends already have a durable,
  idempotent POST, and a socket would need its own replay and acknowledgement
  protocol. More to build, nothing gained for S1–S4.
- **O2-C: polling only.** Simple, but S3's 2 s means polling every second
  from every tab, forever.

### D3 — the creature's state and "Прочитано"

- **O3-A: one published state with freshness; "Прочитано" from the history
  (chosen).**
  - The core publishes `{ state, epoch, publishedAt }`, where `state` is
    `thinking`, `awake` or `asleep`:
    - to one Valkey key with a 15 s expiry;
    - on every change, and every 5 s as a heartbeat;
    - right after it takes the epoch at start, so a restarted core replaces
      a stale `thinking` at once.
  - It is not part of the commit.
  - The tab shows "•••" while `thinking`, and presence in the header. When
    the key is absent or older than 15 s, it shows "нет связи", never
    "asleep" (S11).
  - **"Прочитано"** sits under the owner's last message once its own row is
    in the history. By the owner's decision of 2026-10-15 it means "received
    and written into the history; it answers when it gets to it". It does
    not mean "taken into a turn": the core writes the row while normalizing
    the input, and a busy cognition can still requeue it. A crash before the
    commit replays the input under the same key, so a message shown as read
    is always processed. No separate read-through signal exists.
- **O3-B: per-message statuses (accepted, thinking, answered).** Rejected by
  the owner: the creature thinks as one, not per message.
- **O3-C: state inside the snapshot commit.** Exact, but it writes the state
  into every tick's commit and still needs freshness for a dead core.
  Rejected.

### D4 — where the module's code lives and how it reaches the stores

- **O4-A: one package in the root project (chosen).**
  - The server is `src/web/`, the React app is `web/app/` (Vite), and the
    shared storage operations are in `src/storage/` and `src/ports/`.
  - The server entry is bundled with esbuild into one file, so the web image
    carries only the code the server imports. Its digest then changes only
    when that code or the app changes.
  - The module sees narrow domain operations, never a raw client:
    - `acceptOwnerMessage(id, text)`;
    - `readTranscript({ before | after, limit })`;
    - `watchTranscript(after)`;
    - `readCreatureState()`.
- **O4-B: npm workspaces (`packages/storage`, `packages/web`).** Cleaner
  borders, but a repository restructure that touches every build, test and
  CI path. Deferred until a consumer outside the root project exists.
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
    role, and leased credentials scoped to the intake script on `inbound`
    and its receipts, the `outbound` hint read, the state key read, and
    `SELECT` on the transcript.
  - Residual risk until then: a compromised web module holds the core's full
    store rights. The code-level abstraction does not contain a compromised
    process. Mitigations:
    - the module is reachable only through Traefik, behind the owner's
      session, on the owner's network;
    - network policy limits it to the stores and DNS.
- **O5-B: a static web role now, delivered by a loader-copied Secret.**
  Safer from day one, about one stage longer, and the delivery is replaced by
  lifemodel-2t5. Declined by the owner for now.

## Decision

### 1. One identity for an owner message (VHD-01)

- The tab mints a UUIDv7 `id` per message. Its embedded time is the
  minting time, which Decision 2 checks.
- The web module builds a full `user_message` signal with `signal.id = id`,
  `data.updateId = id`, `data.text`, `data.channel = 'web'` and
  `data.recipientId` = the owner's web recipient (Decision 4).
- The `inbound.message` entry carries `messageId = id` and that signal.
- The core's dedup uses `messageIdForSignal` (= `updateId` = `id`). The
  owner row key is `inbound:<id>`.
- The transcript projection returns `clientId = id` for owner rows, so the
  tab matches its optimistic bubble by `clientId`. Two tabs see the same row
  once.
- **A reply** ("↩ Ответить") sends `replyTo` = the `sequence` of a visible
  message. The module checks that the row exists and is visible, and puts
  `data.replyTo = { sequence, role, excerpt }` (the excerpt at most 280
  characters) into the signal.
  - The core adds the quoted message to the turn's context.
  - It stores `replyTo` in the owner row's payload, and the DTO returns it,
    so the tab shows the quote.
  - Binding to tasks and "@" come with tasks.

### 2. Durable intake receipts (VHD-02)

`acceptOwnerMessage` runs one Valkey script, so the check and the append are
atomic across replicas and restarts:

- With no receipt `inbound:receipt:<id>`, it XADDs the entry and sets the
  receipt `{ streamId, sha256(text) }` with a 7-day expiry. It returns
  `accepted`.
- With a receipt and the same hash, it returns the original `streamId`. The
  module answers 202 again.
- With a receipt and a different hash, it returns `conflict`. The module
  answers 409 and appends nothing.

The module answers 202 only after Valkey acknowledges the script (AOF
`appendfsync always`). The core's dedup ring stays as a second line.

**Age, checked on the server.** Before the script runs, the module reads
the time inside the UUIDv7 `id`:

- an id older than 24 hours, or more than 5 minutes in the future, gets 409
  `stale` and nothing is appended;
- the receipt lives 7 days, longer than any id the server still accepts, so
  every accepted retry meets its own receipt;
- an id can never come back as a new message after its receipt expired,
  because by then the id itself is refused;
- an intentionally new message gets a new id.

The tab marks a message it could not send within 24 hours as not sent; a
"повторить" then mints a new id.

**Inside the script**, Valkey does not roll back a runtime error, so:

- inputs are validated before the call;
- the script appends first and writes the receipt second.

If the receipt write fails after the append, the script returns an error
and the module answers 503. The retry appends a second entry with the same
`messageId`, which the core's dedup absorbs: the entry is fresh, so it is
inside the ring. A receipt never exists without its entry.

### 3. The web module and its routes (VHD-03, VHD-10, VHD-11)

**The workload.** A new Deployment `web` in `lifemodel`:

- RollingUpdate with `maxSurge: 1` and `maxUnavailable: 0`;
- its own image `ghcr.io/<owner>/lifemodel-web`, digest-pinned in the
  release seed like the core;
- readiness means the store operations answer, and it never depends on the
  core's readiness, so the core's stop-first gap cannot refuse intake;
- resource requests and limits set, a bounded Postgres pool, and one shared
  Valkey connection for hints, separate from the intake connection.

**The routes**, all platform-owned (in the signed platform release, not the
deploy branch):

| Host and path | Guard | Target |
|---|---|---|
| `boot.localhost` `/login`, `/setup` (exact, higher priority) | none: the loader refuses `/setup` once a password exists | loader |
| `boot.localhost` everything else | ForwardAuth | loader |
| `localhost` everything (app, assets, `/api/*`) | ForwardAuth | web |

- ForwardAuth's address is the loader's in-cluster Service. The loader
  accepts `/_auth/verify` on that Service host only for this path, and it
  builds the login redirect from `X-Forwarded-Host`. Only Traefik can reach
  the loader (network policy), so the forwarded headers come from Traefik.
- Network policies: Traefik → web; Traefik → loader; web → Valkey, Postgres
  and DNS; nothing else from web.

**The HTTP surface** of the module:

| Route | Purpose |
|---|---|
| `GET /` and the app's assets | serves the built React app |
| `POST /api/messages` | body `{ id, text, replyTo? }`: Decisions 1 and 2 |
| `GET /api/transcript?before=<seq>&limit=50` | the projection (Decision 5), newest first, with `cursor` = the newest `sequence` in the response or, for the latest page, the recipient's newest visible `sequence` read in the same query |
| `GET /api/events?after=<cursor>` | SSE (Decision 6) |

**Security rules:**

- Every state-changing request needs an Origin header that parses to exactly
  the scheme, host and port `http://localhost`. A missing, `null`,
  malformed or sibling-host Origin is refused with 403. No CORS.
- The JSON body must have a UUIDv7 `id`, non-empty text up to 16 KiB, and
  optionally `replyTo` as a decimal `sequence` string. The
  server derives the recipient and channel; the client never sends them.
- The CSP is `default-src 'self'; script-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'; img-src 'self';
  connect-src 'self'`.
- Private API responses carry `Cache-Control: no-store`.
- Limits: request body size, page size (≤ 50), catch-up batch size,
  concurrent event streams per session (4), and send rate.
- An event stream closes after 15 minutes. The browser reconnects, which
  sends a new ForwardAuth check, so an expired session stops streaming.
  Logout closes the tab's stream and clears its cached transcript.
- Logs carry the request id, the client id, the intake result and the resume
  cursor; never message text, cookies or credentials.
- Residuals, said rather than claimed away:
  - over plain HTTP on the owner's network there is no transport
    confidentiality, which is the HTTPS/PWA feature's to fix;
  - logout clears the browser cookie, not a copied token, because sessions
    are stateless signed tokens.

### 4. The owner's web recipient (VHD-04)

- The owner's web recipient has the fixed channel `web` and destination
  `owner`, so its id is deterministic in the recipient registry.
- At start the core durably upserts it and sets it as the primary recipient.
  This replaces the Telegram chat-id conversion: aggregation, the autonomic
  filters and every other primary-recipient consumer get it directly.
- The web module uses the same id when it builds signals (Decision 1).
- `outbound` stays as the core's committed-send log for later channels. The
  `web` channel is a pull channel with no delivery cursor. The outbound trim
  floor is the Postgres apply offset alone, so web never holds `outbound`
  back. A browser's resume cursor is never a delivery record.

### 5. The owner-visible transcript (VHD-08)

- A direct recipient-scoped keyset query over `core.conversation_messages`;
  never the core's whole-history load with its compaction.
- Visible rows are `kind = 'message'` with role `user`, or role `assistant`
  with text content and no tool calls. Tool rows, statuses, actions and
  compaction summaries are never shown.
- Clear markers and compaction change the model's context, not the owner's
  view: the owner sees the whole conversation.
- The DTO is `{ sequence (decimal string), clientId?, role, text,
  createdAt, replyTo? }`.
- Limit and cursors are validated server-side: an invalid cursor gets 400,
  and a cursor ahead of the newest row gets an empty result.

### 6. The live stream (VHD-07)

- The tab reads the latest page and subscribes with `after` = that page's
  `cursor`, so a row inserted in between is in the catch-up.
- `message` events carry the row's `sequence` as the SSE id. Catch-up is in
  order, in batches of up to 50.
- `state` events carry no id, so they never move the resume cursor. The
  current state is sent first on every subscription.
- On reconnect the browser's `Last-Event-ID` resumes. A reload starts again
  from the latest page.
- The tab merges rows by `sequence` and owner bubbles by `clientId`, so
  duplicate delivery renders once.
- A heartbeat comment goes out every 15 s, and the response is flushed per
  event; Traefik buffering for this route is verified on the VM.
- A slow tab's queue is bounded; past the bound the stream closes and the
  tab resumes by cursor.

### 7. The core

- It stays the only writer of `core.conversation_messages` (D1).
- It establishes the web recipient (Decision 4).
- It publishes the creature state with freshness (D3).

### 8. The frontend

- The stack, agreed with the owner on 2026-10-15:
  - React 19, TypeScript and Vite, in `web/app/`;
  - TanStack Query for reads, with the EventSource feeding new rows into its
    cache; TanStack Router for routes; TanStack Virtual for the long list;
  - Radix UI primitives with shadcn/ui components kept in the repository,
    Tailwind CSS v4, and lucide-react icons;
  - code highlighting with Shiki;
  - Node 24 everywhere. Bun was declined for this module; moving the whole
    project to Bun is an idea (lifemodel-knak).
- The server is Fastify on Node 24, with request schemas and hand-written
  SSE, bundled by esbuild into one file.
- **Language:** English and Russian, chosen by the browser's language;
  English by default. i18next with react-i18next, with plural forms and
  dates by locale. This is the interface's language; lifemodel picks the
  language of its answers itself.
- **Themes:** light and dark from the start, following the system setting
  (`prefers-color-scheme`) and changing live with it. Both themes are sets
  of the same design tokens, and both meet WCAG 2.2 AA contrast.
- **One UI kit, no components of our own** (the owner, 2026-10-15). Every
  element of the interface comes from shadcn/ui's registry, kept in the
  repository by its CLI:
  - its base components (Sidebar, Sheet, Card, Badge, Button, Progress,
    Tabs, Command, Avatar, Tooltip, Collapsible, Alert Dialog, Textarea);
  - its chat components (MessageScroller, Message, Bubble, Marker);
  - its AI Elements patterns (Prompt Input, Task, Subagent, Tool, Trace,
    Confirmation, Queue) and Code Block.

  The patterns are written around AI SDK message parts; we feed them our own
  rows and events and take no AI SDK runtime dependency. Our own style is
  the kit's theme only: its CSS variables for colours in both themes,
  radius, fonts and density. A screen element with no kit component is a
  composition of kit components in a product file, never a new primitive; a
  kit component is changed only through its theme or its variants, so a
  kit update can still be taken.
- react-markdown without raw HTML. Links render only for `http` and `https`
  URLs and open in a new tab with `rel="noopener noreferrer"`; images are not
  fetched from model text.
- The kit theme's CSS custom properties are the design tokens; WCAG 2.2 AA.
- The layout of the target view:
  - left navigation (Разговор, Система);
  - the conversation in the middle;
  - the "Сейчас" panel on the right, with the creature state only;
  - one column on narrow screens.
- Accessibility rules (VHD-12):
  - named composer, send and retry controls, with visible focus;
  - Enter sends, Shift+Enter makes a new line, and IME composition is safe;
  - live updates never take focus;
  - the view never jumps while the owner reads older messages;
  - new messages and the state are announced politely;
  - text reflows at 400% zoom.

## Amendments to ADR-010

1. **The ingress gateway's send applier, `cmd.send` → INSERT-by-key →
   `send.settled`, is withdrawn for the web channel.**
   - The core inserts the row (D1).
   - The web module's matrix row in Q7 becomes: run the intake script on
     `inbound` and its receipts; read `outbound` as a hint; read the state
     key; SELECT the transcript. There is no INSERT grant and no
     `send.settled`.
   - `send.settled` returns with the first channel whose delivery can fail
     (lifemodel-yku).
2. **The core's produce row in Q7 adds the creature-state key** (D3).
3. **The `outbound` stream** is lifemodel-avy's name for what ADR-010 calls
   `cmd.send`; this ADR keeps `outbound`.

## Consequences

Good:

- One writer of the history. The web module failing never stalls the core
  (S8).
- One identity from the tab to the row. Retries are idempotent for 7 days
  across replicas.
- Catch-up and live updates are one query, keyed by a recipient-ordered
  cursor (S4).
- The module sees operations, not clients, so the role from lifemodel-2t5 and
  a later storage service fit behind the same seam.

Bad:

- Until lifemodel-2t5 the web module holds the core's full store credentials
  (D5).
- The owner's own message shows in history only once the core has taken it.
  Until then the tab shows it from its own memory.
- Intake receipts are one Valkey key per message for 7 days.
- The creature-state heartbeat is one Valkey write every 5 s.

## Assumptions (each with what invalidates it)

- **Ordering:** owner-visible rows of one recipient are inserted only under
  the per-recipient advisory lock, through `PostgresConversationStore.save`,
  with a non-cached identity. A writer that bypasses the lock breaks the
  cursor.
- **One user:** there is one owner and one recipient. A second user needs
  per-user routes, sessions and recipients.
- **Retry timing:** the tab never retries a message more than 24 hours after
  minting it. A client that does breaks S1's guarantee.
- **The network:** the owner reaches the VM from their own network over
  HTTP. A phone or Internet access needs HTTPS, which is the PWA feature.

## Checks (scenarios become checks)

Each check runs against the launcher's Valkey and Postgres unless it says
VM.

- **S1:** an integration test:
  - crash between the append and the response, then retry the same id;
  - concurrent retries from two module instances before the core reads;
  - a retry after 1,001 later messages;
  - the same id with different text.

  It asserts one logical input, the original `streamId` returned, and 409 on
  a conflict. Two more cases:

  - an id older than 24 hours, and one more than 5 minutes ahead, both get
    409 `stale`;
  - a receipt-write failure after the append gets 503, and its retry is
    absorbed as one input.
- **S2:** a VM walk with a deterministic stub model that sends one answer
  per turn:
  - roll the core's image through the deploy branch while a script sends a
    message every 2 s;
  - then repeat with the core killed past its stop deadline;
  - assert 0 refused sends, every accepted id with a committed outcome, and
    every send effect with exactly one visible row.

  An integration test adds the busy-turn cut: an input absorbed into a
  running turn, and a multi-send turn.
- **S3:** the VM walk measures p95 render latency, and the idle cost of one
  and of three tabs.
- **S4:** an integration test:
  - a row inserted between the page read and the subscription;
  - repeated drops in the middle of a batch;
  - a new EventSource after a reload;
  - state-only intervals;
  - duplicate delivery;
  - wake hints dropped (the fallback poll alone).

  Plus overlapping saves on separate connections, a delayed transaction, a
  rollback and a conflict retry, asserting the cursor never skips a row.
- **S5:**
  - a route-table test: every route requested without a session through a
    ForwardAuth stub is denied, and `/login` and `/setup` stay reachable;
  - on the VM through real Traefik: first setup, first login, the return to
    `localhost`, an expired cookie, a tampered cookie, the loader down (fail
    closed), anonymous assets and events, and direct Service reachability
    from another namespace.
- **S6:** unit tests on the Origin guard: missing, `null`, malformed,
  sibling host, other scheme or port; and on body validation.
- **S7:** unit tests on the renderer with the XSS fixture set (scripts,
  handlers, `javascript:` and `data:` URLs, remote images, raw HTML), and on
  the CSP header.
- **S8:** an integration test: stop the web module, let the core commit and
  write rows, start it again, and assert the catch-up shows each row once.
- **S9:** an integration and frontend test over 10,000 rows: one initial page
  including the stream, bounded earlier pages, and no internal rows.
- **S10:** an axe-core run in both themes and both languages, plus the keyboard and screen-reader checklist of
  Decision 8 as a frontend test where it can be automated. The owner judges
  the layout on the VM walk.
- **S11:** an integration test: kill the core after it published `thinking`;
  the tab shows "нет связи" within 15 s. A restarted core replaces the state
  at once.
- **S12:** an integration test: trigger proactive contact with no owner
  message before; a row appears for the web recipient; after a restart the
  same recipient and transcript are used.

- **S13:** an integration test: a reply to an earlier visible row puts the
  quoted message into the turn's context and `replyTo` into the row and the
  DTO; a reply to an invisible or unknown row gets 400.

Operations: the module exports the oldest unapplied `outbound` age, the
oldest pending inbound age, intake failures, SSE lag, reconnects and state
freshness. Its runbook covers the store outage, the loader outage and a
stuck stream.
