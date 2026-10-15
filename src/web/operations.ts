import Fastify, { type FastifyInstance } from 'fastify';

export interface WebOperationalMetrics {
  oldestUnappliedOutboundAgeSeconds: number;
  oldestPendingInboundAgeSeconds: number;
  intakeFailures: number;
  sseLag: number;
  reconnects: number;
  stateFreshnessSeconds: number;
}

export interface WebOperationsServerOptions {
  checkStores(): Promise<void>;
  readMetrics(): Promise<WebOperationalMetrics>;
}

const METRIC_NAMES: [keyof WebOperationalMetrics, string, string][] = [
  [
    'oldestUnappliedOutboundAgeSeconds',
    'lifemodel_web_oldest_unapplied_outbound_age_seconds',
    'Oldest unapplied outbound event age in seconds.',
  ],
  [
    'oldestPendingInboundAgeSeconds',
    'lifemodel_web_oldest_pending_inbound_age_seconds',
    'Oldest pending inbound message age in seconds.',
  ],
  ['intakeFailures', 'lifemodel_web_intake_failures_total', 'Owner message intake failures.'],
  ['sseLag', 'lifemodel_web_sse_lag', 'Latest transcript sequence distance behind the SSE client.'],
  [
    'reconnects',
    'lifemodel_web_sse_reconnects_total',
    'SSE reconnect requests observed by this instance.',
  ],
  [
    'stateFreshnessSeconds',
    'lifemodel_web_state_freshness_seconds',
    'Age of the last creature state publication in seconds.',
  ],
];

export function createWebOperationsServer(options: WebOperationsServerOptions): FastifyInstance {
  const server = Fastify();
  server.get('/readyz', async (_request, reply) => {
    try {
      await options.checkStores();
      return await reply.code(200).send({ ready: true });
    } catch {
      return await reply.code(503).send({ ready: false });
    }
  });
  server.get('/metrics', async (_request, reply) => {
    const metrics = await options.readMetrics();
    const body = METRIC_NAMES.map(
      ([key, name, help]) =>
        `# HELP ${name} ${help}\n# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}\n${name} ${String(metrics[key])}`
    ).join('\n');
    return await reply.type('text/plain; version=0.0.4; charset=utf-8').send(`${body}\n`);
  });
  return server;
}
