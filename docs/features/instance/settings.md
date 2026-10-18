# lifemodel's own settings

The settings interface is part of the core (`src/settings/`). The server
currently binds to `127.0.0.1`; platform deployment has no settings Service or
Ingress yet, so it is not externally routed. The settings route through the
platform web surface is pending. The server has no separate authentication
layer.

The interface currently edits the OpenAI-compatible model endpoint and its
fast, smart and motor model names. It holds no model key. Telegram bot and chat
configuration are not part of the current core.

## Routes and validation

| Route | Behavior |
| --- | --- |
| `GET /` | Renders current endpoint settings and missing fields. |
| `POST /settings` | Validates and stores the submitted settings, then reloads the endpoint in the running core. |

The endpoint base URL must be HTTP or HTTPS, with no URL credentials, query or
fragment. If any endpoint field is set, the base URL and all three model names
must be present. A blank endpoint is valid. Invalid input returns `400` and
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
is covered by `tests/unit/llm/model-endpoint.test.ts`. Store integration uses
the Postgres-backed configuration store.
