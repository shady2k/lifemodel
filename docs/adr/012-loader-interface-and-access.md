# ADR-012: The loader's interface, the instance's address and its HTTPS

Date: 2026-10-16.

## Status

Proposed (lifemodel-3wi9 design, 2026-10-16). Owner decisions of
2026-10-16 are its frame. Reviewed by gpt-6.1-sol in ATAM manner (round 1:
BLOCK, findings ADR12-01 to ADR12-15; confirmation round: BLOCK on
ADR12-C-01 to C-03, comments C-04 to C-07); this revision answers every
finding, marked in brackets. By the review's convergence rule the C-round
fixes are checked in the first stage review instead of a third design round. ADR12-01 changed the names; the owner chose
`boot-<name>.local` (2026-10-16).

It amends ADR-010 (the loader's surface and network, its Bao grants, the
front door's names) and ADR-011 (hosts, cookies, Origin, the kit's place) in
the places named under "Amendments".

## Context and problem

The owner's first look at the platform (2026-10-16) failed in three ways:

- the former localhost-suffixed names resolved on the browser's own machine, so
  another computer needed an SSH tunnel to port 80; the current `<name>.local`
  and `boot-<name>.local` names are LAN names served by mDNS;
- the loader's pages are bare server-rendered HTML, not the kit the web chat
  uses;
- the login never stuck: browsers refuse a cookie with `Domain=localhost`,
  and the walk had used curl (fixed separately, lifemodel-vhd.6.4).

The target story the owner will test (owner, 2026-10-16): one installer
command → the installer prints an address → the browser opens
`https://lifemodel.local/` → a first-start wizard (onboarding, password,
model access, checked) → the chat, answered by the owner's real model
(lifemodel-2t5 follows this feature; the owner tests both together).

## Decision drivers

- **The owner reaches the instance from any computer of the home network
  with no tunnel, hosts file, client setup or own domain** (owner).
- **Nothing goes between the browser and the node in clear**, the wizard
  included — HTTPS from the first start, as Proxmox does (owner). In-cluster
  hops (Traefik → loader/web, loader → Bao) stay plain HTTP under ADR-010's
  accepted single-node model [ADR12-06].
- **First-start setup is open from the LAN without a code**; whoever opens it
  first sets the password (owner); first writer wins, never last [ADR12-12].
- **No Tailscale** (blocked for the owner). An own domain with Let's Encrypt
  comes later (lifemodel-sd2).
- **One kit, no components of our own** (ADR-011 Decision 8).
- **The repair path never depends on a generation** (ADR-010): the loader's
  interface is baked into the loader image.
- **Origin isolation of the loader from the app**: an app XSS must not reach
  the loader's API or session.
- Both installers (NixOS module, `scripts/install.sh`) stay equivalent.
- There is no live instance (owner, 2026-10-14): first-start mechanisms are
  built for clean installs; an upgrade path for an installed platform is not
  owed by this feature [ADR12-09].

## Decision

### 1. The instance's names [ADR12-01, 02, 03]

- The instance has one name, `lifemodel` by default, set at install
  (`services.lifemodel.name`, `install.sh --name`): one DNS label of at most
  57 characters. The hosts are two-label `.local` names, because nss-mdns on
  Linux resolves only two-label names by default:
  - `<name>.local` — the app (the web module);
  - `boot-<name>.local` — the loader;
  - `vault-<name>.local` — OpenBao's UI, when routed.
- The name is fixed after install: a rerun with another name is refused
  unless the owner reinstalls on purpose. The installers persist it with the
  release digest (Decision 6).
