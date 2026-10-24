import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWorkbenchImportEgress } from '../../loader/src/workbench-import-egress.js';

const PATH =
  '/apis/networking.k8s.io/v1/namespaces/lifemodel-system/networkpolicies/workbench-import-origin-egress';
const NAME = 'workbench-import-origin-egress';
const SELECTOR = { matchLabels: { 'app.kubernetes.io/name': 'loader' } };
const EXCEPT = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
function policy(resourceVersion = '17') {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: NAME, namespace: 'lifemodel-system', resourceVersion },
    spec: { podSelector: SELECTOR, policyTypes: ['Egress'], egress: [] },
  };
}
function fixture() {
  let current = policy();
  const calls: { path: string; method: string; token: string; ca: string; body?: string }[] = [];
  const readProjection = vi.fn(async (path: string) =>
    Buffer.from(path === 'token' ? 'projected-token' : 'projected-ca')
  );
  const request = vi.fn(
    async (
      url: URL,
      method: 'GET' | 'PUT',
      token: string,
      body: string | undefined,
      ca: Buffer
    ) => {
      calls.push({
        path: url.pathname,
        method,
        token,
        ca: ca.toString(),
        ...(body === undefined ? {} : { body }),
      });
      if (method === 'PUT') {
        current = JSON.parse(body!) as ReturnType<typeof policy>;
        current.metadata.resourceVersion = String(Number(current.metadata.resourceVersion) + 1);
      }
      return { status: 200, body: JSON.stringify(current) };
    }
  );
  const options = {
    apiServer: 'https://kubernetes.test',
    tokenFile: 'token',
    caFile: 'ca',
    readProjection,
    request,
  };
  return {
    calls,
    request,
    options,
    get current() {
      return current;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('workbench import phase egress resource', () => {
  it('gets and replaces only the precreated fixed-name policy with optimistic concurrency', async () => {
    const f = fixture();
    const gate = createWorkbenchImportEgress(f.options);
    await gate.enable();
    expect(f.calls.map((call) => [call.path, call.method])).toEqual([
      [PATH, 'GET'],
      [PATH, 'PUT'],
    ]);
    const enabled = JSON.parse(f.calls[1]!.body!);
    expect(enabled).toEqual({
      ...policy(),
      spec: {
        podSelector: SELECTOR,
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ ipBlock: { cidr: '0.0.0.0/0', except: EXCEPT } }],
            ports: [{ protocol: 'TCP', port: 443 }],
          },
        ],
      },
    });
    await gate.disable();
    expect(JSON.parse(f.calls[3]!.body!)).toEqual(policy('18'));
    expect(f.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    expect(f.calls.every((call) => call.path === PATH)).toBe(true);
    expect(JSON.stringify(enabled)).not.toMatch(/ghcr|githubusercontent|dnsName|fqdn/i);
  });

  it('precreates an empty loader-only policy and documents additive, not DNS or crash-time denial', () => {
    const source = readFileSync('deploy/platform/a0/workbench-import-egress.yaml', 'utf8');
    expect(source).toContain('name: workbench-import-origin-egress');
    expect(source).toContain('namespace: lifemodel-system');
    expect(source).toContain('app.kubernetes.io/name: loader');
    expect(source).toMatch(/policyTypes:\s*- Egress/);
    expect(source).toContain('egress: []');
    expect(source).not.toMatch(/namespaceSelector|Ingress|fqdn:/);
    expect(source).toMatch(/additive/);
    expect(source).toMatch(/loader-access/);
    expect(source).toMatch(/restart/);
  });

  it('rereads token and CA for each GET and PUT rather than caching credentials', async () => {
    const f = fixture();
    let generation = 0;
    f.options.readProjection.mockImplementation(async (path) =>
      Buffer.from(path === 'token' ? `token-${++generation}` : 'new-ca')
    );
    const gate = createWorkbenchImportEgress(f.options);
    await gate.enable();
    await gate.disable();
    expect(f.calls.map((call) => call.token)).toEqual(['token-1', 'token-2', 'token-3', 'token-4']);
    expect(f.calls.every((call) => call.ca === 'new-ca')).toBe(true);
  });

  it.each(['enable', 'disable'] as const)(
    'refuses absent or malformed precreated policy on %s without creating anything',
    async (method) => {
      for (const response of [
        { status: 404, body: 'private body token-secret' },
        { status: 200, body: '{}' },
        { status: 200, body: '{' },
        {
          status: 200,
          body: JSON.stringify({
            ...policy(),
            metadata: { ...policy().metadata, resourceVersion: '' },
          }),
        },
        {
          status: 200,
          body: JSON.stringify({
            ...policy(),
            metadata: { ...policy().metadata, name: 'different-policy' },
          }),
        },
      ]) {
        const f = fixture();
        f.request.mockResolvedValue(response);
        const error = await createWorkbenchImportEgress(f.options)
          [method]()
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/egress_(missing|invalid_policy)/);
        expect(String(error)).not.toMatch(/private|token-secret|different-policy/);
        expect(f.calls).toEqual([]);
        expect(f.request).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each([401, 403, 409, 500, 302])(
    'fails safely for Kubernetes status %s without retry or body leakage',
    async (status) => {
      const f = fixture();
      f.request.mockResolvedValueOnce({ status: 200, body: JSON.stringify(policy()) });
      f.request.mockResolvedValueOnce({
        status,
        body: 'https://secret-url/ private-token private-response',
      });
      const error = await createWorkbenchImportEgress(f.options)
        .enable()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/egress_(denied|conflict|unavailable)/);
      expect(JSON.stringify(error)).not.toMatch(/secret-url|private-token|private-response/);
      expect(String(error)).not.toMatch(/https:|private/);
      expect(f.request).toHaveBeenCalledTimes(2);
    }
  );

  it('sanitizes projection and transport failures and refuses malformed credentials', async () => {
    for (const kind of ['projection', 'transport', 'empty', 'whitespace'] as const) {
      const f = fixture();
      if (kind === 'projection')
        f.options.readProjection.mockRejectedValue(new Error('secret file path'));
      if (kind === 'transport')
        f.request.mockRejectedValue(new Error('https://private-url secret token'));
      if (kind === 'empty') f.options.readProjection.mockResolvedValue(Buffer.from(''));
      if (kind === 'whitespace')
        f.options.readProjection.mockResolvedValue(Buffer.from('bad token'));
      const error = await createWorkbenchImportEgress(f.options)
        .disable()
        .catch((e: unknown) => e);
      expect(String(error)).toBe('Error: egress_unavailable');
      expect(JSON.stringify(error)).not.toMatch(/private|secret/);
      if (kind !== 'transport') expect(f.request).not.toHaveBeenCalled();
    }
  });

  it.each(['enable', 'disable'] as const)(
    'bounds both projected reads and transport by one total %s deadline',
    async (method) => {
      vi.useFakeTimers();
      const f = fixture();
      const signals: AbortSignal[] = [];
      f.options.readProjection.mockImplementation(async (_path, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        return Buffer.from('projected');
      });
      f.request.mockImplementation(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        return { status: 200, body: JSON.stringify(policy()) };
      });
      const result = createWorkbenchImportEgress(f.options)
        [method]()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9999);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(String(await result)).toBe('Error: egress_timeout');
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.request).toHaveBeenCalledTimes(2);
    }
  );

  it('times out a never-settling projection and never starts a late request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const held = Promise.withResolvers<Buffer>();
    f.options.readProjection.mockImplementation(() => held.promise);
    const result = createWorkbenchImportEgress(f.options)
      .enable()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(String(await result)).toBe('Error: egress_timeout');
    held.resolve(Buffer.from('late-token'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a never-settling transport, aborts it and never starts a PUT', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let transportSignal: AbortSignal | undefined;
    // Assign outside the mock's narrower inferred signature to inspect the
    // transport's cancellation contract as well as the caller's deadline.
    const request = async (
      _url: URL,
      _method: 'GET' | 'PUT',
      _token: string,
      _body: string | undefined,
      _ca: Buffer,
      signal: AbortSignal
    ) => {
      transportSignal = signal;
      return new Promise<{ status: number; body: string }>(() => undefined);
    };
    const result = createWorkbenchImportEgress({ ...f.options, request })
      .enable()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(String(await result)).toBe('Error: egress_timeout');
    expect(transportSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['GET', 'PUT'] as const)(
    'caps %s responses at 1 MiB in bytes, including injected transports',
    async (method) => {
      const f = fixture();
      if (method === 'PUT')
        f.request.mockResolvedValueOnce({ status: 200, body: JSON.stringify(policy()) });
      f.request.mockResolvedValueOnce({ status: 200, body: 'é'.repeat(512 * 1024 + 1) });
      await expect(createWorkbenchImportEgress(f.options).enable()).rejects.toThrow(
        'egress_response_too_large'
      );
      expect(f.request).toHaveBeenCalledTimes(method === 'GET' ? 1 : 2);
    }
  );

  it.each([
    'http://kubernetes.test',
    'https://user:secret@kubernetes.test',
    'https://kubernetes.test/?secret',
    'not a URL',
  ])('rejects unsafe API configuration without printing it', (apiServer) => {
    expect(() => createWorkbenchImportEgress({ apiServer })).toThrow('egress_config');
  });
});
