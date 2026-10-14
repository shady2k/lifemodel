import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfigLoader } from '../../../src/config/config-loader.js';

const original = process.env['MOTOR_CORTEX_ENABLED'];
afterEach(() => {
  if (original === undefined) delete process.env['MOTOR_CORTEX_ENABLED'];
  else process.env['MOTOR_CORTEX_ENABLED'] = original;
});

describe('Motor Cortex setting', () => {
  it('defaults explicitly to enabled for existing installations', async () => {
    delete process.env['MOTOR_CORTEX_ENABLED'];
    expect((await createConfigLoader('/tmp/lifemodel-motor-config-absent').load()).motorCortex.enabled).toBe(true);
  });

  it('can be disabled by MOTOR_CORTEX_ENABLED=false', async () => {
    process.env['MOTOR_CORTEX_ENABLED'] = 'false';
    expect((await createConfigLoader('/tmp/lifemodel-motor-config-disabled').load()).motorCortex.enabled).toBe(false);
  });

  it('gates tool construction and reports the disabled reason at startup', () => {
    const container = readFileSync(new URL('../../../src/core/container.ts', import.meta.url), 'utf8');
    expect(container).toContain("logger.info({ reason: 'MOTOR_CORTEX_ENABLED=false' }, 'Motor Cortex disabled')");
    expect(container).toContain('if (llmProvider && mergedConfig.motorCortex.enabled)');
    expect(container).toContain('if (motorCortex) {');
  });

  it('rejects values other than true or false', async () => {
    process.env['MOTOR_CORTEX_ENABLED'] = 'off';
    await expect(createConfigLoader('/tmp/lifemodel-motor-config-invalid').load()).rejects.toThrow(
      'MOTOR_CORTEX_ENABLED must be exactly true or false'
    );
  });
});
