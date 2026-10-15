import { describe, expect, it, vi } from 'vitest';
import { DurableEffectRegistry } from '../../../src/core/durable-effect-registry.js';

describe('DurableEffectRegistry', () => {
  it('reports each named effect that remains at the shared deadline', async () => {
    const registry = new DurableEffectRegistry();
    let release!: () => void;
    const effect = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.track('gated memory save', effect);
    const logger = { error: vi.fn() };

    await registry.drain(Date.now() + 10, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { effect: 'gated memory save' },
      'Durable effect abandoned at stop deadline'
    );
    release();
  });
});
