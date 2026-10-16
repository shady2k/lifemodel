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
   storage is never "unset". After an upstream 401/403 the cache is
   invalidated and the request retried once only if the reread key differs.
   The key is added as `Authorization: Bearer <key>` on the upstream leg only;
   a slot without a key (Ollama) is sent without one. The role and policy are
   provisioned in the loader's bootstrap policy action before root revocation,
   beside `loader-model` (ADR-012 D7).
4. **Routing and failover** [G-04, G-05]. Each inbound request makes at most
   one attempt at the primary and one at the reserve; no retries inside a
   slot. Failover is at-least-once generation and may bill twice; the gateway
   never executes tools. The gateway switches to the reserve when the primary
   fails to connect, times out (connect 5 s, first byte 45 s), answers 5xx or
   429, or answers with a body that is not the OpenAI response shape (a
   `null` content with `tool_calls` is a valid answer; content that is not
   the core's application JSON is cognition's concern). Another 4xx is the
   caller's error. A stream that already sent its first byte downstream is
   never switched or replayed. One end-to-end deadline of 110 s (below the
   core's shortest turn timeout); a stream idle 30 s ends; client disconnect,
   slot switch and the deadline abort the upstream request. With no reserve,
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
     success is buffered (bounded) and refused if it contains the slot key; a
     stream is inspected frame by frame with a carry-over window of key
     length − 1 across chunks, and a frame containing the key ends the stream
     with a safe error. Raw upstream and Bao errors are never logged.
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
  a success JSON and an SSE stream split across chunks never reaches the core
  or a log; attempts exactly primary once + reserve once; failover on connect
  error, timeout, 5xx, 429 and a malformed body, none on other 4xx, none after
  the first downstream byte; disconnect aborts upstream; `default` and reserve
  model substitution; streaming passthrough; only the declared paths per
  listener; base-path joining for `/v1`, `/v1/`, a prefixed base; Bao seal,
  token expiry, JWT rotation, deletion and key rotation; status semantics for
  reserve success, repeated failure, recovery and no attempts.
- Bao: the `model-gateway` role reads the slots and is denied writes and
  unrelated paths (real role, on the VM).
- On the test VM from a clean snapshot, with the LAN fixtures saved through
  the wizard: the chat answers via the primary; with the primary stopped it
  answers via the reserve, including a tool call, and `/status` keeps the
  primary's failure; with both stopped the "Сейчас" panel shows "no
  connection to the model since …"; the core reaches nothing for the model
  but the gateway's 8080; the key is in no core pod spec, setting, file, log
  or response.
