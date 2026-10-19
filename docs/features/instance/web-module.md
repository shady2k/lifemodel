# Web module operations

The web module serves the built React application and the owner-facing API on its public listener. Readiness and metrics use the separate internal listener (`LIFEMODEL_WEB_INTERNAL_PORT`); do not route that listener through Traefik. The readiness check runs Valkey `PING` and Postgres `SELECT 1`. It does not depend on whether the core is running.

## Store outage

1. Check the web pod logs for store connection errors. Logs must not contain message text, cookies or credentials.
2. Check Valkey and Postgres health and network access from the web pod. `/readyz` returning 503 means one or both store operations failed; intake should return 503 rather than claim durable acceptance.
3. Restore the stores and verify `/readyz` returns 200. Retry owner sends with their original client ids; the durable intake receipt makes retries idempotent.
4. Check the transcript and the six metrics at `/metrics`. Do not delete application data or receipt keys to make readiness green.

## Loader outage

1. The loader owns authentication and ForwardAuth. A loader outage must fail closed: the owner may be unable to load the app or open an authenticated stream, but the web module and core must not bypass the guard. An open page that the ingress answers with a 5xx keeps retrying in silence; only the loader's login redirect (or a 401) makes it leave for the login, keeping the unsent draft (ADR-011 D6, lifemodel-hf2k.1).
2. Check loader and Traefik health, then verify the ForwardAuth route and loader `/_auth/verify` service path. Restore the loader before testing access through the configured instance host (`<name>.local`).
3. Confirm the owner can authenticate and reach the app, transcript and event stream. Do not expose the web Service directly as a workaround.

## Model status

1. The web module polls the platform gateway's `/status` on 8081 once for all its clients, at most every 5 s, with a 2 s bound on each fetch (ADR-013 D6). The gateway URL is `LIFEMODEL_MODEL_GATEWAY_STATUS_URL`, defaulting to `http://model-gateway.lifemodel-system.svc:8081/status`.
2. The latest answer travels in the stream's own `model` envelope; a status change alone pushes an update, and it never moves the browser's resume cursor. Only the safe fields leave the module: `state`, `outageSince` and `lastErrorCode`.
3. Only a 200 is a status. The answer is read with a 4 KiB byte bound — a larger body is cancelled and unread — and every response the module rejects or discards is aborted or cancelled, so no connection outlives its 2 s bound.
4. The answer and the attempt's clock survive a period with no readers: a tab that reloads, or a client that reconnects, reuses the answer and waits out the rest of the 5 s period instead of fetching again. A fetch that was in flight when the last reader left still answers the next reader. The loader's own read caches its answer for 5 s as well.
5. When no status can be read — the gateway is unreachable, the fetch times out, the body is too large or is not a status — the owner sees "Model status unavailable", never an outage. A hanging `/status` never delays the message or creature-state stream.
6. With both model slots stopped, `/status` reports `state: down` with `outageSince` and the safe error code, and the chat's "Сейчас" panel and the loader's settings show "No connection to the model since HH:MM — …". Check the gateway pod's log and the loader's settings for the same line. The line appears at the next poll after the change lands: a poll already running can add up to 2 s, and one that has just answered is up to 5 s away, so allow about 7 s plus the stream's own state period before treating a missing line as a fault.
7. The projection is defensive, not only faithful: a code the gateway does not own (a URL, a token, a prototype name such as `constructor`) becomes the fixed `unknown_error`, and `outageSince` is kept only for `down` and only as an ISO instant. `tests/fixtures/model-status-conformance.ts` drives both the web and the loader parser through those shapes; extend it, not one parser's own test, when the projection changes.

## Stuck stream

1. Check `/metrics` for SSE lag, reconnects and creature-state freshness. Check web logs for stream termination and store failures; logs must not include message text or credentials.
2. Confirm the owner-visible transcript is advancing and Valkey `outbound` wake hints are present. The stream also polls the transcript, so a missing hint alone should not block catch-up.
3. If the stream remains stuck, restart the web pod only after confirming the core can still commit and the stores are healthy. A reconnect resumes from its last event id; verify catch-up and duplicate suppression in the browser. The page resubscribes by itself, so a `429 too_many_streams` in the log is a page that is recovering, not a stuck one: a lease not renewed for 15 s frees its stream slot, which is how a killed web module's slots return (lifemodel-hf2k.1).
