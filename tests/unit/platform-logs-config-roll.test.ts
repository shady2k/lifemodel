/**
 * A release that changes the collector's configuration, or the store's
 * defaults, replaces the pods that read them (lifemodel-vbog.5.10).
 *
 * The mechanism is zot's (deploy/platform/a/kustomization.yaml): the step's
 * kustomization generates the ConfigMap from the configuration file, the
 * generator's content hash suffixes the ConfigMap name, and the workload's
 * reference is rewritten to the generated name, so the pod template changes and
 * Flux replaces the pod when it applies the release. A fixed name leaves the
 * running pod on its old configuration: Vector runs with
 * `--config /etc/vector/vector.yaml` and no `--watch-config`, and the store
 * reads its defaults through `envFrom` once, at start. Measured on
 * vm-lifemodel on 2026-11-09 (WALK-LOGS-FRESH, lifemodel-vbog.5.9): the
 * collector ran stage 1's configuration for hours and stored no heartbeat.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderStep, type RenderedStep } from '../helpers/kustomize-config-maps.js';

const deployRoot = fileURLToPath(new URL('../../deploy/', import.meta.url));
const collectorStep = join(deployRoot, 'platform/logs');
const storeStep = join(deployRoot, 'platform/logs-store');
const collectorConfig = join(collectorStep, 'config/vector.yaml');
const defaults = join(storeStep, 'config/settings-defaults.env');

const COLLECTOR = 'logs-collector-config';
const DEFAULTS = 'lifemodel-logs-settings-defaults';
const SETTINGS = 'lifemodel-logs-settings';
const HASH = '[0-9a-f]{10}';

function generated(step: RenderedStep, baseName: string) {
  const found = step.generated.find((item) => item.baseName === baseName);
  if (found === undefined) throw new Error(`nothing generates ${baseName}`);
  return found;
}

function find(step: RenderedStep, kind: string, baseName: string): Record<string, any> {
  const found = step.objects.find(
    (object) => object.kind === kind && object.metadata?.name?.startsWith(baseName)
  );
  if (found === undefined) throw new Error(`no rendered ${kind} for ${baseName}`);
  return found;
}

/** The step rendered again with one of its inputs changed, in a scratch copy. */
function renderedWithChange(
  directory: string,
  path: string,
  change: (text: string) => string
): RenderedStep {
  const copy = mkdtempSync(join(tmpdir(), 'lifemodel-logs-config-roll-'));
  try {
    cpSync(directory, copy, { recursive: true });
    const target = join(copy, path);
    const before = readFileSync(target, 'utf8');
    const after = change(before);
    if (after === before) throw new Error(`${path}: the one-byte change did nothing`);
    writeFileSync(target, after);
    return renderStep(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // Vendored Helm charts are Go templates, not standalone Kubernetes YAML.
    if (entry.isDirectory()) return entry.name === 'charts' ? [] : yamlFiles(path);
    return entry.name.endsWith('.yaml') ? [path] : [];
  });
}

/** Every manifest that names this ConfigMap, relative to the deploy tree. */
function namers(name: string): string[] {
  return yamlFiles(deployRoot)
    .filter((path) => readFileSync(path, 'utf8').includes(name))
    .map((path) => relative(deployRoot, path).split('\\').join('/'))
    .sort();
}

