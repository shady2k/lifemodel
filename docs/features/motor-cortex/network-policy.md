# Motor Cortex Network Policy

Per-skill network access via a host-side forward proxy. Containers that need external APIs get tightly scoped egress through the proxy — everything else stays on `--network none`.

## User Flow

```
Cognition: "I need to access api.example.com"
User: "Sure"
  → core.act({ domains: ['api.example.com'], task: "..." })
  → Container: curl api.example.com ✅ | curl evil.com ❌ | curl 1.2.3.4 ❌

Wildcard domains for CDN subdomains:
  → core.act({ domains: ['*.googlevideo.com'], task: "..." })
  → Container: curl rr3---sn-abc.googlevideo.com ✅ | curl evil.com ❌

Mid-run discovery: motor cortex needs cdn.example.com too
  → Fails → Cognition asks user → retry with expanded domains
```

## Architecture: Egress Proxy

Replaces the previous DNS/IP/iptables-per-IP approach with a **host-side HTTP forward proxy**. This is the same pattern Anthropic uses in their sandbox-runtime.

**Why proxy over DNS/iptables?** The old approach pre-resolved domains to IPs and built per-IP iptables ACCEPT rules. This fundamentally could not support wildcard domains (`*.googlevideo.com`) because CDN subdomains are dynamic and resolve to rotating IPs. The proxy operates at the right abstraction level — domain names — and sees hostnames natively via HTTP CONNECT.

### How It Works

1. **Host-side proxy** (`EgressProxyManager`) — each Motor Cortex run gets its own HTTP proxy on an ephemeral port
2. **Container uses `HTTP_PROXY`/`HTTPS_PROXY`** env vars pointing to `host.docker.internal:<port>`
3. **iptables simplified** — container can ONLY reach the Docker gateway IP on the proxy port. Everything else DROP.
4. **DNS blocked** — `--dns 127.0.0.1` stays (defense-in-depth against tools bypassing proxy)

### Security Layers

| Layer | Mechanism | What it blocks |
|-------|-----------|----------------|
| 1. Proxy domain check | Allowlist (exact + wildcard suffix) | Any domain not in the allowlist |
| 2. Proxy SSRF check | DNS resolution + private IP rejection | SSRF via DNS rebinding to internal networks, cloud metadata |
| 3. Proxy port check | Restrict to 80/443 by default | Port scanning, non-HTTP services |
| 4. Kernel iptables | DROP all except gateway:proxyPort | Raw IP access, DNS bypass (DoH/DoT), tools ignoring proxy |
| 5. DNS block | `--dns 127.0.0.1` | Defense-in-depth against external DNS resolution |

No single layer is sufficient alone. Together they cover the attack surface:
- Proxy alone: bypassed by tools that ignore `HTTP_PROXY` env vars
- iptables alone: operates at L3/L4, can't distinguish domains on shared IPs
- DNS block alone: bypassed by hardcoded IPs or DoH

### CONNECT Handler (HTTPS)

```
Client sends: CONNECT api.example.com:443 HTTP/1.1
  → Parse hostname:port
  → Check domain against allowlist (exact match or wildcard suffix)
  → Check port against allowed ports (default: 80, 443)
  → Resolve DNS on host side via dns.resolve4()
  → Reject if ANY resolved IP is private (RFC1918, loopback, link-local, metadata)
  → Connect by resolved IP (not hostname — prevents TOCTOU DNS rebinding)
  → Pipe bidirectional tunnel (200 Connection Established)
  → Or reject with 403 Forbidden
```

### Plain HTTP Handler

Same domain/port/SSRF checks, then forwards request with resolved IP and original Host header.

## Domain Patterns

Three types of domain patterns are supported:

| Pattern | Example | Matches |
|---------|---------|---------|
| Exact | `api.example.com` | Only `api.example.com` |
| Wildcard | `*.googlevideo.com` | `rr3---sn-abc.googlevideo.com`, `any.googlevideo.com` — NOT `googlevideo.com` itself |
| Unrestricted | `*` | Any public domain (SSRF protection still applies — private IPs are rejected) |

