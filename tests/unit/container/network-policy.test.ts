/**
 * Unit tests for Network Policy — mocks DNS resolution and Docker CLI calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isValidDomain,
  isPrivateIP,
  resolveNetworkPolicy,
  buildIptablesRules,
  buildIp6tablesRules,
  mergeDomains,
} from '../../../src/runtime/container/network-policy.js';

// Mock dns.promises module
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
}));

describe('isValidDomain()', () => {
  const validCases = [
    'example.com',
    'api.example.com',
    'sub.domain.example.com',
    'a-b.example.com',
    'test-domain.co.uk',
    '123domain.com',
    'domain123.test',
  ];

  const invalidCases = [
    '', // empty
    '.example.com', // starts with dot
    'example.com.', // ends with dot
    'example..com', // consecutive dots
    '-example.com', // starts with hyphen
    'example-.com', // ends with hyphen
    'exa mple.com', // contains space
    'example.com/path', // contains path
    'http://example.com', // contains protocol
    '1.2.3.4', // IP address
    '[::1]', // IPv6
    'a'.repeat(254), // too long
  ];

  it.each(validCases)('accepts valid domain: %s', (domain) => {
    expect(isValidDomain(domain)).toBe(true);
  });

  it.each(invalidCases)('rejects invalid domain: %s', (domain) => {
    expect(isValidDomain(domain)).toBe(false);
  });
});

describe('isPrivateIP()', () => {
  const privateCases = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback high'],
    ['10.0.0.1', 'RFC1918 class A'],
    ['10.255.255.255', 'RFC1918 class A high'],
    ['172.16.0.1', 'RFC1918 class B low'],
    ['172.31.255.255', 'RFC1918 class B high'],
    ['192.168.0.1', 'RFC1918 class C'],
    ['192.168.255.255', 'RFC1918 class C high'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'AWS metadata'],
    ['0.0.0.0', 'zero network'],
  ] as const;

  const publicCases = [
    ['93.184.216.34', 'example.com'],
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare DNS'],
    ['172.32.0.1', 'just above RFC1918 172.16-31'],
    ['11.0.0.1', 'just above 10.x'],
  ] as const;

  it.each(privateCases)('detects private IP: %s (%s)', (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it.each(publicCases)('allows public IP: %s (%s)', (ip) => {
    expect(isPrivateIP(ip)).toBe(false);
  });
});

describe('resolveNetworkPolicy()', () => {
  let dns: typeof import('node:dns/promises');

  beforeAll(async () => {
    dns = await import('node:dns/promises');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves valid domain to IPs array', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    const policy = await resolveNetworkPolicy(['example.com']);

    expect(policy.domains).toEqual(['example.com']);
    expect(policy.resolvedHosts.get('example.com')).toEqual(['93.184.216.34']);
    expect(policy.ports).toEqual([80, 443]);
  });

  it('resolves domain with multiple A records', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue([
      '93.184.216.34',
      '93.184.216.35',
      '93.184.216.36',
    ]);

    const policy = await resolveNetworkPolicy(['multi-a-record.com']);

    expect(policy.resolvedHosts.get('multi-a-record.com')).toEqual([
      '93.184.216.34',
      '93.184.216.35',
      '93.184.216.36',
    ]);
  });

  it('rejects invalid domain', async () => {
    await expect(resolveNetworkPolicy(['invalid domain'])).rejects.toThrow(
      'Invalid domain name'
    );
  });

  it('rejects IP address as domain', async () => {
    await expect(resolveNetworkPolicy(['1.2.3.4'])).rejects.toThrow(
      'Invalid domain name'
    );
  });

  it('deduplicates duplicate domains', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    const policy = await resolveNetworkPolicy([
      'example.com',
      'example.com',
      'example.com',
    ]);

    expect(policy.domains).toEqual(['example.com']);
    expect(dns.resolve4).toHaveBeenCalledTimes(1);
  });

  it('normalizes domains to lowercase', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    const policy = await resolveNetworkPolicy(['Example.COM', 'EXAMPLE.com']);

    expect(policy.domains).toEqual(['example.com']);
    expect(dns.resolve4).toHaveBeenCalledTimes(1);
  });

  it('deduplicates case-variant domains', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    const policy = await resolveNetworkPolicy(['API.Example.Com', 'api.example.com']);

    expect(policy.domains).toEqual(['api.example.com']);
    expect(dns.resolve4).toHaveBeenCalledTimes(1);
  });

  it('returns empty policy for empty domains array', async () => {
    const policy = await resolveNetworkPolicy([]);

    expect(policy.domains).toEqual([]);
    expect(policy.resolvedHosts.size).toBe(0);
    expect(policy.ports).toEqual([80, 443]);
  });

  it('uses custom ports when provided', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    const policy = await resolveNetworkPolicy(['example.com'], [443, 8443]);

    expect(policy.ports).toEqual([443, 8443]);
  });

  it('rejects invalid port', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    await expect(resolveNetworkPolicy(['example.com'], [99999])).rejects.toThrow(
      'Invalid port'
    );
  });

  it('rejects port out of range', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34']);

    await expect(resolveNetworkPolicy(['example.com'], [0])).rejects.toThrow(
      'Invalid port'
    );
  });

  it('throws on DNS resolution failure', async () => {
    vi.mocked(dns.resolve4).mockRejectedValue(new Error('DNS lookup failed'));

    await expect(resolveNetworkPolicy(['nonexistent.example'])).rejects.toThrow(
      'Failed to resolve domain nonexistent.example'
    );
  });

  it('throws on empty A records', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue([]);

    await expect(resolveNetworkPolicy(['example.com'])).rejects.toThrow(
      'No A records found for domain'
    );
  });

  // Private IP rejection tests
  it('rejects domain resolving to loopback IP', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['127.0.0.1']);

    await expect(resolveNetworkPolicy(['evil.example.com'])).rejects.toThrow(
      'private/reserved IP 127.0.0.1'
    );
  });

  it('rejects domain resolving to RFC1918 IP', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);

    await expect(resolveNetworkPolicy(['internal.example.com'])).rejects.toThrow(
      'private/reserved IP 10.0.0.1'
    );
  });

  it('rejects domain resolving to link-local (metadata endpoint)', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['169.254.169.254']);

    await expect(resolveNetworkPolicy(['metadata.example.com'])).rejects.toThrow(
      'private/reserved IP 169.254.169.254'
    );
  });

  it('rejects if any A record is private (mixed public + private)', async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(['93.184.216.34', '192.168.1.1']);

    await expect(resolveNetworkPolicy(['mixed.example.com'])).rejects.toThrow(
      'private/reserved IP 192.168.1.1'
    );
  });
});

describe('buildIptablesRules()', () => {
  it('defines all three chains with DROP policy', () => {
    const policy = {
      domains: [],
      resolvedHosts: new Map(),
      ports: [80, 443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain(':INPUT DROP [0:0]');
    expect(rules).toContain(':FORWARD DROP [0:0]');
    expect(rules).toContain(':OUTPUT DROP [0:0]');
  });

  it('allows INPUT on loopback and established connections', () => {
    const policy = {
      domains: [],
      resolvedHosts: new Map(),
      ports: [80, 443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('-A INPUT -i lo -j ACCEPT');
    expect(rules).toContain('-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
  });

  it('generates default DROP policy with loopback and established', () => {
    const policy = {
      domains: [],
      resolvedHosts: new Map(),
      ports: [80, 443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('*filter');
    expect(rules).toContain(':OUTPUT DROP [0:0]');
    expect(rules).toContain('-A OUTPUT -o lo -j ACCEPT');
    expect(rules).toContain('-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    expect(rules).toContain('COMMIT');
  });

  it('blocks internal networks', () => {
    const policy = {
      domains: [],
      resolvedHosts: new Map(),
      ports: [80, 443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('-A OUTPUT -d 10.0.0.0/8 -j DROP');
    expect(rules).toContain('-A OUTPUT -d 172.16.0.0/12 -j DROP');
    expect(rules).toContain('-A OUTPUT -d 192.168.0.0/16 -j DROP');
    expect(rules).toContain('-A OUTPUT -d 169.254.0.0/16 -j DROP');
  });

  it('blocks alternative DNS ports', () => {
    const policy = {
      domains: [],
      resolvedHosts: new Map(),
      ports: [80, 443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('-A OUTPUT -p tcp --dport 53 -j DROP');
    expect(rules).toContain('-A OUTPUT -p udp --dport 53 -j DROP');
    expect(rules).toContain('-A OUTPUT -p tcp --dport 853 -j DROP');
  });

  it('generates ACCEPT rules for single IP on default ports', () => {
    const policy = {
      domains: ['example.com'],
      resolvedHosts: new Map([['example.com', ['93.184.216.34']]]),
      ports: [80, 443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('-A OUTPUT -d 93.184.216.34 -p tcp --dport 80 -j ACCEPT');
    expect(rules).toContain('-A OUTPUT -d 93.184.216.34 -p tcp --dport 443 -j ACCEPT');
  });

  it('generates ACCEPT rules for multiple IPs', () => {
    const policy = {
      domains: ['example.com'],
      resolvedHosts: new Map([['example.com', ['93.184.216.34', '93.184.216.35']]]),
      ports: [443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('-A OUTPUT -d 93.184.216.34 -p tcp --dport 443 -j ACCEPT');
    expect(rules).toContain('-A OUTPUT -d 93.184.216.35 -p tcp --dport 443 -j ACCEPT');
  });

  it('generates ACCEPT rules for custom ports', () => {
    const policy = {
      domains: ['example.com'],
      resolvedHosts: new Map([['example.com', ['93.184.216.34']]]),
      ports: [8080, 9443],
    };

    const rules = buildIptablesRules(policy);

    expect(rules).toContain('-A OUTPUT -d 93.184.216.34 -p tcp --dport 8080 -j ACCEPT');
    expect(rules).toContain('-A OUTPUT -d 93.184.216.34 -p tcp --dport 9443 -j ACCEPT');
  });

  it('deduplicates shared IPs across domains', () => {
    const policy = {
      domains: ['example.com', 'another.com'],
      resolvedHosts: new Map([
        ['example.com', ['93.184.216.34']],
        ['another.com', ['93.184.216.34']], // Same IP
      ]),
      ports: [443],
    };

    const rules = buildIptablesRules(policy);

    // Count the number of ACCEPT rules for this IP
    const acceptCount = (rules.match(/-A OUTPUT -d 93\.184\.216\.34/g) || []).length;
    expect(acceptCount).toBe(1); // Only one rule per IP
  });

  it('generates valid iptables-restore format', () => {
    const policy = {
      domains: ['example.com'],
      resolvedHosts: new Map([['example.com', ['93.184.216.34']]]),
      ports: [443],
    };

    const rules = buildIptablesRules(policy);

    const lines = rules.split('\n');
    expect(lines[0]).toBe('*filter');
    expect(lines.at(-1)).toBe('COMMIT');
  });
});

describe('buildIp6tablesRules()', () => {
  it('drops all IPv6 traffic on all chains', () => {
    const rules = buildIp6tablesRules();

    expect(rules).toContain(':INPUT DROP [0:0]');
    expect(rules).toContain(':FORWARD DROP [0:0]');
    expect(rules).toContain(':OUTPUT DROP [0:0]');
  });

  it('allows loopback only', () => {
    const rules = buildIp6tablesRules();

    expect(rules).toContain('-A INPUT -i lo -j ACCEPT');
    expect(rules).toContain('-A OUTPUT -o lo -j ACCEPT');
  });

  it('generates valid ip6tables-restore format', () => {
    const rules = buildIp6tablesRules();

    const lines = rules.split('\n');
    expect(lines[0]).toBe('*filter');
    expect(lines.at(-1)).toBe('COMMIT');
  });

  it('has no ACCEPT rules for external traffic', () => {
    const rules = buildIp6tablesRules();

    // Only loopback accepts — no -d or --dport rules
    const acceptLines = rules.split('\n').filter((l) => l.includes('-j ACCEPT'));
    expect(acceptLines).toHaveLength(2); // INPUT lo + OUTPUT lo
  });
});

describe('mergeDomains()', () => {
  it('merges skill domains with explicit domains', () => {
    const result = mergeDomains(['api.skill.com'], ['user.example.com']);

    expect(result).toEqual(['api.skill.com', 'user.example.com']);
  });

  it('deduplicates overlapping domains', () => {
    const result = mergeDomains(['api.example.com'], ['api.example.com']);

    expect(result).toEqual(['api.example.com']);
  });

  it('returns empty array when both inputs are undefined', () => {
    const result = mergeDomains(undefined, undefined);

    expect(result).toEqual([]);
  });

  it('returns skill domains when explicit is undefined', () => {
    const result = mergeDomains(['api.skill.com'], undefined);

    expect(result).toEqual(['api.skill.com']);
  });

  it('returns explicit domains when skill is undefined', () => {
    const result = mergeDomains(undefined, ['user.example.com']);

    expect(result).toEqual(['user.example.com']);
  });

  it('handles multiple domains from both sources', () => {
    const result = mergeDomains(
      ['api1.skill.com', 'api2.skill.com'],
      ['user1.example.com', 'user2.example.com']
    );

    expect(result).toEqual([
      'api1.skill.com',
      'api2.skill.com',
      'user1.example.com',
      'user2.example.com',
    ]);
  });

  it('deduplicates all sources', () => {
    const result = mergeDomains(
      ['shared.com', 'skill.com'],
      ['shared.com', 'user.com']
    );

    expect(result).toEqual(['shared.com', 'skill.com', 'user.com']);
  });

  it('normalizes to lowercase for deduplication', () => {
    const result = mergeDomains(['API.Example.Com'], ['api.example.com']);

    expect(result).toEqual(['api.example.com']);
  });

  it('returns lowercase domains', () => {
    const result = mergeDomains(['API.SKILL.COM'], undefined);

    expect(result).toEqual(['api.skill.com']);
  });
});
