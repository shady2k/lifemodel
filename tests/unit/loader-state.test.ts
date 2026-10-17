import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { loadConfig } from '../../loader/src/config.js';
import { createLoaderState } from '../../loader/src/state.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { hashPassword, verifyPassword } from '../../loader/src/auth.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('durable loader first writer', () => {
  it('allows only one of independent state writers to publish auth in a shared real directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-state-'));
    roots.push(root);
    const fs = createNodeFileSystem();
    const config = {
      ...loadConfig({ LIFEMODEL_VOLUME_ROOT: root, LIFEMODEL_NAME: 'lifemodel' }),
      loaderDir: join(root, 'loader'),
    };
    const logger = createRecordingLogger([]);
    const a = createLoaderState({ fs, config, logger });
    const b = createLoaderState({ fs, config, logger });
    await Promise.all([a.ensureLayout(), b.ensureLayout()]);
    const passwords = ['winner alpha secure', 'winner beta secure'];
    const records = await Promise.all(passwords.map(hashPassword));
    const outcomes = await Promise.allSettled([a.writeAuth(records[0]!), b.writeAuth(records[1]!)]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((x) => x.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    const reopened = createLoaderState({ fs, config, logger });
    const persisted = await reopened.readAuth();
    expect(persisted).not.toBeNull();
    const matches = await Promise.all(
      records.map((record) => verifyPassword(passwords[records.indexOf(record)]!, persisted!))
    );
    expect(matches.filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'loader', 'auth.json'), 'utf8'))).toHaveProperty(
      'hash'
    );
  });
  it('records completedAt only when device onboarding is completed and persists done state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-complete-'));
    roots.push(root);
    const fs = createNodeFileSystem();
    const config = {
      ...loadConfig({ LIFEMODEL_VOLUME_ROOT: root, LIFEMODEL_NAME: 'lifemodel' }),
      loaderDir: join(root, 'loader'),
    };
    const state = createLoaderState({ fs, config, logger: createRecordingLogger([]) });
    await state.ensureLayout();
    await state.readOnboarding?.();
    const path = join(root, 'loader', 'onboarding.json');
    await expect(state.completeDeviceOnboarding?.('2026-10-19T12:00:00.000Z')).rejects.toThrow(
      'onboarding step conflict'
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      step: 'welcome',
      completedAt: null,
    });
    await fs.writeFileAtomic(
      path,
      JSON.stringify({ version: 1, step: 'device', completedAt: null }),
      0o600
    );
    await state.completeDeviceOnboarding?.('2026-10-19T12:00:00.000Z');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      step: 'done',
      completedAt: '2026-10-19T12:00:00.000Z',
    });
    const reopened = createLoaderState({ fs, config, logger: createRecordingLogger([]) });
    expect(await reopened.readOnboarding?.()).toEqual({
      version: 1,
      step: 'done',
      completedAt: '2026-10-19T12:00:00.000Z',
    });
  });
  it('advances onboarding to device only after a primary model save while in the model step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-onboarding-'));
    roots.push(root);
    const fs = createNodeFileSystem();
    const config = {
      ...loadConfig({ LIFEMODEL_VOLUME_ROOT: root, LIFEMODEL_NAME: 'lifemodel' }),
      loaderDir: join(root, 'loader'),
    };
    const state = createLoaderState({ fs, config, logger: createRecordingLogger([]) });
    await state.ensureLayout();
    expect(await state.readOnboarding?.()).toEqual({
      version: 1,
      step: 'welcome',
      completedAt: null,
    });
    await state.saveModelOnboarding?.();
    expect((await state.readOnboarding?.())?.step).toBe('welcome');
    const onboardingPath = join(root, 'loader', 'onboarding.json');
    await fs.writeFileAtomic(
      onboardingPath,
      JSON.stringify({ version: 1, step: 'model', completedAt: null }),
      0o600
    );
    await state.saveModelOnboarding?.();
    expect((await state.readOnboarding?.())?.step).toBe('device');
    expect(JSON.parse(readFileSync(onboardingPath, 'utf8'))).toEqual({
      version: 1,
      step: 'device',
      completedAt: null,
    });
  });

  it('reconciles durable password auth to model onboarding after an interrupted setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-recovery-'));
    roots.push(root);
    const fs = createNodeFileSystem();
    const config = {
      ...loadConfig({ LIFEMODEL_VOLUME_ROOT: root, LIFEMODEL_NAME: 'lifemodel' }),
      loaderDir: join(root, 'loader'),
    };
    const first = createLoaderState({ fs, config, logger: createRecordingLogger([]) });
    await first.ensureLayout();
    await first.writeAuth(await hashPassword('secure owner password'));
    expect((await first.readOnboarding?.())?.step).toBe('welcome');
    const reopened = createLoaderState({ fs, config, logger: createRecordingLogger([]) });
    await reopened.reconcilePasswordOnboarding?.();
    expect((await reopened.readOnboarding?.())?.step).toBe('model');
    await reopened.saveModelOnboarding?.();
    expect((await reopened.readOnboarding?.())?.step).toBe('device');
  });
});
