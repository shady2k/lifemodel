# Web module operations

The web module serves the built React application and the owner-facing API on its public listener. Readiness and metrics use the separate internal listener (`LIFEMODEL_WEB_INTERNAL_PORT`); do not route that listener through Traefik. The readiness check runs Valkey `PING` and Postgres `SELECT 1`. It does not depend on whether the core is running.

## Store outage

1. Check the web pod logs for store connection errors. Logs must not contain message text, cookies or credentials.
2. Check Valkey and Postgres health and network access from the web pod. `/readyz` returning 503 means one or both store operations failed; intake should return 503 rather than claim durable acceptance.
3. Restore the stores and verify `/readyz` returns 200. Retry owner sends with their original client ids; the durable intake receipt makes retries idempotent.
4. Check the transcript and the six metrics at `/metrics`. Do not delete application data or receipt keys to make readiness green.

## Loader outage

1. The loader owns authentication and ForwardAuth. A loader outage must fail closed: the owner may be unable to load the app or open an authenticated stream, but the web module and core must not bypass the guard.
2. Check loader and Traefik health, then verify the ForwardAuth route and loader `/_auth/verify` service path. Restore the loader before testing access through the configured instance host (`<name>.local`).
3. Confirm the owner can authenticate and reach the app, transcript and event stream. Do not expose the web Service directly as a workaround.

## Model status

1. The web module polls the platform gateway's `/status` on 8081 once for all its clients, at most every 5 s, with a 2 s bound on each fetch (ADR-013 D6). The gateway URL is `LIFEMODEL_MODEL_GATEWAY_STATUS_URL`, defaulting to `http://model-gateway.lifemodel-system.svc:8081/status`.
2. The latest answer travels in the stream's own `model` envelope; a status change alone pushes an update, and it never moves the browser's resume cursor. Only the safe fields leave the module: `state`, `outageSince` and `lastErrorCode`.
3. When no status can be read — the gateway is unreachable, the fetch times out, or the body is not a status — the owner sees "Model status unavailable", never an outage. A hanging `/status` never delays the message or creature-state stream.
4. With both model slots stopped, `/status` reports `state: down` with `outageSince` and the safe error code, and the chat's "Сейчас" panel and the loader's settings show "No connection to the model since HH:MM — …". Check the gateway pod's log and the loader's settings for the same line.

## Stuck stream

1. Check `/metrics` for SSE lag, reconnects and creature-state freshness. Check web logs for stream termination and store failures; logs must not include message text or credentials.
2. Confirm the owner-visible transcript is advancing and Valkey `outbound` wake hints are present. The stream also polls the transcript, so a missing hint alone should not block catch-up.
3. If the stream remains stuck, restart the web pod only after confirming the core can still commit and the stores are healthy. A reconnect resumes from its last event id; verify catch-up and duplicate suppression in the browser.
