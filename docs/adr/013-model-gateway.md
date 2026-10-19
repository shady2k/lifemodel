# ADR-013: The model gateway

Date: 2026-10-16.

## Status

Proposed (lifemodel-2t5 split, 2026-10-16). Reviewed by gpt-6.1-sol in ATAM
manner: round 1 BLOCK (G-01 to G-03 blockers, G-04 to G-10 comments); this
revision answers each, marked in brackets; the fixes are checked in the stage
review by the convergence rule.

It amends ADR-010 (the egress path for model requests, Agent Vault) in the
places named under "Amendments" and leaves the rest of lifemodel-2t5 —
bus-carried egress for tools and Motor, per-process store credentials through
Bank-Vaults, the web module's own identity — to that feature.

## Context and problem

The owner's target story ends with the chat answered by the owner's real
model (owner, 2026-10-16). Today the core calls one OpenAI-compatible
endpoint configured in `core.settings` (base URL and role models, all null by
default) and passes a placeholder key to its SDK; the cluster seeds none of
it, and the earlier walks used an ad-hoc stub pod. ADR-010 designed the full egress
path — `cmd.egress.<module>` command events on the bus, the egress gateway
consuming them, Agent Vault as the last hop injecting keys — and per-process
store credentials. The owner decided (2026-10-16, "Разделить") to build now
only what the story needs and keep the rest of lifemodel-2t5 for after the
test.

Owner decisions this ADR implements (lifemodel-2t5, 2026-10-15/16):

- endpoints and keys are configured in the loader (primary + optional
  reserve; OpenAI-compatible or Ollama `/v1`), kept in OpenBao; lifemodel
  never sees a key;
- the gateway is thin: it injects the key, lets requests out only to the
  configured endpoints, and switches to the reserve when the primary does not
  answer or answers with a protocol error; no protocol translation, no
  LiteLLM;
- the core keeps one endpoint in code; the reserve lives in the gateway;
- "no connection to the model since HH:MM, error …" is a health signal that
  needs no model, shown in the chat's "Сейчас" panel and in the loader.

## Decision drivers

- No model key in any lifemodel process, pod spec, setting, file or log
  (charter outcome 4).
- **lifemodel cannot change the component that holds the key** — a
  self-changing generation that could rewrite the gateway could read the key.
- The core's model call stays synchronous HTTP: moving it onto the bus is the
  large part of lifemodel-2t5, not needed for the story.
- The repair path never depends on a generation (ADR-010).

## Decision

1. **A platform-owned gateway.** `model-gateway` is a Deployment and Service
   in `lifemodel-system`, part of the signed platform (step A, after
   OpenBao), built from the loader's image with its own entry point, so it
   shares the loader's destination validator, URL helper and Bao client and is
   never built or changed by a generation.
2. **Interface.** OpenAI-compatible HTTP on
   `http://model-gateway.lifemodel-system.svc:8080/v1`:
   `POST /v1/chat/completions` (streaming passed through as server-sent
   events) and `GET /v1/models`; nothing else on that listener.
   - **Upstream URL** [G-10]. A slot's `baseUrl` is the complete API base
     (`https://host/v1`, `https://host/prefix/v1`); the gateway appends
     `chat/completions` or `models`, keeping any prefix and normalising one
     trailing slash; the loader's checker uses the same helper. The upstream
     header set is built afresh — Content-Type, Accept and the injected
     Authorization only; inbound Authorization, cookies, forwarding and
     hop-by-hop headers are never forwarded. The slot contract is
     Bearer-only; an endpoint needing other secret headers needs a recorded
     extension first.
   - **The core's configuration** [G-02]. The platform pins the gateway's URL
     for the core by environment (`LIFEMODEL_MODEL_BASE_URL`), which overrides
     `core.settings` and cannot be edited there; the core sends no
     Authorization (its placeholder key is removed). Role models unset in
     `core.settings` default to the model name `default`; the gateway maps
     `default` to the slot's own model id. A role model the owner sets later
     in lifemodel's settings passes through on the primary. No model choice
     crosses from the loader to the core, and the core never reads OpenBao.
