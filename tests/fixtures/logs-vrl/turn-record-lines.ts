/**
 * The lines the core's own logger writes during a real turn (ADR-016 §9 point
 * 4, check L02), and one line at every pino level, produced for the collector's
 * VRL.
 *
 * Run by tsx, from `tests/unit/logs-record-shape.test.ts` and from the host L02
 * harness (`scripts/check-logs-vrl.mjs`), so both read the same lines:
 *
 *   node --import tsx tests/fixtures/logs-vrl/turn-record-lines.ts levels
 *   node --import tsx tests/fixtures/logs-vrl/turn-record-lines.ts reply --result <path>
 *   node --import tsx tests/fixtures/logs-vrl/turn-record-lines.ts thought --result <path>
 *
 * `levels` writes one record at each pino level through `createLogger`.
 *
 * `reply` and `thought` start the real CoreLoop the way the container does
 * (`tests/helpers/core-loop-drain-harness.ts`: the real loop, the real
 * cognition processor, only the LLM provider scripted), with `createLogger`
 * writing one JSON line per record to stdout, and push one trigger:
 *
 * - `reply`: a `user_message` that carries its own recipientId, so the turn's
 *   conversation is that recipient;
 * - `thought`: a proactive trigger with NO recipientId, so the turn's
 *   conversation is cognition's fallback, the primary recipient.
 *
 * The result file says which ids the run used (`conversationId` is what the
 * turn MUST be logged under); the lines themselves go to stdout and nowhere
 * else, because the collector reads stdout alone.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPrimaryRecipientId } from '../../../src/core/globals.js';
import { createLogger } from '../../../src/core/logger.js';
import { createSignal } from '../../../src/types/signal.js';
import type { RealCognitionFacade } from '../../helpers/core-loop-real-cognition.js';
import {
  makeScratchDir,
  startInstance,
  thoughtSignal,
  waitFor,
} from '../../helpers/core-loop-drain-harness.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

function flush(logger: ReturnType<typeof createLogger>): Promise<void> {
  return new Promise<void>((resolve) => {
    logger.flush(() => {
      resolve();
    });
  });
}

/** One record at each pino level 10-60, through the logger the core uses. */
async function writeLevels(): Promise<void> {
  const logDir = mkdtempSync(join(tmpdir(), 'lifemodel-l02-levels-'));
  try {
    const logger = createLogger({ logDir, file: false, pretty: false, level: 'trace' });
    for (const level of LEVELS) logger[level](`lifemodel log check: level ${level}`);
    await flush(logger);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

interface TurnResult {
  triggerType: string;
  triggerSignalId: string;
  conversationId: string | undefined;
  primaryRecipientId: string | undefined;
}

/**
 * Write the turn's lines and stop. The loop keeps ticking behind this one-shot
 * producer, and at trace level its tick lines never let the transport's queue
 * drain (thread-stream's flush waits for the read pointer to catch the write
 * pointer). So the instance's ticking is halted first - the turn's own lines
 * are already written - and only then is the transport flushed.
 */
async function flushTurnLines(
  instance: Awaited<ReturnType<typeof startInstance>>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  instance.coreLoop.haltForTest();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await flush(logger);
}

/**
 * Run one real turn for one trigger, with the core's own JSON logger, and
 * report the ids the run used. The scripted model answers once for a reply and
 * once in JSON for the proactive trigger (which refuses plain text).
 */
async function writeTurn(mode: 'reply' | 'thought', resultPath: string): Promise<void> {
  const scratch = await makeScratchDir(`lifemodel-l02-${mode}-`);
  const logger = createLogger({ logDir: scratch, file: false, pretty: false, level: 'trace' });
  let instance: Awaited<ReturnType<typeof startInstance>> | undefined;
  try {
    instance = await startInstance(scratch, {
      logger,
      turnLogger: logger,
      cognitionMode: 'real-scripted',
      hang: false,
      sleepSchedule: { sleepHour: 0, wakeHour: 0 },
      // A reply may answer in plain text; a proactive trigger refuses it and
      // needs the JSON response, so each mode is scripted for its own turn.
      memoryProvider: { save: async () => undefined } as never,
      script: [
        {
          toolCalls: [
            {
              name: 'core.remember',
              args: { subject: 'project', attribute: 'language', value: 'TypeScript' },
            },
          ],
        },
        mode === 'reply'
          ? { content: 'Understood.' }
          : { content: JSON.stringify({ response: 'Quietly thinking it over.' }) },
      ],
    });
    const cognition = instance.cognition as unknown as RealCognitionFacade;
    const signal =
      mode === 'reply'
        ? createSignal(
            'user_message',
            'sense.web',
            { value: 1 },
            {
              data: {
                kind: 'user_message',
                text: 'hello',
                channel: 'test',
                recipientId: instance.recipientId,
              },
            }
          )
        : thoughtSignal('a passing thought');
    instance.coreLoop.pushSignal(signal);
    await waitFor(() => cognition.calls.length === 1, `the ${mode} turn to start`);
    await cognition.calls[0]?.done;
    await flushTurnLines(instance, logger);
    const result: TurnResult = {
      triggerType: signal.type,
      triggerSignalId: signal.id,
      conversationId: mode === 'reply' ? instance.recipientId : getPrimaryRecipientId(),
      primaryRecipientId: getPrimaryRecipientId(),
    };
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [mode, flag, resultPath] = process.argv.slice(2);
  if (mode === 'levels') {
    await writeLevels();
    return;
  }
  if ((mode !== 'reply' && mode !== 'thought') || flag !== '--result' || !resultPath) {
    throw new Error('usage: turn-record-lines.ts <levels|reply|thought> [--result <path>]');
  }
  await writeTurn(mode, resultPath);
  // The turn's lines are flushed; the loop's own timer would keep the process
  // alive for a stop this one-shot producer does not need.
  process.exit(0);
}

await main();
