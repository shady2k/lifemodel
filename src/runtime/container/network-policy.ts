/**
 * Network Policy for Motor Cortex Container Isolation
 *
 * Implements per-skill network access with kernel-level iptables enforcement.
 * Three layers of defense:
 * 1. DNS: --dns 127.0.0.1 blocks normal DNS resolution
 * 2. Resolution: --add-host domain:IP ensures declared domains work
 * 3. Kernel: iptables OUTPUT DROP + ACCEPT IPs blocks raw IPs, DNS bypass, internal networks
 *
 * Known limitations (documented, not solved in v1):
 * - Shared CDN IPs: Container can reach other domains on the same IP via Host header
 * - IP rotation: Resolved IPs frozen at container creation
 * - No port-per-domain: Ports are global to the policy, not per-domain
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../../types/index.js';

const execFileAsync = promisify(execFile);

/**
 * Network policy for a Motor Cortex run.
 */
export interface NetworkPolicy {
  /** Domain names that are allowed (e.g., ['api.example.com']) */
  domains: string[];

  /** Resolved IP addresses for each domain (all A records, not just first) */
  resolvedHosts: Map<string, string[]>;

  /** Allowed ports (default: [80, 443]) */
  ports: number[];
}

/**
 * Domain validation regex.
 * Allows alphanumeric, dots, hyphens. Rejects IP addresses, spaces, special chars.
 */
const DOMAIN_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * RFC1918, loopback, and link-local CIDR ranges.
 * Resolved IPs in these ranges are rejected to prevent SSRF.
 */
const PRIVATE_RANGES: { prefix: number; mask: number }[] = [
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8 (loopback)
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 (link-local)
  { prefix: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8
];

/**
 * Parse an IPv4 address to a 32-bit integer.
 */
function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  const [a, b, c, d] = parts as [string, string, string, string];
  return (
    ((parseInt(a, 10) << 24) |
      (parseInt(b, 10) << 16) |
      (parseInt(c, 10) << 8) |
      parseInt(d, 10)) >>>
    0
  );
}

/**
 * Check if an IP address falls within any private/reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  const addr = ipToInt(ip);
  for (const range of PRIVATE_RANGES) {
    if ((addr & range.mask) >>> 0 === range.prefix >>> 0) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a domain name against injection attempts.
 *
 * @param domain - Domain to validate
 * @returns true if valid, false otherwise
 */
export function isValidDomain(domain: string): boolean {
  if (!domain || domain.length > 253) return false;

  // Reject IP addresses
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return false;
  if (domain.includes('[') || domain.includes(']')) return false; // IPv6

  // Check against regex
  return DOMAIN_REGEX.test(domain);
}

/**
 * Resolve domains to ALL IP addresses via DNS.
 *
 * Uses dns.promises.resolve4() (not lookup()) to get ALL A records.
 * Throws on failure (deterministic errors need prevention, not recovery).
 * Rejects private/reserved IPs to prevent SSRF via DNS rebinding.
 *
 * @param domains - Domain names to resolve
 * @param ports - Allowed ports (default: [80, 443])
 * @returns Resolved network policy
 * @throws Error if DNS resolution fails, domain is invalid, or IPs are private
 */
