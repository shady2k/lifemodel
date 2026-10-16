import { describe, expect, it, vi } from 'vitest';
import { createWebOperationsServer, type WebOperationalMetrics } from '../../src/web/operations.js';

const metrics: WebOperationalMetrics = {
  oldestUnappliedOutboundAgeSeconds: 12,
  oldestPendingInboundAgeSeconds: 9,
  intakeFailures: 2,
  sseLag: 3,
  reconnects: 4,
  stateFreshnessSeconds: 5,
};

describe('internal web operations endpoints', () => {
  it('is ready when store operations answer, without consulting core readiness', async () => {
    const checkStores = vi.fn().mockResolvedValue(undefined);
    const server = createWebOperationsServer({ checkStores, readMetrics: async () => metrics });
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });
    expect(checkStores).toHaveBeenCalledOnce();
    await server.close();
  });

  it('is not ready when a store operation fails', async () => {
    const server = createWebOperationsServer({
      checkStores: vi.fn().mockRejectedValue(new Error('Valkey unavailable')),
      readMetrics: async () => metrics,
    });
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false });
    await server.close();
  });

  it('exports all six operational signals in Prometheus format', async () => {
    const server = createWebOperationsServer({
      checkStores: async () => {},
      readMetrics: async () => metrics,
    });
    const response = await server.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    for (const signal of [
      'lifemodel_web_oldest_unapplied_outbound_age_seconds 12',
      'lifemodel_web_oldest_pending_inbound_age_seconds 9',
      'lifemodel_web_intake_failures_total 2',
      'lifemodel_web_sse_lag 3',
      'lifemodel_web_sse_reconnects_total 4',
      'lifemodel_web_state_freshness_seconds 5',
    ])
      expect(response.body).toContain(signal);
    await server.close();
  });
});
