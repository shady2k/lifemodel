/**
 * The one kustomize feature the log steps rely on to roll their pods
 * (ADR-016 §1, §5): `configMapGenerator` declares a ConfigMap whose name
 * carries a hash of its content, and kustomize rewrites the workload's
 * reference to the generated name, so a changed configuration changes the pod
 * template.
 *
 * The isolated test boundary ships no kustomize binary, so this is a small
 * model of what the cluster's kustomize-controller does for a step: the step's
 * plain `resources` are read as documents, each generator's ConfigMap is built
 * from its `files`/`envs`/`literals`, a content-derived suffix (ten hex digits,
 * kustomize's suffix shape) names it unless the hash is disabled, and the
 * ConfigMap references in the step's workloads are rewritten to it.
 *
 * Kustomize performs the real render on the cluster. These tests are about the
 * wiring the render needs - the generator, its input, and the reference - and
 * about a change of content changing the name, not about kustomize's own hash
 * value: the suffix here is sha256 over the generator's sorted data, so every
 * input byte is covered.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import YAML from 'yaml';

type Resource = Record<string, any>;

export interface GeneratedConfigMap {
  /** The name the generator declares; this is what a workload references. */
  readonly baseName: string;
  /** The rendered name, with the content suffix unless the hash is disabled. */
  readonly name: string;
  readonly object: Resource;
}

export interface RenderedStep {
  readonly directory: string;
  readonly kustomization: Resource;
  readonly generated: GeneratedConfigMap[];
  /** The step's resources plus its generated ConfigMaps, references rewritten. */
  readonly objects: Resource[];
}

function documentsOf(path: string): Resource[] {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8'))
    .map((document) => document.toJSON() as Resource | null)
    .filter((document): document is Resource => typeof document === 'object' && document !== null);
}

function splitAtFirstEquals(entry: string, what: string): [string, string] {
  const at = entry.indexOf('=');
  if (at <= 0) throw new Error(`${what} entry ${JSON.stringify(entry)} is not KEY=VALUE`);
  return [entry.slice(0, at), entry.slice(at + 1)];
}

function generatorData(generator: Resource, directory: string): Record<string, string> {
  const data: Record<string, string> = {};
  const put = (key: string, value: string, source: string): void => {
    if (Object.hasOwn(data, key)) throw new Error(`${source} declares ${key} twice`);
    data[key] = value;
  };
  for (const literal of generator.literals ?? []) {
    const [key, value] = splitAtFirstEquals(String(literal), 'literal');
    put(key, value, `generator ${String(generator.name)}`);
  }
  for (const entry of generator.envs ?? []) {
    const path = resolve(directory, String(entry));
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const [key, value] = splitAtFirstEquals(trimmed, `env file ${path}`);
      put(key, value, `env file ${path}`);
    }
  }
  for (const entry of generator.files ?? []) {
    const text = String(entry);
    const at = text.indexOf('=');
    // kustomize: `key=path`, or a bare path whose key is its file name.
    const key = at < 0 ? basename(text) : text.slice(0, at);
    const path = resolve(directory, at < 0 ? text : text.slice(at + 1));
    put(key, readFileSync(path, 'utf8'), `generator ${String(generator.name)}`);
  }
  return data;
}

/** Ten hex digits, with every input byte covered (see the file comment). */
function contentSuffix(data: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(data)
      .sort()
      .map((key) => [key, data[key]])
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 10);
}

const REFERENCE_FIELDS = new Set(['configMap', 'configMapRef', 'configMapKeyRef']);

function rewriteReferences(value: unknown, names: ReadonlyMap<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteReferences(item, names);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Resource;
  for (const [key, child] of Object.entries(record)) {
    if (
      REFERENCE_FIELDS.has(key) &&
      typeof child === 'object' &&
      child !== null &&
      typeof (child as Resource).name === 'string'
    ) {
      const rendered = names.get((child as Resource).name);
      if (rendered !== undefined) (child as Resource).name = rendered;
    }
    rewriteReferences(child, names);
  }
}

export function renderStep(directory: string): RenderedStep {
  const kustomization = YAML.parse(
    readFileSync(join(directory, 'kustomization.yaml'), 'utf8')
  ) as Resource;
  const resources: Resource[] = [];
  for (const entry of kustomization.resources ?? []) {
    const text = String(entry);
    if (!text.endsWith('.yaml') && !text.endsWith('.yml'))
      throw new Error(
        `${directory} lists ${text}, which this renderer does not read: it reads plain YAML resources only`
      );
    resources.push(...documentsOf(resolve(directory, text)));
  }
  const generated: GeneratedConfigMap[] = [];
  for (const generator of kustomization.configMapGenerator ?? []) {
    const data = generatorData(generator, directory);
    const disabled: boolean =
      generator.options?.disableNameSuffixHash ??
      kustomization.generatorOptions?.disableNameSuffixHash ??
      false;
    const name = disabled ? String(generator.name) : `${String(generator.name)}-${contentSuffix(data)}`;
    generated.push({
      baseName: String(generator.name),
      name,
      object: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace: generator.namespace },
        data,
      },
    });
  }
  const names = new Map(generated.map((item) => [item.baseName, item.name]));
  for (const object of resources) rewriteReferences(object, names);
  return {
    directory,
    kustomization,
    generated,
    objects: [...resources, ...generated.map((item) => item.object)],
  };
}
