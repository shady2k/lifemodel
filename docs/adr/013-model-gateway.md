# ADR-013: The model gateway

Date: 2026-10-16.

## Status

Proposed (lifemodel-2t5 split, 2026-10-16). Review pending.

It amends ADR-010 (the egress path for model requests, Agent Vault) in the
places named under "Amendments" and leaves the rest of lifemodel-2t5 —
bus-carried egress for tools and Motor, per-process store credentials through
Bank-Vaults, the web module's own identity — to that feature.

## Context and problem

The owner's target story ends with the chat answered by the owner's real
model (owner, 2026-10-16). Today the core calls one OpenAI-compatible
endpoint configured in `core.settings`, with its key there too; in the
cluster it reaches only an in-cluster stub. ADR-010 designed the full egress
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
   OpenBao), built from the loader's image with its own entry point
   (`node dist/model-gateway.js`), so it shares the loader's destination
   validator and Bao client and is never built or changed by a generation.
2. **Interface.** OpenAI-compatible HTTP on
   `http://model-gateway.lifemodel-system.svc:8080/v1`:
   `POST /v1/chat/completions` (streaming passed through as server-sent
   events) and `GET /v1/models`; no other path. The core's endpoint
   `baseUrl` points there with no key; requests carry no Authorization header
   from the core and any it carries is dropped.
3. **Keys.** The gateway logs in to OpenBao with its service account (role
   `model-gateway`, policy `read` on `lifemodel/data/model/*` only), reads the
   two slots, caches them for 30 s, rereads at once after an upstream 401/403,
   and adds `Authorization: Bearer <key>` only on the upstream leg. A slot
   without a key (Ollama) is sent without one. The role and policy are
   provisioned in the loader's bootstrap policy action before root revocation,
   beside `loader-model` (ADR-012 D7).
4. **Routing and failover.** Requests go to the primary. The gateway switches
   to the reserve for that request when the primary fails to connect, times
   out (connect 5 s; first byte 60 s), answers 5xx or 429, or answers with a
   body that is not the OpenAI response shape. A 4xx other than 429 is the
   caller's error and is returned as is. A stream that already started is
   never switched midway. With no reserve configured, the primary's failure is
   returned as a 502 with a safe code. The model id: on the primary the
   request's `model` passes through; on the reserve the reserve slot's model
   id replaces it (a reserve, such as a local Ollama, cannot be assumed to
   serve the primary's model names).
5. **Destinations.** Only the two configured endpoints are reachable, through
   the same validator as the loader's check (ADR-012 D7: resolve once,
   refuse loopback/link-local/cluster ranges except the named in-cluster
   Ollama, no redirects, bounded bodies). The gateway's NetworkPolicy has the
   same egress exception as the loader; ingress only from the `lifemodel`
   namespace's core pods on 8080, and from the web module and the loader to
   `/status`.
6. **Health.** `GET /status` returns
   `{ok, slot, lastSuccessAt, lastErrorAt, lastError}` with safe error codes
   and no endpoint URL or key. The web module reads it and shows "no
   connection to the model since HH:MM, error …" in the "Сейчас" panel when
   the last attempt failed; the loader's settings show the same line.
7. **The core.** The core's NetworkPolicy allows model egress only to the
   gateway; the core's settings hold the gateway's URL and no key. The
   in-cluster `llm-stub` remains a test fixture for walks only; the platform
   no longer points the core at it.

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

- Gateway tests: key injected upstream and never in a response or log; core
  Authorization dropped; failover on connect error, timeout, 5xx, 429 and a
  malformed body, none on other 4xx, none mid-stream; reserve model id
  substituted; streaming passthrough; only `/v1/chat/completions`,
  `/v1/models`, `/status` answered; destination validator shared and refusing
  the same classes as the loader.
- Bao: the `model-gateway` role reads the slots and is denied writes and
  unrelated paths (real role, on the VM).
- On the test VM from a clean snapshot: with the stub as primary and nothing
  else, the chat answers; with the primary pointed at a dead address and the
  stub as reserve, the chat still answers and `/status` names the primary's
  failure; with both dead, the "Сейчас" panel shows "no connection to the
  model since …"; no core pod reaches any address but the gateway; the key is
  in no core pod spec, setting, file or log.
