/**
 * Egress Proxy Manager — Host-side HTTP forward proxy for container network isolation.
 *
 * Replaces DNS/IP-based domain filtering with a proper forward proxy.
 * Containers use HTTP_PROXY/HTTPS_PROXY env vars to route all traffic through this proxy,
 * and iptables ensures they can ONLY reach the proxy (no direct connections).
 *
 * Security model:
 * 1. Proxy checks domain against allowlist (exact + wildcard suffix match)
 * 2. Proxy resolves DNS on host side, rejects private IPs (SSRF protection)
 * 3. Proxy restricts destination ports (default 80/443)
 * 4. Connects by resolved IP (not hostname) to prevent TOCTOU DNS rebinding
 * 5. iptables ensures container can ONLY reach the proxy
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { resolve4 } from 'node:dns/promises';
import type { Server } from 'node:http';
import { matchesDomainPattern, isPrivateIP } from './network-policy.js';

/**
 * Per-run proxy allocation.
 */
interface ProxyAllocation {
  server: Server;
  domains: Set<string>;
  ports: Set<number>;
  port: number;
}

/**
 * Manages per-run egress proxy instances.
 *
 * Each Motor Cortex run gets its own proxy listener with its own domain allowlist.
 * The proxy binds to an ephemeral port and is torn down when the run completes.
 */
class EgressProxyManager {
  private readonly allocations = new Map<string, ProxyAllocation>();