describe("the collector's configuration is rolled by its content hash", () => {
  const step = renderStep(collectorStep);

  it('is a generated object from the configuration file, not a fixed name', () => {
    expect(step.kustomization.configMapGenerator).toEqual([
      {
        name: COLLECTOR,
        namespace: 'lifemodel-logs',
        files: ['vector.yaml=config/vector.yaml', 'check-delivery.sh=config/check-delivery.sh'],
      },
    ]);
    // Turning the hash off would keep the name, and the pod, unchanged.
    expect(step.kustomization.generatorOptions?.disableNameSuffixHash).not.toBe(true);
    const generatedMap = generated(step, COLLECTOR);
    expect(generatedMap.name).toMatch(new RegExp(`^${COLLECTOR}-${HASH}$`));
    // The generator's whole input is the configuration text, byte for byte.
    expect(generatedMap.object).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: generatedMap.name, namespace: 'lifemodel-logs' },
      data: {
        'vector.yaml': readFileSync(collectorConfig, 'utf8'),
        'check-delivery.sh': readFileSync(join(collectorStep, 'config/check-delivery.sh'), 'utf8'),
      },
    });
  });

  it('points the DaemonSet at the generated name, so its template changes', () => {
    const daemonSet = find(step, 'DaemonSet', 'logs-collector');
    const name = generated(step, COLLECTOR).name;
    expect(daemonSet.spec.template.spec.volumes).toContainEqual({
      name: 'config',
      configMap: { name },
    });
    const container = daemonSet.spec.template.spec.containers[0];
    expect(container.volumeMounts).toContainEqual({
      name: 'config',
      mountPath: '/etc/vector',
      readOnly: true,
    });
    // Vector reads the file once: no watch, so the roll is what applies a change.
    expect(container.args).toEqual(['--config', '/etc/vector/vector.yaml']);
    // The only ConfigMap in the step is the generated one, so no fixed-name
    // object can be what the volume mounts while the hash moves.
    expect(
      step.objects
        .filter((object) => object.kind === 'ConfigMap')
        .map((object) => object.metadata.name)
    ).toEqual([name]);
  });

  it('changes the name when one byte of the configuration changes', () => {
    const before = generated(renderStep(collectorStep), COLLECTOR).name;
    expect(generated(renderStep(collectorStep), COLLECTOR).name).toBe(before);
    const changed = renderedWithChange(collectorStep, 'config/vector.yaml', (text) =>
      text.replace('interval: 30', 'interval: 31')
    );
    const after = generated(changed, COLLECTOR).name;
    expect(after).toMatch(new RegExp(`^${COLLECTOR}-${HASH}$`));
    expect(after).not.toBe(before);
    expect(find(changed, 'DaemonSet', 'logs-collector').spec.template.spec.volumes).toContainEqual({
      name: 'config',
      configMap: { name: after },
    });
  });
});

describe("the store's defaults are rolled by their content hash", () => {
  const step = renderStep(storeStep);

  it('is a generated object from the defaults file, not a fixed name', () => {
    expect(step.kustomization.configMapGenerator).toEqual([
      {
        name: DEFAULTS,
        namespace: 'lifemodel-system',
        envs: ['config/settings-defaults.env'],
      },
    ]);
    expect(step.kustomization.generatorOptions?.disableNameSuffixHash).not.toBe(true);
    const generatedMap = generated(step, DEFAULTS);
    expect(generatedMap.name).toMatch(new RegExp(`^${DEFAULTS}-${HASH}$`));
    expect(generatedMap.object.data).toEqual({
      VL_retentionPeriod: '14d',
      VL_retention_maxDiskSpaceUsageBytes: '1610612736',
      VL_storage_minFreeDiskSpaceBytes: '805306368',
    });
    expect(step.objects.filter((object) => object.kind === 'ConfigMap')).toHaveLength(1);
  });

  it('points the Deployment at the generated name and leaves the loader map alone', () => {
    const deployment = find(step, 'Deployment', 'logs-store');
    expect(deployment.spec.template.spec.containers[0].envFrom).toEqual([
      { configMapRef: { name: generated(step, DEFAULTS).name } },
      { configMapRef: { name: SETTINGS, optional: true } },
    ]);
    // The owner's setting stays loader-owned: a release never writes it, and a
    // reconcile never reverts it, so its name carries no generator hash.
    expect(step.generated.map((item) => item.baseName)).not.toContain(SETTINGS);
  });

  it('changes the name when one byte of the defaults changes', () => {
    const before = generated(renderStep(storeStep), DEFAULTS).name;
    const changed = renderedWithChange(storeStep, 'config/settings-defaults.env', (text) =>
      text.replace('VL_retentionPeriod=14d', 'VL_retentionPeriod=15d')
    );
    const after = generated(changed, DEFAULTS).name;
    expect(after).toMatch(new RegExp(`^${DEFAULTS}-${HASH}$`));
    expect(after).not.toBe(before);
    expect(
      find(changed, 'Deployment', 'logs-store').spec.template.spec.containers[0].envFrom[0]
    ).toEqual({ configMapRef: { name: after } });
  });
});

describe('nothing else in the artifact pins either ConfigMap by its fixed name', () => {
  it('names them only where the generator and the workload reference live', () => {
    // A resourceName, an admission policy or a mount that pinned the fixed name
    // would stop matching the generated object the moment its content changed.
    expect(namers(COLLECTOR)).toEqual([
      'platform/logs/kustomization.yaml',
      'platform/logs/vector.yaml',
    ]);
    expect(namers(DEFAULTS)).toEqual([
      'platform/logs-store/kustomization.yaml',
      'platform/logs-store/logs-store.yaml',
    ]);
  });
});
