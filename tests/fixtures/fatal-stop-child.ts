/** Starts the production entrypoint against the disposable test stores. */
if (process.env['TEST_STALL_REGISTRY_FLUSH'] === 'true') {
  const { PersistentRecipientRegistry } = await import('../../src/core/recipient-registry.js');
  const flush = PersistentRecipientRegistry.prototype.flush;
  let flushCalls = 0;
  PersistentRecipientRegistry.prototype.flush = async function (): Promise<void> {
    flushCalls += 1;
    if (flushCalls === 1) return flush.call(this);
    process.stderr.write('REGISTRY_FLUSH_ENTERED\n');
    return new Promise<void>(() => undefined);
  };
}
await import('../../src/index.js');
