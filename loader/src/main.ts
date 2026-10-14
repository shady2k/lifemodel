/** Process entry point for the platform bootstrap loader. */
import { systemClock } from './clock.js';
import { loadConfig, type LoaderConfig } from './config.js';
import { createNodeRunner } from './exec.js';
import { createNodeFileSystem } from './fs.js';
import { createStdoutLogger } from './logger.js';
import { createLoaderApp } from './app.js';
import { describe } from './state.js';

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

let config: LoaderConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  // Nothing is up yet, so this one line goes to stderr in the loader's own shape.
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'error', component: 'loader', msg: describe(error) })}\n`
  );
  process.exit(1);
}

const logger = createStdoutLogger(writeLine);
const app = createLoaderApp({
  config,
  fs: createNodeFileSystem(),
  runner: createNodeRunner(),
  logger,
  clock: systemClock,
  exit: (code) => process.exit(code),
});

let stopping = false;
function leave(reason: string): void {
  if (stopping) return;
  stopping = true;
  void app
    .shutdown(reason)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      logger.error({ error: describe(error) }, 'the loader could not stop cleanly');
      process.exit(1);
    });
}

process.on('SIGTERM', () => {
  leave('SIGTERM');
});
process.on('SIGINT', () => {
  leave('SIGINT');
});
process.on('uncaughtException', (error: Error) => {
  logger.error({ error: describe(error) }, 'the loader hit an uncaught error');
  leave('uncaughtException');
});
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ error: describe(reason) }, 'the loader hit an unhandled rejection');
  leave('unhandledRejection');
});

await app.start();
