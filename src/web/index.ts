import { createWebServer } from './server.js';
import { createOwnerMessageIntakeFromEnv } from '../storage/owner-message-intake.js';
import pino from 'pino';

const logger = pino();

async function main(): Promise<void> {
  const allowedOrigin = process.env['LIFEMODEL_WEB_ALLOWED_ORIGIN'];
  if (!allowedOrigin) throw new Error('LIFEMODEL_WEB_ALLOWED_ORIGIN is required');
  const portValue = process.env['LIFEMODEL_WEB_PORT'];
  if (!portValue) throw new Error('LIFEMODEL_WEB_PORT is required');
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('LIFEMODEL_WEB_PORT must be a valid TCP port');
  const stores = createOwnerMessageIntakeFromEnv();
  const server = createWebServer({ allowedOrigin, intake: stores.intake, logger });
  const close = async () => {
    await server.close();
    await stores.close();
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  await server.listen({ host: '0.0.0.0', port });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Web server failed to start'}\n`
  );
  process.exitCode = 1;
});
