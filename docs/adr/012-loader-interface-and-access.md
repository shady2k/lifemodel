# ADR-012: The loader's interface, the instance's address and its HTTPS

Date: 2026-10-16.

## Status

Proposed (lifemodel-3wi9 design, 2026-10-16). Owner decisions of
2026-10-16 are its frame; review pending.

It amends ADR-010 (the loader's surface, the front door's names) and ADR-011
(hosts, cookies, Origin) in the places named under "Amendments".

## Context and problem

The owner's first look at the platform (2026-10-16) failed in three ways:

- the instance answered only on `localhost` and `boot.localhost`, names a
  browser resolves to its own machine, so another computer needed an SSH
  tunnel to port 80;
- the loader's pages are bare server-rendered HTML, not the kit the web chat
  uses;
- the login never stuck: browsers refuse a cookie with `Domain=localhost`,
  and the walk had used curl (fixed separately, lifemodel-vhd.6.4).

The target story the owner will test (owner, 2026-10-16): one installer
command → the installer prints an address → the browser opens
`https://lifemodel.local/` → a first-start wizard (onboarding, password,
model access, checked) → the chat, answered by the owner's real model
(lifemodel-2t5 follows this feature, the owner tests both together).

## Decision drivers

- **The owner reaches the instance from any computer of the home network
  with no tunnel, hosts file or own domain** (owner).
- **Nothing goes over the network in clear**, the wizard included — HTTPS
  from the first start, as Proxmox does (owner).
- **First-start setup is open from the LAN without a code**; the owner accepts
  that whoever opens it first sets the password (owner).
- **No Tailscale** (blocked for the owner). An own domain with Let's Encrypt
  is offered later (lifemodel-sd2).
- **One kit, no components of our own** (ADR-011 Decision 8): the loader's
  pages use the same shadcn/ui registry output and theme as the chat.
- **The repair path never depends on a generation** (ADR-010): the loader's
  interface is baked into the loader image, never served by lifemodel.
- **Origin isolation of the loader from the app is kept**: an app XSS must not
  reach the loader's forms or session.
- Both installers (NixOS module, `scripts/install.sh`) stay equivalent.

## Decision

### 1. The instance's names

