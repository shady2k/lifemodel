import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

describe('loader to Gitea network and Secret grants', () => {
  it('allows only loader egress to Gitea HTTP using the rendered pod labels', async () => {
    const policy = YAML.parse(await readFile('deploy/platform/a0/network-policy.yaml', 'utf8'));
    const rules = policy.spec.egress;
    const rule = rules.find((entry: any) => entry.ports?.some((port: any) => port.protocol === 'TCP' && port.port === 3000));
    expect(rule).toEqual({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-git' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'gitea', 'app.kubernetes.io/instance': 'gitea' } } }], ports: [{ protocol: 'TCP', port: 3000 }] });
    const gitea = YAML.parse(await readFile('deploy/platform/a/gitea/network-policy.yaml', 'utf8'));
    expect(gitea.spec.ingress).toContainEqual({ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } } }], ports: [{ protocol: 'TCP', port: 3000 }] });
  });
  it('adds the loader Secret role and binding to the Gitea chart resources', async () => {
    const rbac = YAML.parseAllDocuments(await readFile('deploy/platform/a/gitea/loader-rbac.yaml', 'utf8')).map((doc) => doc.toJSON());
    expect(rbac.map((item: any) => item.kind)).toEqual(['Role', 'RoleBinding']);
    expect(rbac[0].rules).toEqual([{ apiGroups: [''], resources: ['secrets'], verbs: ['create'] }, { apiGroups: [''], resources: ['secrets'], resourceNames: ['gitea-admin'], verbs: ['get', 'update'] }]);
    expect((await readFile('deploy/platform/a/gitea/kustomization.yaml', 'utf8'))).toContain('  - loader-rbac.yaml');
  });
});
