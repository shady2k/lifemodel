# Result files in chat

Task: lifemodel-653.8.10. Implements the web side of ADR-015 S-D6/S08.
This document is not a deployed stage acceptance record.

## Built so far

- An assistant message can show file rows below its text. Each row has a file
  icon, display name, localized byte size and download icon. The existing theme
  and English/Russian language selection apply.
- Selecting a row opens the same-origin attachment download. The browser saves
  the file instead of rendering its content inside the app.

## Attachment contract

`SEND_MESSAGE` intent data and committed outbound message payloads may carry
`attachments: [{artifactId, name, size, contentType}]`. The artifact ID is the
storage-module immutable object UUID (canonical lowercase on write). Metadata
lives in the existing `core.conversation_messages.payload` JSONB field; no new
column, table or migration is required. Only assistant messages may carry it.
Every write boundary validates the four metadata fields: at most 20 files,
a well-formed UTF-8 name up to 1024 bytes, a safe nonnegative integer size, and
a bare MIME type up to 128 characters. No bytes or storage
URLs belong in the message. lifemodel-653.8.11 supplies these references when
replying; this leaf supplies preservation, projection and downloads.

## Authorization and transport

`GET /api/attachments/:artifactId` checks the loader's current owner session and
then finds the artifact on a visible assistant message of the server-selected
recipient. The caller cannot select a recipient, conversation or space. The
current product has one owner and one web recipient (ADR-011), not a multi-user
identity model. Tests use separate server-selected recipients to prove isolation.

The storage adapter exposes only `openTaskArtifact(artifactId, range, signal)`.
It reads the rotating web read token and instance CA on each call and uses one
bounded keep-alive HTTPS agent. The module's private read listener accepts the
web identity only on `GET /artifacts/:artifactId`, resolves the marked immutable
object itself, and applies current read leases, live identity and tombstone
checks on each chunk. Generic object/list routes remain core-only. There is no
public storage ingress, CORS, S3 client, presigned URL or core byte relay.

The web checks owner authorization again before each outgoing chunk and every
five seconds while idle. A download ends after at most 15 minutes and requires a
new authenticated request to continue. Logout, expiry, loader unavailability,
module failure or object retirement ends the transfer; partial bytes are never
reported as a complete file. Existing ForwardAuth also guards the route. An
expired attachment request returns 401 rather than saving the login page.

Responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox`, and `Content-Disposition: attachment` with
RFC 5987 UTF-8 encoded filename metadata. Only a small safe content-type list is
preserved; HTML, SVG and unknown types become `application/octet-stream`.
Upstream headers and error bodies are not reflected. Unavailable IDs answer a
safe `artifact_not_available` reason. No filename, token or content enters logs.

A single explicit `Range: bytes=start-end` is accepted, at most 4 MiB. Suffix,
open-ended, multiple, unsafe-integer and oversized ranges are refused. A fresh
request can resume known completed bytes after a transport failure. Browser
native download managers differ in their automatic retry behavior; automatic
resume is not a UI claim. Each request validates the module's total size,
length and content range and preserves backpressure.

## Checks

- `tests/integration/task-artifact-download.test.ts`: actual Postgres ownership,
  TLS read identity and CA, expired sessions, invalid IDs, dangerous names and
  content, bounded ranges, broken/resumed transfers and mid-read invalidation.
- `tests/integration/storage-module-artifacts.test.ts`: actual module route and
  catalog/live-identity/read-lease guards, including mid-read retirement.
- `tests/unit/web-attachments.test.tsx`: file rows and metadata parsing.
- `tests/unit/web-layer-boundary.test.ts`: web uses domain/storage boundaries.

PRA-001 requires built-app Chromium and Firefox screenshots in both supported
languages/themes before interface acceptance. The worker report records their
paths and compares the visible claims above; it does not claim a deployed
Traefik/cluster walk. The task panel and Stop controls belong to lifemodel-hf2k.
