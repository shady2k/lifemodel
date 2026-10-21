/** Task objects: private immutable bytes first, guarded catalog publication second. */
import { Pool, type QueryResultRow } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { StorageAccessError, type StorageTaskStream } from './storage-access.js';
import type { StorageObjectS3 } from './storage-object-s3.js';

export interface StorageTransferSettings {
  chunkBytes: number;
  timeoutMs: number;
  leaseSeconds: number;
}
export const STORAGE_TRANSFER_DEFAULTS: Readonly<StorageTransferSettings> = {
  chunkBytes: 4 * 1024 * 1024,
  timeoutMs: 10_000,
  leaseSeconds: 3600,
};
export interface StorageObjectsOptions {
  connectionString: string;
  s3: StorageObjectS3;
  chunkBytes?: number;
  timeoutMs?: number;
  leaseSeconds?: number;
}
export interface StorageObjects {
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    space: string,
    tail: string,
    stream: StorageTaskStream,
    recover?: () => StorageTaskStream,
    progress?: () => void
  ): Promise<void>;
  expiredUploads(): Promise<{ space: string; uploadId: string }[]>;
  check(signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
interface Receipt {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: 'artifact' | 'result' | 'log' | null;
}
interface ObjectRow extends QueryResultRow {
  id: string;
  space_id: string;
  name: string;
  size: string;
  sha256: string;
  mark: Receipt['mark'];
  sequence: string;
  s3_key: string;
  receipt: Receipt;
}
interface IntentRow extends QueryResultRow {
  object_id: string;
  name: string;
  size: string;
  sha256: string;
  state: string;
}
interface PageRow extends QueryResultRow {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: Receipt['mark'];
  sequence: string;
}
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
function invalid(): never {
  throw new StorageAccessError(400, 'invalid_request');
}
/** Display metadata only. Never joins a backend key or a server filesystem path. */
export function validateStorageName(name: string): void {
  if (
    !name ||
    Buffer.byteLength(name) > 1024 ||
    name.normalize('NFC') !== name ||
    /\p{Cf}/u.test(name) ||
    Array.from(name).some((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point < 32 || (point >= 127 && point <= 159);
    }) ||
    name.includes('\\') ||
    /%(?:25)*(?:2f|5c)/i.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^[A-Za-z]:/.test(name)
  )
    invalid();
}
function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (
    typeof value !== 'string' ||
    req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length !== 1
  )
    invalid();
  return value;
}
function cursor(space: string, sequence: string): string {
  return Buffer.from(JSON.stringify([space, sequence])).toString('base64url');
}
function parseCursor(value: string, space: string): string {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded[0] !== space ||
      typeof decoded[1] !== 'string' ||
      !/^\d{1,19}$/.test(decoded[1]) ||
      BigInt(decoded[1]) > 9223372036854775807n ||
      cursor(space, decoded[1]) !== value
    )
      invalid();
    return decoded[1];
  } catch {
    invalid();
  }
}
export function createStorageObjects(options: StorageObjectsOptions): StorageObjects {
  const settings: StorageTransferSettings = {
    chunkBytes: options.chunkBytes ?? STORAGE_TRANSFER_DEFAULTS.chunkBytes,
    timeoutMs: options.timeoutMs ?? STORAGE_TRANSFER_DEFAULTS.timeoutMs,
    leaseSeconds: options.leaseSeconds ?? STORAGE_TRANSFER_DEFAULTS.leaseSeconds,
  };
  if (
    !Number.isSafeInteger(settings.chunkBytes) ||
    settings.chunkBytes < 1 ||
    settings.chunkBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(settings.timeoutMs) ||
    settings.timeoutMs < 1 ||
    settings.timeoutMs > 10_000 ||
    !Number.isSafeInteger(settings.leaseSeconds) ||
    settings.leaseSeconds < 1 ||
    settings.leaseSeconds > 86400
  )
    throw new StorageAccessError(500, 'invalid_settings');
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis: settings.timeoutMs,
    query_timeout: settings.timeoutMs,
    statement_timeout: settings.timeoutMs,
    application_name: 'lifemodel-storage-objects',
  });
  pool.on('error', () => undefined);
  pool.on('connect', (client) => client.on('error', () => undefined));
  async function query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ) {
    try {
      return await pool.query<T>(text, values);
    } catch {
      throw new StorageAccessError(503, 'catalog_unavailable');
    }
  }
  async function answer(res: ServerResponse, stream: StorageTaskStream, value: unknown) {
    const body = JSON.stringify(value);
    await stream.chunk(0, () => {
      res.writeHead(200, JSON_HEADERS);
      res.end(body);
    });
  }
  async function object(space: string, id: string) {
    const result = await query<ObjectRow>(
      `SELECT o.*,a.s3_key,v.receipt FROM storage.objects o JOIN storage.object_versions v ON v.object_id=o.id JOIN storage.upload_attempts a ON a.id=v.attempt_id WHERE o.space_id=$1 AND o.id::text=$2`,
      [space, id]
    );
    const row = result.rows[0];
    if (!row) throw new StorageAccessError(404, 'object_not_found');
    return row;
  }
  return {
    check: async (signal) => {
      if (signal.aborted) return false;
      try {
        await query(
          'SELECT o.id,v.receipt,i.lease_expires_at,a.s3_key,q.reserved_bytes FROM storage.objects o JOIN storage.object_versions v ON v.object_id=o.id JOIN storage.upload_intents i ON i.object_id=o.id JOIN storage.upload_attempts a ON a.id=v.attempt_id JOIN storage.space_quota q ON q.space_id=o.space_id WHERE false'
        );
        const functions = await query<{ ready: boolean }>(
          "SELECT to_regprocedure('storage.reserve_upload(text,text,uuid,text,bigint,text,integer)') IS NOT NULL AND to_regprocedure('storage.complete_upload(text,text,uuid)') IS NOT NULL AND to_regprocedure('storage.release_upload(text,text)') IS NOT NULL AS ready"
        );
        return !signal.aborted && functions.rows[0]?.ready === true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
    expiredUploads: async () => {
      const result = await query<{ space_id: string; upload_id: string }>(
        "SELECT space_id,upload_id FROM storage.upload_intents WHERE state='pending' AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at,space_id,upload_id LIMIT 100"
      );
      return result.rows.map((row) => ({ space: row.space_id, uploadId: row.upload_id }));
    },
    handle: async (req, res, space, tail, stream, recover, progress) => {
      await stream.chunk(0, () => undefined);
      if (
        tail.length > 1024 ||
        tail.split('?')[0]?.includes('%') ||
        tail
          .split('?')[0]
          ?.split('/')
          .some((part) => part === '.' || part === '..')
      )
        invalid();
      const url = new URL(tail, 'https://storage.invalid');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'PUT' && parts.length === 1) {
        if (url.search || !ID.test(parts[0] ?? invalid())) invalid();
        const uploadId = parts[0] ?? invalid();
        const encoded = header(req, 'x-storage-name');
        if (encoded.length > 1366 || !/^[A-Za-z0-9_-]*$/.test(encoded)) invalid();
        const nameBytes = Buffer.from(encoded, 'base64url');
        let name: string;
        try {
          // Display names are exact metadata: a leading BOM is part of the name.
          name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(nameBytes);
        } catch {
          invalid();
        }
        if (
          nameBytes.toString('base64url') !== encoded ||
          !Buffer.from(name, 'utf8').equals(nameBytes)
        )
          invalid();
        validateStorageName(name);
        const length = header(req, 'x-storage-length');
        const sha256 = header(req, 'x-storage-sha256');
        if (
          !/^(0|[1-9][0-9]{0,10})$/.test(length) ||
          Number(length) > 20_000_000_000 ||
          !/^[0-9a-f]{64}$/.test(sha256)
        )
          invalid();
        const size = Number(length);
        try {
          await stream.publish({
            text: 'SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,$7)',
            values: [space, uploadId, randomUUID(), name, size, sha256, settings.leaseSeconds],
          });
          const intents = await query<IntentRow & { reserved: boolean }>(
            'SELECT * FROM storage.upload_intents WHERE space_id=$1 AND upload_id=$2',
            [space, uploadId]
          );
          const intent = intents.rows[0];
          if (!intent) throw new StorageAccessError(507, 'capacity_exhausted');
          if (intent.name !== name || Number(intent.size) !== size || intent.sha256 !== sha256)
            throw new StorageAccessError(409, 'upload_conflict');
          if (intent.state === 'completed') {
            const saved = await object(space, intent.object_id);
            await answer(res, stream, saved.receipt);
            return;
          }
          if (!intent.reserved) throw new StorageAccessError(507, 'capacity_exhausted');
          const attempt = randomUUID();
          const key = `private/${randomUUID()}`;
          await stream.publish({
            text: 'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
            values: [attempt, space, uploadId, key],
          });
          async function* source() {
            let accepted = 0;
            let emitted = 0;
            let pending: Buffer | undefined;
            let filled = 0;
            const hash = createHash('sha256');
            for await (const part of req) {
              stream.signal.throwIfAborted();
              const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
              if (accepted + bytes.length > size)
                throw new StorageAccessError(400, 'length_mismatch');
              accepted += bytes.length;
              hash.update(bytes);
              for (let offset = 0; offset < bytes.length; ) {
                pending ??= Buffer.allocUnsafe(Math.min(settings.chunkBytes, size - emitted));
                const copied = Math.min(bytes.length - offset, pending.length - filled);
                bytes.copy(pending, filled, offset, offset + copied);
                filled += copied;
                offset += copied;
                if (filled === pending.length) {
                  const chunk = pending;
                  pending = undefined;
                  filled = 0;
                  emitted += chunk.length;
                  yield chunk;
                }
              }
            }
            if (accepted !== size) throw new StorageAccessError(400, 'length_mismatch');
            if (hash.digest('hex') !== sha256) throw new StorageAccessError(400, 'hash_mismatch');
          }
          await options.s3.put(
            key,
            size,
            sha256,
            source(),
            stream.signal,
            (bytes, dispatch) => stream.chunk(bytes, dispatch),
            progress
          );
          const publication = await stream.publish({
            text: 'SELECT storage.complete_upload($1,$2,$3) AS status',
            values: [space, uploadId, attempt],
          });
          const status = publication?.rows[0]?.['status'];
          if (status !== 'completed' && status !== 'already_completed')
            throw new StorageAccessError(503, 'completion_failed');
          const saved = await object(space, intent.object_id);
          await answer(res, stream, saved.receipt);
          return;
        } catch (error) {
          // Conflicting metadata did not acquire a reservation and must not
          // cancel an independent matching attempt using this upload ID.
          if (!(error instanceof StorageAccessError && error.code === 'upload_conflict')) {
            let recovery: StorageTaskStream | undefined;
            const release = {
              text: 'SELECT storage.release_upload($1,$2)',
              values: [space, uploadId],
            };
            try {
              // A disconnected/expired request cannot authorize its own cleanup.
              // Re-open with the same identity and space, not a cached decision.
              recovery = stream.signal.aborted ? recover?.() : undefined;
              try {
                await (recovery ?? stream).publish(release);
              } catch (releaseError) {
                // Cancellation can race the live check while the original guard
                // is proving identity. Retry once with an independent bound.
                if (recovery || !stream.signal.aborted || !recover) throw releaseError;
                recovery = recover();
                await recovery.publish(release);
              }
            } catch {
              // Revocation or a catalog outage must fail closed. Keep the safe
              // original outcome; an unreleased intent remains collectible.
            } finally {
              recovery?.close();
            }
          }
          throw error;
        }
      }
      if (req.method === 'GET' && parts.length === 0) {
        if (
          [...url.searchParams.keys()].some((key) => !['cursor', 'limit'].includes(key)) ||
          [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
        )
          invalid();
        const rawLimit = url.searchParams.get('limit') ?? '100';
        if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) invalid();
        const limit = Number(rawLimit);
        const after = url.searchParams.has('cursor')
          ? parseCursor(url.searchParams.get('cursor') ?? invalid(), space)
          : '0';
        const rows = (
          await query<PageRow>(
            'SELECT id,name,size::float8 AS size,sha256,mark,sequence::text FROM storage.objects WHERE space_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
            [space, after, limit]
          )
        ).rows;
        // Names may need JSON escaping. Bound the encoded page as well as rows.
        const page: PageRow[] = [];
        let encodedBytes = 256;
        for (const row of rows) {
          const { sequence: _, ...item } = row;
          const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (encodedBytes + bytes > 64 * 1024) break;
          page.push(row);
          encodedBytes += bytes;
        }
        const objects = page.map(({ sequence: _, ...row }) => row);
        await answer(res, stream, {
          objects,
          nextCursor: cursor(space, page.at(-1)?.sequence ?? after),
        });
        return;
      }
      if (!parts[0] || !ID.test(parts[0]) || url.search) invalid();
      if (req.method === 'GET' && parts.length === 1) {
        const saved = await object(space, parts[0]);
        const size = Number(saved.size);
        let start = 0;
        let end = size - 1;
        const range = req.headers.range;
        if (range !== undefined) {
          const match = /^bytes=(\d{1,11})-(\d{1,11})$/.exec(range);
          if (!match) throw new StorageAccessError(416, 'invalid_range');
          start = Number(match[1]);
          end = Number(match[2]);
          if (start > end || end >= size || end - start + 1 > settings.chunkBytes)
            throw new StorageAccessError(416, 'invalid_range');
        }
        if (size === 0) {
          await stream.chunk(0, () => {
            res.writeHead(200, {
              'content-length': '0',
              'cache-control': 'no-store',
              'x-storage-size': saved.size,
              'x-storage-sha256': saved.sha256,
            });
            res.end();
          });
          return;
        }
        let headers = false;
        for (let offset = start; offset <= end; offset += settings.chunkBytes) {
          const last = Math.min(end, offset + settings.chunkBytes - 1);
          const body = await options.s3.get(saved.s3_key, offset, last, stream.signal, progress);
          let received = 0;
          for await (const part of body) {
            for (let index = 0; index < part.length; index += settings.chunkBytes) {
              const bytes = part.subarray(index, index + settings.chunkBytes);
              received += bytes.length;
              if (received > last - offset + 1)
                throw new StorageAccessError(503, 'backend_unavailable');
              let drained = true;
              await stream.chunk(bytes.length, () => {
                if (!headers) {
                  res.writeHead(range ? 206 : 200, {
                    'content-type': 'application/octet-stream',
                    'content-length': String(end - start + 1),
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                    'x-storage-size': saved.size,
                    'x-storage-sha256': saved.sha256,
                    ...(range
                      ? { 'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}` }
                      : {}),
                  });
                  headers = true;
                }
                drained = res.write(bytes);
              });
              if (!drained && res.writableNeedDrain) {
                if (res.destroyed) throw new StorageAccessError(503, 'transfer_unavailable');
                await once(res, 'drain', { signal: stream.signal });
              }
            }
          }
          if (received !== last - offset + 1)
            throw new StorageAccessError(503, 'backend_unavailable');
        }
        res.end();
        return;
      }
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'mark') {
        await object(space, parts[0]);
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const part of req) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
          length += bytes.length;
          if (length > 128) throw new StorageAccessError(413, 'request_too_large');
          chunks.push(bytes);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          invalid();
        }
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          !('role' in input) ||
          !['artifact', 'result', 'log'].includes(String(input.role))
        )
          invalid();
        await stream.publish({
          text: 'UPDATE storage.objects SET mark=$3 WHERE space_id=$1 AND id::text=$2 AND (mark IS NULL OR mark=$3)',
          values: [space, parts[0], input.role],
        });
        const saved = await object(space, parts[0]);
        if (saved.mark !== input.role) throw new StorageAccessError(409, 'mark_conflict');
        await answer(res, stream, { ...saved.receipt, mark: saved.mark });
        return;
      }
      throw new StorageAccessError(404, 'route_not_found');
    },
  };
}