- **How the name reaches the cluster.** The installer writes ConfigMap
  `flux-system/lifemodel-instance` (`LIFEMODEL_NAME`) before the root
  Kustomization. A dedicated Kustomization `platform-instance` (in
  `flux-system`, path `./instance` of the same signed artifact, applied first,
  `postBuild.substituteFrom` that ConfigMap, `optional: false`) is the **only**
  Kustomization with substitution. It carries only small hand-written
  objects: the Namespaces `lifemodel-system` and `lifemodel` (moved here
  from A0 and A, which no longer own them), the namespace-local ConfigMaps
  `lifemodel-instance` in both, and every public Ingress, Middleware, TLS
  store and the Traefik HelmChartConfig. Vendored charts (OpenBao, Gitea) and
  the application Kustomization never pass through substitution. A missing
  ConfigMap fails the reconciliation; nothing renders with an empty host.
  **Cold-start chain** [ADR12-C-01]: `platform-instance` (no `dependsOn`; its
  objects need only k3s's own CRDs and become ready at once; an Ingress whose
  Service has no endpoints yet is ready as an object) → A0 (`dependsOn`
  `platform-instance`; the loader's certificate bootstrap) → A → B/C. A0 stays
  independent of Bao, Gitea, the web module and Traefik serving. A check
  reconciles the chain on an empty k3s cluster, not only renders it.
- The loader and the web module read `LIFEMODEL_NAME` from their
  namespace-local ConfigMap (`configMapKeyRef`, not optional) and derive every
  host, allowed origin and redirect from it. The chat learns the loader's
  address at runtime from `GET /api/instance` of the web module, not from a
  build-time constant.
- The `<name>.local` and `boot-<name>.local` hosts are served from the LAN (no localhost compatibility path).

### 2. mDNS on the node [ADR12-13]

- The node announces the three names by mDNS from the host OS, never the
  cluster: Avahi restricted (`allow-interfaces`) to the LAN interface, and a
  publisher unit per name that watches netlink address events
  (`ip monitor address`), withdraws the old record and republishes on change.
  The LAN interface is `services.lifemodel.lanInterface` / `--lan-interface`.
  On NixOS it must be declared by `networking.defaultGateway.interface` or
  `services.lifemodel.lanInterface`; evaluation fails and names both options
  when neither is set, because the declarative firewall must be scoped to a
  known interface. The generic Linux installer selects the lowest-metric
  interface from the structurally parsed IPv4 default routes, unless
  `--lan-interface` is explicit. Both paths refuse `cni*`, `flannel*`, `veth*`,
  `wg*`, `tun*`, `tailscale*`; no default route means the installer fails and
  asks for `--lan-interface`. IPv4 records only
  in this feature. No address: the unit waits and says so. A name collision
  fails the unit visibly; Avahi never renames silently.
- The NixOS module enables it; `install.sh` installs `avahi-daemon`,
  `avahi-utils` and the same units.
- The host firewall admits TCP 80/443 and UDP 5353 on the LAN interface
  only.
- **Assumption, stated:** the node is a home server on one LAN segment and
  has no interface on the public Internet. k3s ServiceLB exposes Traefik on
  every node address; restricting it per interface is not attempted. Multicast
  does not cross VLANs or AP client isolation.
- Supported clients are those actually checked: Linux with nss-mdns (the dev
  machine) and the browsers on it; macOS and Windows 10+ resolve `.local`
  natively by their vendors' documentation but are not checked here. Android
  waits for the domain (lifemodel-sd2).

### 3. HTTPS from the first start: the instance's own CA [ADR12-04, 05]

- **Custody.** The CA's private key lives only in the loader's own volume
  (`/var/lib/loader/pki/ca.key`, 0600), never in a Kubernetes Secret: k3s
  Traefik watches Secrets cluster-wide. The CA certificate (public) is
  published in ConfigMap `lifemodel-system/lifemodel-ca`. The server
  certificate and key are the A0-precreated Secret
  `lifemodel-system/lifemodel-tls` (created empty `IfNotPresent`, prune
  disabled; the loader has get/update on that name only). Traefik and cluster
  administrators can read the leaf key; that is the trusted-controller
  exception, stated.
- **Bootstrap before HTTP.** Before the loader opens its HTTP port it runs the
  certificate bootstrap using only A0 resources: create the CA if the loader's
  instance identity (`/var/lib/loader/instance.json`, holding the CA
  fingerprint) does not exist; write and read back the CA, then the identity;
  issue the leaf; update the Secret and the ConfigMap. The loader is not Ready until its leaf is written. Traefik may still serve
  its fallback certificate during the asynchronous reload window; the installer's
  verified wait (lifemodel-3wi9.5.1) keeps the owner from that window.
- **Repair.** A missing or expiring leaf is reissued from the existing CA. A
  missing or corrupt CA while the identity exists fails the loader visibly
  (doctor says so); it is never silently regenerated. A valid CA found after
  a crash before the identity was published is reused; a CA that does not
  match the identity is refused. Every file is published atomically (write,
  fsync, rename, fsync the directory); `auth.json` is created exclusively from
  a fully written temporary file. `lifemodel doctor` reports the PKI state
  (identity, CA present and matching, leaf validity and SANs). Backup and
  restore are manual and documented: the whole loader volume, permissions
  kept, the CA fingerprint verified after restore; losing the volume means a
  reinstall and new trust on every device. An explicit reset command is out
  of scope [ADR12-C-04].
- **Renewal.** The leaf is valid 397 days and reissued when 30 days remain, by
  a daily timer in the loader as well as at start. Traefik reloads the Secret
  live. The CA is valid 10 years; its renewal is a later concern, recorded.
- **Profile.** CA: ECDSA P-256, BasicConstraints CA:true pathlen 0,
  KeyUsage keyCertSign+cRLSign, random 128-bit serial, notBefore 1 h back.
  Leaf: ECDSA P-256, SANs = the three names, ExtendedKeyUsage serverAuth,
  KeyUsage digitalSignature, random serial, notBefore 1 h back. Issued with
  `@peculiar/x509` (pinned) over WebCrypto; Node's `X509Certificate` only
  parses.
- The loader's Deployment uses the `Recreate` strategy: one writer of its
  volume.

### 4. The edge [ADR12-06, 07]

- k3s Traefik is configured by `HelmChartConfig kube-system/traefik` (the name
  k3s documents) to redirect the `web` entry point to `websecure`
  permanently; every public Ingress sets entry point `websecure` and TLS
  explicitly; `TLSStore default` (one, beside `lifemodel-tls`) serves the
  leaf. Port 80 only redirects, for every method, without forwarding a body.
- `boot-<name>.local` routes **entirely** to the loader without ForwardAuth:
  the loader is the authority and enforces per route (table below). The app
  host routes to the web module through ForwardAuth, except the exact path
  `/_auth/handoff`, which goes to the loader. ForwardAuth keeps
  `trustForwardHeader: false`; redirects are built from the configured hosts,
  never from forwarded headers.
- Origin checks compare scheme, host and port exactly
  (`https://boot-<name>.local`, `https://<name>.local`); uppercase host spelling
  and an explicit default `:443` are accepted as the same canonical origin.
  A missing, `null` or malformed Origin on a write is refused, never rescued by Referer.

| Host | Path | Method | Admission |
|---|---|---|---|
| `boot-` | static shell, `/assets/*` | GET | public |
| `boot-` | `/ca.crt` | GET | public |
| `boot-` | `/api/state` | GET | public; returns `{setupNeeded, loggedIn}` and, only with a session, the wizard step and the CSRF token (`no-store`) |
| `boot-` | `/api/setup` | POST | only while no password exists; exact Origin + `Content-Type: application/json` |
| `boot-` | `/api/login` | POST | exact Origin + JSON content type |
| `boot-` | `/api/model` | GET | session; Origin may be absent (same-origin reads carry none) but a present Origin must match exactly; `Sec-Fetch-Site`, when sent, must be `same-origin`; `no-store` [ADR12-C-02] |
| `boot-` | every `/api/*` write (POST, PUT, DELETE) | as listed in Decision 6 | session + CSRF token header + exact Origin |
| `boot-` | `/api/*` with another method | | 405 |
| `boot-` | `/_auth/verify` | — | refused (verify is answered only on the Service host) |
| `<name>` | `/_auth/handoff` | GET | ticket only; then a clean redirect, `Referrer-Policy: no-referrer` |
| `<name>` | everything else | any | ForwardAuth → web module |
| any other host or path | | | 404 from the loader |

No CORS headers anywhere. JSON content type is what makes setup and login
safe from cross-site forms before a session exists.

### 5. Sessions [ADR12-12; lifemodel-vhd.6.4]

- Cookies are host-only, `Secure`, `HttpOnly`, `SameSite=Lax`, named with the
  `__Host-` prefix. The loader logs the owner in on `boot-<name>.local`; a
  login whose `next` is on the app host hands the session over with a
  single-use, host-bound ticket of at most 60 s, redeemed at
  `https://<name>.local/_auth/handoff`.
- Logout and a password change rotate the session secret: every session and
  every outstanding ticket ends.
- **Durable loader state** lives in the loader volume, versioned:
  `auth.json` (password record, session secret) and `onboarding.json`
  (`{version, step, completedAt}`, no keys). Setup creates `auth.json` with an
  exclusive create: the first writer wins and a second request is refused, even
  across a restart. Password set and wizard completed are separate facts; the
  wizard is complete only after the primary endpoint is saved and the device
  step acknowledged, and it resumes at the stored step after a reload or crash.

### 6. The loader's interface [ADR12-11]

- **Code:** `web/kit/` holds the whole shadcn/ui registry output
  (`components/ui`, `hooks`, `lib` including `highlighter`), the theme CSS and
  the provenance lock; its `components.json` aliases are `@kit/...`, so the
  CLI writes `@kit/` imports and the locked output stays byte-identical to the
  CLI's. `web/app` (the chat) and `web/loader` (the loader's pages) import
  `@kit/*`; TypeScript, Vite, Vitest and Tailwind source scanning resolve it
  in both. `scripts/shadcn-add.sh`, the provenance test and the CI job cover
  `web/kit`, and CI triggers on kit, generator and config changes.