3. **Keys** [G-06]. The gateway logs in to OpenBao with its own service
   account (role `model-gateway`, policy `read` on `lifemodel/data/model/*`
   only) through a role-parameterised Bao client shared with the loader —
   never the loader's bootstrap identity, root or unseal material. The token
   lives in memory; the projected JWT is read afresh at each login; the token
   is renewed or re-obtained before expiry; a rejected token gets one bounded
   re-login. Slots are cached 30 s; after 5 min of failed refreshes the cache
   expires and requests fail with `storage_unavailable` until Bao answers
   again. A deleted latest version is "unset"; sealed, unreachable or denied
   storage is never "unset". An upstream 401/403 invalidates the cache for
   the next inbound request; the current request is not retried in that slot
   (D4's one attempt per slot holds) [B-02].
   The key is added as `Authorization: Bearer <key>` on the upstream leg only;
   a slot without a key (Ollama) is sent without one. The role and policy are
   provisioned in the loader's bootstrap policy action before root revocation,
   beside `loader-model` (ADR-012 D7). The role excludes the default policy.
   Bootstrap verifies a parented, nonrenewable token carrying only
   `model-gateway`, with an explicit 60 s TTL and no default policy. Root
   checks that target token through `sys/capabilities` and revokes it through
   `auth/token/revoke`; failed cleanup rejects the phase and keeps root.
   Policy and role writes repeat safely; token creation is not idempotent.
   A crash or lost create response can leave an unknown token alive until its
   TTL expires (at most 60 s), or until its parent root is retired. Re-entry
   repeats verification before root retirement; this bounded residual is not
   an exactly-once token-creation guarantee.
4. **Routing and failover** [G-04, G-05]. Each inbound request makes at most
   one attempt at the primary and one at the reserve; no retries inside a
   slot. Failover is at-least-once generation and may bill twice; the gateway
   never executes tools. The gateway switches to the reserve when the primary
   fails to connect, times out (connect 5 s, first byte 45 s), answers 5xx or
   429, or answers with a body that is not the OpenAI response shape (a
   `null` content with `tool_calls` is a valid answer; content that is not
   the core's application JSON is cognition's concern). Another 4xx is the
   caller's error. A stream that already sent its first byte downstream is
   never switched or replayed. One end-to-end deadline of 110 s; a stream
   idle 30 s ends; client disconnect, slot switch and the deadline abort the
   upstream request. The gateway's primary/reserve pair is the whole transport
   failover budget [B-02]: the core's provider makes one HTTP attempt per
   gateway-backed completion (no transport retries of its own), its timeout
   aborts that HTTP request through an AbortSignal and no later attempt
   starts after it reports a timeout; the gateway sees the disconnect and
   aborts upstream. Cognition's own retries and escalation stay separate,
   recorded turns. With no reserve,
   the primary's failure is returned as an error. On the primary the
   request's `model` passes through (`default` → the slot's model); on the
   reserve the reserve's model id replaces it, so fast and smart collapse to
   one reserve model by design. The reserve must support the
   OpenAI-compatible subset the core uses — tool calls and results,
   structured output; the walk checks it. Responses carry `x-lifemodel-slot`
   and the upstream's real `model`.
   - **What crosses back** [G-01]. Never an upstream error body or header: an
     upstream error becomes a gateway-owned OpenAI-shaped error
     (`{error: {type, code}}`, safe code), keeping the upstream status for
     4xx/429 and 502 otherwise. Response headers are allowlisted
     (Content-Type, `x-lifemodel-slot`, a safe Retry-After). A non-streaming
     success is buffered (bounded), parsed, and refused if the raw bytes or
     any decoded JSON string value contains the slot key (escapes such as
     `\u0073k-` are decoded first). A stream is parsed event by event; for
     each choice and each text field the client reassembles (content, tool
     call arguments, reasoning) the gateway keeps the reconstructed tail and
     withholds the part that could still be a prefix of the key, so the
     fragment that would complete the key is never released: that stream ends
     with a safe error. The raw chunk guard (carry-over of key length − 1)
     stays for anything forwarded unparsed. Frames and per-field state are
     bounded; malformed or oversized input fails closed. The same rule applies
     on both slots [B-01]. Raw upstream and Bao errors are never logged.
5. **Destinations and network** [G-07]. Only the two configured endpoints are
   reachable, through the loader's validator (ADR-012 D7: resolve once,
   refuse loopback, link-local and cluster ranges except the named in-cluster
   Ollama, no redirects, bounded bodies); application validation, not a broad
   ipBlock, pins the dynamic destinations. NetworkPolicies are L3/L4 in k3s,
   so status has its own listener: 8081 answers only `GET /status`. Ingress
   to 8080 only from core pods, to 8081 from web and loader pods
   (namespaceSelector AND podSelector in one peer), with the matching egress
   on the core, web and loader side and Bao ingress from the gateway. The
   gateway's egress: DNS, Bao and the loader's model exception. The namespace
   default-deny in `lifemodel-system` is split from the loader's own allow
   rules, so the gateway inherits no API-server or Gitea route.
