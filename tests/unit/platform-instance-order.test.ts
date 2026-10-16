import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const read = (path: string) => YAML.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const resource = (name: string) => read(join(root, name));

describe('platform dependency structure', () => {
  it('orders platform-instance before A0, A, B and C without a dependency cycle', () => {
    const docs = [
      'instance-reconciler.yaml',
      'a0-reconciler.yaml',
      'a-reconciler.yaml',
      'b-reconciler.yaml',
      'c-reconciler.yaml',
    ].map((name) => read(join(root, name)));
    const byName = new Map(docs.map((doc) => [doc.metadata.name, doc]));
    expect(byName.get('platform-instance')?.spec.dependsOn ?? []).toEqual([]);
    expect(byName.get('platform-a0')?.spec.dependsOn).toEqual([{ name: 'platform-instance' }]);
    expect(byName.get('platform-a')?.spec.dependsOn).toEqual([{ name: 'platform-a0' }]);
    expect(byName.get('platform-b')?.spec.dependsOn).toEqual([{ name: 'platform-a' }]);
    expect(byName.get('platform-c')?.spec.dependsOn).toEqual([{ name: 'platform-b' }]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visiting.has(name)) throw new Error(`dependency cycle at ${name}`);
      if (visited.has(name)) return;
      visiting.add(name);
      for (const dep of byName.get(name)?.spec.dependsOn ?? []) {
        expect(byName.has(dep.name)).toBe(true);
        visit(dep.name);
      }
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of byName.keys()) visit(name);
    expect([...visited]).toHaveLength(5);
  });

  it('gives every namespaced object an upstream namespace or one in the same Kustomization', () => {
    const dirs = ['instance', 'a0', 'a', 'b', 'state'];
    const owned = new Map<string, string[]>();
    const objectsByDir = new Map<string, Record<string, any>[]>();
    const collect = (directory: string): Record<string, any>[] => {
      const absolute = join(root, directory);
      const ks = read(join(absolute, 'kustomization.yaml'));
      return (ks.resources ?? []).flatMap((name: string) => {
        const path = join(absolute, name);
        try {
          if (readdirSync(path).includes('kustomization.yaml'))
            return collect(join(directory, name));
        } catch {
          /* file resource */
        }
        return YAML.parseAllDocuments(readFileSync(path, 'utf8'))
          .map((doc) => doc.toJSON())
          .filter(Boolean) as Record<string, any>[];
      });
    };
    for (const dir of dirs) {
      const objects = collect(dir);
      objectsByDir.set(dir, objects);
      owned.set(
        dir,
        objects.filter((obj) => obj.kind === 'Namespace').map((obj) => obj.metadata.name)
      );
    }
    const namespaceOwners = [...owned.entries()].flatMap(([directory, names]) =>
      names.map((name) => ({ directory, name }))
    );
    for (const name of ['lifemodel-system', 'lifemodel']) {
      expect(namespaceOwners.filter((owner) => owner.name === name)).toEqual([
        { directory: 'instance', name },
      ]);
    }
    const owners = new Set(namespaceOwners.map((owner) => owner.name));
    for (const [dir, objects] of objectsByDir)
      for (const obj of objects) {
        const namespace = obj.metadata?.namespace;
        if (!namespace || obj.kind === 'Namespace') continue;
        expect(
          owners.has(namespace) || owned.get(dir)?.includes(namespace),
          `${dir}/${obj.kind}/${obj.metadata?.name} namespace ${namespace} must be owned upstream or in this Kustomization`
        ).toBe(true);
      }
  });
});
