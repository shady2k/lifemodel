import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createModelGateway } from '../../loader/src/model-gateway-app.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { ModelSlot, ModelSlotName } from '../../loader/src/model.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  const host = Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === 'IPv4' && !a.internal)?.address;
  if (!address || typeof address === 'string' || !host) throw new Error('no listener');
  return `http://${host}:${address.port}`;
}
async function fixture(statuses: number[], bodies: unknown[] = [], session?: string) {
  const attempts: string[] = [];
  const slots = new Map<ModelSlotName, ModelSlot>();
  for (const [index, status] of statuses.entries()) {
    const name = index === 0 ? 'primary' : 'reserve';
    const baseUrl = await listen(
      createServer((req, res) => {
        req.resume();
        attempts.push(name);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            bodies[index] ??
              (status === 200
                ? {
                    model: 'test',
                    choices: [
                      {
                        index: 0,
                        message: { role: 'assistant', content: 'OK' },
                        finish_reason: 'stop',
                      },
                    ],
                  }
                : { error: { message: 'upstream failure' } })
          )
        );
      })
    );
    slots.set(name, {
      kind: 'openai',
      baseUrl,
      model: 'test',
      key: 'test-key',
    });
  }
  const lines: RecordedLine[] = [];
  const app = createModelGateway({
    logger: createRecordingLogger(lines),
    slots: {
      async read(name: ModelSlotName) {
        return slots.has(name)
          ? { state: 'present' as const, slot: slots.get(name)!, version: 1 }
          : { state: 'absent' as const };
      },
      async identity() {
        return 'absent';
      },
      invalidate() {},
      keys: () => ['test-key'],
    },
  });
  const url = await listen(app.api);
  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(session ? { 'x-lifemodel-session': session } : {}),
      },
      body: JSON.stringify({ model: 'default', messages: [] }),
    });
    return {
      status: response.status,
      body: await response.json(),
      lines,
      attempts,
    };
  } finally {
    app.close();
  }
}
const gatewayLines = (lines: RecordedLine[]) =>
  lines.filter((line) => line.message.startsWith('Model gateway '));
describe('gateway final outcome and body isolation (ADR-016 L03/L04)', () => {
  it.each([
    {
      statuses: [500],
      levels: ['error'],
      attempts: ['primary'],
      code: 'upstream_500',
    },
    {
      statuses: [400, 200],
      levels: ['error'],
      attempts: ['primary'],
      code: 'upstream_400',
    },
    {
      statuses: [500, 200],
      levels: ['warn'],
      attempts: ['primary', 'reserve'],
      code: undefined,
    },
    {
      statuses: [500, 500],
      levels: ['warn', 'error'],
      attempts: ['primary', 'reserve'],
      code: 'upstream_500',
    },
    { statuses: [200], levels: [], attempts: ['primary'], code: undefined },
  ])('records the final outcome for $statuses', async ({ statuses, levels, attempts, code }) => {
    const result = await fixture(statuses, [], 'conv_gateway');
    const records = gatewayLines(result.lines);
    expect(records.map((line) => line.level)).toEqual(levels);
    expect(result.attempts).toEqual(attempts);
    expect(result.status).toBe(code ? (code === 'upstream_400' ? 400 : 502) : 200);
    if (code) {
      expect(records.at(-1)).toMatchObject({
        level: 'error',
        message: 'Model gateway request failed',
        fields: { error_type: code, conversation_id: 'conv_gateway' },
      });
      expect(result.body).toEqual({ error: { type: 'gateway_error', code } });
    }
    if (levels.includes('warn'))
      expect(records[0]).toMatchObject({
        level: 'warn',
        fields: {
          error_type: 'upstream_500',
          conversation_id: 'conv_gateway',
        },
      });
  });
  it.each([false, true])('never emits response text for refused 2xx=%s', async (refused) => {
    const marker = refused
      ? '0123456789abcdef0123456789abcdef'
      : 'abcdef0123456789abcdef0123456789';
    const body = refused ? { model: marker, choices: marker } : { error: { message: marker } };
    const result = await fixture([refused ? 200 : 500], [body]);
    const code = refused ? 'bad_response' : 'upstream_500';
    expect(result.body).toEqual({ error: { type: 'gateway_error', code } });
    expect(result.body.error).not.toHaveProperty('message');
    expect(JSON.stringify(result.lines)).not.toContain(marker);
    expect(JSON.stringify(result.body)).not.toContain(marker);
    const final = gatewayLines(result.lines).at(-1)!;
    expect(final).toMatchObject({
      level: 'error',
      fields: { error_type: code },
    });
    expect(final.fields).not.toHaveProperty('conversation_id');
    if (refused)
      expect(final.fields.reason).toEqual({
        check: 'choices_type',
        path: 'choices',
        got: 'string',
      });
  });
});