6. **Health** [G-08]. `GET /status` on 8081 returns
   `{state: unknown|ok|down, outageSince, lastAttemptAt, lastSuccessAt,
   lastErrorCode, primary: {lastErrorCode, lastErrorAt}, reserve: {...}}` —
   safe codes, no URL, no key. `state` describes whole requests: `ok` when
   the last request succeeded on either slot, `down` when it failed on every
   slot, `unknown` before any request. `outageSince` is set at the first
   failed request, kept across consecutive failures and cleared on success;
   the per-slot fields keep a primary failure visible while the reserve
   serves. The web module polls it (bounded, cached across clients, every
   ≤ 10 s) into its own stream envelope, independent of the core's snapshot
   and part of the envelope's change key, and shows "no connection to the
   model since HH:MM, error …" in the "Сейчас" panel only for `down`; a failed
   status fetch shows "model status unavailable", never an outage. The
   loader's settings show the same.
7. **The core.** Its NetworkPolicy allows model egress only to the gateway's
   8080 (DNS, Postgres and Valkey stay); the gateway URL comes from the
   platform-pinned environment; no key anywhere in the core.
8. **Deployment** [G-09]. The container overrides the image's command with
   `node <absolute path>/model-gateway.js` (never the loader's `main.js`);
   its own ServiceAccount; no loader PVC, custody Secret or PKI; read-only
   root filesystem; resource bounds. The release flow pins step A's gateway
   image to the same pushed loader digest as A0, asserted by a release render
   test. Readiness is the process's own (listeners up); missing slots before
   onboarding never make it unready, so the wizard never holds `platform-a`.
9. **The walk's fixture** [G-03]. No cluster stub is admitted by the
   validator. The walk runs two OpenAI-compatible fixtures with tool-call
   support on the dev machine in the LAN (RFC 1918, permitted plain HTTP),
   saves them through the wizard as primary and reserve while both are live,
   then stops the primary, then both. Nothing test-only enters the release.

## Considered options

- **The full ADR-010 egress path now** (rejected by the owner, 2026-10-16:
  it would delay the story by days and rewrite the core's turn loop).
- **The gateway as a generation module in `lifemodel`** (rejected — a
  generation could change the code that holds the key).
- **The core reads the key from OpenBao** (rejected — the key would be in
  lifemodel's process).
- **LiteLLM or another proxy inside the instance** (rejected by the owner,
  2026-10-15).
- **Agent Vault as the last hop** (dropped for model traffic: keys are entered
  in the loader and kept in OpenBao; the gateway injects them. Whether Agent
  Vault remains for other credentials is lifemodel-2t5's).

## Amendments

- **D6, Health (2026-10-19, lifemodel-s9v5.1.6).** A recorded outage names
  each failing slot's KV v2 identity: `metadata.version` from the same
  read-only `lifemodel/data/model/<slot>` read, or `absent` for the required
  primary. No new permission, endpoint or listener is added. An absent optional
  reserve is not a failure; it is a separate recovery candidate.
  Only while `state` is `down`, `GET /status` re-reads identifiable failing
  slots and the absent-reserve candidate. At most one Bao read batch remains
  in flight until its reads actually settle; a new batch starts no more than
  once per 5 s. Each caller waits at most 1 s on that shared batch. Results
  arriving past the batch's 1 s deadline are discarded. A Bao error or an
  identity-less storage failure is skipped independently, not treated as a
  change and not allowed to suppress other slots' resets.
  A changed slot clears its own `lastErrorCode`/`lastErrorAt` and cached value
  only if its failure revision is still the one observed before the read.
  Active-attempt credentials remain in response inspection (buffered, SSE and
  headers) until those attempts end, regardless of cache eviction.
  The request level returns to `unknown` with `outageSince` and `lastErrorCode`
  null only if its outcome revision has not changed, no request is in flight,
  and no failing slot remains. Alternatively, an absent reserve appearing
  makes the request level `unknown` so the next request can use it; unchanged
  identifiable slot failures remain, and any identity-less failure still
  blocks that request-level reset. A newer success or failure cannot be
  overwritten by an older re-check. `ok` and initial `unknown` do not re-read
  Bao. `lastAttemptAt` and `lastSuccessAt` remain facts; identities and
  revisions never enter the status body.
  The loader shows "model saved — waiting for the first request" for `unknown`
  after a successful save in the page session. Its safe status projection has
  no `lastSuccessAt`, so it retains that save fact for the whole page session:
  neither an older poll nor a historical `ok` poll proves a post-save success.
  The waiting line is hidden for `ok`, `down` and unavailable status; a real
  failure still shows the outage.
- **D2, custom slot headers (2026-10-19, lifemodel-4utg).** A slot gains an
  optional ordered list of additional headers, `{name, value}`, stored with the
  key in the same `lifemodel/data/model/<slot>` record and secret exactly as the
  key is: no value reaches `/status`, a log line, an error message, the core or
  any response, and a saved value is never shown back in the loader — only its
  name, with the value masked. No new OpenBao permission and no new endpoint:
  the gateway's existing read of `lifemodel/data/model/*` already carries the
  record.
  A header joins the key in the material D4's response inspectors refuse when
  the answer echoes it, and the rule is narrow on purpose. What counts is the
  value's static part — the stored value with every `{session}` removed — and
  only from 16 bytes: a value whose static part is 15 bytes or less (`1`,
  `true`, a version, a bare `{session}`) is not matched, because such a string
  occurs in ordinary replies and would refuse a valid answer. What is matched is
  the rendered value that attempt really sent upstream, never its template. The
  guard remains a heuristic against echo, not proof of secrecy: direct
  redaction above covers every value, of any length. Each attempt pins its
  key and its rendered values with a reference count and releases them when the
  attempt ends, exactly as the key is pinned, so a slot cache eviction cannot
  drop protection from an answer still in flight; they are inspected in
  buffered JSON, in SSE split across frames and in the forwarded response
  headers, as the key is.
  A name is an RFC 9110 token of at most 64 characters, compared
  case-insensitively; a value is HTAB and printable US-ASCII (0x20–0x7E) only
  and at most 1024 bytes — a non-ASCII value is refused rather than encoded,
  because Node rejects it before the wire and a UTF-8 secret sent as Latin-1
  would not be the same secret; at
  most 16 headers, no duplicate names. Refused names are the gateway's own and
  the hop-by-hop and cookie headers: `host`, `authorization`,
  `proxy-authorization`, `content-length`, `content-type`, `accept`,
  `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`,
  `expect`, `cookie`, every `proxy-*` and every `:`-prefixed name. The rule is
  enforced where the slot is saved — a refused save answers that rule's own safe
  code, which the loader shows in English and Russian — and again where the
  gateway reads a slot: a stored list that breaks it is refused, never trimmed.
  Omitting the list when saving keeps the stored one, as an omitted key does; an
  explicit empty list clears it. A save request's body is bounded at 43,008 bytes
  (`MAX_SLOT_BODY`): the declared maxima with JSON escaping — sixteen 1024-byte
  values of quotes or backslashes, their names, the entry envelopes and the
  slot's own fields. A larger body answers `body_too_large` before any rule or
  endpoint check.
  A value may carry `{session}`. The core names the conversation of a chat turn
  in one inbound request header, `x-lifemodel-session` — its conversation id,
  and a later task its own. Every provider request whose conversation is known
  carries it: each turn of the agentic loop, the compaction summary of a
  conversation and a recipient-scoped batch reflection. A call that belongs to no
  conversation (global maintenance, Motor's own task identity) names none. The gateway reads that header and no other inbound
  header, accepts it only as `^[A-Za-z0-9._:-]{1,128}$`, and replaces every
  `{session}` with it. When a value carries `{session}` and the caller names no
  valid id, the gateway fills it with one random id it made at start and logs one
  line naming those headers, never a value. The loader's own model check sends
  the same headers with `{session}` set to a fixed probe id, so a slot is checked
  with what the gateway will later send.
  The upstream header set is built in that order: the slot's own headers first,
  then the gateway's `host`, `content-type`, `accept`, `authorization` and
  `content-length` over them, so no custom header can replace one of those. A
  slot without headers sends exactly the headers D2 named before this amendment.
  The sentence "The slot contract is Bearer-only; an endpoint needing other
  secret headers needs a recorded extension first" is superseded: this is that
  extension.
- **D4, null tool calls, slot attribution and the rejection reason (2026-10-19, lifemodel-mx6r).**
  A converting OpenAI-compatible endpoint answers a text reply with `tool_calls: null`, so the
  gateway treats a message whose `tool_calls` is `null` as an answer with no tool calls (its
  `content` must then be a string) and a delta whose `tool_calls` is `null` as carrying none; a
  non-array, non-null `tool_calls`, and a `null` content without tool calls, still fail closed on
  both paths, and the caller still receives the upstream's answer, re-serialized. A request
  failure names the slot that was really attempted: the active slot moves to a slot only when its
  attempt starts, so with the primary failing and no reserve configured, the warn line, the
  `x-lifemodel-slot` error header and `/status` name `primary`, and with a configured reserve
  failing they name `reserve`; a slot read that fails is attributed to the slot whose read failed,
  so a reserve read that comes back unavailable after a primary attempt failure names `reserve`
  on every surface. When an upstream answer is refused as `bad_response` or
  `unsafe_response`, the warn line also carries a safe reason: a fixed check code, a JSON path
  with array indexes into the answer, and, when the check is about a type, only the JSON type name
  that was found (for example `{check: "tool_calls_type", path: "choices[0].message.tool_calls",
  got: "string"}`) — never a value, a key or any other string from the body, and never in
  `/status`, whose safe shape is unchanged. A stream reason names the choice's array position in
  the frame being checked, with `.delta` between the choice and its fields; accumulated answer or
  tool state keeps the position where it first appeared; a model-listing id failure ends in
  `.id`.
- ADR-010: model requests leave through the platform-owned `model-gateway`
  over synchronous HTTP, not through `cmd.egress` events and Agent Vault;
  the egress gateway of ADR-010 remains the design for tool and Motor egress
  (lifemodel-2t5). The core's network row gains only the gateway as model
  egress.

## Consequences

- The chat answers with the owner's model and the key never enters
  lifemodel.
- The gateway is a single point for model availability; its `/status` names
  an outage instead of leaving a silent slow tick.
- Moving model traffic onto the bus later changes only the core's client and
  the gateway's front, not the key custody.

## Checks

- Gateway tests: key injected upstream only; inbound Authorization dropped;
  the key echoed by an upstream in a 4xx body, a 5xx body, a response header,
  a success JSON, a JSON-escaped success, an SSE stream split across chunks
  and a key split across two SSE deltas (content and tool-call arguments)
  never reaches the core or a log; attempts exactly primary once + reserve
  once, also after a 401 with a rotated key (the rotation serves the next
  request); through the real core provider: one HTTP attempt per completion,
  its timeout during each leg aborts the request, and no upstream activity
  follows the reported timeout; failover on connect
  error, timeout, 5xx, 429 and a malformed body, none on other 4xx, none after
  the first downstream byte; disconnect aborts upstream; `default` and reserve
  model substitution; streaming passthrough; only the declared paths per
  listener; base-path joining for `/v1`, `/v1/`, a prefixed base; Bao seal,
  token expiry, JWT rotation, deletion and key rotation; status semantics for
  reserve success, repeated failure, recovery and no attempts.
- Custom slot headers: a slot saved with `x-opencode-session: {session}` makes
  the gateway send the caller's conversation id, and the loader's check sends a
  probe id; a simple completion that knows its conversation names it too — a
  compaction summary and a recipient-scoped batch reflection, checked through
  the adapter on a real HTTP gateway; a reserved or malformed name, a CR/LF
  value, a control character, a non-ASCII value, a duplicate name and an
  over-long list are refused at save and at read; sixteen 1024-byte values save
  on both slots, with and without JSON escaping, and a body past the bound
  answers `body_too_large`; a reserve save that omits the list keeps it, also
  across a key change; no value reaches `/status`, a log line, the core or a
  response; a slot without headers sends what it sent before. A rendered value
  of 16 static bytes or more echoed by an upstream in a buffered answer, an SSE
  frame or two SSE deltas of one field is refused, also after a status re-check
  invalidated the slot cache while that answer was in flight, and a
  one-character value in an ordinary answer is not; the session fallback is
  logged once per slot configuration. A slot handed to the gateway with
  reserved names in mixed case cannot replace its host, content type, accept,
  authorization or content length, on a POST or a bodyless GET, with or without
  a key.
- Bao: the `model-gateway` role reads the slots and is denied writes and
  unrelated paths (real role, on the VM).
- On the test VM from a clean snapshot, with the LAN fixtures saved through
  the wizard: the chat answers via the primary; with the primary stopped it
  answers via the reserve, including a tool call, and `/status` keeps the
  primary's failure; with both stopped the "Сейчас" panel shows "no
  connection to the model since …"; the core reaches nothing for the model
  but the gateway's 8080; the key is in no core pod spec, setting, file, log
  or response.
