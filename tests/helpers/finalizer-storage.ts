/** Fake storage module at its TLS boundary. Its state survives core replacement. */
import { createServer, request, type Server } from 'node:https';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { TaskManifestObject, TaskSealReceipt } from '../../src/ports/tasks.js';
import type { StorageSealRequest } from '../../src/core/storage-control-client.js';
import { createStorageCertificate } from './storage-certificate.js';

export async function createFinalizerStorage(pool: Pool) {
  const certificate = await createStorageCertificate(['localhost']);
  const root = await mkdtemp(join(tmpdir(), 'task-finalize-'));
  const tokenFile = join(root, 'token');
  const caFile = join(root, 'ca');
  await writeFile(tokenFile, 'finalizer-test-token');
  await writeFile(caFile, certificate.ca);
  const allocations = new Map<string, { id: string; space: string; effectKey: string }>();
  const marks = new Map<string, TaskManifestObject>();
  const seals = new Map<string, { request: StorageSealRequest; receipt: TaskSealReceipt }>();
  const calls: { path: string; body: Record<string, string> }[] = [];
  const sockets = new Set<Socket>();
  let unavailable = false;
  let loseMarkReply = false;
  let checksumMismatch = false;
  let revokeBeforeSeal = false;
  const server: Server = createServer(
    { cert: certificate.cert, key: certificate.key },
    (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          const send = (status: number, body: unknown) =>
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
          if (req.headers.authorization !== 'Bearer finalizer-test-token') {
            send(401, {});
            return;
          }
          const path = req.url!;
          const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
          calls.push({ path, body });
          if (unavailable) {
            send(503, { error: { code: 'catalog_unavailable' } });
            return;
          }
          if (path === '/allocate') {
            const receipt = allocations.get(body.effectKey!) ?? {
              id: 'allocation_1',
              space: 'space_1',
              effectKey: body.effectKey!,
            };
            allocations.set(body.effectKey!, receipt);
            await pool.query('INSERT INTO storage.spaces(id) VALUES($1) ON CONFLICT DO NOTHING', [
              receipt.space,
            ]);
            send(200, receipt);
            return;
          }
          // Acknowledged marks are immutable module-owned metadata. This fake route
          // models the task-side mark ACK, not a core control-client operation.
          if (path === '/mark') {
            const object = JSON.parse(body.object!) as TaskManifestObject;
            const old = marks.get(object.id);
            if (old && JSON.stringify(old) !== JSON.stringify(object)) {
              send(409, {});
              return;
            }
            marks.set(object.id, object);
            if (loseMarkReply) {
              loseMarkReply = false;
              req.socket.destroy();
              return;
            }
            send(200, { objectId: object.id });
            return;
          }
          if (path === '/seal') {
            const input = body as unknown as StorageSealRequest;
            const old = seals.get(input.effectKey);
            if (old) {
              if (JSON.stringify(old.request) !== JSON.stringify(input)) {
                send(409, { error: { code: 'effect_conflict' } });
                return;
              }
              send(200, old.receipt);
              return;
            }
            if (revokeBeforeSeal) {
              revokeBeforeSeal = false;
              // Module's asynchronous canonical-revoke worker wins after the
              // core saved expectedRevision, before seal locks the space.
              await pool.query(
                "UPDATE storage.spaces SET mode='revoked',access_revision=access_revision+1 WHERE id=$1",
                [input.space]
              );
            }
            const revision = (
              await pool.query('SELECT access_revision::text FROM storage.spaces WHERE id=$1', [
                input.space,
              ])
            ).rows[0]?.access_revision;
            if (revision !== input.expectedRevision) {
              send(409, { error: { code: 'revision_conflict' } });
              return;
            }
            const markedObjects = [...marks.values()];
            if (checksumMismatch && input.outcome === 'completed') {
              await pool.query(
                "UPDATE storage.spaces SET mode='frozen',access_revision=access_revision+1 WHERE id=$1",
                [input.space]
              );
              send(503, { error: { code: 'checksum_mismatch' } });
              return;
            }
            const excluded = checksumMismatch
              ? markedObjects
                  .filter((object) => object.mark === 'result')
                  .map((object) => ({ ...object, reason: 'checksum_mismatch' }))
              : [];
            const objects = checksumMismatch
              ? markedObjects.filter((object) => object.mark !== 'result')
              : markedObjects;
            if (
              input.outcome === 'completed' &&
              !objects.some((object) => object.mark === 'result')
            ) {
              send(409, { error: { code: 'missing_result' } });
              return;
            }
            const receipt: TaskSealReceipt = {
              id: 'seal_1',
              space: input.space,
              effectKey: input.effectKey,
              // Recovery reuses the existing frozen operation/revision. Only
              // a fresh freeze advances it (the real module behaves this way).
              revision: checksumMismatch
                ? input.expectedRevision
                : String(BigInt(input.expectedRevision) + 1n),
              outcome: input.outcome,
              state: 'sealed',
              reason: checksumMismatch
                ? 'checksum_mismatch'
                : input.outcome === 'completed'
                  ? null
                  : objects.some((object) => object.mark === 'result')
                    ? 'partial_output'
                    : 'missing_result',
              manifest: {
                id: 'manifest_1',
                version: 1,
                sha256: createHash('sha256')
                  .update(
                    JSON.stringify({
                      version: 1,
                      objects: [...objects]
                        .sort((a, b) => a.id.localeCompare(b.id))
                        .map(({ id, name, size, sha256, mark }) => ({
                          id,
                          name,
                          size,
                          sha256,
                          mark,
                        })),
                      ...(excluded.length
                        ? {
                            excluded: excluded.map(({ id, name, size, sha256, mark, reason }) => ({
                              id,
                              name,
                              size,
                              sha256,
                              mark,
                              reason,
                            })),
                          }
                        : {}),
                    })
                  )
                  .digest('hex'),
                objects,
                ...(excluded.length ? { excluded } : {}),
              },
            };
            seals.set(input.effectKey, { request: input, receipt });
            await pool.query(
              "UPDATE storage.spaces SET mode='sealed',access_revision=$2 WHERE id=$1",
              [input.space, receipt.revision]
            );
            send(200, receipt);
            return;
          }
          send(404, {});
        })().catch(() => res.writeHead(500).end('{}'));
      });
    }
  );
  server.on('error', () => undefined);
  server.on('tlsClientError', () => undefined);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TLS fixture address');
  const origin = `https://localhost:${address.port}`;
  async function mark(object: TaskManifestObject) {
    return new Promise<void>((resolve, reject) => {
      const req = request(
        `${origin}/mark`,
        {
          method: 'POST',
          ca: certificate.ca,
          headers: {
            authorization: 'Bearer finalizer-test-token',
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.on('error', reject);
          res.resume();
          res.on('end', () =>
            res.statusCode === 200 ? resolve() : reject(new Error('Mark rejected'))
          );
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ object: JSON.stringify(object) }));
    });
  }
  return {
    origin,
    tokenFile,
    caFile,
    allocations,
    marks,
    seals,
    calls,
    mark,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    loseNextMarkReply: () => {
      loseMarkReply = true;
    },
    setChecksumMismatch: (value: boolean) => {
      checksumMismatch = value;
    },
    revokeBeforeNextSeal: () => {
      revokeBeforeSeal = true;
    },
    reset: async () => {
      unavailable = false;
      loseMarkReply = false;
      checksumMismatch = false;
      revokeBeforeSeal = false;
      allocations.clear();
      marks.clear();
      seals.clear();
      calls.length = 0;
      await pool.query('TRUNCATE storage.spaces CASCADE');
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      certificate.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