- **Delivery:** the loader image gains a build stage that builds `web/loader`
  from the root lockfile and copies only the static output into the runtime
  stage; the web image's context assembler and Dockerfile take `web/kit`.
  Neither context admits secrets, `.git` or `node_modules`.
- **JSON API** (Decision 4's table): `GET /api/state`, `POST /api/setup`,
  `POST /api/login`, `POST /api/logout`, `POST /api/password`,
  `GET /api/model`, `PUT /api/model/<primary|reserve>`,
  `DELETE /api/model/reserve`, `POST /api/onboarding/device` (acknowledge).
- **First start: the wizard** — welcome (what lifemodel and the loader are,
  what happens next) → password → model access → this device (the address,
  the CA fingerprint, the optional CA download with per-OS steps) → done
  ("Open the chat" through the handoff). Afterwards `/` shows **settings**:
  model access, password change, the CA certificate, logout.
- Russian and English by the browser's locale (English default), both themes
  by the system setting, axe-core clean.

### 7. Model access [ADR12-08, 09, 10]

- **Slots:** primary (required) and reserve (optional), each
  `{kind: openai|ollama, baseUrl, model, key?}`; the key is optional for
  Ollama.
- **Check-and-save is one server operation.** `PUT /api/model/<slot>` checks
  the exact candidate (one chat-completions request of a few tokens) and
  saves it only if the check passes, in the same request; there is no
  client-trusted "checked" flag. Omitting `key` keeps the stored key (used for
  the recheck); a new `key` replaces it; `DELETE` clears the reserve.
  `GET /api/model` returns the slots with `keySet: true|false`, never a key.
- **Errors** are safe codes — `unreachable`, `tls`, `timeout`,
  `auth_failed`, `model_not_found`, `bad_response`, `blocked_destination` —
  with the HTTP status; never the upstream body or headers. No log line holds
  a key, an upstream body or a URL with a query.
- **Destinations.** `https` to a public address, or `http`/`https` to a
  private LAN address (RFC 1918) for Ollama on the home network — that
  plaintext LAN leg is the owner's own network, stated. One in-cluster
  target is allowed by name, for an Ollama module the owner may run in the
  cluster (lifemodel-2t5 owner decision, 2026-10-15): exactly
  `http://ollama.ollama.svc.cluster.local:11434`, validated against that
  Service's resolved address [ADR12-C-03]. Refused: URL
  credentials, other schemes, loopback, link-local (including
  `169.254.169.254`), the cluster's pod and service ranges except that one
  target, the API server, IPv6 and
  IPv4-mapped literals of those, and names resolving to any of them. The
  checker resolves once, validates every address, connects to the validated
  address with the original host for TLS/SNI, follows no redirect, and bounds
  the whole check at 15 s and 64 KiB; one check per slot at a time.
- **Network policy:** the loader's NetworkPolicy gains egress to `0.0.0.0/0`
  except the pod and service CIDRs and `169.254.0.0/16`, plus TCP 11434 to
  pods of namespace `ollama` — a narrow, recorded exception to ADR-010's
  egress matrix for the trusted loader; the application-level validation
  above enforces the rest.
- **OpenBao.** A KV v2 engine mounted at `lifemodel/` and the policy
  `loader-model` (`create`, `update`, `read` on
  `lifemodel/data/model/*`, `read` on `lifemodel/metadata/model/*`, `delete`
  on exactly `lifemodel/data/model/reserve`) bound to the loader's
  Kubernetes-auth role are provisioned inside the existing policy action of
  `openbao.ts`, before its root revocation, idempotently, and verified under
  the loader role before the root token is revoked (clean installs only, by
  the drivers). Clearing the reserve is a KV v2 delete of its latest version;
  a deleted latest version reads as unset, for the loader and the gateway
  alike [ADR12-C-05]. The
  loader logs in with its service-account token and logs in again when the
  Bao token expires; sealed or unreachable Bao answers `503 storage
  unavailable`, never "not set". The egress gateway's read-only policy is
  lifemodel-2t5's.

### 8. The installer finishes for a person [ADR12-14]

- **Release pin** [ADR12-C-06]. After pushing and verifying the signed
  platform, the release workflow publishes a versioned installer bundle as a
  GitHub release asset: `install.sh`, the root templates and the CLI, with
  that release's platform URL and digest stamped in (the release job gains
  `contents: write` only). "Latest" is that asset of the latest release, never
  the source archive; a clean-directory smoke run checks it. The NixOS module's
  default is the platform **tag** of the flake's own version (signature
  verification pins the release workflow's identity, so the tag cannot be
  re-signed by anyone else); Nix evaluation stays offline. The installer
  persists name and digest in `/etc/lifemodel/instance.env`; a rerun keeps
  both unless the owner passes another release explicitly.
