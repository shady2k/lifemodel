/** Runtime checks for storage listener authority and dependency shutdown order. */
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import type { StorageAccess, StorageTaskStream } from '../../loader/src/storage-access.js';
import type { StorageObjects } from '../../loader/src/storage-objects.js';
import type { StorageSeal } from '../../loader/src/storage-seal.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { STORAGE_BUCKET } from '../../loader/src/storage-custody.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

let certificate: TestStorageCertificate;
beforeAll(async () => {
  certificate = await createStorageCertificate();
});
afterAll(() => certificate.cleanup());

function stream(): StorageTaskStream {
  return {
    signal: new AbortController().signal,
    chunk: vi.fn(async () => undefined),
    publish: vi.fn(async () => ({ rows: [] })),
    close: vi.fn(),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('storage seal wiring', () => {
  it('keeps core read recovery on the core stream with the same object scope', async () => {
    const primary = stream();
    const recovery = stream();
    const openCoreStream = vi.fn().mockReturnValueOnce(primary).mockReturnValue(recovery);
    const openTaskStream = vi.fn(() => stream());
    const access: StorageAccess = {
      identity: {
        verify: vi.fn(),
        verifyBinding: vi.fn(),
      },
      openTaskStream,
      revoke: vi.fn(),
      settleSpace: vi.fn(),
      quiesceSpace: vi.fn(),
      check: vi.fn(async () => true),
    };
    const seal: StorageSeal = {
      allocate: vi.fn(),
      bind: vi.fn(),
      seal: vi.fn(),
      openCoreStream,
      check: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    const objects: StorageObjects = {
      // Force the normally unused GET recovery seam to prove its authority.
      handle: vi.fn(async (_req, res, _space, _tail, _stream, recover) => {
        const repair = recover!();
        try {
          await repair.chunk(0, () => undefined);
          res.writeHead(200);
          res.end('recovered');
        } finally {
          repair.close();
        }
      }),
      expiredUploads: vi.fn(async () => []),
      check: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };
    const app = createStorageModule({
      access,
      seal,
      objects,
      bucket: STORAGE_BUCKET,
      catalog: { check: async () => ({ ok: true }) },
      custody: { read: vi.fn() },
      check: vi.fn(),
      logger: createRecordingLogger([]),
      tls: {
        cert: certificate.cert,
        key: certificate.key,
        read: async () => certificate,
      },
    });
    try {
      await new Promise<void>((resolve) => app.read.server.listen(0, '127.0.0.1', resolve));
      const address = app.read.server.address();
      if (!address || typeof address === 'string') throw new Error('not listening');
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            servername: 'storage-module.lifemodel-system.svc',
            ca: certificate.ca,
            path: '/spaces/space-a/objects/object-a',
            headers: { authorization: 'Bearer core-token' },
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (part: Buffer) => chunks.push(part));
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() })
            );
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(response).toEqual({ status: 200, body: 'recovered' });
      expect(openTaskStream).not.toHaveBeenCalled();
      expect(openCoreStream).toHaveBeenCalledTimes(2);
      for (const [input] of openCoreStream.mock.calls)
        expect(input).toMatchObject({
          token: 'core-token',
          space: 'space-a',
          objectId: 'object-a',
          signal: expect.any(AbortSignal),
        });
      expect(openCoreStream.mock.calls[1]![0].signal).not.toBe(primary.signal);
      expect(recovery.chunk).toHaveBeenCalledOnce();
      expect(recovery.close).toHaveBeenCalledOnce();
      expect(primary.close).toHaveBeenCalledOnce();
    } finally {
      app.task.close();
      app.control.close();
      app.read.close();
      app.status.close();
    }
  });

  it('stops intake and awaits both SQL pools before closing their S3 dependency', async () => {
    const sealDrained = deferred();
    const objectsDrained = deferred();
    const sealClose = vi.fn(() => sealDrained.promise);
    const objectsClose = vi.fn(() => objectsDrained.promise);
    const s3Close = vi.fn();
    const listener = () => ({
      server: Object.assign(new EventEmitter(), { listen: vi.fn(), close: vi.fn() }),
      close: vi.fn(),
    });
    const app = {
      task: listener(),
      control: listener(),
      read: listener(),
      status: Object.assign(new EventEmitter(), {
        listen: vi.fn(),
        closeAllConnections: vi.fn(),
        close: vi.fn(),
      }),
    };
    let stop!: () => void;
    const on = vi.spyOn(process, 'on').mockImplementation((event, callback) => {
      if (event === 'SIGTERM') stop = callback as () => void;
      return process;
    });
    const paths = [
      'node:fs/promises',
      '../../loader/src/model-bao.js',
      '../../loader/src/storage-catalog.js',
      '../../loader/src/storage-custody.js',
      '../../loader/src/storage-s3.js',
      '../../loader/src/storage-module-app.js',
      '../../loader/src/storage-access.js',
      '../../loader/src/storage-identity.js',
      '../../loader/src/storage-objects.js',
      '../../loader/src/storage-object-s3.js',
      '../../loader/src/storage-seal.js',
    ];
    vi.doMock('node:fs/promises', () => ({ readFile: async () => 'fixture-certificate' }));
    vi.doMock('../../loader/src/model-bao.js', () => ({ createRoleBaoClient: () => ({}) }));
    vi.doMock('../../loader/src/storage-catalog.js', () => ({
      createCatalog: () => ({}),
      catalogConnectionString: () => 'fixture-database',
    }));
    vi.doMock('../../loader/src/storage-custody.js', () => ({
      STORAGE_BUCKET,
      createCachedCustodyReader: () => ({}),
      readCustodyRecord: vi.fn(),
    }));
    vi.doMock('../../loader/src/storage-s3.js', () => ({ checkS3Bucket: vi.fn() }));
    vi.doMock('../../loader/src/storage-module-app.js', () => ({ createStorageModule: () => app }));
    vi.doMock('../../loader/src/storage-access.js', () => ({ createStorageAccess: () => ({}) }));
    vi.doMock('../../loader/src/storage-identity.js', () => ({
      createKubernetesStorageIdentity: () => ({}),
    }));
    vi.doMock('../../loader/src/storage-objects.js', () => ({
      createStorageObjects: () => ({ close: objectsClose }),
    }));
    vi.doMock('../../loader/src/storage-object-s3.js', () => ({
      createStorageObjectS3: () => ({ close: s3Close }),
    }));
    vi.doMock('../../loader/src/storage-seal.js', () => ({
      createStorageSeal: () => ({ close: sealClose }),
    }));
    for (const key of [
      'LIFEMODEL_OPENBAO_ADDRESS',
      'LIFEMODEL_STORAGE_S3_ENDPOINT',
      'LIFEMODEL_DB_USERNAME',
      'LIFEMODEL_DB_PASSWORD',
      'LIFEMODEL_STORAGE_TLS_DIR',
    ])
      vi.stubEnv(key, 'fixture');
    vi.stubEnv('LIFEMODEL_STORAGE_BUCKET', STORAGE_BUCKET);
    try {
      await import('../../loader/src/storage-module.js');
      stop();
      for (const listener of [app.task, app.control, app.read]) {
        expect(listener.server.close).toHaveBeenCalledOnce();
        expect(listener.close).not.toHaveBeenCalled();
      }
      expect(app.status.close).toHaveBeenCalledOnce();
      expect(sealClose).toHaveBeenCalledOnce();
      expect(objectsClose).toHaveBeenCalledOnce();
      expect(s3Close).not.toHaveBeenCalled();
      sealDrained.resolve();
      await sealDrained.promise;
      expect(s3Close).not.toHaveBeenCalled();
      objectsDrained.resolve();
      await vi.waitFor(() => expect(s3Close).toHaveBeenCalledOnce());
      for (const listener of [app.task, app.control, app.read])
        expect(listener.close).toHaveBeenCalledOnce();
      stop();
      expect(sealClose).toHaveBeenCalledOnce();
      expect(objectsClose).toHaveBeenCalledOnce();
      expect(s3Close).toHaveBeenCalledOnce();
    } finally {
      sealDrained.resolve();
      objectsDrained.resolve();
      on.mockRestore();
      vi.unstubAllEnvs();
      for (const path of paths) vi.doUnmock(path);
      vi.resetModules();
    }
  });
});
