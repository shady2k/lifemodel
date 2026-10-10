import { describe, expect, it } from 'vitest';
import type {
  JourneyEvent,
} from '../integration/helpers/instance-journey-fixture.js';
import {
  hasAuthenticatedTelegramRequest,
} from '../integration/helpers/instance-telegram-correlation.js';

type Response = Parameters<typeof hasAuthenticatedTelegramRequest>[1];
type Method = Parameters<typeof hasAuthenticatedTelegramRequest>[2];

const request: JourneyEvent = {
  event: 'telegram.request',
  seq: 10,
  requestId: 1,
  method: 'getUpdates',
  actualHost: 'api.telegram.org',
  tokenMatch: true,
};

const response: Response = { requestId: 1, seq: 30 };

function fullJournal(
  records: readonly JourneyEvent[],
): readonly JourneyEvent[] {
  return [
    { event: 'fixture.ready', seq: 1 },
    {
      event: 'telegram.request',
      seq: 2,
      requestId: 99,
      method: 'sendMessage',
      actualHost: '127.0.0.1',
      tokenMatch: false,
    },
    // Bad duplicate auth records for another ID must not affect ID 1.
    {
      event: 'telegram.request',
      seq: 3,
      requestId: 99,
      method: 'getUpdates',
      actualHost: 'private.local',
      tokenMatch: false,
    },
    ...records,
    { event: 'model.request', seq: 25, requestId: 100 },
    { event: 'telegram.poll.response', ...response },
    { event: 'fixture.control', seq: 40 },
  ];
}

interface Case {
  name: string;
  records: readonly JourneyEvent[];
  response?: Response;
  method?: Method;
  expected: boolean;
}

const cases: Case[] = [
  {
    name: 'valid request before the response',
    records: [request],
    expected: true,
  },
  {
    name: 'exact production host with port 443',
    records: [{ ...request, actualHost: 'api.telegram.org:443' }],
    expected: true,
  },
  {
    name: 'valid sendMessage request',
    records: [{ ...request, method: 'sendMessage' }],
    method: 'sendMessage',
    expected: true,
  },
  {
    name: 'missing request record',
    records: [],
    expected: false,
  },
  {
    name: 'different request ID',
    records: [{ ...request, requestId: 2 }],
    expected: false,
  },
  {
    name: 'duplicate valid auth records',
    records: [request, { ...request, seq: 11 }],
    expected: false,
  },
  {
    name: 'valid and bad auth records share an ID',
    records: [
      request,
      { ...request, seq: 11, tokenMatch: false },
    ],
    expected: false,
  },
  {
    name: 'two bad auth records share an ID',
    records: [
      { ...request, tokenMatch: false },
      { ...request, seq: 11, actualHost: 'private.local' },
    ],
    expected: false,
  },
  {
    name: 'non-request event does not duplicate an auth record',
    records: [
      request,
      { event: 'telegram.poll.request', seq: 11, requestId: 1 },
    ],
    expected: true,
  },
  {
    name: 'non-request event cannot supply authentication',
    records: [{ ...request, event: 'telegram.poll.request' }],
    expected: false,
  },
  {
    name: 'wrong method',
    records: [{ ...request, method: 'sendMessage' }],
    expected: false,
  },
  {
    name: 'missing method',
    records: [{ ...request, method: undefined }],
    expected: false,
  },
  {
    name: 'false token match',
    records: [{ ...request, tokenMatch: false }],
    expected: false,
  },
  {
    name: 'missing token match',
    records: [{ ...request, tokenMatch: undefined }],
    expected: false,
  },
  {
    name: 'truthy token match is not true',
    records: [{ ...request, tokenMatch: 'true' }],
    expected: false,
  },
  {
    name: 'request at response sequence',
    records: [{ ...request, seq: 30 }],
    expected: false,
  },
  {
    name: 'request after response',
    records: [{ ...request, seq: 31 }],
    expected: false,
  },
  {
    name: 'missing request ID',
    records: [{ ...request, requestId: undefined }],
    expected: false,
  },
];

const badNumbers: readonly unknown[] = [
  undefined, 0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, true,
];

for (const value of badNumbers) {
  const label = String(value);
  cases.push(
    {
      name: `invalid response requestId: ${label}`,
      records: [request],
      response: { ...response, requestId: value } as Response,
      expected: false,
    },
    {
      name: `invalid response seq: ${label}`,
      records: [request],
      response: { ...response, seq: value } as Response,
      expected: false,
    },
    {
      name: `invalid request requestId: ${label}`,
      records: [{ ...request, requestId: value } as JourneyEvent],
      expected: false,
    },
    {
      name: `invalid request seq: ${label}`,
      records: [{ ...request, seq: value } as JourneyEvent],
      expected: false,
    },
  );
}

