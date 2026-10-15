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
        ).toBe('lifemodel-system-loader-auth@kubernetescrd');
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
            'lifemodel-system-loader-auth@kubernetescrd'
      )
    ).toBe(true);
    const middleware = all.find(
      (item) => item.kind === 'Middleware' && item.metadata?.name === 'loader-auth'
    );
    expect(middleware?.metadata?.namespace).toBe('lifemodel-system');
    expect(middleware?.spec?.forwardAuth?.address).toBe(
      'http://loader.lifemodel-system.svc.cluster.local:7000/_auth/verify'
    );
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
      { namespace: 'lifemodel-state', pod: undefined, ports: ['TCP/5432'] },
      { namespace: 'lifemodel-state', pod: undefined, ports: ['TCP/6379'] },
    ]);
  });
});
