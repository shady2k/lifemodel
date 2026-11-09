#!/usr/bin/env node
/**
 * The logs page's paging protocol against the pinned store (ADR-016 §4, L15).
 *
 * The isolated test boundary has no Docker socket and no pinned log store, so
 * this check cannot run inside it. Run it on the host, under the shared lock so
 * it does not compete for memory with a launcher run:
 *
 *   flock /work/check.lock node scripts/check-logs-paging.mjs
 *   flock /work/check.lock node scripts/check-logs-paging.mjs --record
 *
 * It starts the digest-pinned VictoriaLogs image, writes 5,000 records at one
 * timestamp and 300 byte-identical lines at another through the collector's
 * insert protocol, and pages the window in 250-record pages through the
 * loader's own query code (`loader/src/logs-query.ts`, resolved from source).
 * It asserts: a quiet window pages to its end with every record exactly once,
 * the same page read twice returns the same bytes, and one record inserted
 * inside the window makes the next page incomplete.
 *
 * `--record` also writes what the store answered: the two paging fixture files
 * the suite replays inside the boundary (`logs-paging-quiet.json`, the window
 * before the insert; `logs-paging-late.json`, the same window after it), and
 * the window-count answer each record query of the older fixture files needs
 * for a page's count query.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const IMAGE =
  'docker.io/victoriametrics/victoria-logs@sha256:251121fa882af99b95ba0c230a4a2f412ea602d2698c64a96c58dc9842bb755d';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures');
const record = process.argv.includes('--record');

const T1 = '2026-11-07T10:00:00.000Z';
const T2 = '2026-11-07T10:30:00.000Z';
const FROM = '2026-11-07T09:00:00.000Z';
const TO = '2026-11-07T11:00:00.000Z';
const BULK = 5000;
const IDENTICAL = 300;
const PAGE = 250;
const LATE = 'zzzz late arrival';
const WINDOW = { from: Date.parse(FROM), to: Date.parse(TO) };
const QUERY_PATH = '/select/logsql/query';
const INSERT_PATH = '/insert/jsonline?_stream_fields=module&_msg_field=message&_time_field=timestamp';

let failures = 0;

function check(ok, name, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail === '' ? '' : ` - ${detail}`}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === '' ? '' : ` - ${detail}`}`);
  }
  return ok;
}

function note(text) {
  console.log(`NOTE ${text}`);
}

function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout ?? '';
}

/** One pinned store with an empty data directory of its own. */
async function startStore() {
  const directory = mkdtempSync(join(tmpdir(), 'lifemodel-logs-paging-'));
  const name = `lifemodel-logs-paging-${String(process.pid)}`;
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::9428',
    '-v',
    `${directory}:/data`,
    IMAGE,
    '-storageDataPath=/data',
    '-httpListenAddr=:9428',
  ]);
  const published = docker(['port', name, '9428/tcp']).trim().split('\n')[0] ?? '';
  const port = published.slice(published.lastIndexOf(':') + 1);
  if (port === '') throw new Error(`the store published no port: ${published}`);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) return { name, directory, base };
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error('the store did not answer /health');
}

function stopStore(store) {
  spawnSync('docker', ['rm', '-f', store.name], { encoding: 'utf8' });
  rmSync(store.directory, { recursive: true, force: true });
}

async function insert(store, records) {
  const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const answer = await fetch(`${store.base}${INSERT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/stream+json' },
    body,
  });
  if (!answer.ok) throw new Error(`insert answered ${answer.status}: ${await answer.text()}`);
  await answer.text();
}

async function raw(store, logsql) {
  const answer = await fetch(`${store.base}${QUERY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: logsql }).toString(),
  });
  if (!answer.ok) throw new Error(`query answered ${answer.status}: ${await answer.text()}`);
  return { body: await answer.text() };
}

/** The store's own answer to a count query, as the adapter reads it. */
async function count(store, filter) {
  const answer = await raw(store, `${filter} | stats count()`);
  const line = answer.body.split('\n').find((candidate) => candidate.trim() !== '');
  const value = JSON.parse(line ?? '{}');
  return Number(value['count(*)']);
}

/**
 * The store buffers inserts for about a second, so a read that follows a write
 * waits for the count it expects instead of racing the flush.
 */
async function waitFor(store, filter, expected) {
  let total = await count(store, filter);
  for (let attempt = 0; attempt < 100 && total !== expected; attempt += 1) {
    await sleep(200);
    total = await count(store, filter);
  }
  return total;
}

/**
 * The paging fixture's records: the fields the page's order and identity need,
 * written through the collector's insert protocol. The recorded answers carry
 * every field the store keeps, so a page's bytes are the store's own.
 */
