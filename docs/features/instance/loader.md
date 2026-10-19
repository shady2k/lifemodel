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
2. Create the initial Gitea administrator Secret, wait for Gitea, and verify
   administrator access.
3. Seed protected `main` from the release's full-history git bundle, create
   and protect `deploy`, then create read-only source credentials and the
   application Kustomizations.

Each phase is persisted in the platform-created `loader-bootstrap-state`
Secret. On restart, the loader resumes from the recorded phase. Failures remain
visible and retry with backoff while the interface stays available.

## Interface

The loader serves its own kit app on the boot host (`boot-<name>.local`),
accepted by the owner on 2026-10-19 (lifemodel-3wi9, ADR-012):

- **First start, a wizard:** welcome, password (whoever opens it first sets
  it), model access (an OpenAI-compatible or Ollama endpoint checked safely and
  saved to OpenBao in the same request), and "this device" (the chat address,
  the CA certificate's SHA-256 fingerprint and its download), then the chat.
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
