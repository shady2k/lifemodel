/**
 * Child process fixture driving the REAL entry point's stop coordinator
 * (lifemodel-q4x.4.1, review round 2 finding I).
 *
 * The earlier fixture (settings-partial-request-child.ts) re-typed the stop
 * order into its own `leave` function: a mutation in src/index.ts could not
 * touch it, so its exit code proved nothing about the entry point. THIS child
 * imports the entry point itself (autostart disabled for the import), binds a
 * CONTROLLED boundary double through the product's own `boundStopContainer`,
 * and starts the interface through the product's own
 * `startSettingsInterface`: an ACTUAL successful POST then runs the real
 * `restartAfterSettingsSaved` -> `stopAndLeave` -> `runStopSequence` path.
 *
 *   tsx tests/fixtures/settings-entrypoint-child.ts restart-grace
 *     a successful POST saves the config; the coordinator stops (close, then
 *     the controlled drain) and leaves with the loader's restart code 75.
 *
 *   tsx tests/fixtures/settings-entrypoint-child.ts restart-abandoned
 *     the same successful save with a half-sent request holding a socket and
 *     a drain that never ends: the stop deadline the coordinator ARMED FIRST
 *     abandons the stop (exit 1, one deadline error line) - the bounded stop.
 *
 *   tsx tests/fixtures/settings-entrypoint-child.ts sigterm
 *     the half-sent request and a signal like the loader's stop: drained,
 *     exit 0.
 *
 * Markers, written with writeSync(2) (a piped stderr may lose an async write
 * before process.exit):
 *   HELD-SOCKET-RECEIVED  the server RECEIVED the half-sent request (a
 *                         server-side event, not a fixed sleep)
 *   SAVED-200             the real POST answered 200
 *   DEADLINE-EXERCISED    the stop did not finish (the parent asserts the
 *                         deadline's own error line from the same logger)
 *   DRAIN-DONE            the controlled boundary's shutdown ran, AFTER close
 */
import { writeSync } from 'node:fs';
import { connect } from 'node:net';
import { request } from 'node:http';

import {
  boundStopContainer,
  startSettingsInterface,
  type SettingsServer,
} from '../../src/index.js';
import type { Container, StopStep } from '../../src/core/container.js';
import { createTestLogger } from '../helpers/test-logger.js';

const mode = process.argv[2];
if (mode !== 'restart-grace' && mode !== 'restart-abandoned' && mode !== 'sigterm') {
  throw new Error(`usage: settings-entrypoint-child.ts restart-grace|restart-abandoned|sigterm`);
}

const DRAIN_BUDGET_MS = 3_000;
const CLOSE_GRACE_MS = 400;
const HALF_SENT_BODY_LENGTH = 10_000;

const say = (line: string): void => {
  writeSync(2, `${line}\n`);
};

let drainStarted = false;

/** The controlled turn/send/storage boundary: what the stop must drain. */
const boundary: Container = {
  logger: createTestLogger('error'),
  coreLoop: {
    getStopDrainTimeoutMs: (): number => DRAIN_BUDGET_MS,
    stopReport: () => ({
      loopStopped: true,
      tickInFlight: false,
      schedulerInFlight: false,
      turnInFlight: false,
      sendsOutstanding: 0,
      queuedSignals: 0,
    }),
  },
  stopProgress: (): StopStep => 'intake_stop',
  shutdown:
    mode === 'restart-abandoned'
      ? async (): Promise<void> => {
          drainStarted = true;
          // Hung on purpose, like a stalled flush: the class the stop
          // deadline abandons (src/core/hard-exit.ts).
          await new Promise<void>(() => undefined);
        }
      : async (): Promise<void> => {
          drainStarted = true;
          say('DRAIN-DONE');
        },
} as Container;

let receivedPartial = (): void => {};
const partialReceived = new Promise<void>((resolve) => {
  receivedPartial = resolve;
});

/** The half-sent request's head, identified on the server side by its own form. */
const PARTIAL_FORM = 'POST /settings HTTP/1.1\r\nHost: localhost:8080\r\n';

async function main(): Promise<void> {
  // The wiring the REAL start does, on the CONTROLLED boundary: the module's
  // stop state is what the product's own stop coordination reads.
  boundStopContainer(boundary);
  const logger = boundary.logger;
  const server = await startSettingsInterface(logger, {
    port: 0,
    closeGraceMs: CLOSE_GRACE_MS,
    onConnection: (socket) => {
      let seen = '';
      socket.on('data', (chunk: Buffer) => {
        seen += String(chunk);
        // The half-sent request: its header came through, its body never will.
        if (seen.includes('Content-Length: 10000')) {
          receivedPartial();
        }
      });
    },
  });
  say(`LISTENING`);

  if (mode === 'restart-grace') {
    await successfulSave(server);
    // The response finish called the REAL restart path. The process leaves
    // itself; the fixture never exits here.
    return;
  }

  if (mode === 'restart-abandoned') {
    holdHalfSentRequest(server);
    await partialReceived;
    say('HELD-SOCKET-RECEIVED');
    await successfulSave(server);
    return;
  }
  if (mode === 'sigterm') {
    // The signal case holds only the socket: an ACTUAL successful POST here
    // would be the restart request by finish (exit 75) and would legitimately
    // win over the signal - that is the restart case's business, not this one.
    holdHalfSentRequest(server);
    await partialReceived;
    say('HELD-SOCKET-RECEIVED');
    return;
  }
}

/**
 * One REAL successful POST /settings: same origin, valid endpoint. Its
 * SAVED-200 marker fires only once the answer is ON the wire.
 */
function successfulSave(server: SettingsServer): Promise<void> {
  const address = server.address();
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  const form = new URLSearchParams({
    endpointBaseUrl: 'http://127.0.0.1:1234/v1',
    fastModel: 'fast-small',
    smartModel: 'smart-big',
    motorModel: 'motor-mid',
    telegramChatId: '4242',
    telegramBotToken: '__telegram_bot_token__',
  }).toString();
  return new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/settings',
        method: 'POST',
        headers: {
          Host: 'localhost:8080',
          Origin: 'http://localhost:8080',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(form)),
        },
      },
      (res) => {
        let status = res.statusCode ?? 0;
        res.setEncoding('utf8');
        res.on('data', () => undefined);
        res.on('end', () => {
          if (status === 200) {
            // The answer is ON the wire; the server's finish event (the
            // restart trigger) fires with it. From here the fixture and the
            // coordinator run on their own.
            say('SAVED-200');
            resolve();
          } else {
            reject(new Error(`save answered ${String(status)}`));
          }
        });
      }
    );
    req.on('error', (error: Error) => {
      if (!drainStarted) reject(error); // after the stop began, errors are the close, not the save
    });
    req.write(form);
    req.end();
  });
}

/** The half-sent request: the remainder never arrives; it holds the close. */
function holdHalfSentRequest(server: SettingsServer): void {
  const address = server.address();
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  const socket = connect({ host: '127.0.0.1', port }, () => {
    socket.write(
      PARTIAL_FORM +
        'Content-Type: application/x-www-form-urlencoded\r\n' +
        `Content-Length: ${HALF_SENT_BODY_LENGTH}\r\n\r\nx=`
    );
  });
  socket.on('error', () => undefined); // the close may destroy it - that is the contract
}

void main();
