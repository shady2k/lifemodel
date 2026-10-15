# Web module operations

The web module serves the built React application and the owner-facing API on its public listener. Readiness and metrics use the separate internal listener (`LIFEMODEL_WEB_INTERNAL_PORT`); do not route that listener through Traefik. The readiness check runs Valkey `PING` and Postgres `SELECT 1`. It does not depend on whether the core is running.

## Store outage

1. Check the web pod logs for store connection errors. Logs must not contain message text, cookies or credentials.
2. Check Valkey and Postgres health and network access from the web pod. `/readyz` returning 503 means one or both store operations failed; intake should return 503 rather than claim durable acceptance.
3. Restore the stores and verify `/readyz` returns 200. Retry owner sends with their original client ids; the durable intake receipt makes retries idempotent.
4. Check the transcript and the six metrics at `/metrics`. Do not delete application data or receipt keys to make readiness green.

## Loader outage

1. The loader owns authentication and ForwardAuth. A loader outage must fail closed: the owner may be unable to load the app or open an authenticated stream, but the web module and core must not bypass the guard.
2. Check loader and Traefik health, then verify the ForwardAuth route and loader `/_auth/verify` service path. Restore the loader before testing access through `localhost`.
3. Confirm the owner can authenticate and reach the app, transcript and event stream. Do not expose the web Service directly as a workaround.

## Stuck stream

1. Check `/metrics` for SSE lag, reconnects and creature-state freshness. Check web logs for stream termination and store failures; logs must not include message text or credentials.
2. Confirm the owner-visible transcript is advancing and Valkey `outbound` wake hints are present. The stream also polls the transcript, so a missing hint alone should not block catch-up.
3. If the stream remains stuck, restart the web pod only after confirming the core can still commit and the stores are healthy. A reconnect resumes from its last event id; verify catch-up and duplicate suppression in the browser.