const badHosts: readonly unknown[] = [
  undefined,
  null,
  123,
  { toString: () => 'api.telegram.org' },
  '127.0.0.1',
  '10.0.0.1',
  'private.local',
  'q4x32-stub.local',
  'portal-model.local',
  'http://api.telegram.org',
  'https://api.telegram.org',
  'api.telegram.org:80',
  'api.telegram.org:444',
  'api.telegram.org:0443',
  'api.telegram.org.evil',
  'evil-api.telegram.org',
  'API.TELEGRAM.ORG',
  'api.telegram.org.',
  ' api.telegram.org',
  'api.telegram.org ',
  'api.telegram.org/path',
  'api.telegram.org\n',
  'api.telegram.org\r',
  'api.telegram.org\r\n',
  'api.telegram.org\u2028',
  'api.telegram.org\u2029',
  'api.telegram.org:443\n',
  'api.telegram.org:443\r\n',
];

for (const actualHost of badHosts) {
  cases.push({
    name: `invalid actualHost: ${String(actualHost)}`,
    records: [{ ...request, actualHost }],
    expected: false,
  });
}

describe('hasAuthenticatedTelegramRequest', () => {
  it.each(cases)('$name', ({
    records,
    response: candidate = response,
    method = 'getUpdates',
    expected,
  }) => {
    expect(hasAuthenticatedTelegramRequest(
      fullJournal(records),
      candidate,
      method,
    )).toBe(expected);
  });

  it('correlates a cross-boundary poll and a same-window send', () => {
    const since = 20;
    const delivered: JourneyEvent = {
      event: 'telegram.poll.response',
      seq: 30,
      requestId: 1,
      updateIds: [220004],
    };
    const sent: JourneyEvent = {
      event: 'telegram.send.request',
      seq: 33,
      requestId: 2,
      phase: 'q4x22-recreate',
      chatMatch: true,
      text: 'fixture recreate answer',
    };

    const journal: readonly JourneyEvent[] = [
      { event: 'fixture.ready', seq: 1 },
      request, // seq 10: before since, but causally before delivery.
      { event: 'fixture.control', seq: since },
      { event: 'model.request', seq: 25, requestId: 3 },
      delivered,
      {
        event: 'telegram.request',
        seq: 32,
        requestId: 2,
        method: 'sendMessage',
        tokenMatch: true,
        actualHost: 'api.telegram.org:443',
      },
      sent,
      {
        event: 'telegram.send.ack',
        seq: 34,
        requestId: 2,
        phase: 'q4x22-recreate',
      },
    ];

    const events = journal.filter(event => event.seq > since);
    expect(events.includes(delivered)).toBe(true);
    expect(events.includes(sent)).toBe(true);
    expect(events.includes(request)).toBe(false);

    expect(hasAuthenticatedTelegramRequest(
      journal, delivered, 'getUpdates',
    )).toBe(true);
    expect(hasAuthenticatedTelegramRequest(
      journal, sent, 'sendMessage',
    )).toBe(true);
  });

  it.each([5, 10, 20])('keeps a fresh response when since=%s is before/equal/after its request', (since) => {
    const delivered: JourneyEvent = { event: 'telegram.poll.response', ...response };
    const journal: readonly JourneyEvent[] = [request, delivered];
    const fresh = journal.filter(event => event.seq > since);
    expect(fresh.includes(delivered)).toBe(true);
    expect(hasAuthenticatedTelegramRequest(journal, delivered, 'getUpdates')).toBe(true);
  });

  it.each([19, 20])('does not use correlation to admit a response at/before since: seq=%s', (seq) => {
    const since = 20;
    const delivered: JourneyEvent = { event: 'telegram.poll.response', ...response, seq };
    const journal: readonly JourneyEvent[] = [request, delivered];
    // The caller's unchanged strict fresh-event window remains separate.
    const fresh = journal.filter(event => event.seq > since);
    expect(fresh.includes(delivered)).toBe(false);
    // Correlation alone is not a license to select an old response.
    expect(hasAuthenticatedTelegramRequest(journal, delivered, 'getUpdates')).toBe(true);
  });

  it('does not mutate a frozen journal or its records', () => {
    const journal = Object.freeze([
      Object.freeze({ ...request }),
      Object.freeze({ event: 'fixture.control', seq: 20 }),
    ]);
    const candidate = Object.freeze({ ...response });

    expect(hasAuthenticatedTelegramRequest(
      journal, candidate, 'getUpdates',
    )).toBe(true);
    expect(journal).toEqual([
      request,
      { event: 'fixture.control', seq: 20 },
    ]);
  });
});
