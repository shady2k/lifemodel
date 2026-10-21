import { createServer, type Server } from 'node:https';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageCertificate } from './storage-certificate.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';

export async function storageObjectIdentity() {
  const certificate = await createStorageCertificate(['localhost']);
  const root = mkdtempSync(join(tmpdir(), 'storage-objects-'));
  const tokenFile = join(root, 'token');
  const caFile = join(root, 'ca');
  writeFileSync(tokenFile, 'module-token');
  writeFileSync(caFile, certificate.ca);
  let reviews = 0;
  let onReview: (() => Promise<void>) | undefined;
  const api: Server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void (async () => {
      if (req.headers.authorization !== 'Bearer module-token') {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = '';
      for await (const part of req) body += part;
      let value: unknown;
      if (req.url?.endsWith('/tokenreviews')) {
        reviews++;
        await onReview?.();
        const input = JSON.parse(body).spec;
        const pod = input.token;
        value = {
          status: {
            authenticated: ['a', 'b'].includes(pod),
            audiences: ['lifemodel-task-storage'],
            user: {
              username: 'system:serviceaccount:lifemodel-motor:task',
              uid: 'sa',
              extra: {
                'authentication.kubernetes.io/pod-name': [pod],
                'authentication.kubernetes.io/pod-uid': [`pod-${pod}`],
              },
            },
          },
        };
      } else if (req.url?.includes('/pods/')) {
        const name = req.url.split('/').at(-1)!;
        value = {
          metadata: {
            name,
            namespace: 'lifemodel-motor',
            uid: `pod-${name}`,
            ownerReferences: [
              {
                apiVersion: 'batch/v1',
                kind: 'Job',
                name: `job-${name}`,
                uid: `job-${name}`,
                controller: true,
              },
            ],
          },
          spec: { serviceAccountName: 'task' },
        };
      } else if (req.url?.includes('/jobs/')) {
        const name = req.url.split('/').at(-1)!;
        value = { metadata: { name, namespace: 'lifemodel-motor', uid: name } };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    })().catch(() => res.destroy());
  });
  api.on('connection', (socket) => socket.on('error', () => undefined));
  api.on('error', () => undefined);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw Error('no API');
  return {
    certificate,
    identity: createKubernetesStorageIdentity({
      apiServer: `https://localhost:${address.port}`,
      tokenFile,
      caFile,
    }),
    get reviews() {
      return reviews;
    },
    setReviewHook(hook: (() => Promise<void>) | undefined) {
      onReview = hook;
    },
    async close() {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      certificate.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
