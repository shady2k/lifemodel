import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../deploy/platform/instance/', import.meta.url));
const instanceYamlFiles = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
  .map((entry) => {
    const relative = entry.parentPath ? `${entry.parentPath}/${entry.name}` : entry.name;
    return new URL(relative, `file://${root}/`);
  });
const docs = instanceYamlFiles.flatMap((file) =>
  YAML.parseAllDocuments(readFileSync(file, 'utf8'))
    .map((doc) => doc.toJSON())
    .filter(Boolean)
);

describe('public instance HTTPS routes', () => {
  it('routes each public Ingress only through websecure with the instance TLS Secret', () => {
    const ingresses = docs.filter((doc) => doc.kind === 'Ingress');
    expect(ingresses).toHaveLength(3);
    for (const ingress of ingresses) {
      expect(ingress.spec.ingressClassName).toBe('traefik');
      expect(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.entrypoints']).toBe(
        'websecure'
      );
      expect(ingress.spec.tls).toHaveLength(1);
      expect(ingress.spec.tls[0].secretName).toBeUndefined();
      expect(ingress.spec.tls[0].hosts).toEqual(ingress.spec.rules.map((rule: any) => rule.host));
    }
  });

  it('resolves every public Ingress backend to a real Service in that Ingress namespace', () => {
    const manifests = [
      ...docs,
      ...YAML.parseAllDocuments(
        readFileSync(new URL('../a0/service.yaml', `file://${root}`), 'utf8')
      )
        .map((doc) => doc.toJSON())
        .filter(Boolean),
      ...YAML.parseAllDocuments(
        readFileSync(new URL('../applications/lifemodel/web.yaml', `file://${root}`), 'utf8')
      )
        .map((doc) => doc.toJSON())
        .filter(Boolean),
    ] as any[];
    const services = manifests.filter((doc) => doc.kind === 'Service');
    for (const ingress of manifests.filter((doc) => doc.kind === 'Ingress')) {
      for (const rule of ingress.spec.rules)
        for (const path of rule.http.paths) {
          expect(services).toContainEqual(
            expect.objectContaining({
              metadata: expect.objectContaining({
                name: path.backend.service.name,
                namespace: ingress.metadata.namespace,
              }),
            })
          );
        }
    }
  });

  it('configures Traefik web as a permanent HTTPS-only redirect to websecure', () => {
    const config = YAML.parseAllDocuments(
      readFileSync(new URL('traefik.yaml', `file://${root}`), 'utf8')
    )[0]!.toJSON();
    expect(config).toMatchObject({
      apiVersion: 'helm.cattle.io/v1',
      kind: 'HelmChartConfig',
      metadata: { name: 'traefik', namespace: 'kube-system' },
    });
    const values = YAML.parse(config.spec.valuesContent);
    expect(values.ports.web.http.redirections.entryPoint).toEqual({
      to: 'websecure',
      scheme: 'https',
      permanent: true,
    });
    const store = YAML.parseAllDocuments(
      readFileSync(new URL('traefik.yaml', `file://${root}`), 'utf8')
    )
      .map((doc) => doc.toJSON())
      .find((doc: any) => doc?.kind === 'TLSStore');
    expect(store).toMatchObject({
      metadata: { name: 'default', namespace: 'lifemodel-system' },
      spec: { defaultCertificate: { secretName: 'lifemodel-tls' } },
    });
    expect(
      YAML.parseAllDocuments(readFileSync(new URL('traefik.yaml', `file://${root}`), 'utf8'))
        .map((doc) => doc.toJSON())
        .filter((doc: any) => doc?.kind === 'TLSStore' && doc.metadata.name === 'default')
    ).toHaveLength(1);
  });
});
