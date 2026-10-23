# Task object API

Task: lifemodel-653.7.5. Implements ADR-015 S-D3 object operations. This is not a deployed acceptance record.

The storage module task TLS listener (8443) serves:

| Route | Input / output |
| --- | --- |
| `PUT /spaces/:space/objects/:uploadId` | Raw immutable bytes; `x-storage-name` is unpadded base64url of canonical UTF-8 display metadata; `x-storage-length` is decimal bytes; `x-storage-sha256` is lowercase hex. Returns the saved receipt `{id,name,size,sha256,mark}`. A completed retry returns the original receipt, including its original null mark. |
| `GET /spaces/:space/objects/:objectId` | Entire object in bounded chunks, or one explicit `Range: bytes=start-end` of at most 4 MiB. No suffix or multiple ranges. Catalog `x-storage-size` and `x-storage-sha256` headers describe the complete immutable object, including empty objects. |
| `GET /spaces/:space/objects?limit=100&cursor=...` | Own-space page `{objects,nextCursor}`, bounded to 100 rows and 64 KiB of encoded metadata (a page can be shorter than the requested limit). Continue from the returned opaque cursor. Cursor is bound to one space and a monotonic catalog sequence, not a bucket/prefix. |
| `POST /spaces/:space/objects/:objectId/mark` | Exactly `{role:"artifact"}`, `result`, or `log`. First role sticks. Repeating it is idempotent; changing it conflicts. |

Every operation opens the existing task authorization stream. Every outgoing PUT/GET byte chunk dispatches synchronously within `stream.chunk`; network drains happen after the guard. Durable reservation, attempt tracking, publication and mark writes each use a fixed module-owned statement through `stream.publish`. A request owns a 10-second no-progress timer, reset after successful bounded dispatches and backend responses; SQL/identity operations and individual S3 waits remain bounded. A progressing transfer has no fixed request-wide cutoff. Socket idle and header deadlines remain bounded. Stream cancellation aborts transfers; close runs in finally. This leaf added no trusted-read routes; [storage seal](storage-seal.md) subsequently adds core-only marked-object reads. Owner downloads remain the later owner-read integration, not task authorization reused for web.

Migration `20261015000013_create_storage_objects.sql` expands the catalog with `space_quota`, `upload_intents`, `upload_attempts`, `objects`, and `object_versions`. One immutable object ID identifies one completed version. Display names never construct backend keys. UTF-8 decoding preserves every code point and must re-encode to exactly the declared bytes before validation. Both server and CLI reject Unicode format/bidi controls (`\p{Cf}`), including U+FEFF (BOM); they never strip them into a different accepted name. Quota is charged once under a per-space transactional ledger. The per-space 20 GB default is a policy bound only until 653.7.7's capacity admission, not a physical bound. The per-space ledger is complemented by the [instance retention ledger](storage-retention.md), which enforces the shared decimal 20 GB admission ceiling. Neither is a physical-PVC accounting claim. Each retry of an incomplete upload creates another unique private key tracked by its intent; no attempt is listed until the object and saved receipt commit. A pending live attempt holds a reservation; handled upload failures release it under the same per-space quota lock through fresh guarded publication. The same upload ID can re-reserve its unchanged metadata on retry. Aborted requests use a separate bounded authorization stream solely for this release; revocation still denies it, so an unavailable or revoked authority can leave a reservation for recovery. The bounded `expiredUploads()` query selects at most 100 expired pending leases. Automatic expired-upload collection is not enabled here. [Seal cleanup](storage-seal.md) now deletes tracked non-retained attempt keys during finalization. Repeated failed attempts can consume additional physical backend capacity until that collector exists. The future collector must coordinate live attempts and leases before deleting or releasing reservations.

S3 uses module-held custody credentials and SigV4 over keep-alive HTTP(S). PUT uses a unique key with `If-None-Match: *`, measured bytes and SHA-256, then checksum-enabled HEAD to verify length and hash. Only then can catalog publication ACK. This is not an S3/SQL atomic transaction. Backend orphans remain private and tracked if publication fails. A revoke between completion and ACK can return 403 after a successful catalog commit; a completed-ID retry replays its saved receipt. All three catalog functions pin `search_path = pg_catalog, pg_temp` and revoke PUBLIC execute. The current module login is the migration/function owner, so ownership retains execute; scoped roles and explicit grants remain lifemodel-2t5. Completion returns `completed|already_completed|intent_unknown|attempt_unknown`, and the module checks that outcome before reading or acknowledging the receipt.

## CLI shipped by the loader

`loader/src/storage-cli-main.ts` compiles to `loader/dist/storage-cli-main.js`. `docker/loader/lifemodel-storage` installs `/usr/local/bin/lifemodel-storage` in the loader image and runs `/opt/lifemodel/loader/dist/storage-cli-main.js`.

Commands:

```
lifemodel-storage put relative/file.txt --upload-id stable-id
lifemodel-storage get object-id relative/download.txt
lifemodel-storage list --limit 100 --cursor opaque-cursor
lifemodel-storage mark object-id artifact
```

