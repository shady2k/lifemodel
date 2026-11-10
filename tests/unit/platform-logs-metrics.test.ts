/** The collector's own metrics exporter (ADR-016 §6, L07): an internal_metrics
 * source and a prometheus_exporter bound to the pod's loopback only, read by
 * WALK-LOGS-CRASH through a kubectl port-forward. Nothing in the cluster may
 * reach it, no Service or container port may expose it, and the collector's
 * resource limits must still hold.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { renderStep } from '../helpers/kustomize-config-maps.js';

const deployRoot = fileURLToPath(new URL('../../deploy/', import.meta.url));
const step = join(deployRoot, 'platform/logs');
const configPath = join(step, 'config/vector.yaml');

function config(): Record<string, any> {
  return YAML.parse(readFileSync(configPath, 'utf8'));
}

describe('the collector\'s internal metrics exporter', () => {
  it('takes Vector\'s internal metrics and exports them on the loopback only', () => {
    const parsed = config();
    expect(parsed.sources.internal_metrics).toEqual({ type: 'internal_metrics' });
    const exporter = parsed.sinks.metrics;
    expect(exporter.type).toBe('prometheus_exporter');
    expect(exporter.inputs).toEqual(['internal_metrics']);
    expect(exporter.address).toBe('127.0.0.1:9598');
  });

  it('does not reach the pod network: no container port and no Service', () => {
    const rendered = renderStep(step);
    const daemonSet = rendered.objects.find(
      (object) => object.kind === 'DaemonSet' && object.metadata?.name?.startsWith('logs-collector')
    );
    expect(daemonSet).toBeDefined();
    const container = daemonSet?.spec?.template?.spec?.containers?.[0];
    // A container port would publish the exporter to the pod network.
    expect(container.ports ?? []).toEqual([]);
    // No Service in the step, and none mentions the metrics port.
    expect(rendered.objects.filter((object) => object.kind === 'Service')).toEqual([]);
    // Only the ConfigMap carries the address, as the configuration text.
    for (const object of rendered.objects.filter((entry) => entry.kind !== 'ConfigMap')) {
      expect(JSON.stringify(object)).not.toContain('9598');
    }
  });

  it('keeps the collector\'s resource limits, which hold with the exporter', () => {
    const rendered = renderStep(step);
    const daemonSet = rendered.objects.find(
      (object) => object.kind === 'DaemonSet' && object.metadata?.name?.startsWith('logs-collector')
    );
    const container = daemonSet?.spec?.template?.spec?.containers?.[0];
    expect(container.resources).toEqual({
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '1', memory: '300Mi' },
    });
  });
});