- **Wait.** After applying, the installer waits at most 10 min (each request
  bounded to 10 s) for an anonymous `GET https://boot-<name>.local/api/state`
  answered 200 from the node (`--resolve` to `127.0.0.1`), verified with
  `--cacert` set to the CA certificate read from ConfigMap `lifemodel-ca`
  (no `-k`). Then it prints the address and "SHA-256 fingerprint of the CA
  certificate (DER)". On timeout it names the first step not ready (k3s, Flux
  source, `platform-instance`, the loader pod, the certificate, the route)
  and points to `lifemodel doctor`.
- `lifemodel address` prints the same two lines from the established identity
  at any time, says "not installed" or "not ready" distinctly, and never reads
  the CA key. The NixOS bootstrap unit logs them.
- The LAN walk from another machine remains separate acceptance evidence.

## Considered options

- **Names:** localhost-suffixed names + tunnel (rejected — unreachable from the LAN);
  `boot.<name>.local` (rejected after review — three labels fail nss-mdns by
  default; owner chose the hyphen); one host with the loader under `/boot`
  (rejected — loses origin isolation); own domain (later, lifemodel-sd2);
  Tailscale (rejected by the owner).
- **Name propagation:** Flux substitution on the existing Kustomizations
  (rejected — it rewrites vendored charts' shell scripts, ADR12-02); per-instance
  artifacts or images (rejected — one signed artifact); a dedicated
  substituted `platform-instance` Kustomization (chosen).
- **TLS:** none on the LAN (rejected by the owner); a single self-signed leaf
  (rejected — no per-device trust); the instance's own CA (chosen; Proxmox's
  model); mkcert on each client (rejected — client tooling).
