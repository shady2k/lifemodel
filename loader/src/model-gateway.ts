/** Separate process entry point, built into the platform loader image. */
import { createRoleBaoClient, createCachedSlotReader } from './model-bao.js';
import { createModelGateway } from './model-gateway-app.js';
import { createStdoutLogger } from './logger.js';

const logger = createStdoutLogger((line) => process.stdout.write(`${line}\n`));
const address = process.env['LIFEMODEL_OPENBAO_ADDRESS'];
if (!address) {
  logger.error({ code: 'missing_bao_address' }, 'Model gateway cannot start');
  process.exit(1);
}
const bao = createRoleBaoClient({ address, role: 'model-gateway', logger });
const app = createModelGateway({ slots: createCachedSlotReader(bao.readSlot), logger });
app.api.listen(8080, '0.0.0.0');
app.status.listen(8081, '0.0.0.0');
function stop(): void {
  app.api.closeAllConnections();
  app.status.closeAllConnections();
  app.api.close();
  app.status.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
for (const server of [app.api, app.status])
  server.on('error', () => {
    logger.error({ code: 'listener_failed' }, 'Model gateway listener failed');
    stop();
    process.exitCode = 1;
  });