Wildcards match any subdomain suffix via `.endsWith()`. The base domain does NOT match a wildcard pattern — `*.x.com` does not match `x.com`.

The unrestricted `*` wildcard is used by builtin skills like `web-research` that need to fetch arbitrary URLs discovered during web searches. SSRF protection (private IP rejection) runs after the domain check, so `*` means "allow any public domain", not "allow everything".

Validation: `isValidDomainPattern()` accepts exact domains, `*.domain` wildcards, and the `*` wildcard. Used in `core.act`, `core.skill`, and the proxy itself.

## Container Creation Flow

```
1. egressProxyManager.allocate(runId, domains, ports)  ← start proxy, get ephemeral port
2. docker create motor-container --network bridge --dns 127.0.0.1 \
     --add-host host.docker.internal:host-gateway \
     -e HTTP_PROXY=http://host.docker.internal:<port> \
     -e HTTPS_PROXY=http://host.docker.internal:<port> \
     -e WAIT_FOR_READY=1 \
     --sysctl net.ipv6.conf.all.disable_ipv6=1 ...
3. Copy workspace to container
4. docker start -ai motor-container       ← tool-server blocks on stdin waiting for "ready\n"
5. Resolve host gateway IP
6. Apply iptables: DROP all, ACCEPT only gateway:proxyPort
7. Write "ready\n" to stdin               ← tool-server starts IPC processing
```

On failure at any step: `egressProxyManager.release(runId)` + container cleanup.

Without domains, containers still use `--network none` (no proxy allocated).

## iptables Rules (Proxy Mode)

Applied atomically via `iptables-restore`. All traffic is blocked except to the proxy:

```
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Block DNS (defense-in-depth)
-A OUTPUT -p tcp --dport 53 -j DROP
-A OUTPUT -p udp --dport 53 -j DROP
-A OUTPUT -p tcp --dport 853 -j DROP
# Allow ONLY the proxy
-A OUTPUT -d <gateway-ip> -p tcp --dport <proxy-port> -j ACCEPT
COMMIT
```

IPv6 rules (`ip6tables-restore`) drop everything except loopback.

## Helper Container

A minimal Debian + iptables image (`lifemodel-netpolicy:latest`) runs with `--cap-add NET_ADMIN` in the target container's network namespace. Built lazily on first use.

## Dynamic Domain Addition

For builtin skills with `autoAllowSearchDomains`, the Motor Cortex can dynamically expand the proxy allowlist mid-run via `egressProxyManager.addDomain(runId, domain)`. This is wired through `motor-tools.ts → motor-loop.ts → motor-cortex.ts`. No container restart needed — the proxy's domain set is mutable.

## Domain Threading

Domains flow from multiple sources, merged (union, deduplicated, lowercased) at each stage:

```
policy.domains         core.act({ domains })    core.task({ action:'retry', domains })
         \                      |                         /
          └────── mergeDomains() ─── MotorRun.domains ──┘
                                          |
                            ContainerConfig.allowedDomains
                                          |
                          egressProxyManager.allocate()
                                          |
                              proxy allowlist per run
```

On retry, new domains are unioned with existing `run.domains` — the set only grows, never shrinks within a run.

### Tiered Domain Permissions

Domain approvals are remembered at three levels:

| Level | Scope | Storage | Lifetime |
|-------|-------|---------|----------|
| Run | Single Motor Cortex run | `run.domains` (in-memory) | Until run completes |
| Session | All runs in the process | `MotorCortex.sessionAllowedDomains` (in-memory Set) | Until process restart |
| Permanent | All future runs of a skill | `policy.json` `domains` array (on disk) | Until manually removed |

