/** Private immutable S3 bytes. Only this trusted adapter dispatches upload chunks. */
import { createHash } from 'node:crypto';
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { StorageS3Credentials } from './storage-custody.js';
import { StorageAccessError } from './storage-access-error.js';
import { signS3Request } from './storage-s3.js';

export type StorageObjectS3Guard = (bytes: number, dispatch: () => undefined) => Promise<void>;
export interface StorageObjectS3 {
  put(
    key: string,
    length: number,
    sha256: string,
    source: AsyncIterable<Buffer>,
    signal: AbortSignal,
    guard: StorageObjectS3Guard
  ): Promise<void>;
  get(key: string, start: number, end: number, signal: AbortSignal): Promise<AsyncIterable<Buffer>>;
  close(): void;
}
export interface StorageObjectS3Options {
  endpoint: string;
  bucket: string;
  custody: { read(): Promise<StorageS3Credentials> };
  chunkBytes?: number;
  timeoutMs?: number;
}
const MAX_CHUNK = 4 * 1024 * 1024;
const unavailable = () => new StorageAccessError(503, 'object_store_unavailable');
const invalid = () => new StorageAccessError(400, 'invalid_request');
const ignoreError = (): void => undefined;

export function createStorageObjectS3(options: StorageObjectS3Options): StorageObjectS3 {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw invalid();
  }
  const chunkBytes = options.chunkBytes ?? MAX_CHUNK;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(options.bucket) ||
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > MAX_CHUNK ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_000
  )
    throw invalid();
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
  const active = new Set<() => void>();
  const sockets = new WeakSet<object>();
  let closed = false;
  function path(key: string): URL {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(key) || key.length > 1024) throw invalid();
    return new URL(`/${options.bucket}/${key}`, endpoint);
  }
  function operation(parent: AbortSignal) {
    if (closed || parent.aborted) throw unavailable();
    const controller = new AbortController();
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let done = false;
    const cancel = (): void => {
      controller.abort();
      request?.destroy();
      response?.destroy();
      dispose();
    };
    const timer = setTimeout(cancel, timeoutMs);
    timer.unref();
    parent.addEventListener('abort', cancel, { once: true });
    active.add(cancel);
    function dispose(): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', cancel);
      active.delete(cancel);
    }
    async function wait<T>(promise: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        void promise.catch(ignoreError);
        throw unavailable();
      }
      return new Promise<T>((resolve, reject) => {
        const abort = (): void => {
          reject(unavailable());
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        void promise.then(
          (value) => {
            controller.signal.removeEventListener('abort', abort);
            if (controller.signal.aborted) reject(unavailable());
            else resolve(value);
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', abort);
            reject(error instanceof StorageAccessError ? error : unavailable());
          }
        );
      });
    }
    async function open(
      method: string,
      url: URL,
      headers: Record<string, string>,
      payloadHash?: string
    ) {
      const credentials = await wait(options.custody.read());
      const signed = signS3Request({
        method,
        url,
        credentials,
        now: new Date(),
        headers,
        ...(payloadHash ? { payloadHash } : {}),
      });
      if (controller.signal.aborted) throw unavailable();
      let resolveResponse: (res: IncomingMessage) => void = ignoreError;
      let rejectResponse: (error: Error) => void = ignoreError;
      const received = new Promise<IncomingMessage>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      // A refusal can arrive while the source/guard is awaited. Retain the promise,
      // but attach the rejection listener before dispatch to avoid an unhandled event.
      void received.catch(ignoreError);
      response = undefined;
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        { method, headers: signed, agent: url.protocol === 'https:' ? httpsAgent : httpAgent },
        (res) => {
          response = res;
          res.on('error', ignoreError);
          res.on('aborted', ignoreError);
          resolveResponse(res);
        }
      );
      request = req;
      req.on('error', () => {
        rejectResponse(unavailable());
      });
      req.on('close', () => {
        if (!response) rejectResponse(unavailable());
      });
      req.on('socket', (socket) => {
        if (!sockets.has(socket)) {
          sockets.add(socket);
          socket.on('error', ignoreError);
        }
      });
      return { req, received };
    }
    async function drain(res: IncomingMessage): Promise<void> {
      const iterator = res[Symbol.asyncIterator]();
      while (!(await wait(iterator.next())).done) {
        /* No backend response body escapes. */
      }
    }
    return {
      wait,
      open,
      drain,
      cancel,
      dispose,
      live: () => {
        if (controller.signal.aborted) throw unavailable();
      },
    };
  }
  return {
    async put(key, length, sha256, source, signal, guard) {
      const url = path(key);
      if (!Number.isSafeInteger(length) || length < 0 || !/^[a-f0-9]{64}$/.test(sha256))
        throw invalid();
      const op = operation(signal);
      let iterator: AsyncIterator<Buffer> | undefined;
      try {
        const { req, received } = await op.open(
          'PUT',
          url,
          {
            'content-length': String(length),
            'if-none-match': '*',
            'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
          },
          sha256
        );
        const measured = createHash('sha256');
        let count = 0;
        iterator = source[Symbol.asyncIterator]();
        for (;;) {
          const next = await op.wait(iterator.next());
          if (next.done) break;
          if (!Buffer.isBuffer(next.value) || count + next.value.length > length) throw invalid();
          for (let offset = 0; offset < next.value.length; offset += chunkBytes) {
            const chunk = next.value.subarray(offset, offset + chunkBytes);
            op.live();
            let writable = true;
            // Authority encloses exactly the synchronous socket dispatch. Socket
            // backpressure never retains the caller's decision or database lock.
            await op.wait(
              guard(chunk.length, () => {
                op.live();
                writable = req.write(chunk);
                return undefined;
              })
            );
            measured.update(chunk);
            count += chunk.length;
            if (!writable && req.writableNeedDrain)
              await op.wait(
                new Promise<void>((resolve, reject) => {
                  const cleanup = (): void => {
                    req.removeListener('drain', drained);
                    req.removeListener('error', failed);
                    req.removeListener('close', failed);
                  };
                  const drained = (): void => {
                    cleanup();
                    resolve();
                  };
                  const failed = (): void => {
                    cleanup();
                    reject(unavailable());
                  };
                  req.once('drain', drained);
                  req.once('error', failed);
                  req.once('close', failed);
                  if (req.destroyed) failed();
                })
              );
          }
        }
        if (count !== length || measured.digest('hex') !== sha256) throw invalid();
        op.live();
        req.end();
        const res = await op.wait(received);
        if (res.statusCode !== 200) throw unavailable();
        await op.drain(res);
        const head = await op.open('HEAD', url, { 'x-amz-checksum-mode': 'ENABLED' });
        head.req.end();
        const verified = await op.wait(head.received);
        if (
          verified.statusCode !== 200 ||
          verified.headers['content-length'] !== String(length) ||
          verified.headers['x-amz-checksum-sha256'] !==
            Buffer.from(sha256, 'hex').toString('base64')
        )
          throw unavailable();
        await op.drain(verified);
        op.live();
      } catch (error) {
        op.cancel();
        if (error instanceof StorageAccessError) throw error;
        throw unavailable();
      } finally {
        op.dispose();
        if (iterator?.return) {
          try {
            void Promise.resolve(iterator.return()).catch(ignoreError);
          } catch {
            /* Source teardown cannot replace the safe outcome. */
          }
        }
      }
    },
    async get(key, start, end, signal) {
      const url = path(key);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        !Number.isSafeInteger(end - start + 1)
      )
        throw invalid();
      const op = operation(signal);
      try {
        const { req, received } = await op.open('GET', url, {
          range: `bytes=${String(start)}-${String(end)}`,
        });
        req.end();
        const res = await op.wait(received);
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range'] ?? '');
        if (
          res.statusCode !== 206 ||
          !range ||
          Number(range[1]) !== start ||
          Number(range[2]) !== end ||
          Number(range[3]) <= end ||
          res.headers['content-length'] !== String(end - start + 1)
        )
          throw unavailable();
        return (async function* () {
          let count = 0;
          let emitted = 0;
          let pending: Buffer | undefined;
          let filled = 0;
          let complete = false;
          try {
            const iterator = res[Symbol.asyncIterator]();
            for (;;) {
              op.live();
              const next = await op.wait(iterator.next());
              if (next.done) break;
              const bytes = Buffer.from(next.value);
              if (count + bytes.length > end - start + 1) throw unavailable();
              count += bytes.length;
              for (let offset = 0; offset < bytes.length; ) {
                op.live();
                // TCP fragments are not authorization chunks. Retain at most
                // one bounded output buffer, and fill it before delivery.
                pending ??= Buffer.allocUnsafe(Math.min(chunkBytes, end - start + 1 - emitted));
                const copied = Math.min(bytes.length - offset, pending.length - filled);
                bytes.copy(pending, filled, offset, offset + copied);
                filled += copied;
                offset += copied;
                if (filled === pending.length) {
                  const chunk = pending;
                  pending = undefined;
                  filled = 0;
                  emitted += chunk.length;
                  op.live();
                  yield chunk;
                }
              }
            }
            if (count !== end - start + 1 || filled !== 0) throw unavailable();
            complete = true;
          } catch (error) {
            if (error instanceof StorageAccessError) throw error;
            throw unavailable();
          } finally {
            if (!complete) op.cancel();
            op.dispose();
          }
        })();
      } catch (error) {
        op.cancel();
        op.dispose();
        if (error instanceof StorageAccessError) throw error;
        throw unavailable();
      }
    },
    close() {
      closed = true;
      for (const cancel of [...active]) cancel();
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
