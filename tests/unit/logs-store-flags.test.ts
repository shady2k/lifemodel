/**
 * The store's `/flags` read (ADR-016 §5, F3, check L08).
 *
 * The exchange is a recorded answer of the pinned store: the three retention
 * flags it was given through `-envflag.prefix=VL_`, and the partition key it
 * prints beside them, which must not leave the adapter.
 */
import { describe, expect, it } from 'vitest';
import { createLogsStore } from '../../loader/src/logs-store-adapter.js';
import { startLogsStoreFixture } from '../helpers/logs-store-fixture.js';

describe("the store's own flags through the adapter", () => {
  it('reads the three retention flags and nothing else', async () => {
    const fixture = await startLogsStoreFixture('logs-store-flags.json');
    try {
      const store = createLogsStore({ url: fixture.url });
      const answer = await store.retentionFlags();
      expect(answer).toEqual({
        state: 'ok',
        flags: {
          retentionPeriod: '14d',
          retentionMaxDiskSpaceUsageBytes: '1610612736',
          storageMinFreeDiskSpaceBytes: '805306368',
        },
      });
      // The answer carries the three numbers, never the body: the same body
      // prints the partition key.
      expect(JSON.stringify(answer)).not.toContain('secret');
      expect(JSON.stringify(answer)).not.toContain('partitionManageAuthKey');
      expect(fixture.requests).toEqual([{ method: 'GET', path: '/flags', query: '' }]);
    } finally {
      await fixture.close();
    }
  });

  it('answers unavailable when the store does not answer the flags path', async () => {
    const fixture = await startLogsStoreFixture();
    try {
      // The recorded query fixture has no `/flags`: the store answers 400.
      const store = createLogsStore({ url: fixture.url });
      const answer = await store.retentionFlags();
      expect(answer.state).toBe('unavailable');
    } finally {
      await fixture.close();
    }
  });

  it('answers unavailable when the store cannot be reached at all', async () => {
    const store = createLogsStore({ url: 'http://127.0.0.1:1', timeoutMs: 200 });
    expect((await store.retentionFlags()).state).toBe('unavailable');
  });
});