function bulkRecord(index) {
  return {
    timestamp: T1,
    message: `bulk ${String(index).padStart(5, '0')}`,
    module: 'bulk',
    pod: 'bulk-0',
    stream: 'stdout',
  };
}

const IDENTICAL_RECORD = {
  timestamp: T2,
  message: 'identical line',
  module: 'ident',
  pod: 'ident-0',
  stream: 'stdout',
};

function dataset() {
  return [
    ...Array.from({ length: BULK }, (_, index) => bulkRecord(index)),
    ...Array.from({ length: IDENTICAL }, () => IDENTICAL_RECORD),
  ];
}

/** The loader's own paging code, resolved from its TypeScript source. */
async function loadLoader() {
  const hook = join(mkdtempSync(join(tmpdir(), 'lifemodel-logs-hook-')), 'resolve.mjs');
  writeFileSync(
    hook,
    [
      "import { existsSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      'export async function resolve(specifier, context, next) {',
      "  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {",
      "    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);",
      '    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);',
      '  }',
      '  return next(specifier, context);',
      '}',
      '',
    ].join('\n')
  );
  register(pathToFileURL(hook).href, import.meta.url);
  const query = await import(pathToFileURL(join(root, 'loader', 'src', 'logs-query.ts')).href);
  const adapter = await import(pathToFileURL(join(root, 'loader', 'src', 'logs-store-adapter.ts')).href);
  rmSync(dirname(hook), { recursive: true, force: true });
  return { query, adapter };
}

/** A store that remembers every query it was asked, for the fixture. */
function watched(store, queries) {
  return {
    query: (logsql) => {
      queries.push(logsql);
      return store.query(logsql);
    },
    count: (logsql) => {
      queries.push(logsql);
      return store.count(logsql);
    },
    modules: () => store.modules(),
  };
}

function identity(record) {
  return [
    record.time,
    record.message,
    record.fields?.pod ?? '',
    record.fields?.stream ?? '',
  ].join('\u0000');
}

