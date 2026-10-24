# The platform loader

The loader is part of the signed platform release deployed by Flux into
`lifemodel-system`. It is a platform bootstrap process, not an instance
supervisor. It does not start lifemodel, build an instance image, run Agent
Vault, install container egress rules, or manage a legacy Docker instance command deployment.

The code lives in `loader/` and builds to `loader/dist/`. The platform OCI
image is defined by `docker/loader/Dockerfile`; build it from the checkout root
with the release context prepared first:

```sh
scripts/release/prepare-loader-context.sh
docker build -f docker/loader/Dockerfile .
```

The platform loader serves its authenticated interface on port 7000. It records
durable bootstrap phases and retries incomplete work after restart. The
platform deployment provides its persistent state, Service, Ingress,
default-deny NetworkPolicy and restricted ServiceAccount.

## First-start duties

The platform loader performs resumable setup in the order defined by
[ADR-010](../../adr/010-container-generations.md):

1. Initialize OpenBao, persist and verify custody, unseal it, configure the
   loader Kubernetes-auth policy, and revoke the bootstrap root token after
   hand-off.
2. Establish Seaweed custody, then zot custody. Store the sole zot push
   password in OpenBao and project only its bcrypt hash into `zot-htpasswd`.
3. Create the initial Gitea administrator Secret, wait for Gitea, and verify
   administrator access.
4. Seed protected `main` from the release's full-history git bundle, create
   and protect `deploy`, then create read-only source credentials and the
   application Kustomizations.

Each phase is persisted in the platform-created `loader-bootstrap-state`
Secret. On restart, the loader resumes from the recorded phase. Failures remain
visible and retry with backoff while the interface stays available.

The importer uses the loader's existing model-check egress. NetworkPolicy is
additive; there is no temporary import-egress policy and no phase-only network
enforcement is claimed. The importer's own host confinement is the boundary:
HTTPS to the configured source registry, checked token realms, and anonymous
HTTPS blob redirects. Stored pull credentials are sent only to the configured
registry or its same-origin token realm. An off-host HTTPS realm named by that
registry may be used anonymously only; with a stored credential it is refused.
This keeps registry configuration from delegating its secret to an attacker realm.
Blob redirects carry neither Authorization nor cookies; digest and size checks
still verify every downloaded byte. The zot push password is read from Bao at use and sent only
to zot. Requests, total phase time, and object sizes are bounded. Zot's hourly
GC reclaims partial uploads idle for two hours, beyond the 30-minute phase
budget, while explicit retention preserves digest-only release roots and
their referenced graph. See the platform README for storage recovery.

## Workbench source and background import

The settings page names the source registry as an HTTPS origin and an OCI
repository path. The shipped default is `https://ghcr.io` with repository
`shady2k/lifemodel-workbench`. A private registry may have a username and a
password or pull token. The source and its optional credential are stored in
OpenBao at `lifemodel/data/workbench/source`, not in the public settings dump.
The interface returns only the username and whether a password is set, never
the password. An omitted password keeps it only while registry, repository and
username are unchanged. A blank password explicitly removes the whole pull credential. A new username
requires a password; changing the source or username requires a replacement
password rather than forwarding the previous secret. Invalid or
missing fields return 400 with safe field reason codes. Registry URLs cannot
contain credentials, a path, query or fragment; HTTP is refused.

Saving takes effect without restart and retriggers the loader-owned import.
The digest is not editable: `LIFEMODEL_WORKBENCH_DIGEST` comes from the release
pin and must match the core image pin. A separate background task imports that
exact graph into zot. It never blocks Gitea or application source creation.
The task records `pending`, `importing`, `ready` or `failed`, the last attempt
time and a safe reason code in `workbench-import.json` on the loader volume.
The settings page shows this status beside model settings in English and Russian.
Failures retry with exponential backoff (one second to one minute). A save
cancels the old attempt and wakes the retry. On restart, even a saved `ready`
record is verified against zot again; verified destination objects are resume
keys after a kill. No process-memory marker is a restart boundary.

Core performs one bounded anonymous manifest HEAD to the fixed in-instance zot
before accepting a task. Until the pinned digest is present, start refuses with
`workbench_unavailable` and creates neither a Job nor a task registry row. The
HEAD is cheap and avoids treating a stale loader status as launch authority.
Jobs never fall back to the external source.

## Interface

The loader serves its own kit app on the boot host (`boot-<name>.local`),
accepted by the owner on 2026-10-19 (lifemodel-3wi9, ADR-012):

- **First start, a wizard:** welcome, password (whoever opens it first sets
  it), model access (an OpenAI-compatible or Ollama endpoint checked safely and
  saved to OpenBao in the same request), and "this device" (the chat address,
  the CA certificate's SHA-256 fingerprint and its download), then the chat.
  A slot may also carry additional headers: a collapsed section of name and
  value rows, where `{session}` in a value reaches the endpoint as the
  conversation id. A saved header is shown by its name with the value masked,
  because a value is secret like the key (ADR-013, custom headers).
- **Afterwards, settings:** the primary and the optional reserve model, the
  model's connection line from the gateway's `/status` (ADR-013 D6) — including
  "model saved — waiting for the first request" while the state is `unknown`
  after a save in this page session — password change, the CA certificate and
  logout. The save fact stays for the page session because the status projection
  has no success timestamp; historical `ok` polls cannot retire it. The waiting
  line is hidden for `ok`, `down` and unavailable status.

The design pass on the wizard and settings (focus, the device step fitting the
screen, step progress and Back, header actions, sections) waits in
lifemodel-bnhq, deferred by the owner.

## Authentication

The loader stores its password digest and session secret in its platform-owned
persistent volume. Setup is available before a password is set; thereafter the
session cookie and CSRF checks protect state-changing requests. Platform mode
has no panic, resume, or lifemodel status controls. The loader's ServiceAccount
is restricted to the named bootstrap resources; see ADR-010 for the exact
ownership and permission boundaries.

## Build and checks

`npm run build:loader` builds the loader and `npm run typecheck:loader`
typechecks it. `npm run check` includes the loader typecheck, lint, format
check, and isolated test suite. Tests run only through
`scripts/test-isolated.mjs`; the instance-image and Docker-run first-start
walks were removed. Outcome 4 is re-walked on the k3s shape by the manual
clean-VM acceptance check.