Configuration is mounted by the trusted launcher, not credential flags: `LIFEMODEL_STORAGE_ENDPOINT` (TLS module origin), `LIFEMODEL_STORAGE_SPACE`, `LIFEMODEL_STORAGE_TOKEN_FILE`, and `LIFEMODEL_STORAGE_CA_FILE`. Each invocation reads the rotating projected token again. Task paths use Linux fd-relative traversal and no-follow opens for every component, reject non-regular files, and never overwrite an existing download. Failed downloads are retained, not unlinked: another process can replace the destination entry while the request runs. The bounded error identifies the retained inode by device/inode numbers, not by a path. Node does not expose `linkat(AT_EMPTY_PATH)` or `renameat2(RENAME_NOREPLACE)` for safe anonymous staging and atomic no-replace publication. This uses the safe fallback: the exclusive destination can contain partial bytes until the caller removes it, and retrying the same path fails rather than overwriting. No stat-then-unlink cleanup is attempted. Projected config files may use Kubernetes-managed symlinks; task artifact paths may not. GET measures downloaded length and SHA-256 and compares both against the catalog headers before fsync/success. Its output is `{id,size,sha256}`. A mismatch retains the identified partial inode and reports failure. Only allowlisted API metadata is printed, never a raw upstream URL or error body. CLI errors include an HTTP `status=` only for actual server rejections; local argument, file, configuration, output, transport and response-validation failures omit it instead of inventing a server status. All failures still exit nonzero. The standalone entrypoint attaches stdout/stderr error listeners before writing, awaits write completion, and bounds each write to one second. Closed output pipes return status 1 without an uncaught exception or recursive writes to failed stderr.

Stage 3 must copy the wrapper and compiled CLI modules into the Linux workbench image (with Node runtime), mount the audience-specific rotating token and CA-only trust, and set the module origin and allocated space. It must not mount module TLS private keys or signing credentials.

No platform dependency changed: A0→A→B→C→D still starts storage after SQL/Bao/Seaweed. Empty authorization/object tables are valid; no task Job or allocation is needed for startup. Allocate/bind/freeze/seal are described in [storage seal](storage-seal.md) (653.7.6). Worker admission, reserved capacity and fair scheduling are being implemented by 653.7.7. The integration fixture is not S10 acceptance; the deployed RSS budget still needs WALK-STORAGE-LOAD acceptance.

## Transfer bounds

One in-process admission scheduler covers all three TLS listeners. It stores only
slot and queue metadata, never durable authority or artifact buffers. Each chunk
releases its worker after the backend/socket drain and rejoins the space-fair
queue before allocating the next buffer. Task traffic cannot borrow the read
reserve. The per-space cap applies separately to task uploads/downloads on 8443
and to owner/core reads on 8445 (at most two reads per space). Reads of the same
space do not consume the task cap; they use the read reserve plus free general
slots. Control traffic has its own workers. An aborted transfer frees its worker
immediately. Control cancellation propagates to SQL/S3, but its execution slot
stays occupied until the handler and cleanup settle. Control SQL cancellation
terminates only its own captured PostgreSQL session and awaits the server's
termination acknowledgement; closing a client socket alone is not settlement.
The cancellation connection is bounded and does not wait behind the blocked
operation's pool checkout. Partial control bodies close at their own progress
deadline. Fresh authorization and the SQL maintenance
fence still apply to every chunk and publication. Admission never replaces those
guards.

Configuration uses integer environment settings. Invalid values fail startup;
values are never clamped. Defaults are also finite hard maxima unless noted:

| Environment setting | Default | Allowed range |
| --- | ---: | --- |
| `LIFEMODEL_STORAGE_CHUNK_BYTES` | 4194304 | 1–4194304 |
| `LIFEMODEL_STORAGE_TRANSFER_WORKERS` | 8 | 2–8 |
| `LIFEMODEL_STORAGE_PER_SPACE_WORKERS` | 2 | 1–2 |
| `LIFEMODEL_STORAGE_RESERVED_READ_WORKERS` | 2 | 1–2, less than total workers |
| `LIFEMODEL_STORAGE_CONTROL_WORKERS` | 2 | 1–2 |
| `LIFEMODEL_STORAGE_BUFFER_BYTES` | 33554432 | Must fit the read reserve and at least one task chunk; at most 33554432 |
| `LIFEMODEL_STORAGE_QUEUE_REQUESTS` | 32 | 1–32 |
| `LIFEMODEL_STORAGE_QUEUE_BYTES` | 65536 | 1–65536 |
| `LIFEMODEL_STORAGE_QUEUE_WAIT_MS` | 900 | 1–900 |
| `LIFEMODEL_STORAGE_CHUNK_DEADLINE_MS` | 10000 | 1–10000 |

Queue accounting includes the request's header/path byte count, not its body.
Requests wait without consuming their bodies. An excess request, or one still
queued at its own deadline, returns `429` with `Retry-After: 1`. Retrying after
pressure clears follows the normal authorization and idempotency rules. No
transfer occupies a control worker. A stalled chunk is canceled after its own
no-progress deadline, including while waiting for a source or backend response.

Kubernetes proof uses one keep-alive HTTPS agent with at most ten sockets. The
access guard uses one PostgreSQL pool with at most ten clients. Neither caches
positive TokenReview, Pod, Job or authorization decisions. Pool and socket error
listeners survive request teardown. S3 uses separate bounded keep-alive pools
for PUT (40 sockets: active plus queued request ceiling), GET (8 sockets) and
HEAD/DELETE/list control (2 sockets), so a full PUT kept open between chunk
turns cannot exhaust the read reserve. Write callbacks settle before chunk
buffer ownership is released, even below the socket high-water mark.
Readiness still fails closed on an inaccessible catalog or backend and reports recovery after the next successful
check, never a failed store as an empty page.

The integration pressure fixture checks admission, buffers, queue bounds,
control/read isolation and connection reuse. It is not the deployed RSS receipt.
The coordinator must run WALK-STORAGE-LOAD on the VM and record RSS ≤512 MiB plus
a diagnostic log scan before accepting S10.
