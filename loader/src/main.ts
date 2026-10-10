/**
 * The container's main process (lifemodel-q4x.2.1).
 *
 * It runs as root under tini, brings up the loader's own port, and starts
 * lifemodel as the unprivileged user. SIGTERM (what `docker stop` sends) is
 * FORWARDED to lifemodel and its exit is awaited for the length of its drain,
 * so the stop gives the instance the restart guarantee it was built for.
 */
import { systemClock } from './clock.js';
import { loadConfig, type LoaderConfig } from './config.js';
import { createNodeLauncher, createNodeRunner } from './exec.js';
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
  launcher: createNodeLauncher(),
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
