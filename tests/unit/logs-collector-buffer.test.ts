import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { listLogPartitions, removeLogPartition } from '../../loader/src/logs-partitions.js';
import { EVICTOR_HEADROOM_BYTES } from '../../loader/src/logs-volume-space.js';
const base = fileURLToPath(new URL('../../deploy/platform/logs/', import.meta.url));
describe('collector persistent outage buffer', () => {
  it('bounds disk bytes inside eviction headroom and keeps the 300Mi memory limit', async () => {
    const config = YAML.parse(await readFile(join(base, 'config/vector.yaml'), 'utf8'));
    const workload = YAML.parse(await readFile(join(base, 'vector.yaml'), 'utf8'));
    const sink = config.sinks['logs-store'];
    expect(config.sources.kubernetes.type).toBe('kubernetes_logs');
    expect(sink.buffer).toEqual({ type: 'disk', max_size: 320 * 1024 ** 2, when_full: 'block' });
    expect(sink.buffer.max_size).toBeGreaterThanOrEqual(268435488);
    expect(sink.buffer.max_size + 128 * 1024 ** 2).toBeLessThan(EVICTOR_HEADROOM_BYTES);
    const pod = workload.spec.template.spec;
    expect(pod.volumes.find((v: any) => v.name === 'checkpoints').hostPath).toEqual({
      path: '/var/lib/lifemodel-logs/collector',
      type: 'Directory',
    });
    expect(config.data_dir).toBe('/var/lib/lifemodel-logs-collector');
    expect(pod.containers[0].resources.limits.memory).toBe('300Mi');
    expect(pod.containers[0].livenessProbe.exec.command).toEqual([
      '/bin/bash',
      '/etc/vector/check-delivery.sh',
    ]);
    expect(pod.containers[0].livenessProbe.timeoutSeconds).toBeGreaterThanOrEqual(8);
  });
  it('keeps buffer files outside the store mount and the evictor partition removal', async () => {
    const volume = await mkdtemp(join(tmpdir(), 'collector-volume-'));
    try {
      const store = join(volume, 'data');
      await mkdir(join(store, 'partitions/20261110'), { recursive: true });
      await mkdir(join(volume, 'collector'), { recursive: true });
      const marker = join(volume, 'collector/buffer.db');
      await writeFile(marker, 'durable');
      expect(await listLogPartitions(store)).toEqual(['20261110']);
      await removeLogPartition(store, '20261110');
      expect(await readFile(marker, 'utf8')).toBe('durable');
      expect(await listLogPartitions(store)).toEqual([]);
    } finally {
      await rm(volume, { recursive: true, force: true });
    }
  });
});
