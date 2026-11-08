/**
 * ADR-016 §5: the log store's PersistentVolume is retained, so a claim that is
 * deleted and recreated leaves the volume `Released` with the old claim's UID
 * and it never binds again by itself. The loader's pre-flight clears that stale
 * `spec.claimRef` - the one supported way to make a retained volume claimable -
 * and it does it only for the store's own volume and only while the volume is
 * Released.
 */
import { describe, expect, it } from 'vitest';
import {
  createLogsVolumeClaimPreflight,
  LOGS_CLAIM_NAME,
  LOGS_CLAIM_NAMESPACE,
  LOGS_VOLUME_NAME,
} from '../../loader/src/logs-volume-claim.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

const volumePath = `/api/v1/persistentvolumes/${LOGS_VOLUME_NAME}`;
const claimPath = `/api/v1/namespaces/${LOGS_CLAIM_NAMESPACE}/persistentvolumeclaims/${LOGS_CLAIM_NAME}`;

interface RecordedCall {
  method: 'get' | 'patch';
  path: string;
  body?: string;
}

function kubernetesObjects(objects: Record<string, Record<string, unknown>>): {
  api: {
    get(path: string): Promise<{ status: number; body: string }>;
    patch(path: string, body: string): Promise<{ status: number; body: string }>;
  };
  calls: RecordedCall[];
  patchStatus(status: number): void;
} {
  const calls: RecordedCall[] = [];
  let patchStatus = 200;
  return {
    calls,
    patchStatus: (status) => {
      patchStatus = status;
    },
    api: {
      get: async (path) => {
        calls.push({ method: 'get', path });
        const found = objects[path];
        return found === undefined
          ? { status: 404, body: '{"message":"not found"}' }
          : { status: 200, body: JSON.stringify(found) };
      },
      patch: async (path, body) => {
        calls.push({ method: 'patch', path, body });
        return patchStatus === 200
          ? { status: 200, body: '{}' }
          : { status: patchStatus, body: '{"message":"conflict"}' };
      },
    },
  };
}

function releasedVolume(claimUid: string, overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: LOGS_VOLUME_NAME, resourceVersion: '12' },
    spec: {
      claimRef: { namespace: LOGS_CLAIM_NAMESPACE, name: LOGS_CLAIM_NAME, uid: claimUid },
    },
    status: { phase: 'Released' },
    ...overrides,
  };
}

function claim(uid: string) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { namespace: LOGS_CLAIM_NAMESPACE, name: LOGS_CLAIM_NAME, uid },
  };
}

function preflight(objects: Record<string, Record<string, unknown>>) {
  const fake = kubernetesObjects(objects);
  const lines: RecordedLine[] = [];
  return {
    fake,
    lines,
    run: () =>
      createLogsVolumeClaimPreflight({
        api: fake.api,
        logger: createRecordingLogger(lines),
      }).run(),
  };
}

describe('the log volume claim pre-flight (ADR-016 §5)', () => {
  it('clears a released volume whose claimRef names the previous claim', async () => {
    const run = preflight({
      [volumePath]: releasedVolume('old-uid'),
      [claimPath]: claim('new-uid'),
    });
    await run.run();
    expect(run.fake.calls).toEqual([
      { method: 'get', path: volumePath },
      { method: 'get', path: claimPath },
      {
        method: 'patch',
        path: volumePath,
        body: JSON.stringify({ metadata: { resourceVersion: '12' }, spec: { claimRef: null } }),
      },
    ]);
    // One line, the volume name and the old claim UID only.
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]!.level).toBe('info');
    expect(run.lines[0]!.fields).toEqual({ volume: LOGS_VOLUME_NAME, claimUid: 'old-uid' });
  });

  it('clears a released volume when no claim of the current generation exists', async () => {
    const run = preflight({ [volumePath]: releasedVolume('old-uid') });
    await run.run();
    expect(run.fake.calls.map((call) => [call.method, call.path])).toEqual([
      ['get', volumePath],
      ['get', claimPath],
      ['patch', volumePath],
    ]);
    expect(run.lines).toHaveLength(1);
  });

  it('leaves a released volume alone when claimRef already names the live claim', async () => {
    const run = preflight({
      [volumePath]: releasedVolume('same-uid'),
      [claimPath]: claim('same-uid'),
    });
    await run.run();
    expect(run.fake.calls.map((call) => call.method)).toEqual(['get', 'get']);
    expect(run.lines).toEqual([]);
  });

  it('never touches a bound volume', async () => {
    const volume = releasedVolume('old-uid');
    volume.status = { phase: 'Bound' };
    const run = preflight({ [volumePath]: volume, [claimPath]: claim('new-uid') });
    await run.run();
    expect(run.fake.calls).toEqual([{ method: 'get', path: volumePath }]);
    expect(run.lines).toEqual([]);
  });

  it('never touches an available volume', async () => {
    const volume = releasedVolume('old-uid');
    volume.status = { phase: 'Available' };
    delete (volume.spec as Record<string, unknown>)['claimRef'];
    const run = preflight({ [volumePath]: volume, [claimPath]: claim('new-uid') });
    await run.run();
    expect(run.fake.calls).toEqual([{ method: 'get', path: volumePath }]);
    expect(run.lines).toEqual([]);
  });

  it('does nothing, and does not fail, when the volume does not exist', async () => {
    const run = preflight({});
    await expect(run.run()).resolves.toBeUndefined();
    expect(run.fake.calls).toEqual([{ method: 'get', path: volumePath }]);
    expect(run.lines).toEqual([]);
  });

  it('never reads another volume, and never clears a claimRef of another claim', async () => {
    const other = releasedVolume('old-uid');
    (other.spec as any).claimRef = {
      namespace: LOGS_CLAIM_NAMESPACE,
      name: 'another-store',
      uid: 'old-uid',
    };
    const foreignNamespace = releasedVolume('old-uid');
    (foreignNamespace.spec as any).claimRef = {
      namespace: 'lifemodel-motor',
      name: LOGS_CLAIM_NAME,
      uid: 'old-uid',
    };
    for (const volume of [other, foreignNamespace]) {
      const run = preflight({ [volumePath]: volume, [claimPath]: claim('new-uid') });
      await run.run();
      expect(run.fake.calls).toEqual([{ method: 'get', path: volumePath }]);
      expect(run.lines).toEqual([]);
    }
  });

  it('fails loudly when the patch is refused, so the next attempt retries', async () => {
    const run = preflight({
      [volumePath]: releasedVolume('old-uid'),
      [claimPath]: claim('new-uid'),
    });
    run.fake.patchStatus(409);
    await expect(run.run()).rejects.toThrow(/409/);
    expect(run.lines).toEqual([]);
  });
});
