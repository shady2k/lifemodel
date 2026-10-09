/**
 * Child process fixture for the bounded settings close (lifemodel-q4x.4)
 *
 * Controls for the real-process finding.
 *
 *   tsx tests/fixtures/settings-partial-request-child.ts restart
 *     saves through the interface (a save that asks for the restart) while a
 *     HALF-SENT request holds a socket, and leaves with the restart code.
 *
 *   tsx tests/fixtures/settings-partial-request-child.ts sigterm
 *     the same half-sent request, and a signal like the loader's stop instead
 *     of a save. Exits 0.
 *
 * The exit codes ARE the assertion: a close that waited on the half-sent
 * request (fastify's requestTimeout is 0) never ran the exit itself, so the
 * timeout of the test killed the child, or the deadline had to abandon it.
 * Everything is written with writeSync(2, ...): a piped stderr may lose an
 * async write when process.exit follows it.
 */
import { writeSync } from 'node:fs';
import { connect } from 'node:net';

import { armStopDeadlineExit, type ArmedStopDeadlineExit } from '../../src/core/hard-exit.js';
import { createConfigLoader } from '../../src/config/config-loader.js';
import { RESTART_EXIT_CODE } from '../../src/settings/restart.js';
import { createSettingsServer } from '../../src/settings/server.js';
import { createTestLogger } from '../helpers/test-logger.js';

const mode = process.argv[2];

function raw(endpoint: { address(): string }, body: string): Promise<void> {
  const port = Number(endpoint.address().slice(endpoint.address().lastIndexOf(':') + 1));
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(body);
      // The body's remainder NEVER arrives, and the socket stays OPEN.
      resolve();
    });
    socket.on('error', reject);
  });
}

async function main(): Promise<void> {
  const logger = createTestLogger('silent');
  const server = createSettingsServer({
    config: createConfigLoader('data/config'),
    logger,
    port: 0,
    closeGraceMs: 400,
    onSaved: () => undefined,
  });
  await server.listen();

  // One socket holds a POST with a Content-Length and a partial body.
  await raw(
    server,
    'POST /settings HTTP/1.1\r\nHost: localhost:8080\r\n' +
      'Content-Type: application/x-www-form-urlencoded\r\n' +
      'Content-Length: 10000\r\n\r\nx='
  );
  writeSync(2, 'HOLD-OPEN\n');

  const armed: ArmedStopDeadlineExit = armStopDeadlineExit({
    logger,
    budgetMs: 5_000,
    pending: () => ({ step: 'settings_close' }),
  });

  const leave = async (code: number): Promise<void> => {
    // The order src/index.ts uses (the review's finding was the OLD order,
    // which waited here BEFORE arming the deadline above).
    await server.close();
    armed.disarm();
    writeSync(2, `CLOSED-BOUNDED\n`);
    process.exit(code);
  };

  if (mode === 'restart') {
    void leave(RESTART_EXIT_CODE);
    return;
  }
  if (mode === 'sigterm') {
    process.on('SIGTERM', () => {
      void leave(0);
    });
    return;
  }
  throw new Error(`unknown mode: ${mode ?? '(none)'}`);
}

void main();
