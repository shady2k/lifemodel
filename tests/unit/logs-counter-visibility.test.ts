import { describe, expect, it } from 'vitest';
import { createLogsQuery } from '../../loader/src/logs-query.js';
import { createModelLogsStore } from '../helpers/logs-model-store.js';
import type { LogsRecord } from '../../loader/src/logs-store-adapter.js';

function record(second: number, module: string, untrusted?: string): LogsRecord {
  return {
    time: new Date(second * 1000).toISOString(),
    message: `line ${second}`,
    fields: { module, pod: 'pod', ...(untrusted === undefined ? {} : { untrusted }) },
  };
}

describe('collector counters are not message records', () => {
  it('hides owned counters from counts, boundaries and pages, but preserves a forged task module label', async () => {
    const records = [
      record(6, 'throttle-window'),
      record(5, 'core'),
      record(4, 'throttle-window', 'true'),
      record(3, 'throttle-window'),
      record(2, 'core'),
    ];
    const model = createModelLogsStore(records);
    const logs = createLogsQuery({ store: model.store });
    const filter = { from: 0, to: 10000 };
    const first = await logs.page({ filter, offset: 0, limit: 2, expected: null });
    expect(first).toMatchObject({
      state: 'ok',
      count: 3,
      incomplete: false,
      records: [records[1], records[2]],
    });
    const older = await logs.page({ filter, offset: 2, limit: 2, expected: 3 });
    expect(older).toMatchObject({
      state: 'ok',
      count: 3,
      incomplete: false,
      records: [records[4]],
    });
    const labeled = await logs.page({
      filter: { ...filter, module: 'throttle-window' },
      offset: 0,
      limit: 2,
      expected: null,
    });
    expect(labeled).toMatchObject({ state: 'ok', count: 1, records: [records[2]] });
  });
});