- The instance has one name, `lifemodel` by default, set once at install
  (`services.lifemodel.name`, `install.sh --name`). The hosts are
  `<name>.local` (the app), `boot.<name>.local` (the loader) and
  `vault.<name>.local` (OpenBao's UI, when routed).
- The installer writes the name into the ConfigMap `lifemodel-instance` in
  `flux-system`; the platform's Kustomizations substitute it into Ingress hosts
  through Flux `postBuild.substituteFrom` (the platform artifact stays one
  signed artifact for every instance). The loader and the web module read the
  same value from their environment.
- The `*.localhost` names are removed everywhere (no compatibility path):
  allowed hosts, Origin checks, Ingress rules, tests, docs.

### 2. mDNS on the node

- The node announces `<name>.local`, `boot.<name>.local` and
  `vault.<name>.local` on the LAN by mDNS, from the host OS, not the cluster:
  Avahi with one `avahi-publish --address` per name, pointing at the node's
  LAN address, run as systemd units that restart when the address changes.
  The NixOS module enables it; `install.sh` installs `avahi-daemon` and the
  same units.
- The host firewall admits TCP 80 and 443 and UDP 5353.
- Clients: macOS, iOS, Linux with nss-mdns and Windows 10+ resolve `.local`
  by mDNS natively; Android support varies — the domain (lifemodel-sd2) is
  the answer there.

### 3. HTTPS from the first start: the instance's own CA

- At its first start, before it serves any page, the loader creates the
  instance's certificate authority (ECDSA P-256, 10 years) and a server
  certificate from it for the three names (397 days, renewed by the loader
  when 30 days remain). The CA key and the server certificate are Kubernetes
  Secrets in `lifemodel-system` that only the loader's ServiceAccount reads
  or writes; the server certificate is Traefik's default certificate
  (`TLSStore default`).
- Traefik redirects every HTTP request to HTTPS (entry point redirection);
  nothing but the redirect answers on port 80.
- Session cookies gain `Secure`. Origin checks compare against
  `https://<host>`.
- The installer prints the CA certificate's SHA-256 fingerprint with the
  address. The loader offers the CA certificate (`/ca.crt`, public) for
  optional installation on a device: installed, the browser trusts the
  instance and the PWA can be installed without a domain.
- An own domain with Let's Encrypt later replaces the server certificate
  (lifemodel-sd2); the CA stays for the LAN names.

### 4. Sessions: host-only cookies and a handoff (lifemodel-vhd.6.4)

- Every cookie is host-only (no `Domain`). The loader logs the owner in on
  `boot.<name>.local`; a login whose `next` is on the app host hands the
  session over with a single-use, host-bound ticket of at most 60 s, redeemed
  at `https://<name>.local/_auth/handoff` (routed to the loader without
  ForwardAuth), which sets the app host's own cookie.
- Logout on the loader ends every session (a session epoch the token's
  signature covers).

### 5. The loader's interface

- **Code:** `web/kit/` holds the shadcn/ui registry output (components, hooks,
  utils, the theme CSS, the provenance lock); `web/app` (the chat) and
  `web/loader` (the loader's pages) both import it. `scripts/shadcn-add.sh`
  and the CI provenance job move to `web/kit`.
- **Delivery:** `web/loader` is built into static files baked into the loader
  image; the loader serves them on `boot.<name>.local` with the same CSP and
  cache rules as the web module. The loader's server stays small: static
  files plus a JSON API.
- **JSON API** (same-origin, Origin-checked; state-changing calls also carry
  the session-bound CSRF token): `GET /api/state` (setup needed, logged in,
  wizard step, model access configured, CA fingerprint), `POST /api/setup`,
  `POST /api/login`, `POST /api/logout`, `POST /api/password`,
  `GET /api/model` (endpoints without keys), `POST /api/model/check`,
  `PUT /api/model`.
- **First start: the wizard** — welcome (what lifemodel and the loader are,
  what happens next) → password → model access → this device (the address,
  the fingerprint, the optional CA download) → done ("Open the chat", which
  goes through the handoff). Afterwards `/` shows **settings**: model access,
  password change, the CA certificate; the wizard never shows again.
- **Model access:** a primary and an optional reserve endpoint, each of kind
  OpenAI-compatible or Ollama (through its `/v1` API), with base URL, key
  (optional for Ollama) and model id. "Check" makes one real chat request of a
  few tokens from the loader; only a checked endpoint is saved. Keys are
  written to OpenBao (`secret/lifemodel/model/<primary|reserve>`), never to a
  file, log, page or API response; the API returns only whether a key is set.
  The egress gateway (lifemodel-2t5) reads them from there.
- Russian and English by the browser's locale (English default), both themes
  by the system setting, axe-core clean — as the chat.

### 6. The installer finishes for a person

- One line with no required parameters: the platform URL and tag default to
  the latest signed release; `--name` is optional.
- At the end it waits (bounded, 10 min) until `https://boot.<name>.local/`
  answers from the node, then prints the address and the CA fingerprint; on a
  timeout it says which step is not ready and points to `lifemodel doctor`.
- `lifemodel address` prints the same two lines at any time (the NixOS module
  prints them from its bootstrap unit too, as nixos-rebuild cannot).

## Considered options

- **Names:** `*.localhost` + tunnel (today; rejected — not reachable from the
  LAN); one host with the loader under `/boot` (rejected — loses origin
  isolation); `.local` by mDNS (chosen); own domain (later, lifemodel-sd2);
  Tailscale (rejected by the owner).
- **TLS:** none on the LAN (rejected by the owner: "HTTPS по умолчанию");
  a single self-signed leaf (rejected — cannot be trusted per device);
  the instance's own CA (chosen; Proxmox's model); mkcert on each client
  (rejected — client-side tooling).
- **Who makes the CA:** the installer (rejected — two installers diverge, the
  key would sit on the host) vs the loader (chosen).
- **Loader UI:** server-rendered pages styled by hand (rejected by ADR-011 D8);
  pages served by the web module (rejected — a broken generation would break
  the repair pages); a static kit app baked into the loader image (chosen).

## Amendments

- ADR-010: the loader's routes gain the static UI, `/api/*`, `/ca.crt` and
  `/_auth/handoff` on the app host; the front door's names come from the
  instance name; HTTP redirects to HTTPS.
- ADR-011: hosts `<name>.local`/`boot.<name>.local` replace `localhost`/
  `boot.localhost`; cookies are host-only and `Secure`; Origin is
  `https://<name>.local`; the kit lives in `web/kit`.

## Consequences

- The owner opens the instance by name from the LAN, over HTTPS, after one
  certificate warning per device or none with the CA installed.
- Android without mDNS and access from outside wait for the domain.
- The loader grows a static UI and a JSON API; its trusted base grows by the
  certificate code and the model check's outbound request.

## Checks (scenarios become checks)

- A browser walk (Playwright, Chromium and Firefox) on the test VM from a
  clean snapshot, from another LAN machine: `https://lifemodel.local/`
  resolves by mDNS, redirects from HTTP, shows the wizard; setup, model check
  against a stub, handoff to the chat; the second visit shows settings.
- No `Set-Cookie` carries `Domain`; every one carries `Secure`.
- The CA and server certificate exist after first start, the certificate's
  SANs are the three names, the fingerprint printed equals the served chain's.
- The key is in OpenBao and in no file, log, page or API response.
- With lifemodel's generation broken, the loader's pages still load.
- The kit provenance check covers `web/kit`; no component outside it.