export async function resolveNetworkPolicy(
  domains: string[],
  ports: number[] = [80, 443]
): Promise<NetworkPolicy> {
  // Normalize to lowercase and dedupe
  const uniqueDomains = Array.from(new Set(domains.map((d) => d.toLowerCase())));

  // Validate all domains first
  for (const domain of uniqueDomains) {
    if (!isValidDomain(domain)) {
      throw new Error(`Invalid domain name: ${domain}`);
    }
  }

  // Import dns module dynamically (Node.js built-in)
  const dns = await import('node:dns/promises');

  // Resolve each domain to ALL A records
  const resolvedHosts = new Map<string, string[]>();
  for (const domain of uniqueDomains) {
    try {
      const ips = await dns.resolve4(domain); // All A records, not just first
      if (ips.length === 0) {
        throw new Error(`No A records found for domain: ${domain}`);
      }

      // Reject private/reserved IPs (SSRF prevention)
      for (const ip of ips) {
        if (isPrivateIP(ip)) {
          throw new Error(
            `Domain ${domain} resolved to private/reserved IP ${ip} — this is not allowed`
          );
        }
      }

      resolvedHosts.set(domain, ips);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Re-throw our own errors directly
      if (message.includes('private/reserved IP') || message.includes('No A records')) {
        throw error;
      }
      throw new Error(`Failed to resolve domain ${domain}: ${message}`);
    }
  }

  // Validate ports
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${String(port)}`);
    }
  }

  return {
    domains: uniqueDomains,
    resolvedHosts,
    ports,
  };
}

/**
 * Generate iptables-restore compatible ruleset (IPv4).
 *
 * Uses iptables-restore format for atomic rule application (no sequential calls).
 * Default DROP policy on all chains, then explicit ACCEPT rules for allowed IPs/ports.
 *
 * @param policy - Network policy with resolved IPs
 * @returns iptables-restore compatible ruleset
 */
export function buildIptablesRules(policy: NetworkPolicy): string {
  const lines: string[] = [
    '*filter',
    ':INPUT DROP [0:0]',
    ':FORWARD DROP [0:0]',
    ':OUTPUT DROP [0:0]',
  ];

  // INPUT: allow established + loopback (for tool-server IPC)
  lines.push('-A INPUT -i lo -j ACCEPT');
  lines.push('-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');

  // OUTPUT: allow loopback
  lines.push('-A OUTPUT -o lo -j ACCEPT');

  // OUTPUT: allow established/related connections
  lines.push('-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');

  // Block internal networks (metadata endpoints, Docker bridge, host services)
  lines.push('-A OUTPUT -d 10.0.0.0/8 -j DROP');
  lines.push('-A OUTPUT -d 172.16.0.0/12 -j DROP');
  lines.push('-A OUTPUT -d 192.168.0.0/16 -j DROP');
  lines.push('-A OUTPUT -d 169.254.0.0/16 -j DROP');

  // Block alternative DNS (prevents DoH/DoT bypass)
  lines.push('-A OUTPUT -p tcp --dport 53 -j DROP');
  lines.push('-A OUTPUT -p udp --dport 53 -j DROP');
  lines.push('-A OUTPUT -p tcp --dport 853 -j DROP');

  // Build a set of unique IPs (domains may share IPs)
  const ipSet = new Set<string>();
  for (const ips of policy.resolvedHosts.values()) {
    for (const ip of ips) {
      ipSet.add(ip);
    }
  }

  // Allow specific IPs on specific ports
  for (const ip of ipSet) {
    for (const port of policy.ports) {
      lines.push(`-A OUTPUT -d ${ip} -p tcp --dport ${String(port)} -j ACCEPT`);
    }
  }

  // Commit the ruleset
  lines.push('COMMIT');

  return lines.join('\n');
}

/**
 * Generate ip6tables-restore ruleset that drops ALL IPv6 traffic.
 *
 * Defense-in-depth: even if the --sysctl net.ipv6.conf.all.disable_ipv6=1
 * is ignored or unsupported, iptables blocks IPv6 at the kernel level.
 *
 * @returns ip6tables-restore compatible ruleset
 */
export function buildIp6tablesRules(): string {
  return [
    '*filter',
    ':INPUT DROP [0:0]',
    ':FORWARD DROP [0:0]',
    ':OUTPUT DROP [0:0]',
    // Allow loopback only (for internal IPC)
    '-A INPUT -i lo -j ACCEPT',
    '-A OUTPUT -o lo -j ACCEPT',
    'COMMIT',
  ].join('\n');
}

/**
 * Apply network policy via privileged helper container.
 *
 * Spawns a temporary helper container with NET_ADMIN capability,
 * shares the target container's network namespace, applies iptables
 * AND ip6tables rules atomically, then exits.
 *
 * @param containerId - Target container ID
 * @param policy - Network policy to apply
 * @param logger - Logger instance
 * @throws Error if helper container fails to apply rules
 */
export async function applyNetworkPolicy(
  containerId: string,
  policy: NetworkPolicy,
  logger: Logger
): Promise<void> {
  const log = logger.child({ component: 'network-policy', containerId: containerId.slice(0, 12) });

  // Generate iptables rules (IPv4 + IPv6)
  const ipv4Rules = buildIptablesRules(policy);
  const ipv6Rules = buildIp6tablesRules();

  // Generate unique helper container name
  const helperName = `netpolicy-${randomBytes(4).toString('hex')}`;

  log.info(
    { domains: policy.domains, ipCount: policy.resolvedHosts.size },
    'Applying network policy'
  );

  try {
    // Apply both IPv4 and IPv6 rules atomically in a single helper container run.
    // ip6tables-restore may fail on hosts without IPv6 support — that's fine
    // (if there's no IPv6, there's nothing to block).
    const script = [
      'set -e',
      `iptables-restore <<'RULES4'`,
      ipv4Rules,
      'RULES4',
      `ip6tables-restore <<'RULES6' 2>/dev/null || true`,
      ipv6Rules,
      'RULES6',
    ].join('\n');

    const { stderr } = await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        helperName,
        '--cap-add',
        'NET_ADMIN',
        '--network',
        `container:${containerId}`,
        'lifemodel-netpolicy:latest',
        '-c',
        script,
      ],
      {
        timeout: 10_000,
      }
    );

    // Log any stderr output (diagnostic)
    if (stderr.trim()) {
      log.debug({ output: stderr.trim() }, 'Helper container stderr');
    }

    log.info('Network policy applied successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Failed to apply network policy');
    throw new Error(`Network policy application failed: ${message}`);
  }
}

/**
 * Merge domains from multiple sources (skill + explicit user input).
 * Normalizes to lowercase for case-insensitive deduplication.
 *
 * @param skillDomains - Domains from skill definition
 * @param explicitDomains - Domains from user's core.act call
 * @returns Deduplicated union of domains (lowercased)
 */
export function mergeDomains(
  skillDomains: string[] | undefined,
  explicitDomains: string[] | undefined
): string[] {
  const all = [...(skillDomains ?? []), ...(explicitDomains ?? [])].map((d) => d.toLowerCase());
  return Array.from(new Set(all));
}

// === Wildcard domain support (for egress proxy) ===

/**
 * Wildcard domain regex: *.example.com format.
 * Must start with "*.", followed by a valid domain name.
 */
const WILDCARD_DOMAIN_REGEX =
  /^\*\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Validate a wildcard domain pattern (e.g., *.googlevideo.com).
 *
 * Only supports prefix wildcards: *.example.com
 * Rejects: *.*, *example.com, foo.*.com, etc.
 */
export function isValidWildcardDomain(domain: string): boolean {
  if (!domain || domain.length > 255) return false;
  return WILDCARD_DOMAIN_REGEX.test(domain);
}

/**
 * Validate a domain pattern — either exact domain or wildcard.
 */
export function isValidDomainPattern(domain: string): boolean {
  if (domain === '*') return true;
  return isValidDomain(domain) || isValidWildcardDomain(domain);
}

/**
 * Check if a hostname matches a domain pattern.
 *
 * - Exact pattern: "api.example.com" matches only "api.example.com"
 * - Wildcard pattern: "*.example.com" matches "sub.example.com", "a.b.example.com"
 *   but NOT "example.com" itself
 */
export function matchesDomainPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();

  // Unrestricted wildcard: matches any domain
  if (p === '*') return true;

  if (p.startsWith('*.')) {
    // Wildcard: *.example.com → match anything.example.com
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }

  // Exact match
  return h === p;
}

/**
 * Generate iptables-restore rules for proxy-based network policy.
 *
 * Much simpler than the legacy per-IP rules: only allow traffic to the
 * Docker gateway on the proxy port. Everything else is DROP.
 *
 * @param opts - Gateway IP and proxy port
 * @returns iptables-restore compatible ruleset
 */
export function buildProxyIptablesRules(opts: { gatewayIp: string; proxyPort: number }): string {
  const { gatewayIp, proxyPort } = opts;

  const lines: string[] = [
    '*filter',
    ':INPUT DROP [0:0]',
    ':FORWARD DROP [0:0]',
    ':OUTPUT DROP [0:0]',

    // INPUT: allow established + loopback (for tool-server IPC)
    '-A INPUT -i lo -j ACCEPT',
    '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',

    // OUTPUT: allow loopback
    '-A OUTPUT -o lo -j ACCEPT',

    // OUTPUT: allow established/related connections
    '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',

    // Block DNS (defense-in-depth — container already has --dns 127.0.0.1)
    '-A OUTPUT -p tcp --dport 53 -j DROP',
    '-A OUTPUT -p udp --dport 53 -j DROP',
    '-A OUTPUT -p tcp --dport 853 -j DROP',

    // ACCEPT: only the proxy on the gateway
    `-A OUTPUT -d ${gatewayIp} -p tcp --dport ${String(proxyPort)} -j ACCEPT`,

    // Everything else is DROP (default policy)
    'COMMIT',
  ];

  return lines.join('\n');
}

/**
 * Apply proxy-based network policy via privileged helper container.
 *
 * Same helper container approach as applyNetworkPolicy(), but with
 * simplified rules that only allow proxy traffic.
 *
 * @param containerId - Target container ID
 * @param opts - Gateway IP and proxy port
 * @param logger - Logger instance
 */
export async function applyProxyNetworkPolicy(
  containerId: string,
  opts: { gatewayIp: string; proxyPort: number },
  logger: Logger
): Promise<void> {
  const log = logger.child({ component: 'network-policy', containerId: containerId.slice(0, 12) });

  const ipv4Rules = buildProxyIptablesRules(opts);
  const ipv6Rules = buildIp6tablesRules();

  const helperName = `netpolicy-${randomBytes(4).toString('hex')}`;

  log.info(
    { gatewayIp: opts.gatewayIp, proxyPort: opts.proxyPort },
    'Applying proxy network policy'
  );

  try {
    const script = [
      'set -e',
      `iptables-restore <<'RULES4'`,
      ipv4Rules,
      'RULES4',
      `ip6tables-restore <<'RULES6' 2>/dev/null || true`,
      ipv6Rules,
      'RULES6',
    ].join('\n');

    const { stderr } = await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        helperName,
        '--cap-add',
        'NET_ADMIN',
        '--network',
        `container:${containerId}`,
        'lifemodel-netpolicy:latest',
        '-c',
        script,
      ],
      {
        timeout: 10_000,
      }
    );

    if (stderr.trim()) {
      log.debug({ output: stderr.trim() }, 'Helper container stderr');
    }

    log.info('Proxy network policy applied successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error: message }, 'Failed to apply proxy network policy');
    throw new Error(`Proxy network policy application failed: ${message}`);
  }
}