- **CA custody:** a Kubernetes Secret (rejected — Traefik watches Secrets
  cluster-wide); the installer's host (rejected — installers diverge); the
  loader's volume (chosen).
- **Loader UI:** server-rendered pages (rejected by ADR-011 D8); pages from
  the web module (rejected — a broken generation would break the repair
  pages); a static kit app baked into the loader image (chosen).
- **Check before save:** a check then a separate save with a client flag
  (rejected — ADR12-10); one check-and-save request (chosen).

## Amendments

- ADR-010: the loader serves `boot-<name>.local` entirely and `/_auth/handoff`
  on the app host; HTTP redirects to HTTPS; names come from the instance name
  through `platform-instance`; the loader gains egress to non-cluster
  addresses for the model check, and the Bao grant `loader-model`; the loader
  Deployment is `Recreate`.
- ADR-011: hosts `<name>.local`/`boot-<name>.local` replace
  the prior local-only names; cookies are host-only `__Host-` and `Secure`;
  Origin is exact `https://`; the kit lives in `web/kit`; the chat reads the
  loader's address from `/api/instance`.

## Consequences

- The owner opens the instance by name from the LAN, over HTTPS, after one
  certificate warning per device, or none with the CA installed.
- Android without mDNS and access from outside wait for the domain.
- The loader grows a static UI, a JSON API, certificate code and one outbound
  checker; its trusted base grows by exactly those.