**Flow:** When a user approves a domain via `ask_user` (auto-pause):
1. Domain is added to `run.domains` (run-scoped, immediate)
2. Domain is added to `sessionAllowedDomains` (session-scoped, future runs auto-approve)
3. For skill runs: domain is persisted to `policy.json` (permanent, future sessions)

Session-scoped check happens in the fetch executor (`motor-tools.ts`). When a domain is blocked but found in `sessionAllowedDomains`, it's auto-approved without user prompt and added to the run's allowlist + egress proxy. This avoids corrupting the consecutive-failure counter that the motor loop uses for auto-fail detection.

Refusal detection: if the user's answer contains refusal signals (`no`, `deny`, `block`, etc.), domain merging and persistence are skipped.

### Domain Persistence

Creation domains and usage domains are **separate concerns**:

- **Creation domains** (`run.domains`): Domains needed to build the skill (docs sites, skills.sh, etc.). These are NOT persisted to `policy.domains` — they would over-grant runtime permissions.
- **Usage domains** (`policy.domains`): Runtime execution permissions. Set by the user during approval (via `core.skill(action:"update")`), preserved on skill updates.

Cognition owns all policy persistence. Motor Cortex middleware handles post-run extraction only.

## Files

| File | Purpose |
|------|---------|
| `src/runtime/container/egress-proxy.ts` | `EgressProxyManager` — per-run proxy lifecycle, CONNECT handler, plain HTTP handler, SSRF protection |
| `src/runtime/container/network-policy.ts` | `isValidDomainPattern()`, `isValidWildcardDomain()`, `matchesDomainPattern()`, `buildProxyIptablesRules()`, `applyProxyNetworkPolicy()`, `isPrivateIP()`, `mergeDomains()` |
| `src/runtime/container/netpolicy-image.ts` | Lazy build of `lifemodel-netpolicy:latest` helper image |
| `src/runtime/container/container-manager.ts` | Proxy lifecycle in `create()`, `destroy()`, `runScript()`, `destroyAll()` |
| `src/runtime/container/types.ts` | `ContainerConfig.allowedDomains`, `ContainerConfig.allowedPorts` |
| `src/runtime/motor-cortex/motor-cortex.ts` | Wires `egressProxyManager.addDomain` callback |
| `src/runtime/motor-cortex/motor-tools.ts` | Wildcard-aware fetch domain matching via `matchesDomainPattern()` |
| `src/runtime/motor-cortex/motor-loop.ts` | Passes through `onProxyDomainAdded` callback |
| `src/layers/cognition/tools/core/act.ts` | `domains` parameter validation with `isValidDomainPattern()` |
| `src/layers/cognition/tools/core/skill.ts` | Policy domain validation with `isValidDomainPattern()` |
| `tests/unit/container/network-policy.test.ts` | Wildcard validation, proxy iptables, domain matching tests |
| `tests/unit/container/egress-proxy.test.ts` | Proxy lifecycle, CONNECT tunneling, SSRF rejection tests |

## Legacy Functions (Deprecated)

The old DNS/IP-based approach functions are kept but deprecated:
- `resolveNetworkPolicy()` — was: resolve domains to IPs for `--add-host` and iptables
- `buildIptablesRules()` — was: per-IP ACCEPT rules
- `buildIp6tablesRules()` — was: IPv6 DROP-all rules
- `applyNetworkPolicy()` — was: run helper container with old iptables rules

These are superseded by the proxy-based approach (`applyProxyNetworkPolicy()`, `buildProxyIptablesRules()`).

## Advantages Over Previous Approach

| Concern | Old (DNS/IP) | New (Proxy) |
|---------|-------------|-------------|
| Wildcard domains | Not supported (IPs are static) | Native (hostname matching) |
| CDN IP rotation | Stale IPs after creation | Resolved per-request |
| Shared CDN IPs | Could reach other domains on same IP | Proxy sees actual hostname |
| DNS rebinding | Resolved once at creation | Resolved per-request + private IP check |
| Implementation | DNS sidecar + iptables per-IP | Single proxy process per run |
