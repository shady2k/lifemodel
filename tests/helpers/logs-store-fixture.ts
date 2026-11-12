/**
 * A recorded log-store protocol fixture (ADR-016 §3, L11).
 *
 * The exchange file holds real responses captured from the pinned store after
 * records were written through the collector's insert protocol. The server
 * answers the exact recorded `POST /select/logsql/query` requests and refuses
 * anything else, so a test proves the adapter's request form, not a simulator.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

export interface RecordedExchange {
  request: { method: string; path: string; query: string };
  status: number;
  body: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
}

export interface LogsStoreFixture {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const loaded = new Map<string, RecordedExchange[]>();

/** The exchanges of one recorded fixture file under `tests/fixtures/`. */
function exchangesOf(name: string): RecordedExchange[] {
  const cached = loaded.get(name);
  if (cached !== undefined) return cached;
  const exchanges = (
    JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')) as {
      exchanges: RecordedExchange[];
    }
  ).exchanges;
  loaded.set(name, exchanges);
  return exchanges;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

export async function startLogsStoreFixture(
  name = 'logs-store-protocol.json'
): Promise<LogsStoreFixture> {
  const exchanges = exchangesOf(name);
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const query = new URLSearchParams(body).get('query') ?? '';
      const method = req.method ?? '';
      requests.push({ method, path, query });
      const exchange = exchanges.find(
        (entry) =>
          entry.request.method === method &&
          entry.request.path === path &&
          entry.request.query === query
      );
      if (exchange === undefined) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('the recorded fixture has no such query');
        return;
      }
      res.writeHead(exchange.status, { 'content-type': 'application/stream+json' });
      res.end(exchange.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}
