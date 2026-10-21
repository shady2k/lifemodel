/** Kubernetes boundary for seal tests. Core never supplies task resource names. */
import { createServer } from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageCertificate } from './storage-certificate.js';

export async function createSealIdentity() {
  const certificate = await createStorageCertificate(['localhost']);
  const root = await mkdtemp(join(tmpdir(), 'storage-seal-identity-'));
  const tokenFile = join(root, 'token');
  const caFile = join(root, 'ca');
  await writeFile(tokenFile, 'module-token');
  await writeFile(caFile, certificate.ca);
  const deadPods = new Set<string>();
  const deadJobs = new Set<string>();
  const calls: string[] = [];
  const reviews: string[] = [];
  const tokens = {
    a: {
      namespace: 'lifemodel-motor',
      account: 'task',
      pod: 'a',
      audience: 'lifemodel-task-storage',
    },
    b: {
      namespace: 'lifemodel-motor',
      account: 'task',
      pod: 'b',
      audience: 'lifemodel-task-storage',
    },
    core: {
      namespace: 'lifemodel',
      account: 'core',
      pod: 'core',
      audience: 'lifemodel-core-storage-control',
    },
    coreRead: {
      namespace: 'lifemodel',
      account: 'core',
      pod: 'core',
      audience: 'lifemodel-core-storage-read',
    },
    web: {
      namespace: 'lifemodel',
      account: 'web',
      pod: 'web',
      audience: 'lifemodel-web-storage-read',
    },
  };
  const api = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void (async () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== 'Bearer module-token') {
        res.writeHead(403);
        res.end();
        return;
      }
      let value: unknown;
      if (req.url?.endsWith('/tokenreviews')) {
        let body = '';
        for await (const part of req) body += part;
        const spec = JSON.parse(body).spec;
        reviews.push(spec.token);
        const token = tokens[spec.token as keyof typeof tokens];
        value = {
          status: {
            authenticated: !!token && spec.audiences.includes(token.audience),
            audiences: token ? [token.audience] : [],
            user: {
              username: `system:serviceaccount:${token?.namespace}:${token?.account}`,
              uid: 'sa-uid',
              extra: {
                'authentication.kubernetes.io/pod-name': [token?.pod],
                'authentication.kubernetes.io/pod-uid': [`pod-${token?.pod}`],
              },
            },
          },
        };
      } else if (req.url?.includes('/pods/')) {
        const name = req.url.split('/').at(-1)!;
        if (deadPods.has(name)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const task = name === 'a' || name === 'b';
        value = {
          metadata: {
            name,
            namespace: task ? 'lifemodel-motor' : 'lifemodel',
            uid: `pod-${name}`,
            ownerReferences: task
              ? [
                  {
                    apiVersion: 'batch/v1',
                    kind: 'Job',
                    name: `job-${name}`,
                    uid: `job-${name}`,
                    controller: true,
                  },
                ]
              : [],
          },
          spec: { serviceAccountName: task ? 'task' : name },
        };
      } else if (req.url?.includes('/jobs/')) {
        const name = req.url.split('/').at(-1)!;
        if (deadJobs.has(name)) {
          res.writeHead(404);
          res.end();
          return;
        }
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
  api.on('error', () => undefined);
  api.on('connection', (socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw Error('identity listen failed');
  return {
    certificate,
    deadPods,
    deadJobs,
    calls,
    reviews,
    options: { apiServer: `https://localhost:${address.port}`, tokenFile, caFile, timeoutMs: 2000 },
    async close() {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      certificate.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
