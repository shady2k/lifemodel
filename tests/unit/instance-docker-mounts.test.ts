import { describe, expect, it } from 'vitest';
import { compareInstanceMounts } from '../integration/helpers/instance-docker-mounts.js';

type FixtureRecord = Record<string, unknown>;

function fixture(): FixtureRecord[] {
  return [
    {
      Type: 'volume',
      Name: 'synthetic-instance-volume',
      Source: '/var/lib/docker/volumes/synthetic-instance-volume/_data',
      Destination: '/var/lib/lifemodel',
      Driver: 'local',
      Mode: 'z',
      RW: true,
      Propagation: '',
    },
    {
      Type: 'bind',
      Source: '/tmp/synthetic-fixture/fixture-ca.pem',
      Destination: '/etc/ssl/certs/lifemodel-ci-fixture.pem',
      Mode: '',
      RW: false,
      Propagation: 'rprivate',
    },
  ];
}

const accepted = {
  equal: true,
  valid: true,
  sameCount: true,
  sameDestinationSet: true,
  changedFields: [],
};

const invalid = {
  equal: false,
  valid: false,
  sameCount: false,
  sameDestinationSet: false,
  changedFields: [],
};

function expectRejected(left: unknown, right: unknown): void {
  // Assert only public output, never secret-bearing fixture records.
  expect(compareInstanceMounts(left, right).equal).toBe(false);
  expect(compareInstanceMounts(right, left).equal).toBe(false);
}

