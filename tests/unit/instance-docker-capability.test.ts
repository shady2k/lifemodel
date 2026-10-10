import { describe, expect, it } from 'vitest';
import {
  INSTANCE_ADDED_CAPABILITY,
  hasOnlyInstanceAddedCapability,
} from '../integration/helpers/instance-docker-capability.js';

describe('instance Docker added capability', () => {
  it('exports the exact canonical capability', () => {
    expect(INSTANCE_ADDED_CAPABILITY).toBe('CAP_NET_ADMIN');
  });

  const cases: { name: string; value: unknown; expected: boolean }[] = [
    {
      name: 'canonical Docker create-request output (known schema fixture)',
      value: ['CAP_NET_ADMIN'],
      expected: true,
    },
    { name: 'missing', value: undefined, expected: false },
    { name: 'null', value: null, expected: false },
    { name: 'nonarray string', value: 'CAP_NET_ADMIN', expected: false },
    {
      name: 'nonarray array-like object',
      value: { 0: 'CAP_NET_ADMIN', length: 1 },
      expected: false,
    },
    { name: 'empty array', value: [], expected: false },
    { name: 'legacy alias', value: ['NET_ADMIN'], expected: false },
    { name: 'ALL', value: ['ALL'], expected: false },
    { name: 'canonical ALL', value: ['CAP_ALL'], expected: false },
    { name: 'unrelated capability', value: ['CAP_SYS_ADMIN'], expected: false },
    {
      name: 'extra capability',
      value: ['CAP_NET_ADMIN', 'CAP_SYS_ADMIN'],
      expected: false,
    },
    {
      name: 'extra legacy alias',
      value: ['CAP_NET_ADMIN', 'NET_ADMIN'],
      expected: false,
    },
    {
      name: 'extra ALL',
      value: ['CAP_NET_ADMIN', 'ALL'],
      expected: false,
    },
    {
      name: 'duplicate',
      value: ['CAP_NET_ADMIN', 'CAP_NET_ADMIN'],
      expected: false,
    },
    { name: 'wrong case', value: ['cap_net_admin'], expected: false },
    { name: 'padded value', value: [' CAP_NET_ADMIN '], expected: false },
    { name: 'nonstring member', value: [null], expected: false },
  ];

  it.each(cases)('$name', ({ value, expected }) => {
    expect(hasOnlyInstanceAddedCapability(value)).toBe(expected);
  });
});
