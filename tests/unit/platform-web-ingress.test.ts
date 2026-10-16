import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));

type Resource = Record<string, any>;
function documents(path: string): Resource[] {
  const parsed = YAML.parseAllDocuments(readFileSync(path, 'utf8'));
  expect(
    parsed.flatMap((doc) => doc.errors),
    `invalid YAML in ${path}`
  ).toEqual([]);
  return parsed.map((doc) => doc.toJSON() as Resource).filter(Boolean);
}
function render(directory: string, active = new Set<string>()): Resource[] {
  const absolute = resolve(directory);
  if (active.has(absolute)) throw new Error(`recursive kustomization at ${directory}`);
  active.add(absolute);
  const k = YAML.parse(readFileSync(join(directory, 'kustomization.yaml'), 'utf8')) as {
    resources?: string[];
  };
  const objects = (k.resources ?? []).flatMap((resource) => {
    const path = join(directory, resource);
    try {
      if (
        readdirSync(path, { withFileTypes: true }).some(
          (entry) => entry.isFile() && entry.name === 'kustomization.yaml'
        )
      )
        return render(path, active);
    } catch {
      /* file resource */
    }
    return documents(path);
  });
  active.delete(absolute);
  return objects;
}

const objects = () => [...render(join(platformRoot, 'a0')), ...render(join(platformRoot, 'a'))];