describe('compareInstanceMounts', () => {
  it('accepts the full two-record Docker fixture in reversed list order', () => {
    const left = fixture();
    const right = fixture().reverse();

    // Production-interface regression. Do not retain the old comparison.
    expect(compareInstanceMounts(left, right)).toEqual(accepted);
  });

  it('ignores object key insertion order, including nested objects', () => {
    const left = fixture();
    const right = fixture();
    left[0]!.Extension = { first: 1, second: { a: true, b: false } };
    right[0]!.Extension = { second: { b: false, a: true }, first: 1 };

    right[0] = Object.fromEntries(Object.entries(right[0]!).reverse());
    right[1] = Object.fromEntries(Object.entries(right[1]!).reverse());

    expect(compareInstanceMounts(left, right.reverse())).toEqual(accepted);
  });

  const mutations = [
    ['Type', 'bind'],
    ['Name', 'synthetic-other-volume'],
    ['Source', '/synthetic/other-source'],
    ['Destination', '/synthetic/other-destination'],
    ['Driver', 'synthetic-other-driver'],
    ['Mode', 'ro'],
    ['RW', false],
    ['Propagation', 'rshared'],
  ] as const;

  for (const [field, replacement] of mutations) {
    it(`rejects a ${field} mutation with a fixed field diagnostic`, () => {
      const left = fixture();
      const right = fixture();
      right[0]![field] = replacement;

      const result = compareInstanceMounts(left, right);
      expect(result).toEqual({
        equal: false,
        valid: true,
        sameCount: true,
        sameDestinationSet: field !== 'Destination',
        changedFields: [field],
      });
      expectRejected(left, right);
    });
  }

  for (const field of [
    'Name', 'Source', 'Driver', 'Mode', 'RW', 'Propagation',
  ] as const) {
    it(`rejects deletion of ${field}`, () => {
      const left = fixture();
      const right = fixture();
      delete right[0]![field];

      expect(compareInstanceMounts(left, right).changedFields).toEqual([field]);
      expectRejected(left, right);
    });
  }

  it('distinguishes an absent known field from an own undefined field', () => {
    const left = fixture();
    const right = fixture();
    right[1]!.Name = undefined;

    expect(compareInstanceMounts(left, right).changedFields).toEqual(['Name']);
    expectRejected(left, right);
  });

  it('distinguishes an absent unknown field from own undefined without leaking its key', () => {
    const left = fixture();
    const right = fixture();
    const privateKey = 'synthetic-private-unknown-field';
    right[1]![privateKey] = undefined;
    const expected = {
      equal: false,
      valid: true,
      sameCount: true,
      sameDestinationSet: true,
      changedFields: ['otherFields'],
    };
    const forward = compareInstanceMounts(left, right);
    const reverse = compareInstanceMounts(right, left);
    expect(forward).toEqual(expected);
    expect(reverse).toEqual(expected);
    expect(JSON.stringify([forward, reverse])).not.toContain(privateKey);
  });

  it('rejects a writable synthetic CA bind', () => {
    const left = fixture();
    const right = fixture();
    right[1]!.RW = true;

    expect(compareInstanceMounts(left, right)).toEqual({
      equal: false,
      valid: true,
      sameCount: true,
      sameDestinationSet: true,
      changedFields: ['RW'],
    });
    expectRejected(left, right);
  });

  it('rejects unknown-field addition and deletion', () => {
    const left = fixture();
    const right = fixture();
    right[0]!.SyntheticExtension = { enabled: true };

    expect(compareInstanceMounts(left, right).changedFields)
      .toEqual(['otherFields']);
    expect(compareInstanceMounts(right, left).changedFields)
      .toEqual(['otherFields']);
    expectRejected(left, right);
  });

  it('rejects unknown-field value changes', () => {
    const left = fixture();
    const right = fixture();
    left[0]!.SyntheticExtension = { enabled: true };
    right[0]!.SyntheticExtension = { enabled: false };

    expect(compareInstanceMounts(left, right).changedFields)
      .toEqual(['otherFields']);
    expectRejected(left, right);
  });

  it('rejects an unknown nested value prototype change', () => {
    const left = fixture();
    const right = fixture();
    left[0]!.SyntheticExtension = { enabled: true };
    right[0]!.SyntheticExtension = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { enabled: true },
    );

    expect(compareInstanceMounts(left, right).changedFields)
      .toEqual(['otherFields']);
    expectRejected(left, right);
  });

  it('rejects a plain mount record prototype change', () => {
    const left = fixture();
    const right = fixture();
    right[0] = Object.assign(
      Object.create(null) as FixtureRecord,
      right[0],
    );

    expect(compareInstanceMounts(left, right)).toEqual({
      equal: false,
      valid: true,
      sameCount: true,
      sameDestinationSet: true,
      changedFields: ['otherFields'],
    });
    expectRejected(left, right);
  });

  it('accepts matching null-prototype plain records', () => {
    const left = fixture().map(record =>
      Object.assign(Object.create(null) as FixtureRecord, record),
    );
    const right = fixture().map(record =>
      Object.assign(Object.create(null) as FixtureRecord, record),
    );

    expect(compareInstanceMounts(left, right.reverse())).toEqual(accepted);
  });

  it('rejects nested array order changes', () => {
    const left = fixture();
    const right = fixture();
    left[0]!.SyntheticExtension = { entries: ['first', 'second'] };
    right[0]!.SyntheticExtension = { entries: ['second', 'first'] };

    expect(compareInstanceMounts(left, right).changedFields)
      .toEqual(['otherFields']);
    expectRejected(left, right);
  });

  it('rejects symbol-keyed unknown-field changes without exposing the key', () => {
    const key = Symbol('synthetic-private-symbol');
    const left = fixture();
    const right = fixture();
    Object.defineProperty(left[0]!, key, {
      value: 'synthetic-private-left',
      enumerable: true,
    });
    Object.defineProperty(right[0]!, key, {
      value: 'synthetic-private-right',
      enumerable: true,
    });

    expect(compareInstanceMounts(left, right).changedFields)
      .toEqual(['otherFields']);
    expectRejected(left, right);
  });

  it('rejects count addition and deletion', () => {
    const left = fixture();
    const right = fixture();
    right.push({
      Type: 'bind',
      Source: '/synthetic/extra',
      Destination: '/synthetic/extra',
      Mode: '',
      RW: false,
      Propagation: 'rprivate',
    });

    expect(compareInstanceMounts(left, right)).toEqual({
      equal: false,
      valid: true,
      sameCount: false,
      sameDestinationSet: false,
      changedFields: ['Destination'],
    });
    expectRejected(left, right);
    expectRejected(fixture(), fixture().slice(0, 1));
  });

  it('rejects duplicate destinations even when both lists are identical', () => {
    const left = fixture();
    left[1]!.Destination = left[0]!.Destination;
    const right = fixture();
    right[1]!.Destination = right[0]!.Destination;

    expect(compareInstanceMounts(left, right)).toEqual(invalid);
    expect(compareInstanceMounts(left, left)).toEqual(invalid);
  });

  it('rejects duplicate identical records', () => {
    const record = fixture()[0]!;
    const mounts = [record, record];

    expect(compareInstanceMounts(mounts, mounts)).toEqual(invalid);
  });

  it('does not collapse destination path aliases', () => {
    const left = fixture();
    const right = fixture();
    right[0]!.Destination = '/var/lib/./lifemodel';

    expect(compareInstanceMounts(left, right).changedFields)
      .toEqual(['Destination']);
    expectRejected(left, right);
  });

  it('does not normalize source paths or coerce RW', () => {
    const sourceChanged = fixture();
    sourceChanged[0]!.Source =
      '/var/lib/docker/volumes/./synthetic-instance-volume/_data';
    expectRejected(fixture(), sourceChanged);

    const rwChanged = fixture();
    rwChanged[0]!.RW = 'true';
    expectRejected(fixture(), rwChanged);
  });

  const badDestinations: unknown[] = [
    undefined, null, '', 'relative/path', 7, false, [], {},
  ];

  badDestinations.forEach((destination, index) => {
    it(`rejects malformed destination case ${index}`, () => {
      const mounts = fixture();
      mounts[0]!.Destination = destination;

      expect(compareInstanceMounts(mounts, fixture())).toEqual(invalid);
      expect(compareInstanceMounts(fixture(), mounts)).toEqual(invalid);
    });
  });

  it('rejects a missing destination', () => {
    const mounts = fixture();
    delete mounts[0]!.Destination;

    expect(compareInstanceMounts(mounts, mounts)).toEqual(invalid);
  });

  const badTypes: unknown[] = [undefined, null, '', 7, false, [], {}];

  badTypes.forEach((type, index) => {
    it(`rejects malformed type case ${index}`, () => {
      const mounts = fixture();
      mounts[0]!.Type = type;

      expect(compareInstanceMounts(mounts, mounts)).toEqual(invalid);
    });
  });

  it('rejects a missing type', () => {
    const mounts = fixture();
    delete mounts[0]!.Type;

    expect(compareInstanceMounts(mounts, mounts)).toEqual(invalid);
  });

  const badRecords: unknown[] = [
    null, undefined, 7, 'record', [], new Date(0),
  ];

  badRecords.forEach((record, index) => {
    it(`rejects malformed record case ${index}`, () => {
      expect(compareInstanceMounts([record], [record])).toEqual(invalid);
    });
  });

  const nonArrays: unknown[] = [
    undefined, null, false, 7, 'mounts', {},
    { 0: fixture()[0], length: 1 },
  ];

  nonArrays.forEach((value, index) => {
    it(`rejects non-array case ${index}`, () => {
      expect(compareInstanceMounts(value, fixture())).toEqual(invalid);
      expect(compareInstanceMounts(fixture(), value)).toEqual(invalid);
    });
  });

  it('rejects empty lists', () => {
    expect(compareInstanceMounts([], [])).toEqual(invalid);
    expectRejected([], fixture());
  });

  it('accepts sixteen unique records and rejects seventeen', () => {
    const mounts = Array.from({ length: 16 }, (_, index) => ({
      Type: 'bind',
      Source: `/synthetic/source-${index}`,
      Destination: `/synthetic/destination-${index}`,
      RW: false,
    }));

    expect(compareInstanceMounts(mounts, [...mounts].reverse()))
      .toEqual(accepted);

    const oversized = [
      ...mounts,
      { Type: 'bind', Destination: '/synthetic/destination-16', RW: false },
    ];
    expect(compareInstanceMounts(oversized, oversized)).toEqual(invalid);
  });

  it('rejects sparse lists and extra array properties', () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = fixture()[1];
    expect(compareInstanceMounts(sparse, sparse)).toEqual(invalid);

    const extra = fixture();
    Object.defineProperty(extra, 'SyntheticExtension', {
      value: true,
      enumerable: true,
    });
    expect(compareInstanceMounts(extra, extra)).toEqual(invalid);
  });

  it('rejects accessors without calling them', () => {
    let calls = 0;
    const mounts = fixture();
    Object.defineProperty(mounts[0]!, 'SyntheticExtension', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('synthetic-private-error');
      },
    });

    expect(compareInstanceMounts(mounts, mounts)).toEqual(invalid);
    expect(calls).toBe(0);
  });

  it('rejects hidden record fields rather than dropping them', () => {
    const mounts = fixture();
    Object.defineProperty(mounts[0]!, 'SyntheticExtension', {
      value: 'synthetic-private-value',
      enumerable: false,
    });

    expect(compareInstanceMounts(mounts, mounts)).toEqual(invalid);
  });

  it('fails closed without leaking a reflection exception', () => {
    const record = new Proxy(fixture()[0]!, {
      getPrototypeOf() {
        throw new Error('synthetic-private-reflection-error');
      },
    });

    expect(compareInstanceMounts([record], fixture())).toEqual(invalid);
  });

  it('reports multiple deltas in fixed public field order', () => {
    const left = fixture();
    const right = fixture();
    right[0]!.Propagation = 'rshared';
    right[0]!.Source = '/synthetic/changed';
    right[0]!.Name = 'synthetic-changed';
    right[0]!.SyntheticExtension = true;

    expect(compareInstanceMounts(left, right).changedFields).toEqual([
      'Name', 'Source', 'Propagation', 'otherFields',
    ]);
  });

  it('returns only public evidence despite synthetic private keys and values', () => {
    const left = fixture();
    const right = fixture();
    const privateKey = 'synthetic-private-unknown-key';
    left[0]![privateKey] = {
      secret: 'synthetic-private-left-value',
      path: '/synthetic/private-left-path',
    };
    right[0]![privateKey] = {
      secret: 'synthetic-private-right-value',
      path: '/synthetic/private-right-path',
    };
    right[0]!.Source = '/synthetic/private-source-value';

    const result = compareInstanceMounts(left, right);
    expect(result).toEqual({
      equal: false,
      valid: true,
      sameCount: true,
      sameDestinationSet: true,
      changedFields: ['Source', 'otherFields'],
    });
    expect(Object.keys(result)).toEqual([
      'equal', 'valid', 'sameCount', 'sameDestinationSet', 'changedFields',
    ]);
    expect(JSON.stringify(result)).toBe(
      '{"equal":false,"valid":true,"sameCount":true,' +
      '"sameDestinationSet":true,"changedFields":["Source","otherFields"]}',
    );
  });

  it('does not mutate inputs and returns no private object reference', () => {
    const left = fixture();
    const right = fixture().reverse();
    const leftExtension = Object.freeze({
      entries: Object.freeze(['first', 'second']),
    });
    const rightExtension = Object.freeze({
      entries: Object.freeze(['first', 'second']),
    });
    left[0]!.SyntheticExtension = leftExtension;
    right[1]!.SyntheticExtension = rightExtension;

    const leftFirst = left[0];
    const leftSecond = left[1];
    const rightFirst = right[0];
    const rightSecond = right[1];

    left.forEach(Object.freeze);
    right.forEach(Object.freeze);
    Object.freeze(left);
    Object.freeze(right);

    const result = compareInstanceMounts(left, right);
    expect(result).toEqual(accepted);
    expect(left[0] === leftFirst && left[1] === leftSecond).toBe(true);
    expect(right[0] === rightFirst && right[1] === rightSecond).toBe(true);
    expect(left[0]!.SyntheticExtension === leftExtension).toBe(true);
    expect(right[1]!.SyntheticExtension === rightExtension).toBe(true);

    result.changedFields.push('otherFields');
    expect(compareInstanceMounts(left, right)).toEqual(accepted);
  });
});
