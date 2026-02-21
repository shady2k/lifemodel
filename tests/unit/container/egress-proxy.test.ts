/**
 * Unit tests for Egress Proxy Manager.
 *
 * Tests proxy allocation/release lifecycle, domain filtering, and SSRF protection.
 * Uses actual HTTP connections for testing proxy behavior.
 *
 * For successful CONNECT tests, we run a local TCP echo server as the "upstream"
 * and skip the SSRF check by resolving DNS to the echo server's address.
 * Since the SSRF check rejects all RFC1918/loopback, we use a separate approach:
 * we mock the isPrivateIP check for specific test IPs.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { EgressProxyManager } from '../../../src/runtime/container/egress-proxy.js';
import net from 'node:net';
import http from 'node:http';

// Mock DNS resolution to avoid real network calls
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
}));

// Get the REAL isPrivateIP implementation (bypasses vi.mock) for restoring in beforeEach
const { isPrivateIP: realIsPrivateIP } = await vi.importActual<typeof import('../../../src/runtime/container/network-policy.js')>('../../../src/runtime/container/network-policy.js');

// Partially mock network-policy to allow 127.0.0.1 in tests while keeping matchesDomainPattern real
vi.mock('../../../src/runtime/container/network-policy.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/runtime/container/network-policy.js')>('../../../src/runtime/container/network-policy.js');
  return {
    ...actual,
    isPrivateIP: vi.fn(actual.isPrivateIP),
  };
});

describe('EgressProxyManager', () => {
  let manager: EgressProxyManager;
  let dns: typeof import('node:dns/promises');
  let networkPolicy: typeof import('../../../src/runtime/container/network-policy.js');

  // Local TCP echo server (acts as upstream for successful CONNECT tests)
  let echoServer: net.Server;
  let echoPort: number;

  beforeEach(async () => {
    manager = new EgressProxyManager();
    dns = await import('node:dns/promises');
    networkPolicy = await import('../../../src/runtime/container/network-policy.js');
    vi.resetAllMocks();
    // Restore real isPrivateIP (must use realIsPrivateIP from vi.importActual, not the mock reference)
    vi.mocked(networkPolicy.isPrivateIP).mockImplementation(realIsPrivateIP);

    // Start a local echo server
    echoServer = net.createServer((socket) => {
      socket.write('echo-connected\n');
      socket.on('error', () => {});
    });
    echoPort = await new Promise<number>((resolve) => {
      echoServer.listen(0, '127.0.0.1', () => {
        const addr = echoServer.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });
  });

  afterEach(async () => {
    await manager.releaseAll();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      echoServer.close(() => resolve());
    });
  });

  /**
   * Set up mocks so the proxy connects to the local echo server.
   * - DNS resolves to 127.0.0.1
   * - isPrivateIP returns false for 127.0.0.1 (bypass SSRF for testing)
   */
  function allowLocalUpstream(): void {
    vi.mocked(dns.resolve4).mockResolvedValue(['127.0.0.1']);
    vi.mocked(networkPolicy.isPrivateIP).mockReturnValue(false);
  }

  describe('allocate/release lifecycle', () => {
    it('allocates a proxy on an ephemeral port', async () => {
      const { port } = await manager.allocate('run-1', ['example.com']);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });

    it('rejects duplicate allocation for same runId', async () => {
      await manager.allocate('run-1', ['example.com']);
      await expect(manager.allocate('run-1', ['other.com'])).rejects.toThrow(
        'Proxy already allocated'
      );
    });

    it('releases without error', async () => {
      await manager.allocate('run-1', ['example.com']);
      await expect(manager.release('run-1')).resolves.toBeUndefined();
    });

    it('release is idempotent (no error for unknown runId)', async () => {
      await expect(manager.release('nonexistent')).resolves.toBeUndefined();
    });

    it('releaseAll cleans up all allocations', async () => {
      await manager.allocate('run-1', ['a.com']);
      await manager.allocate('run-2', ['b.com']);
      await expect(manager.releaseAll()).resolves.toBeUndefined();
    });

    it('allows re-allocation after release', async () => {
      await manager.allocate('run-1', ['example.com']);
      await manager.release('run-1');
      const { port } = await manager.allocate('run-1', ['example.com']);
      expect(port).toBeGreaterThan(0);
    });
  });

  describe('addDomain', () => {
    it('adds domain to existing allocation (CONNECT succeeds)', async () => {
      allowLocalUpstream();

      const { port } = await manager.allocate('run-1', ['example.com'], [echoPort]);
      manager.addDomain('run-1', 'new.example.com');

      const result = await connectViaProxy(port, `new.example.com:${String(echoPort)}`);
      expect(result.statusLine).toContain('200');
    });

    it('no-op for unknown runId', () => {
      manager.addDomain('nonexistent', 'example.com');
    });
  });

  describe('CONNECT handler (HTTPS tunneling)', () => {
    it('allows CONNECT to allowed domain (tunnel established)', async () => {
      allowLocalUpstream();

      const { port } = await manager.allocate('run-1', ['example.com'], [echoPort]);
      const result = await connectViaProxy(port, `example.com:${String(echoPort)}`);

      expect(result.statusLine).toContain('200');
    });

    it('rejects CONNECT to disallowed domain', async () => {
      const { port } = await manager.allocate('run-1', ['example.com']);
      const result = await connectViaProxy(port, 'evil.com:443');

      expect(result.statusLine).toContain('403');
      expect(result.body).toContain('not in allowlist');
    });

    it('supports wildcard domain matching', async () => {
      allowLocalUpstream();

      const { port } = await manager.allocate('run-1', ['*.googlevideo.com'], [echoPort]);
      const result = await connectViaProxy(
        port,
        `rr3---sn-abc.googlevideo.com:${String(echoPort)}`
      );

      expect(result.statusLine).toContain('200');
    });

    it('rejects wildcard base domain (*.x.com does not match x.com)', async () => {
      const { port } = await manager.allocate('run-1', ['*.googlevideo.com']);
      const result = await connectViaProxy(port, 'googlevideo.com:443');

      expect(result.statusLine).toContain('403');
    });

    it('rejects CONNECT to private IP (SSRF protection)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);
      // Restore real isPrivateIP for this test
      const { port } = await manager.allocate('run-1', ['evil-ssrf.com']);
      const result = await connectViaProxy(port, 'evil-ssrf.com:443');

      expect(result.statusLine).toContain('403');
      expect(result.body).toContain('private IP');
    });

    it('rejects CONNECT to loopback IP', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['127.0.0.1']);
      const { port } = await manager.allocate('run-1', ['loopback.com']);
      const result = await connectViaProxy(port, 'loopback.com:443');

      expect(result.statusLine).toContain('403');
      expect(result.body).toContain('private IP');
    });

    it('rejects CONNECT to metadata endpoint IP', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['169.254.169.254']);
      const { port } = await manager.allocate('run-1', ['metadata.com']);
      const result = await connectViaProxy(port, 'metadata.com:443');

      expect(result.statusLine).toContain('403');
      expect(result.body).toContain('private IP');
    });

    it('rejects CONNECT to disallowed port', async () => {
      const { port } = await manager.allocate('run-1', ['example.com'], [443]);
      const result = await connectViaProxy(port, 'example.com:8080');

      expect(result.statusLine).toContain('403');
      expect(result.body).toContain('not allowed');
    });

    it('handles DNS resolution failure', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('NXDOMAIN'));

      const { port } = await manager.allocate('run-1', ['bad-dns.com']);
      const result = await connectViaProxy(port, 'bad-dns.com:443');

      expect(result.statusLine).toContain('502');
    });

    it('handles empty DNS result', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue([]);

      const { port } = await manager.allocate('run-1', ['empty-dns.com']);
      const result = await connectViaProxy(port, 'empty-dns.com:443');

      expect(result.statusLine).toContain('502');
    });
  });

  describe('unrestricted wildcard *', () => {
    it('CONNECT succeeds for any domain when * in allowlist', async () => {
      allowLocalUpstream();

      const { port } = await manager.allocate('run-star', ['*'], [echoPort]);
      const result = await connectViaProxy(port, `any-domain.example.com:${String(echoPort)}`);
      expect(result.statusLine).toContain('200');
    });

    it('SSRF protection still blocks private IPs even with *', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);
      // Don't bypass isPrivateIP — let it reject

      const { port } = await manager.allocate('run-star-ssrf', ['*']);
      const result = await connectViaProxy(port, 'ssrf-target.com:443');
      expect(result.statusLine).toContain('403');
      expect(result.body).toContain('private IP');
    });
  });

  describe('plain HTTP handler', () => {
    it('rejects plain HTTP to disallowed domain', async () => {
      const { port } = await manager.allocate('run-1', ['example.com']);

      const result = await httpViaProxy(port, 'http://evil.com/test');
      expect(result.statusCode).toBe(403);
    });

    it('rejects plain HTTP to private IP (SSRF)', async () => {
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);
      const { port } = await manager.allocate('run-1', ['internal.com']);

      const result = await httpViaProxy(port, 'http://internal.com/test');
      expect(result.statusCode).toBe(403);
    });
  });
});

/**
 * Helper: send a CONNECT request through the proxy and return the status line + body.
 */
function connectViaProxy(
  proxyPort: number,
  target: string
): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

    let data = '';
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();

      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd >= 0) {
        const statusLine = data.slice(0, headerEnd).split('\r\n')[0] ?? '';
        const body = data.slice(headerEnd + 4);
        resolve({ statusLine, body });
      } else if (data.length > 0) {
        const lines = data.split('\r\n');
        resolve({ statusLine: lines[0] ?? '', body: data });
      } else {
        reject(new Error('No data received'));
      }
    };

    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        done();
      }
    });

    socket.on('end', done);
    socket.on('close', done);
    socket.on('error', () => done());

    setTimeout(done, 3000);
  });
}

/**
 * Helper: send a plain HTTP request through the proxy.
 */
function httpViaProxy(
  proxyPort: number,
  url: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: url,
        method: 'GET',
        headers: { Host: parsed.hostname },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('HTTP timeout'));
    });
    req.end();
  });
}
