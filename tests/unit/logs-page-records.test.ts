/** The comparison WALK-LOGS-PAGE makes between its first and second page, and
 * between the page and the answer it drew from (ADR-016 §4; PRA-001).
 *
 * On the VM the second page was called a duplicate of the first in all four
 * runs while the store's own records shared none: 29 messages on page 2 had the
 * same text as one on page 1 ("collector heartbeat", CoreDNS's import-glob
 * warning), because message text repeats every few seconds. These checks hold
 * the comparison the page can actually make - the time line, the module chip and
 * the message, which are what the record element draws - and that a repeated
 * message text passes while a really repeated record fails.
 */
import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE,
  axeSummary,
  missingModules,
  describeIdentity,
  identityOf,
  identityOfAnswer,
  repeatedRecords,
  sameIdentity,
} from '../../deploy/platform/logs-page-records.mjs';

const drawn = (time: string, module: string, message: string) => identityOf({ time, module, message });

describe('the identity the logs page draws a record by', () => {
  it('is the time line, the module chip and the message, all three', () => {
    const record = drawn('2026-11-09T21:00:00.000Z', 'core', 'collector heartbeat');
    expect(record).toEqual({
      time: '2026-11-09T21:00:00.000Z',
      module: 'core',
      message: 'collector heartbeat',
    });
    expect(sameIdentity(record, { ...record })).toBe(true);
    expect(sameIdentity(record, { ...record, time: '2026-11-09T21:00:02.000Z' })).toBe(false);
    expect(sameIdentity(record, { ...record, module: 'coredns' })).toBe(false);
    expect(sameIdentity(record, { ...record, message: 'collector heartbeat 2' })).toBe(false);
  });

  it('reads an API record through the loader\'s own shape', () => {
    const record = identityOfAnswer({
      time: '2026-11-09T21:00:00.000Z',
      message: '  collector heartbeat  ',
      fields: { module: 'core', level: 'info' },
    });
    expect(record).toEqual({
      time: '2026-11-09T21:00:00.000Z',
      module: 'core',
      message: 'collector heartbeat',
    });
    expect(identityOfAnswer({}).module).toBe('');
  });

  it('says what was compared, so a failure line shows the three fields', () => {
    expect(describeIdentity(drawn('2026-11-09T21:00:00.000Z', 'core', 'collector heartbeat')))
      .toBe('2026-11-09T21:00:00.000Z | core | collector heartbeat');
    expect(describeIdentity(null)).toBe('no record');
    expect(describeIdentity(drawn('t', 'm', 'x'.repeat(200)))).toContain('...');
  });

  it('uses the page\'s own page size', () => {
    // loader/src/logs-query.ts LOGS_PAGE_SIZE; the count line is 200 on a full page.
    expect(PAGE_SIZE).toBe(200);
  });
});

describe('the second page against the first', () => {
  it('passes a repeated message text on both pages whose records differ', () => {
    // The measured VM case: page 1 ends with a heartbeat, page 2 begins with the
    // next heartbeat, and the CoreDNS warning appears on both.
    const first = [
      drawn('2026-11-09T21:00:00.000Z', 'coredns', '[WARNING] No files matching import glob pattern: zz'),
      drawn('2026-11-09T21:00:01.000Z', 'core', 'collector heartbeat'),
    ];
    const appended = [
      drawn('2026-11-09T20:59:58.000Z', 'core', 'collector heartbeat'),
      drawn('2026-11-09T20:59:57.000Z', 'coredns', '[WARNING] No files matching import glob pattern: zz'),
    ];
    expect(appended.some((entry) => first.some((held) => held.message === entry.message))).toBe(true);
    expect(repeatedRecords(first, appended)).toEqual([]);
  });

  it('fails a record drawn on both pages', () => {
    const first = [drawn('2026-11-09T21:00:01.000Z', 'core', 'collector heartbeat')];
    const appended = [
      drawn('2026-11-09T21:00:01.000Z', 'core', 'collector heartbeat'),
      drawn('2026-11-09T20:59:58.000Z', 'core', 'collector heartbeat'),
    ];
    const repeated = repeatedRecords(first, appended);
    expect(repeated).toHaveLength(1);
    expect(describeIdentity(repeated[0])).toBe('2026-11-09T21:00:01.000Z | core | collector heartbeat');
  });
});

describe('the page walk\'s own checks', () => {
  it('reports each axe rule with its impact and each node\'s selector, never page text', () => {
    const summary = axeSummary({
      violations: [
        {
          id: 'color-contrast',
          impact: 'serious',
          nodes: [
            {
              target: ['main p.text-muted-foreground'],
              failureSummary: 'Element has insufficient color contrast of 2.9:1. Expected 4.5:1 for normal text.',
            },
            { target: ['#logs-settings'] },
          ],
        },
        { id: 'label', impact: 'moderate', nodes: [{}] },
      ],
    });
    expect(summary).toEqual([
      {
        id: 'color-contrast',
        impact: 'serious',
        count: 2,
        targets: ['main p.text-muted-foreground', '#logs-settings'],
      },
      { id: 'label', impact: 'moderate', count: 1, targets: [] },
    ]);
    expect(axeSummary({ violations: [] })).toEqual([]);
    expect(axeSummary(null)).toEqual([]);
    expect(JSON.stringify(summary)).toContain('main p.text-muted-foreground');
    expect(JSON.stringify(summary)).not.toContain('insufficient color contrast');
  });

  it('names the modules a filter\'s options are missing', () => {
    expect(missingModules(['core', 'model-gateway', 'All modules'], ['core', 'logs-evictor']))
      .toEqual(['logs-evictor']);
    expect(missingModules(['core'], ['core'])).toEqual([]);
    expect(missingModules(null, ['core'])).toEqual(['core']);
  });
});