  /**
   * Allocate a proxy for a run.
   *
   * Creates an HTTP server that handles CONNECT (HTTPS tunneling) and
   * plain HTTP forwarding, both gated by domain allowlist.
   *
   * @param runId - Unique run identifier
   * @param domains - Allowed domain patterns (exact or wildcard like *.example.com)
   * @param ports - Allowed destination ports (default: [80, 443])
   * @returns The ephemeral port the proxy is listening on
   */
  async allocate(
    runId: string,
    domains: string[],
    ports: number[] = [80, 443]
  ): Promise<{ port: number }> {
    if (this.allocations.has(runId)) {
      throw new Error(`Proxy already allocated for run ${runId}`);
    }

    const domainSet = new Set(domains.map((d) => d.toLowerCase()));
    const portSet = new Set(ports);

    const server = createServer((req, res) => {
      this.handlePlainHttp(req, res, domainSet, portSet).catch(() => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Proxy error');
        }
      });
    });

    // CONNECT handler for HTTPS tunneling
    server.on('connect', (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head, domainSet, portSet).catch(() => {
        if (!clientSocket.destroyed) {
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      });
    });

    // Bind to ephemeral port on all interfaces (reachable from Docker bridge)
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '0.0.0.0', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get proxy port'));
        }
      });
      server.on('error', reject);
    });

    this.allocations.set(runId, { server, domains: domainSet, ports: portSet, port });

    return { port };
  }

  /**
   * Dynamically add a domain to an existing proxy allocation.
   * Used by autoAllowSearchDomains to expand the allowlist at runtime.
   */
  addDomain(runId: string, domain: string): void {
    const alloc = this.allocations.get(runId);
    if (alloc) {
      alloc.domains.add(domain.toLowerCase());
    }
  }

  /**
   * Release a proxy for a run.
   */
  async release(runId: string): Promise<void> {
    const alloc = this.allocations.get(runId);
    if (!alloc) return;

    this.allocations.delete(runId);

    await new Promise<void>((resolve) => {
      alloc.server.close(() => {
        resolve();
      });
      // Force-destroy any remaining connections
      alloc.server.closeAllConnections?.();
    });
  }

  /**
   * Release all proxies (cleanup on shutdown).
   */
  async releaseAll(): Promise<void> {
    const releases = Array.from(this.allocations.keys()).map((runId) => this.release(runId));
    await Promise.all(releases);
  }

  /**
   * Handle HTTPS CONNECT tunneling.
   *
   * Parses hostname:port from CONNECT target, checks against allowlist,
   * resolves DNS on host side, verifies no private IPs, then creates
   * a TCP tunnel to the resolved IP (not hostname — prevents DNS rebinding).
   */
  private async handleConnect(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
    domains: Set<string>,
    allowedPorts: Set<number>
  ): Promise<void> {
    const target = req.url ?? '';
    const colonIdx = target.lastIndexOf(':');

    let hostname: string;
    let port: number;

    if (colonIdx > 0) {
      hostname = target.slice(0, colonIdx).toLowerCase();
      port = parseInt(target.slice(colonIdx + 1), 10);
    } else {
      hostname = target.toLowerCase();
      port = 443;
    }

    // Check domain
    if (!this.isDomainAllowed(hostname, domains)) {
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          `Domain ${hostname} not in allowlist`
      );
      return;
    }

    // Check port
    if (!allowedPorts.has(port)) {
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          `Port ${String(port)} not allowed`
      );
      return;
    }

    // Resolve DNS on host side
    let resolvedIp: string;
    try {
      const ips = await resolve4(hostname);
      if (ips.length === 0) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nNo DNS records');
        return;
      }
      // Use first IP
      resolvedIp = ips[0] as string;
    } catch {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nDNS resolution failed');
      return;
    }

    // SSRF protection: reject private IPs
    if (isPrivateIP(resolvedIp)) {
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          `Resolved to private IP ${resolvedIp}`
      );
      return;
    }

    // Connect by resolved IP (not hostname) to prevent DNS rebinding
    const serverSocket = connect(port, resolvedIp, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => {
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });
  }

  /**
   * Handle plain HTTP requests (non-CONNECT).
   *
   * Parses Host header, checks against allowlist, resolves DNS,
   * forwards request with resolved IP.
   */
  private async handlePlainHttp(
    req: IncomingMessage,
    res: ServerResponse,
    domains: Set<string>,
    allowedPorts: Set<number>
  ): Promise<void> {
    const { hostname, port: portStr } = (() => {
      try {
        const parsed = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
        return { hostname: parsed.hostname.toLowerCase(), port: parsed.port || '80' };
      } catch {
        return { hostname: '', port: '80' };
      }
    })();

    const port = parseInt(portStr, 10);

    if (!hostname) {
      res.writeHead(400);
      res.end('Missing host');
      return;
    }

    // Check domain
    if (!this.isDomainAllowed(hostname, domains)) {
      res.writeHead(403);
      res.end(`Domain ${hostname} not in allowlist`);
      return;
    }

    // Check port
    if (!allowedPorts.has(port)) {
      res.writeHead(403);
      res.end(`Port ${String(port)} not allowed`);
      return;
    }

    // Resolve DNS
    let resolvedIp: string;
    try {
      const ips = await resolve4(hostname);
      if (ips.length === 0) {
        res.writeHead(502);
        res.end('No DNS records');
        return;
      }
      resolvedIp = ips[0] as string;
    } catch {
      res.writeHead(502);
      res.end('DNS resolution failed');
      return;
    }

    // SSRF check
    if (isPrivateIP(resolvedIp)) {
      res.writeHead(403);
      res.end(`Resolved to private IP ${resolvedIp}`);
      return;
    }

    // Forward request using resolved IP
    const { request } = await import('node:http');
    const proxyReq = request(
      {
        hostname: resolvedIp,
        port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: hostname },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Upstream error');
      }
    });

    req.pipe(proxyReq);
  }

  /**
   * Check if a hostname is allowed by the domain set.
   * Supports exact match and wildcard patterns (*.example.com).
   */
  private isDomainAllowed(hostname: string, domains: Set<string>): boolean {
    // Unrestricted wildcard: allow any public domain (SSRF check still runs after this)
    if (domains.has('*')) return true;

    // Fast path: exact match
    if (domains.has(hostname)) return true;

    // Slow path: check wildcards
    for (const pattern of domains) {
      if (pattern.startsWith('*.') && matchesDomainPattern(hostname, pattern)) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Singleton egress proxy manager.
 */
export const egressProxyManager = new EgressProxyManager();

// Export the class for testing
export { EgressProxyManager };
