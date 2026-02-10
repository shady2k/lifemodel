# Motor Cortex Network Policy

Per-skill network access with kernel-level enforcement. Containers that need external APIs get tightly scoped egress — everything else stays on `--network none`.

## User Flow

```
Cognition: "I need to access api.agentmail.dev"
User: "Sure"
  → core.act({ domains: ['api.agentmail.dev'], task: "..." })
  → Container: curl api.agentmail.dev ✅ | curl evil.com ❌ | curl 1.2.3.4 ❌

Mid-run discovery: motor cortex needs cdn.agentmail.dev too
  → Fails → Cognition asks user → retry with expanded domains
```

## Three Layers of Defense

| Layer | Mechanism | What it blocks |
|-------|-----------|----------------|
| 1. DNS | `--dns 127.0.0.1` | Normal DNS resolution for undeclared domains |
| 2. Resolution | `--add-host domain:IP` (all A records) | Ensures only declared domains can be resolved |
| 3. Kernel | iptables + ip6tables DROP + per-IP ACCEPT | Raw IP access, DNS bypass (DoH/DoT), internal networks, metadata endpoints, IPv6 |

No single layer is sufficient alone. Together they cover the attack surface:
- Layer 1 alone: bypassed by hardcoded IPs or DoH
- Layer 2 alone: container could still reach any IP directly
- Layer 3 alone: sufficient but layers 1+2 provide defense-in-depth

## Additional Security Measures

**Private IP rejection:** DNS results are validated against RFC1918, loopback, and link-local ranges at resolution time. A domain resolving to `127.0.0.1`, `10.x.x.x`, or `169.254.169.254` (cloud metadata) is rejected before the container is created. This prevents SSRF via DNS rebinding.

**IPv6 lockdown:** Both `--sysctl net.ipv6.conf.all.disable_ipv6=1` AND `ip6tables-restore` DROP-all rules are applied. If the sysctl is ignored or unsupported, ip6tables blocks IPv6 at the kernel level.

**Domain normalization:** All domains are lowercased before deduplication and resolution. `API.Example.Com` and `api.example.com` are treated as the same domain.

**Cleanup on failure:** If iptables application fails after the container is started and paused, the container is force-removed. A paused container with no iptables rules is never left running.

## Container Creation Flow

```
1. resolveNetworkPolicy()                ← DNS resolution ONCE, reused throughout
2. docker create motor-container --network bridge --dns 127.0.0.1 \
     --add-host domain:IP ... --sysctl net.ipv6.conf.all.disable_ipv6=1 ...
3. docker start motor-container          ← starts, tool-server blocks on stdin
4. docker pause motor-container           ← freeze (defense-in-depth)
5. docker run --rm --cap-add NET_ADMIN \
     --network container:motor-container \
     lifemodel-netpolicy:latest           ← applies iptables + ip6tables atomically
6. docker unpause motor-container         ← resume with network locked down
7. docker attach for IPC                  ← tool-server processes requests
```

DNS resolution happens exactly once (step 1). The same `NetworkPolicy` object is used for both `--add-host` entries (step 2) and iptables rules (step 5) — no possibility of divergence.

The pause/unpause sequence is defense-in-depth. The tool-server entrypoint blocks on stdin before doing any network work, so the start→pause window has no network activity in practice. The pause ensures this property survives future entrypoint changes.

Without domains, containers still use `--network none` (unchanged from Phase 3).

## iptables Rules

Applied atomically via `iptables-restore` (not sequential `iptables -A` calls). All three chains (INPUT, FORWARD, OUTPUT) are defined with DROP policy:

```
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Block internal networks
-A OUTPUT -d 10.0.0.0/8 -j DROP
-A OUTPUT -d 172.16.0.0/12 -j DROP
-A OUTPUT -d 192.168.0.0/16 -j DROP
-A OUTPUT -d 169.254.0.0/16 -j DROP
# Block alternative DNS (prevents DoH/DoT bypass)
-A OUTPUT -p tcp --dport 53 -j DROP
-A OUTPUT -p udp --dport 53 -j DROP
-A OUTPUT -p tcp --dport 853 -j DROP
# Allow specific IPs on allowed ports
-A OUTPUT -d 93.184.216.34 -p tcp --dport 443 -j ACCEPT
-A OUTPUT -d 93.184.216.34 -p tcp --dport 80 -j ACCEPT
COMMIT
```

IPv6 rules (`ip6tables-restore`) drop everything except loopback. Applied with `|| true` to handle hosts without IPv6 support gracefully.

## Helper Container

A minimal Alpine + iptables image (`lifemodel-netpolicy:latest`) runs with `--cap-add NET_ADMIN` in the target container's network namespace. Built lazily on first use (same pattern as the motor cortex image).

```dockerfile
FROM alpine:3.21
RUN apk add --no-cache iptables-legacy
ENTRYPOINT ["sh"]
```

## Domain Threading

Domains flow from multiple sources, merged (union, deduplicated, lowercased) at each stage:

```
SKILL.md frontmatter    core.act({ domains })    core.task({ action:'retry', domains })
         \                      |                         /
          └────── mergeDomains() ─── MotorRun.domains ──┘
                                          |
                            ContainerConfig.allowedDomains
                                          |
                              resolveNetworkPolicy()  ← single call, reused
                                          |
                         ┌────────────────┼────────────────┐
                   --add-host        buildIptablesRules  buildIp6tablesRules
```

On retry, new domains are unioned with existing `run.domains` — the set only grows, never shrinks within a run.

## Files

| File | Purpose |
|------|---------|
| `src/runtime/container/network-policy.ts` | `resolveNetworkPolicy()`, `buildIptablesRules()`, `buildIp6tablesRules()`, `applyNetworkPolicy()`, `mergeDomains()`, `isPrivateIP()` |
| `src/runtime/container/netpolicy-image.ts` | Lazy build of `lifemodel-netpolicy:latest` helper image |
| `src/runtime/container/container-manager.ts` | `buildCreateArgs()` network mode selection, pause/unpause flow with cleanup in `create()` |
| `src/runtime/container/types.ts` | `ContainerConfig.allowedDomains`, `ContainerConfig.allowedPorts` |
| `src/runtime/motor-cortex/motor-cortex.ts` | `startRun()` / `retryRun()` domain merging, threading to container config |
| `src/runtime/motor-cortex/motor-protocol.ts` | `MotorRun.domains` field |
| `src/layers/cognition/tools/core/act.ts` | `domains` parameter on `core.act` |
| `src/layers/cognition/tools/core/task.ts` | `domains` parameter on retry action |
| `tests/unit/container/network-policy.test.ts` | 75 unit tests |

## Known Limitations (v1)

**Shared CDN IPs:** If a domain resolves to a shared CDN IP (e.g., Cloudflare), the container can technically reach other domains on that IP via Host header manipulation. The iptables rules operate at L3/L4 — they allow the IP, not the domain.

**IP rotation:** Resolved IPs are frozen at container creation time. Long-running containers may encounter stale IPs if the upstream DNS changes.

**No port-per-domain:** Allowed ports are global to the policy (default: 80, 443), not per-domain. All allowed IPs can be reached on all allowed ports.

## Future Architecture Path

- **v2:** Egress proxy (Envoy/HAProxy) with SNI enforcement for domain-level security on shared IPs
- **v3:** Cilium/eBPF or microVM (Firecracker) for defense-in-depth
