import { createWebOperationsServer } from './operations.js';
import { createWebServer, type WebRuntimeMetrics } from './server.js';
import { createOwnerMessageIntakeFromEnv } from '../storage/owner-message-intake.js';
import pino from 'pino';

const logger = pino();

function requiredPort(name: string): number {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a valid TCP port`);
  return port;
}

async function main(): Promise<void> {
  const allowedOrigin = process.env['LIFEMODEL_WEB_ALLOWED_ORIGIN'];
  if (!allowedOrigin) throw new Error('LIFEMODEL_WEB_ALLOWED_ORIGIN is required');
  const appDirectory = process.env['LIFEMODEL_WEB_APP_DIRECTORY'];
  if (!appDirectory) throw new Error('LIFEMODEL_WEB_APP_DIRECTORY is required');
  const port = requiredPort('LIFEMODEL_WEB_PORT');
  const internalPort = requiredPort('LIFEMODEL_WEB_INTERNAL_PORT');
  if (internalPort === port)
    throw new Error('LIFEMODEL_WEB_INTERNAL_PORT must differ from LIFEMODEL_WEB_PORT');
  const stores = createOwnerMessageIntakeFromEnv();
  const runtimeMetrics: WebRuntimeMetrics = { intakeFailures: 0, sseLag: 0, reconnects: 0 };
  const server = createWebServer({
    allowedOrigin,
    appDirectory,
    runtimeMetrics,
    intake: stores.intake,
    transcript: stores.transcript,
    creatureState: stores.creatureState,
    logger,
  });
  const operations = createWebOperationsServer({
    checkStores: () => stores.checkStores(),
    readMetrics: () => stores.readMetrics(runtimeMetrics),
  });
  const close = async () => {
    await Promise.all([server.close(), operations.close()]);
    await stores.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  await Promise.all([
    server.listen({ host: '0.0.0.0', port }),
    operations.listen({ host: '0.0.0.0', port: internalPort }),
  ]);
  process.stdout.write('Web server listening\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Web server failed to start'}\n`
  );
  process.exitCode = 1;
});
