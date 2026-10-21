# Task object API

Task: lifemodel-653.7.5. Implements ADR-015 S-D3 object operations. This is not a deployed acceptance record.

The storage module task TLS listener (8443) serves:

| Route | Input / output |
| --- | --- |
| `PUT /spaces/:space/objects/:uploadId` | Raw immutable bytes; `x-storage-name` is unpadded base64url of canonical UTF-8 display metadata; `x-storage-length` is decimal bytes; `x-storage-sha256` is lowercase hex. Returns the saved receipt `{id,name,size,sha256,mark}`. A completed retry returns the original receipt, including its original null mark. |
| `GET /spaces/:space/objects/:objectId` | Entire object in bounded chunks, or one explicit `Range: bytes=start-end` of at most 4 MiB. No suffix or multiple ranges. |
| `GET /spaces/:space/objects?limit=100&cursor=...` | Own-space page `{objects,nextCursor}`, bounded to 100 rows and 64 KiB of encoded metadata (a page can be shorter than the requested limit). Continue from the returned opaque cursor. Cursor is bound to one space and a monotonic catalog sequence, not a bucket/prefix. |
| `POST /spaces/:space/objects/:objectId/mark` | Exactly `{role:"artifact"}`, `result`, or `log`. First role sticks. Repeating it is idempotent; changing it conflicts. |

Every operation opens the existing task authorization stream. Every outgoing PUT/GET byte chunk dispatches synchronously within `stream.chunk`; network drains happen after the guard. Durable reservation, attempt tracking, publication and mark writes each use a fixed module-owned statement through `stream.publish`. Stream cancellation aborts transfers; close runs in finally. No object routes are added to the trusted-read listener in this leaf. Owner downloads remain the later owner-read integration, not task authorization reused for web.

Migration `20261015000013_create_storage_objects.sql` expands the catalog with `space_quota`, `upload_intents`, `upload_attempts`, `objects`, and `object_versions`. One immutable object ID identifies one completed version. Display names never construct backend keys. Quota is charged once under a per-space transactional ledger. This ledger is not an instance-wide quota or a physical-PVC accounting claim. Each retry of an incomplete upload creates another unique private key tracked by its intent; no attempt is listed until the object and saved receipt commit. A pending intent keeps its reservation. The bounded `expiredUploads()` query selects at most 100 expired pending leases. Collection, deletion and reservation release are deliberately not enabled here. Repeated failed attempts can consume additional physical backend capacity until that collector exists. The future collector must coordinate live attempts and leases before deleting or releasing reservations.

S3 uses module-held custody credentials and SigV4 over keep-alive HTTP(S). PUT uses a unique key with `If-None-Match: *`, measured bytes and SHA-256, then checksum-enabled HEAD to verify length and hash. Only then can catalog publication ACK. This is not an S3/SQL atomic transaction. Backend orphans remain private and tracked if publication fails.

## CLI shipped by the loader

`loader/src/storage-cli-main.ts` compiles to `loader/dist/storage-cli-main.js`. `docker/loader/lifemodel-storage` installs `/usr/local/bin/lifemodel-storage` in the loader image and runs `/opt/lifemodel/loader/dist/storage-cli-main.js`.

Commands:

```
lifemodel-storage put relative/file.txt --upload-id stable-id
lifemodel-storage get object-id relative/download.txt
lifemodel-storage list --limit 100 --cursor opaque-cursor
lifemodel-storage mark object-id artifact
```

Configuration is mounted by the trusted launcher, not credential flags: `LIFEMODEL_STORAGE_ENDPOINT` (TLS module origin), `LIFEMODEL_STORAGE_SPACE`, `LIFEMODEL_STORAGE_TOKEN_FILE`, and `LIFEMODEL_STORAGE_CA_FILE`. Each invocation reads the rotating projected token again. Task paths use Linux fd-relative traversal and no-follow opens for every component, reject non-regular files, and never overwrite an existing download. Failed downloads are removed. Projected config files may use Kubernetes-managed symlinks; task artifact paths may not. Only allowlisted API metadata is printed, never a raw upstream URL or error body.

Stage 3 must copy the wrapper and compiled CLI modules into the Linux workbench image (with Node runtime), mount the audience-specific rotating token and CA-only trust, and set the module origin and allocated space. It must not mount module TLS private keys or signing credentials.

No platform dependency changed: A0→A→B→C→D still starts storage after SQL/Bao/Seaweed. Empty authorization/object tables are valid; no task Job or allocation is needed for startup. Allocate/bind/freeze/seal belong to 653.7.6. Worker admission, reserved capacity, fair scheduling, RSS and overload bounds belong to 653.7.7. Transfer chunk and deadline settings are typed and bounded but do not claim S10 acceptance.
