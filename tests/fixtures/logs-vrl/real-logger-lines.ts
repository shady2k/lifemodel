/**
 * The real output of the two loggers a cluster module writes its records with
 * (ADR-016 §9 points 1 and 2, check L02), produced for the collector's VRL.
 *
 * Run by tsx from the host L02 harness (`scripts/check-logs-vrl.mjs`) and from
 * `tests/unit/logs-json-lines.test.ts`, so both read the same lines:
 *
 *   node --import tsx tests/fixtures/logs-vrl/real-logger-lines.ts plan
 *   node --import tsx tests/fixtures/logs-vrl/real-logger-lines.ts core
 *   node --import tsx tests/fixtures/logs-vrl/real-logger-lines.ts core-pretty
 *   node --import tsx tests/fixtures/logs-vrl/real-logger-lines.ts loader
 *
 * `plan` prints the records as JSON; the logger modes write one record per
 * level to stdout and nothing else. The core mode builds `createLogger` from
 * the merged configuration with no settings document, exactly as
 * `src/core/container.ts` does when nobody set `logging.pretty`; `core-pretty`
 * passes `pretty: true` explicitly, as a development run does. The loader mode
 * is the loader image's own stdout logger, which the model gateway, the
 * storage module and the task launcher share.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoader } from '../../../src/config/config-loader.js';
import { createLogger } from '../../../src/core/logger.js';
import { createStdoutLogger } from '../../../loader/src/logger.js';

/** One record at each level the page filters on. */
export const RECORDS = [
  { level: 'info', message: 'lifemodel log check: the turn started' },
  { level: 'warn', message: 'lifemodel log check: the turn is slow' },
  { level: 'error', message: 'lifemodel log check: the turn failed' },
] as const;

const MODES = ['plan', 'core', 'core-pretty', 'loader'] as const;
type Mode = (typeof MODES)[number];

function mode(): Mode {
  const value = process.argv[2];
  const found = MODES.find((candidate) => candidate === value);
  if (!found) throw new Error(`usage: real-logger-lines.ts <${MODES.join('|')}>`);
  return found;
}

async function writeCore(pretty: boolean | 'default'): Promise<void> {
  const config = await new ConfigLoader({
    read: async () => null,
    write: async () => undefined,
  }).load();
  const logDir = mkdtempSync(join(tmpdir(), 'lifemodel-logs-record-'));
  try {
    const logger = createLogger({
      logDir,
      file: false,
      // 'default': what the container passes when nobody set logging.pretty.
      pretty: pretty === 'default' ? config.logging.pretty : pretty,
      level: config.logging.level,
    });
    for (const record of RECORDS) logger[record.level](record.message);
    await new Promise<void>((resolve) => {
      logger.flush(() => {
        resolve();
      });
    });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

function writeLoader(): void {
  const logger = createStdoutLogger((line) => process.stdout.write(`${line}\n`));
  for (const record of RECORDS) logger[record.level]({}, record.message);
}

async function main(): Promise<void> {
  const selected = mode();
  if (selected === 'plan') {
    process.stdout.write(`${JSON.stringify({ records: RECORDS })}\n`);
    return;
  }
  if (selected === 'loader') {
    writeLoader();
    return;
  }
  await writeCore(selected === 'core-pretty' ? true : 'default');
}

await main();