- Losing the loader volume loses the CA: every device that installed it must
  install the new one after a reinstall.

## Checks (scenarios become checks)

Unit and integration checks in the isolated suite:

- A Flux-equivalent post-build render of `platform-instance` for names
  `lifemodel` and `home`: only intended fields change, no placeholder remains,
  and the OpenBao and Gitea manifests are byte-identical before and after.
- Hosts, origins and redirects derive from the name; `<name>.local` is the application host;
  a bad or too-long name fails install and evaluation.
- Certificate bootstrap: first start creates CA, identity and leaf in that
  order; a restart reuses them; a missing leaf is reissued from the same CA; a
  missing CA with an identity fails; an expiring leaf is renewed by the timer;
  profile fields asserted by parsing.
- Every Set-Cookie is `__Host-`, `Secure`, without `Domain`; the route table
  above holds for every row, including sibling hosts, wrong methods, wrong
  content types, missing/`null` Origin and absent CSRF.
- Concurrent setup: one wins, the other is refused; the wizard resumes after a
  restart at every step; a partial reserve save does not complete it.
- The checker: rebinding, redirect to private, IPv6/mapped literals, metadata,
  slow and oversized bodies refused; an endpoint echoing the key on success
  and error never leaks it to a response or log; PUT without a passing check
  saves nothing; LAN Ollama accepted.
- Kit provenance covers `web/kit`; clean-context builds of both images
  succeed and the loader image holds the static UI.

On the test VM from a clean snapshot (acceptance):

- From the dev machine with the system resolver: the three names resolve by
  mDNS; in Playwright Chromium and Firefox `http://lifemodel.local/` redirects
  to HTTPS, the served leaf chains to the CA whose fingerprint the installer
  printed, the wizard runs to the chat, the second visit shows settings.
- A real Traefik matrix: HTTP methods only redirect; anonymous private paths
  fail closed; spoofed forwarded headers change nothing.
- The model key is in OpenBao under the loader's real role, and in no file,
  log, page or API response; an unrelated Bao path is denied to that role.
- With lifemodel's generation broken, the loader's pages still load.
