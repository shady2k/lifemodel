/** Starts the production entrypoint against the disposable test stores. */
if (process.env['TEST_STALL_REGISTRY_FLUSH'] === 'true') {
  const { PersistentRecipientRegistry } = await import('../../src/core/recipient-registry.js');
  PersistentRecipientRegistry.prototype.flush = async function (): Promise<void> {
    process.stderr.write('REGISTRY_FLUSH_ENTERED\n');
    return new Promise<void>(() => undefined);
  };
}
await import('../../src/index.js');
