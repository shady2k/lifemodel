import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));

type Resource = Record<string, any>;
function documents(path: string): Resource[] {
  const source = readFileSync(path, 'utf8').replaceAll('${LIFEMODEL_NAME}', 'lifemodel');
  const parsed = YAML.parseAllDocuments(source);
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

const objects = () => [
  ...render(join(platformRoot, 'instance')),
  ...render(join(platformRoot, 'a0')),
  ...render(join(platformRoot, 'a')),
];
const services = () => objects().filter((item) => item.kind === 'Service');
function assertIngressBackendsResolve(ingresses: Resource[]) {
  const allServices = [
    ...services(),
    ...documents(join(platformRoot, 'applications/lifemodel/web.yaml')).filter(
      (item) => item.kind === 'Service'
    ),
  ];
  for (const ingress of ingresses) {
    for (const rule of ingress.spec?.rules ?? [])
      for (const route of rule.http?.paths ?? []) {
        const service = allServices.find(
          (item) =>
            item.metadata?.namespace === ingress.metadata?.namespace &&
            item.metadata?.name === route.backend?.service?.name
        );
        expect(
          service,
          `${ingress.metadata?.namespace}/${ingress.metadata?.name} backend ${route.backend?.service?.name} must exist in namespace`
        ).toBeDefined();
        const requested = route.backend?.service?.port;
        expect(
          service?.spec?.ports?.some(
            (port: any) => port.name === requested?.name || port.port === requested?.number
          ),
          `${ingress.metadata?.name} backend port must exist`
        ).toBe(true);
      }
  }
}

describe('platform web ingress and egress', () => {
  it('guards every private route and leaves boot login and setup unguarded', () => {
    const all = objects();
    const ingresses = all.filter((item) => item.kind === 'Ingress');
    assertIngressBackendsResolve(ingresses);
    const privateRoutes = ingresses.flatMap((ingress) =>
      (ingress.spec?.rules ?? []).flatMap((rule: any) =>
        (rule.http?.paths ?? []).map((path: any) => ({ ingress, host: rule.host, path }))
      )
    );
    const handoff = privateRoutes.filter(
      ({ host, path }) =>
        host === 'lifemodel.local' && path.path === '/_auth/handoff' && path.pathType === 'Exact'
    );
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.ingress.metadata.namespace).toBe('lifemodel-system');
    expect(
      handoff[0]?.ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']
    ).toBeUndefined();
    expect(
      Number(
        handoff[0]?.ingress.metadata.annotations?.['traefik.ingress.kubernetes.io/router.priority']
      )
    ).toBeGreaterThan(0);
    const bootPublic = privateRoutes.filter(
      ({ host, path }) =>
        host === 'boot-lifemodel.local' && path.path === '/' && path.pathType === 'Prefix'
    );
    expect(bootPublic).toHaveLength(1);
    for (const { ingress, host, path } of privateRoutes) {
      if (
        host === 'boot-lifemodel.local' ||
        (host === 'lifemodel.local' && path.path === '/_auth/handoff')
      ) {
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
      ({ host }) => host === 'boot-lifemodel.local' || host === 'lifemodel.local'
    );
    expect(
      privatePaths.some(
        ({ host, path }) =>
          host === 'boot-lifemodel.local' && path.path === '/' && path.pathType === 'Prefix'
      )
    ).toBe(true);
    expect(
      privatePaths.some(
        ({ host, path, ingress }) =>
          host === 'lifemodel.local' &&
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
    expect(middlewares.map((item) => item.metadata?.namespace)).toEqual(['lifemodel']);
    for (const middleware of middlewares) {
      expect(middleware.spec?.forwardAuth?.address).toBe(
        'http://loader.lifemodel-system.svc.cluster.local:7000/_auth/verify'
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