describe('platform web ingress and egress', () => {
  it('guards every private route and leaves boot login and setup unguarded', () => {
    const all = objects();
    const ingresses = all.filter((item) => item.kind === 'Ingress');
    const privateRoutes = ingresses.flatMap((ingress) =>
      (ingress.spec?.rules ?? []).flatMap((rule: any) =>
        (rule.http?.paths ?? []).map((path: any) => ({ ingress, host: rule.host, path }))
      )
    );
    const bootPublic = privateRoutes.filter(
      ({ host, path }) =>
        host === 'boot.localhost' &&
        path.pathType === 'Exact' &&
        ['/login', '/setup'].includes(path.path)
    );
    expect(bootPublic.map(({ path }) => path.path).sort()).toEqual(['/login', '/setup']);
    for (const { ingress, host, path } of privateRoutes) {
      if (host === 'boot.localhost' && ['/login', '/setup'].includes(path.path)) {
        expect(
          ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']
        ).toBeUndefined();
      } else {
        expect(
          ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.middlewares'],
          `${host}${path.path} must use ForwardAuth`
        ).toBe(`${ingress.metadata.namespace}-loader-auth@kubernetescrd`);
      }
    }
    const privatePaths = privateRoutes.filter(
      ({ host }) => host === 'boot.localhost' || host === 'localhost'
    );
    expect(
      privatePaths.some(
        ({ host, path }) =>
          host === 'boot.localhost' && path.path === '/' && path.pathType === 'Prefix'
      )
    ).toBe(true);
    expect(
      privatePaths.some(
        ({ host, path, ingress }) =>
          host === 'localhost' &&
          path.path === '/' &&
          path.pathType === 'Prefix' &&
          path.backend.service.name === 'web' &&
          path.backend.service.port.number === 8080 &&
          ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.middlewares'] ===
            'lifemodel-loader-auth@kubernetescrd'
      )
    ).toBe(true);
    const middlewares = all.filter(
      (item) => item.kind === 'Middleware' && item.metadata?.name === 'loader-auth'
    );
    expect(middlewares.map((item) => item.metadata?.namespace).sort()).toEqual([
      'lifemodel',
      'lifemodel-system',
    ]);
    for (const middleware of middlewares) {
      expect(middleware.spec?.forwardAuth?.address).toBe(
        'http://loader.lifemodel-system.svc.cluster.local:7000/_auth/verify'
      );
    }
  });

  it('routes HTTP requests through a fail-closed ForwardAuth stub', async () => {
    const { createServer } = await import('node:http');
    const ingresses = objects().filter((item) => item.kind === 'Ingress');
    const candidatesFor = (host: string, requestPath: string) =>
      ingresses
        .flatMap((ingress) => {
          const priority = Number(
            ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.priority'] ?? 0
          );
          return (ingress.spec?.rules ?? [])
            .filter((rule: any) => rule.host === host)
            .flatMap((rule: any) =>
              (rule.http?.paths ?? [])
                .filter((path: any) =>
                  path.pathType === 'Exact'
                    ? requestPath === path.path
                    : requestPath.startsWith(path.path)
                )
                .map((path: any) => ({ ingress, path, priority }))
            );
        })
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            Number(b.path.pathType === 'Exact') - Number(a.path.pathType === 'Exact')
        );

    const router = createServer((request, response) => {
      const host = request.headers['x-route-host'] ?? '';
      const selected = candidatesFor(host, request.url ?? '/')[0];
      if (!selected) {
        response.writeHead(404).end(`${host} ${request.url}`);
        return;
      }
      const middleware =
        selected.ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.middlewares'];
      if (middleware) {
        const session = request.headers['x-session-state'];
        // This is a ForwardAuth stub: invalid credentials redirect, and an
        // unavailable verifier rejects rather than allowing the request.
        if (session === 'failure') {
          response.writeHead(503).end('auth unavailable');
          return;
        }
        if (session !== 'valid') {
          response.writeHead(302, { location: 'http://boot.localhost/login' }).end();
          return;
        }
      }
      response
        .writeHead(200, {
          'x-backend': selected.path.backend.service.name,
          'x-path-type': selected.path.pathType,
        })
        .end('routed');
    });
    await new Promise<void>((resolve) => router.listen(0, '127.0.0.1', resolve));
    const address = router.address();
    if (!address || typeof address === 'string') throw new Error('router did not bind TCP');
    const send = async (host: string, path: string, auth: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        headers: { 'x-route-host': host, 'x-session-state': auth },
        redirect: 'manual',
      });
      return {
        body: await response.text(),
        status: response.status,
        location: response.headers.get('location'),
        backend: response.headers.get('x-backend'),
        pathType: response.headers.get('x-path-type'),
      };
    };
    try {
      for (const path of ['/', '/assets/app.js', '/api/messages', '/api/events']) {
        for (const auth of ['anonymous', 'expired', 'tampered']) {
          const response = await send('localhost', path, auth);
          expect(response.status, `${auth} ${path}: ${response.body}`).toBe(302);
          expect(response.location).toBe('http://boot.localhost/login');
        }
        expect(await send('localhost', path, 'failure')).toMatchObject({ status: 503 });
        expect(await send('localhost', path, 'valid')).toMatchObject({
          status: 200,
          backend: 'web',
        });
      }
      for (const path of ['/login', '/setup']) {
        expect(await send('boot.localhost', path, 'anonymous')).toMatchObject({
          status: 200,
          backend: 'loader',
          pathType: 'Exact',
        });
        expect(await send('boot.localhost', path, 'failure')).toMatchObject({
          status: 200,
          backend: 'loader',
        });
      }
      expect(await send('boot.localhost', '/login/extra', 'anonymous')).toMatchObject({
        status: 302,
      });
      expect(await send('boot.localhost', '/setup/extra', 'anonymous')).toMatchObject({
        status: 302,
      });
      expect(await send('boot.localhost', '/login', 'valid')).toMatchObject({
        status: 200,
        pathType: 'Exact',
      });
      expect(await send('boot.localhost', '/setup', 'valid')).toMatchObject({
        status: 200,
        pathType: 'Exact',
      });
      // Exact public route wins the priority overlap with the private prefix.
      expect(await send('boot.localhost', '/login', 'anonymous')).toMatchObject({
        backend: 'loader',
        pathType: 'Exact',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        router.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('limits web pod egress to Valkey, Postgres and DNS', () => {
    const policies = objects().filter(
      (item) => item.kind === 'NetworkPolicy' && item.metadata?.namespace === 'lifemodel'
    );
    for (const policy of policies.filter((item) => (item.spec?.egress ?? []).length > 0)) {
      const selector = policy.spec.podSelector?.matchLabels ?? {};
      expect(selector, `${policy.metadata.name} must not broaden web egress`).toMatchObject({
        'app.kubernetes.io/name': expect.stringMatching(/^(core|web)$/),
      });
    }
    const applicable = policies.filter(
      (policy) => policy.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'web'
    );
    const allowed = applicable
      .flatMap((policy) => policy.spec?.egress ?? [])
      .map((rule: any) => ({
        namespace: rule.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'],
        pod: rule.to?.[0]?.podSelector?.matchLabels,
        ports: (rule.ports ?? []).map((port: any) => `${port.protocol}/${port.port}`).sort(),
      }));
    expect(allowed).toEqual([
      { namespace: 'kube-system', pod: { 'k8s-app': 'kube-dns' }, ports: ['TCP/53', 'UDP/53'] },
      {
        namespace: 'lifemodel-state',
        pod: { 'cnpg.io/cluster': 'lifemodel' },
        ports: ['TCP/5432'],
      },
      { namespace: 'lifemodel-state', pod: { app: 'valkey' }, ports: ['TCP/6379'] },
    ]);
  });
});