function counted(records) {
  const counts = new Map();
  for (const record of records) {
    const key = identity(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function expectedWindow() {
  const counts = new Map();
  for (let index = 0; index < BULK; index += 1) {
    counts.set(
      `2026-11-07T10:00:00Z\u0000bulk ${String(index).padStart(5, '0')}\u0000bulk-0\u0000stdout`,
      1
    );
  }
  counts.set(`2026-11-07T10:30:00Z\u0000identical line\u0000ident-0\u0000stdout`, IDENTICAL);
  return counts;
}

function same(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** Pages the quiet window to its end and returns every page and store query. */
async function walk(logs, queries) {
  const pages = [];
  let expected = null;
  for (let offset = 0; ; offset += PAGE) {
    const page = await logs.page({ filter: WINDOW, offset, limit: PAGE, expected });
    if (page.state !== 'ok') throw new Error(`page ${String(offset)}: ${page.reason}`);
    pages.push(page);
    expected = page.count;
    if (page.records.length < PAGE) return pages;
  }
}

function recorded(exchanges, description) {
  return `${JSON.stringify(
    {
      description,
      capturedFrom: `${IMAGE} (v1.53.0), captured ${new Date().toISOString().slice(0, 10)}`,
      exchanges,
    },
    null,
    2
  )}\n`;
}

/** Every query the walk issued, answered once more verbatim, for the fixture. */
async function exchangesOf(store, queries) {
  const exchanges = [];
  const seen = new Set();
  for (const logsql of queries) {
    if (seen.has(logsql)) continue;
    seen.add(logsql);
    const answer = await raw(store, logsql);
    exchanges.push({
      request: { method: 'POST', path: QUERY_PATH, query: logsql },
      status: 200,
      body: answer.body,
    });
  }
  return exchanges;
}

async function quietCase({ query, adapter }) {
  console.log(`--- the quiet window: ${String(BULK)} records at ${T1}, ${String(IDENTICAL)} identical at ${T2}`);
  const store = await startStore();
  const queries = [];
  try {
    await insert(store, dataset());
    const total = await waitFor(store, `_time:[${FROM}, ${TO}]`, BULK + IDENTICAL);
    check(total === BULK + IDENTICAL, 'the store holds the whole window', `${String(total)} records`);

    const logs = query.createLogsQuery({
      store: watched(adapter.createLogsStore({ url: store.base }), queries),
    });
    const pages = await walk(logs, queries);
    const walkLength = queries.length;
    const all = pages.flatMap((page) => page.records);
    check(
      pages.length === Math.ceil((BULK + IDENTICAL) / PAGE),
      'the quiet window pages to its end',
      `${String(pages.length)} pages of ${String(PAGE)}`
    );
    check(all.length === BULK + IDENTICAL, 'every page is full but the last', `${String(all.length)} records`);
    check(
      pages.every((page) => page.count === BULK + IDENTICAL && !page.incomplete),
      'a quiet page never says its answer is incomplete'
    );
    check(
      same(counted(all), expectedWindow()),
      'every record exactly once: no repeat and no skip'
    );

    const first = await logs.page({ filter: WINDOW, offset: 2 * PAGE, limit: PAGE, expected: BULK + IDENTICAL });
    const second = await logs.page({ filter: WINDOW, offset: 2 * PAGE, limit: PAGE, expected: BULK + IDENTICAL });
    check(
      JSON.stringify(first) === JSON.stringify(second),
      'the same page read twice returns the same bytes'
    );

    const walked = queries.slice(0, walkLength);
    const offsetOf = (logsql) => {
      const match = /\| offset (\d+) \| limit (\d+)$/.exec(logsql);
      return match === null ? null : Number(match[1]);
    };
    const reads = walked.filter((logsql) =>
      logsql.includes('| sort by (_time desc, _msg desc, pod desc) |')
    );
    const boundary = walked.filter((logsql) => logsql.includes('| sort by (_time desc) |'));
    check(
      reads.map(offsetOf).every((offset, index) => offset === index * PAGE),
      'each page was read at its own offset, in order',
      `${String(reads.length)} ordered reads`
    );
    check(
      boundary.every((logsql, index) => offsetOf(logsql) === (index + 1) * PAGE - 1) &&
        boundary.every((logsql) => logsql.endsWith('| limit 1')),
      'each page was found by the record at its last position, by time alone',
      `${String(boundary.length)} boundary reads`
    );
    check(
      walked.every((logsql) => logsql.startsWith('_time:[') && logsql.includes(`, ${TO}]`)),
      'the window end stayed at the first page'
    );
    check(
      walked.filter((logsql) => logsql.endsWith('| stats count()')).length === pages.length,
      'every page re-read the window count with one query'
    );
    const boundaryTimes = await Promise.all(
      boundary.map(async (logsql) => {
        const answer = await raw(store, logsql);
        const line = answer.body.split('\n').find((candidate) => candidate.trim() !== '');
        return line === undefined ? null : JSON.parse(line)._time;
      })
    );
    check(
      reads
        .slice(0, -1)
        .every((logsql, index) => logsql.startsWith(`_time:[${boundaryTimes[index]}, `)),
      'each ordered read starts at the time its boundary answered'
    );

    if (record) {
      const exchanges = await exchangesOf(store, [
        `${`_time:[${FROM}, ${TO}]`} | stats count()`,
        ...queries.filter((logsql) => logsql.includes('| sort by ')),
      ]);
      writeFileSync(
        join(fixtures, 'logs-paging-quiet.json'),
        recorded(
          exchanges,
          'Recorded VictoriaLogs answers for the loader log paging protocol (ADR-016 §4, L15): 5,000 records at one timestamp and 300 byte-identical lines at another, across every 250-record page of the window. Recorded by scripts/check-logs-paging.mjs --record; responses were captured verbatim.'
        )
      );
      note('wrote tests/fixtures/logs-paging-quiet.json');
    }
  } finally {
    stopStore(store);
  }
}

async function lateCase({ query, adapter }) {
  console.log(`--- one late record arrives in the same window`);
  const store = await startStore();
  const queries = [];
  try {
    await insert(store, dataset());
    const quiet = await waitFor(store, `_time:[${FROM}, ${TO}]`, BULK + IDENTICAL);
    check(quiet === BULK + IDENTICAL, 'the store holds the quiet window', `${String(quiet)} records`);
    const logs = query.createLogsQuery({
      store: watched(adapter.createLogsStore({ url: store.base }), queries),
    });
    const first = await logs.page({ filter: WINDOW, offset: 0, limit: PAGE, expected: null });
    if (first.state !== 'ok') throw new Error(first.reason);
    check(first.count === BULK + IDENTICAL, 'the first page read the quiet window', `${String(first.count)} records`);

    await insert(store, [{ ...IDENTICAL_RECORD, message: LATE }]);
    const total = await waitFor(store, `_time:[${FROM}, ${TO}]`, BULK + IDENTICAL + 1);
    check(total === BULK + IDENTICAL + 1, 'the late record is inside the window', `${String(total)} records`);

    const next = await logs.page({ filter: WINDOW, offset: PAGE, limit: PAGE, expected: first.count });
    if (next.state !== 'ok') throw new Error(next.reason);
    check(next.incomplete, 'the next page is marked incomplete');
    check(next.count === BULK + IDENTICAL + 1, 'the next page carries the window count it found', `${String(next.count)}`);

    const read = [...first.records, ...next.records];
    const identical = counted(read).get(`2026-11-07T10:30:00Z\u0000identical line\u0000ident-0\u0000stdout`);
    check(
      identical === IDENTICAL + 1,
      'the offset moved: one record of the first page was read twice',
      `${String(identical ?? 0)} identical rows, ${String(IDENTICAL)} stored`
    );
    check(
      read.every((record) => record.message !== LATE),
      'the record that arrived is on neither page already read'
    );

    const refreshed = await logs.page({ filter: WINDOW, offset: 0, limit: PAGE, expected: null });
    if (refreshed.state !== 'ok') throw new Error(refreshed.reason);
    check(
      refreshed.count === BULK + IDENTICAL + 1 && refreshed.records[0]?.message === LATE,
      'the refresh from the first page shows the arrival'
    );

    if (record) {
      const exchanges = await exchangesOf(store, [
        // The quiet count is the one the reader held when it read page one.
        `${`_time:[${FROM}, ${TO}]`} | stats count()`,
        ...queries.filter((logsql) => logsql.includes('| sort by ')),
      ]);
      writeFileSync(
        join(fixtures, 'logs-paging-late.json'),
        recorded(
          exchanges,
          'Recorded VictoriaLogs answers for the same log window after one record arrived inside it (ADR-016 §4, L15), including the count query answer that marks the next page incomplete. Recorded by scripts/check-logs-paging.mjs --record; responses were captured verbatim.'
        )
      );
      note('wrote tests/fixtures/logs-paging-late.json');
    }
    return { queries };
  } finally {
    stopStore(store);
  }
}

/**
 * The older fixture files answer pages too, so each of their record queries
 * needs the store's answer to the matching count query. Those answers are
 * recorded here, from a store holding exactly the records the file shows.
 */
async function recordCounts(file) {
  const path = join(fixtures, file);
  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  const isRecordQuery = (query) => query.includes('| sort by ');
  const countQueryOf = (query) => `${query.replace(/ \| sort by .*$/u, '')} | stats count()`;
  const seeds = new Map();
  for (const exchange of fixture.exchanges) {
    if (!isRecordQuery(exchange.request.query)) continue;
    for (const line of exchange.body.split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line);
      const seed = { timestamp: record._time, message: record._msg };
      for (const [field, value] of Object.entries(record)) {
        if (field.startsWith('_')) continue;
        seed[field] = value;
      }
      seeds.set(JSON.stringify(seed), seed);
    }
  }
  const store = await startStore();
  try {
    const all = [...seeds.values()];
    await insert(store, all);
    const stored = await waitFor(store, '*', all.length);
    check(stored === all.length, `${file}: the store holds the fixture's records`, `${String(stored)}`);

    const countExchanges = [];
    for (const exchange of fixture.exchanges) {
      const query = exchange.request.query;
      if (!isRecordQuery(query)) continue;
      const rows = exchange.body.split('\n').filter((line) => line.trim() !== '').length;
      const observed = await count(store, query.replace(/ \| sort by .*$/u, ''));
      if (
        !check(
          observed === rows,
          `${file}: the count matches the recorded answer`,
          `${String(observed)} = ${String(rows)}`
        )
      )
        continue;
      const countQuery = countQueryOf(query);
      const answer = await raw(store, countQuery);
      countExchanges.push({
        request: { method: 'POST', path: QUERY_PATH, query: countQuery },
        status: 200,
        body: answer.body,
      });
    }

    const kept = fixture.exchanges.filter(
      (exchange) => !countExchanges.some((added) => added.request.query === exchange.request.query)
    );
    const written = {
      ...fixture,
      description:
        fixture.description.split(' The window-count answer')[0] +
        ' The window-count answer of each record query was captured the same way, from a store holding these records. Recorded by scripts/check-logs-paging.mjs --record.',
      exchanges: [...kept, ...countExchanges],
    };
    if (record) {
      writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
      note(`wrote tests/fixtures/${file}`);
    }
  } finally {
    stopStore(store);
  }
}

async function main() {
  const loader = await loadLoader();
  await quietCase(loader);
  await lateCase(loader);
  for (const file of ['logs-store-protocol.json', 'logs-store-filters.json']) {
    await recordCounts(file);
  }

  if (failures > 0) {
    console.log(`${String(failures)} check(s) failed`);
    return 1;
  }
  console.log('all checks passed');
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`logs paging check: ${error.message}`);
  process.exitCode = 2;
}
