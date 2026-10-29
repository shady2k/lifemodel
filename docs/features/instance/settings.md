# lifemodel's own settings

The settings interface is part of the core (`src/settings/`). The server
currently binds to `127.0.0.1`; platform deployment has no settings Service or
Ingress yet, so it is not externally routed. The settings route through the
platform web surface is pending. The server has no separate authentication
layer.

The interface currently edits the OpenAI-compatible model endpoint and its
fast, smart and motor model names and their optional reasoning effort. It holds no model key. Telegram bot and chat
configuration are not part of the current core.

## Routes and validation

| Route | Behavior |
| --- | --- |
| `GET /` | Renders current endpoint settings and missing fields. |
| `POST /settings` | Validates and stores the submitted settings, then reloads the endpoint in the running core. |

The endpoint base URL must be HTTP or HTTPS, with no URL credentials, query or
fragment. Without `LIFEMODEL_MODEL_BASE_URL`, if any endpoint field is set,
the base URL and all three model names must be present. An unpinned role with
no model is refused, not sent as `default`. A blank endpoint is valid. Invalid input returns `400` and
writes nothing. Cross-origin or origin-less writes return `403`. A failed
Postgres write returns `500`; a save during shutdown returns `503`.

Where the platform pins the endpoint with `LIFEMODEL_MODEL_BASE_URL` — the
cluster, where the endpoint is the platform's model gateway — the base URL
field is shown read-only and a different submitted value is refused by that
field. The models stay the owner's to set and are optional there: a role left
blank asks the gateway for the model `default`, which it maps to the model
configured for the slot it uses (ADR-013 D2). A save writes no base URL into
the configuration document while the platform names the endpoint.

Endpoint URLs are redacted before rendering. Model credentials are provided
through the platform's credential path and are never stored in the settings
document.

## Reasoning effort

The loader's model slot page (`web/loader/src/App.tsx`) shows **Reasoning
effort** beside each primary and reserve model. Accepted values are
`none`, `minimal`, `low`, `medium` and `high`. Blank leaves the endpoint's
normal behavior unchanged. A slot save checks the model with that same effort
and stores it in OpenBao as `reasoningEffort`. Invalid values return `400`
before a model check or write. Blank explicitly clears the saved default;
an omitted API field keeps it.

For each upstream attempt, the model gateway adds the slot's effort as the
OpenAI-compatible `reasoning_effort` field only if the request lacks that
field. A client-provided value wins. Reserve failover uses the reserve slot's
own default, not the primary default. Both core requests and the authenticated
task-model gateway use this rule. Tasks use the same slots, so they need no
separate effort setting. An agent that sends its own effort keeps it.

The core's own role model form also shows one effort selector for each role.
The configuration fields are `fastReasoningEffort`, `smartReasoningEffort`
and `motorReasoningEffort` under `llm.endpoint`. Blank stores `null` and sends
no field. A selected value reaches the outgoing request for that role,
including a blank role model that asks the pinned gateway for `default`.
An explicit core role effort goes to both slots, including the reserve during
failover, rather than using either slot's default. Both upstream models must
support that value; the slot save check tests only the slot's own effort, not
a core override. With the platform gateway pinned, the slot setting is the
recommended control: keep core role efforts blank by default. Saving the core
form with a blank or absent effort field clears that role's saved effort;
unlike the loader API, omission does not preserve it. Without an explicit
role, effort follows the same model selection order: smart, fast, then motor
(or the smart role for a fully blank pinned endpoint). These settings apply
to future requests after save, not to individual cognition triggers.
An endpoint must support a selected value; there is no retry that silently
drops an unsupported effort.

## Storage and application

Configuration is stored in Postgres schema `core.settings`, not in a local
JSON file. `src/config/config-loader.ts` reads and writes it through
`PostgresConfigStore`. The settings server writes the new configuration and
calls the running container's `reloadConfig` callback. That replaces the LLM
provider for future requests in place; saving does not restart the process or
return a restart exit code.

The reload does not interrupt a cognition turn already in flight. New model
requests use the updated endpoint. A missing or incomplete endpoint remains
visible on the settings page and does not silently select another model.

## Tests

`tests/unit/settings-interface.test.ts` covers the HTTP form, validation,
redaction, write failures and in-place reload callback. Endpoint construction
is covered by `tests/unit/llm/model-endpoint.test.ts`. The real HTTP provider
checks in `tests/unit/llm/model-gateway-provider.test.ts` cover saved role
efforts reaching the wire after a config reload. Slot validation and forwarding
are covered by `tests/unit/loader-http-auth.test.ts`,
`tests/unit/loader-model-bao.test.ts`, `tests/unit/loader-model.test.ts` and
`tests/unit/model-gateway.test.ts`; `tests/web-loader/loader.test.tsx` covers
the slot controls. Store integration uses
the Postgres-backed configuration store.

## Time-limited model exchange capture

The loader's model page has **Capture model exchanges**. It is off by default.
Choose 10 minutes, 1 hour, or 24 hours (the maximum), optionally name one exact
chat/session id, then enable it. Disable stops new captures after the gateway's
next settings refresh (at most 30 seconds). Expiry is checked on every attempt
and write, so expiry needs no restart or cleanup action. The setting lives in
OpenBao at `lifemodel/data/model/capture`; the gateway refreshes it in the
background and never waits for it on a model call. An unavailable setting or
secret inventory disables capture.

**Captures store personal conversation text on this machine.** They do not go
to an external observability service. The gateway stores one redacted exchange
per upstream attempt in Postgres, including the original caller request, the
actual upstream request after model/effort selection, upstream response headers
and body (SSE text for streams), timing, call id, slot, attempt, session and
trusted task id where present. The call id is the `lifemodel.call_id` in
`lifemodel doctor llm`; read it with `lifemodel doctor exchange <call_id>` or
`lifemodel doctor exchange last [N]`.

Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-Api-Key and Api-Key
headers are replaced with `[redacted len=N]`. All custom slot headers are treated
as secret because the slot format has no secret flag. Every slot's key and
custom-header secret material, the incoming credential values and the database
passwords are scrubbed from stored text, including JSON-escaped and URL-encoded
forms. A final guard drops a row if any configured secret still occurs.

Each body retains at most 1 MiB plus an explicit truncation marker naming its
original byte length. The complete exchange has a 4 MiB database limit. The
store retains at most 100 MiB of recorded payload, newest first, and 24 hours.
A background prune runs every minute even while capture is off; reader access
also hides rows older than 24 hours. At most 16 exchanges collect bodies at
once and 8 redacted rows wait in memory. A full queue, missing database or
capture error drops evidence, never the model result. Database work runs off
the model-call path with one connection and a 1-second query/connect bound.
