/** Run the production entry point with test-only deployment addresses and ephemeral ports.
 * The loader hook changes constants, not adapters or startup/owner behavior. */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const target = new URL(config.connectionString);
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes('/loader/src/')) return loaded;
    let source =
      typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source!).toString();
    if (url.endsWith('/storage-catalog.ts'))
      source = source.replace(
        'lifemodel-rw.lifemodel-state.svc.cluster.local:5432/lifemodel',
        `${target.host}${target.pathname}`
      );
    if (url.endsWith('/storage-identity.ts'))
      source = source
        .replace('/var/run/secrets/kubernetes.io/serviceaccount', config.serviceAccount)
        .replace('`${SA}/ca.crt`', '`${SA}/ca`');
    if (url.endsWith('/model-bao.ts'))
      source = source.replace(
        '/var/run/secrets/kubernetes.io/serviceaccount/token',
        `${config.serviceAccount}/token`
      );
    if (url.endsWith('/storage-module.ts')) {
      source = source.replace(
        /const (STATUS|TASK|CONTROL|READ)_PORT = \d+;/g,
        'const $1_PORT = 0;'
      );
      source += `
        await Promise.all([app.status, app.task.server, app.control.server, app.read.server].map(
          server => new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve))
        ));
        process.send?.({ ready: {
          status: app.status.address().port,
          task: app.task.server.address().port,
          control: app.control.server.address().port,
          read: app.read.server.address().port
        }});
      `;
    }
    return { ...loaded, source };
  },
});
await import(fileURLToPath(new URL('../../loader/src/storage-module.ts', import.meta.url)));
