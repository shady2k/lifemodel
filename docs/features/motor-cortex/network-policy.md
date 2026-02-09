# Motor Cortex Network Policy

## Current State (Phase 3)

All Motor Cortex containers run with `--network none`. No network access is available from inside containers. This is the most conservative security posture.

Skills that need network access (e.g., `curl` to an API) currently rely on the host's `runShell()` when running in unsafe mode, or cannot execute network requests when running in container isolation.

## Future Design (Phase 4+)

### Per-Skill Domain Declarations

Skills declare network requirements in their SKILL.md frontmatter:

```yaml
---
name: agentmail
version: 1
tools: [shell, code, filesystem]
credentials: [agentmail_api_key]
domains: [api.agentmail.dev]
---
```

The `domains` field is already accepted and validated by the skill loader (as of Phase 3), but not enforced at runtime.

### Enforcement Options

Two approaches are under consideration:

#### Option A: DNS-Based Proxy Sidecar

- Run a tiny DNS proxy as a sidecar container
- Container's `/etc/resolv.conf` points to the proxy
- Proxy only resolves domains from the skill's allowlist
- All other DNS queries return NXDOMAIN

**Pros:** Works with any tool (curl, wget, Node fetch)
**Cons:** Complex setup, macOS Docker Desktop has DNS quirks

#### Option B: `--add-host` Approach

- Resolve allowed domains at container creation time
- Pass `--add-host domain:ip` flags to `docker create`
- Container can only reach pre-resolved IPs

**Pros:** Simple, no sidecar
**Cons:** Doesn't handle DNS changes, CDN/load-balanced services break

### Cognition Approval Gate

When a skill requests network access:

1. Cognition reviews the `domains` list before approving the run
2. Skills requesting network without prior user approval are rejected
3. Approved domains are cached per-skill (don't re-prompt for known skills)

### Implementation Notes

- `--network none` remains the default for skills without `domains`
- Network-enabled containers use a dedicated Docker network with egress filtering
- Container manager creates the network lazily on first use
- All network traffic is logged for audit purposes
