/** Recovery CLI never exposes SQL credentials, filenames or exception bodies. */
import { describe, expect, it, vi } from 'vitest';
import { runStorageRecoveryCli } from '../../loader/src/storage-recovery-cli.js';

async function run(args: string[], extra: Record<string, unknown> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runStorageRecoveryCli(args, {
    env: {},
    stdout: async (text: string) => {
      stdout += text;
    },
    stderr: async (text: string) => {
      stderr += text;
    },
    ...extra,
  });
  return { code, stdout, stderr };
}

describe('storage recovery operator CLI', () => {
  it('rejects connection strings and unknown commands without echoing arguments', async () => {
    const result = await run(['status', '--database', 'postgres://private-password@private-host']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('invalid_arguments');
    expect(result.stderr).not.toContain('private');
  });
  it('requires explicit generation and artifact digest before restore preparation', async () => {
    expect((await run(['prepare-restore', '1', 'wrong'])).code).toBe(2);
    expect((await run(['release', '0'])).code).toBe(2);
  });
  it('does not expose database exceptions or credentials', async () => {
    const result = await run(['status'], {
      env: { LIFEMODEL_DB_USERNAME: 'private-user', LIFEMODEL_DB_PASSWORD: 'private-password' },
      maintenance: () => {
        throw new Error('postgres://private-password@private-host');
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('recovery_failed');
    expect(result.stderr).not.toContain('private');
  });
  it('begins keyed backup holds and closes its SQL connection', async () => {
    const close = vi.fn(async () => undefined);
    const begin = vi.fn(async () => ({
      generation: '00000000-0000-4000-8000-000000000007',
      state: 'held',
      purpose: 'backup',
    }));
    const result = await run(['begin', 'walk-backup-001'], {
      env: { LIFEMODEL_DB_USERNAME: 'u', LIFEMODEL_DB_PASSWORD: 'p' },
      maintenance: () => ({ begin, close }),
    });
    expect(result.code).toBe(0);
    expect(begin).toHaveBeenCalledWith({ effectKey: 'walk-backup-001' });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: 'hold_started',
      generation: '00000000-0000-4000-8000-000000000007',
      state: 'held',
    });
  });
  it('prints only allowlisted maintenance status fields', async () => {
    const result = await run(['status'], {
      env: { LIFEMODEL_DB_USERNAME: 'u', LIFEMODEL_DB_PASSWORD: 'p' },
      maintenance: () => ({
        status: async () => ({
          generation: '00000000-0000-4000-8000-000000000009',
          state: 'held',
          purpose: 'backup',
          password: 'private',
        }),
        close: async () => undefined,
      }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('private');
    expect(JSON.parse(result.stdout)).toMatchObject({
      generation: '00000000-0000-4000-8000-000000000009',
      state: 'held',
    });
  });
  it('requires an explicit positive exact unavailable count for degraded release', async () => {
    const generation = '00000000-0000-4000-8000-000000000007';
    const releaseDegraded = vi.fn(async () => ({
      generation,
      state: 'normal',
      purpose: 'restore',
    }));
    const close = vi.fn(async () => undefined);
    for (const count of ['0', '-1', '1.5', '9007199254740992', '1e2'])
      expect((await run(['release-degraded', generation, count])).code).toBe(2);
    const result = await run(['release-degraded', generation, '3'], {
      env: { LIFEMODEL_DB_USERNAME: 'u', LIFEMODEL_DB_PASSWORD: 'p' },
      maintenance: () => ({ releaseDegraded, close }),
    });
    expect(result.code).toBe(0);
    expect(releaseDegraded).toHaveBeenCalledWith({ generation, unavailable: 3 });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'hold_released', state: 'normal' });
  });
  it('does not silently succeed if its output fails', async () => {
    const result = await run(['help'], {
      stdout: async () => {
        throw new Error('private-pipe');
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('private-pipe');
  });
});
