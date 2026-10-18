import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('channel health surface', () => {
  it('has no unused circuit-breaker runtime or monitoring API', () => {
    const root = new URL('../../', import.meta.url);
    expect(existsSync(new URL('src/core/circuit-breaker.ts', root))).toBe(false);
    for (const file of ['src/channels/channel.ts', 'src/channels/index.ts', 'src/types/index.ts']) {
      expect(readFileSync(fileURLToPath(new URL(file, root)), 'utf8')).not.toMatch(
        /CircuitStats|getCircuitStats|circuit-breaker/
      );
    }
  });
});
