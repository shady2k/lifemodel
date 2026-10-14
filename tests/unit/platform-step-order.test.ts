import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const builtInNamespaces = new Set(['kube-system', 'default', 'kube-public', 'flux-system']);
const clusterScopedKinds = new Set([
  'Namespace', 'Node', 'PersistentVolume', 'StorageClass', 'CustomResourceDefinition',
  'ClusterRole', 'ClusterRoleBinding', 'PriorityClass', 'RuntimeClass', 'APIService',
  'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'VolumeAttachment',
]);

type Resource = { file: string; object: Record<string, any> };

function documents(file: string): Record<string, any>[] {
  const parsed = YAML.parseAllDocuments(readFileSync(file, 'utf8'));
  expect(parsed.flatMap((doc) => doc.errors), `invalid YAML in ${file}`).toEqual([]);
  return parsed.map((doc) => doc.toJSON() as Record<string, any>).filter(Boolean);
}

function renderResources(directory: string, active = new Set<string>()): Resource[] {
  const kustomizationPath = join(directory, 'kustomization.yaml');
  const absoluteDirectory = resolve(directory);
  if (active.has(absoluteDirectory)) throw new Error(`recursive kustomization at ${directory}`);
  active.add(absoluteDirectory);
  const kustomization = YAML.parse(readFileSync(kustomizationPath, 'utf8')) as { resources?: string[] };
  const resources = (kustomization.resources ?? []).flatMap((resource) => {
    const path = join(directory, resource);
    try {
      const names = readdirSync(path, { withFileTypes: true });
      if (names.some((entry) => entry.isFile() && entry.name === 'kustomization.yaml')) {
        return renderResources(path, active);
      }
      if (names.length > 0) return names.filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
        .flatMap((entry) => documents(join(path, entry.name)).map((object) => ({ file: join(path, entry.name), object })));
    } catch { /* Resource is a file. */ }
    return documents(path).map((object) => ({ file: path, object }));
  });
  active.delete(absoluteDirectory);
  return resources;
}

function platformSteps(): { name: string; directory: string; dependencies: string[] }[] {
  return readdirSync(platformRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-reconciler.yaml'))
    .map((entry) => {
      const reconcilerPath = join(platformRoot, entry.name);
      const reconciler = documents(reconcilerPath)[0];
      const relativePath = reconciler.spec.path.replace(/^\.\//, '');
      return {
        name: reconciler.metadata.name,
        directory: join(platformRoot, relativePath),
        dependencies: (reconciler.spec.dependsOn ?? []).map((dependency: any) => dependency.name),
      };
    });
}

function ancestors(step: string, steps: Map<string, ReturnType<typeof platformSteps>[number]>, seen = new Set<string>()): Set<string> {
  if (seen.has(step)) return seen;
  seen.add(step);
  for (const dependency of steps.get(step)?.dependencies ?? []) ancestors(dependency, steps, seen);
  return seen;
}

describe('platform step namespace ordering', () => {
  it('creates every target namespace in the same or a prerequisite step', () => {
    const steps = platformSteps();
    const byName = new Map(steps.map((step) => [step.name, step]));
    const namespacesByStep = new Map(steps.map((step) => [
      step.name,
      new Set(renderResources(step.directory).filter(({ object }) => object.kind === 'Namespace')
        .map(({ object }) => object.metadata?.name)),
    ]));
    const violations: string[] = [];

    for (const step of steps) {
      const availableNamespaces = [...ancestors(step.name, byName)]
        .flatMap((ancestor) => [...(namespacesByStep.get(ancestor) ?? [])]);
      for (const { file, object } of renderResources(step.directory)) {
        const namespace = object.metadata?.namespace;
        if (!namespace || builtInNamespaces.has(namespace) || clusterScopedKinds.has(object.kind)) continue;
        if (!availableNamespaces.includes(namespace)) {
          violations.push(`${file}: ${object.kind}/${object.metadata?.name} in namespace ${namespace} (step ${step.name})`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
