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
import type { LoaderLogger } from './logger.js';
import { StorageAccessError } from './storage-access-error.js';
import { signS3Request } from './storage-s3.js';

/** Retained core reads remain authorized across seal and do not join its barrier. */
export type StorageObjectS3Lifecycle = 'space' | 'retained-read';
export type StorageObjectS3Guard = (bytes: number, dispatch: () => undefined) => Promise<void>;
export interface StorageObjectS3Listing {
  objects: { key: string; size: number; lastModified: number }[];
  nextCursor: string | null;
}
export interface StorageObjectS3 {
  /** One bounded bucket page, restricted to the module's opaque private keys. */
  listPrivate(cursor: string | undefined, signal: AbortSignal): Promise<StorageObjectS3Listing>;
  put(
    space: string,
    key: string,
    length: number,
    sha256: string,
    source: AsyncIterable<Buffer>,
    signal: AbortSignal,
    guard: StorageObjectS3Guard,
    onProgress?: () => void
  ): Promise<void>;
  get(
    space: string,
    key: string,
    start: number,
    end: number,
    signal: AbortSignal,
    onProgress?: () => void,
    lifecycle?: StorageObjectS3Lifecycle
  ): Promise<AsyncIterable<Buffer>>;
  verify(
    space: string,
    key: string,
    length: number,
    sha256: string,
    signal: AbortSignal
  ): Promise<void>;
  delete(space: string, key: string, signal: AbortSignal): Promise<void>;
  /** Await task/collector operations and real request closure, never retained core reads. */
  settle(space: string, signal: AbortSignal): Promise<void>;
  close(): void;
}
export interface StorageObjectS3Options {
  endpoint: string;
  bucket: string;
  custody: { read(): Promise<StorageS3Credentials> };
  logger?: Pick<LoaderLogger, 'warn'>;
  chunkBytes?: number;
  timeoutMs?: number;
}
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_LIST_BYTES = 128 * 1024;
const MAX_CURSOR_BYTES = 4096;
const PRIVATE_KEY = /^private\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validCursor(cursor: string): boolean {
  if (cursor.length === 0 || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) return false;
  for (const character of cursor) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x20 || (point >= 0x7f && point <= 0x9f) || (point >= 0xd800 && point <= 0xdfff))
      return false;
  }
  return true;
}
const unavailable = () => new StorageAccessError(503, 'object_store_unavailable');
const invalid = () => new StorageAccessError(400, 'invalid_request');
const ignoreError = (): void => undefined;

interface ListXmlNode {
  name: string;
  text: string;
  children: ListXmlNode[];
}
/** A deliberately small XML subset: no DTD, external entities, CDATA or processing instructions. */
function parsePrivateListing(body: string): StorageObjectS3Listing & { skipped: number } {
  function fail(): never {
    throw unavailable();
  }
  function decode(text: string): string {
    return text.replace(
      /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);|&/g,
      (_entity, name: string | undefined) => {
        if (name === 'amp') return '&';
        if (name === 'lt') return '<';
        if (name === 'gt') return '>';
        if (name === 'quot') return '"';
        if (name === 'apos') return "'";
        if (!name || !/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) return fail();
        const point = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        if (
          !Number.isSafeInteger(point) ||
          !(
            point === 9 ||
            point === 10 ||
            point === 13 ||
            (point >= 0x20 && point <= 0xd7ff) ||
            (point >= 0xe000 && point <= 0xfffd) ||
            (point >= 0x10000 && point <= 0x10ffff)
          )
        )
          return fail();
        return String.fromCodePoint(point);
      }
    );
  }
  for (const character of body) {
    const point = character.codePointAt(0) ?? 0;
    if (
      (point < 0x20 && point !== 9 && point !== 10 && point !== 13) ||
      point === 0xfffe ||
      point === 0xffff
    )
      fail();
  }
  // Only the standard XML declaration may precede the one document element.
  body = body.replace(
    /^\ufeff?\s*<\?xml version=(["'])1\.0\1(?: encoding=(["'])UTF-8\2)?\s*\?>/i,
    ''
  );
  const document: ListXmlNode = { name: '', text: '', children: [] };
  const stack = [document];
  let offset = 0;
  let nodes = 0;
  while (offset < body.length) {
    const parent = stack[stack.length - 1];
    if (!parent) fail();
    if (body[offset] !== '<') {
      const end = body.indexOf('<', offset);
      const text = body.slice(offset, end < 0 ? body.length : end);
      if (text.includes(']]>')) fail();
      parent.text += decode(text);
      offset += text.length;
      continue;
    }
    const end = body.indexOf('>', offset);
    if (end < 0) fail();
    const token = body.slice(offset + 1, end);
    if (token.startsWith('/')) {
      if (stack.length < 2 || token !== `/${parent.name}`) fail();
      stack.pop();
    } else {
      const tag =
        /^([A-Za-z][A-Za-z0-9]*)(?:\s+xmlns=(["'])http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/\2)?\s*(\/?)$/.exec(
          token
        );
      if (
        !tag ||
        (token.includes('xmlns') && stack.length !== 1) ||
        ++nodes > 2500 ||
        stack.length > 8
      )
        fail();
      const node: ListXmlNode = { name: tag[1] ?? '', text: '', children: [] };
      parent.children.push(node);
      if (!tag[3]) stack.push(node);
    }
    offset = end + 1;
  }
  if (stack.length !== 1 || document.text.trim() || document.children.length !== 1) fail();
  const root = document.children[0];
  if (root?.name !== 'ListBucketResult' || root.text.trim()) fail();
  function field(parent: ListXmlNode, name: string, required = true): string | undefined {
    const matches = parent.children.filter((child) => child.name === name);
    if (matches.length > 1 || (required && matches.length !== 1)) fail();
    const node = matches[0];
    if (node?.children.length) fail();
    return node?.text;
  }
  const prefix = field(root, 'Prefix', false);
  const maxKeys = field(root, 'MaxKeys', false);
  if (
    (prefix !== undefined && prefix !== 'private/') ||
    (maxKeys !== undefined && maxKeys !== '100')
  )
    fail();
  const truncated = field(root, 'IsTruncated');
  const cursor = field(root, 'NextContinuationToken', false);
  if (truncated !== 'true' && truncated !== 'false') fail();
  if (truncated === 'true' ? cursor === undefined || !validCursor(cursor) : cursor !== undefined)
    fail();
  const contents = root.children.filter((child) => child.name === 'Contents');
  if (contents.length > 100) fail();
  const keyCount = field(root, 'KeyCount', false);
  // KeyCount describes the wire page, including entries that are not ours to collect.
  if (keyCount !== undefined && keyCount !== String(contents.length)) fail();
  const keys = new Set<string>();
  const objects: StorageObjectS3Listing['objects'] = [];
  let skipped = 0;
  for (const entry of contents) {
    if (entry.text.trim()) fail();
    // Missing or invalid values affect this entry only. Duplicate/nested fields
    // still indicate structural damage and must fail the complete page.
    const key = field(entry, 'Key', false);
    const rawSize = field(entry, 'Size', false);
    const rawDate = field(entry, 'LastModified', false);
    if (key !== undefined) {
      if (keys.has(key)) fail();
      keys.add(key);
    }
    const size = rawSize === undefined ? NaN : Number(rawSize);
    const lastModified = rawDate === undefined ? NaN : Date.parse(rawDate);
    // ISO UTC timestamps only; Date.parse alone normalizes invalid dates such as February 30.
    if (
      key === undefined ||
      !PRIVATE_KEY.test(key) ||
      rawSize === undefined ||
      !/^(?:0|[1-9][0-9]*)$/.test(rawSize) ||
      !Number.isSafeInteger(size) ||
      rawDate === undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(rawDate) ||
      !Number.isSafeInteger(lastModified) ||
      lastModified < 0 ||
      new Date(lastModified).toISOString().slice(0, 19) !== rawDate.slice(0, 19)
    ) {
      skipped += 1;
      continue;
    }
    objects.push({ key, size, lastModified });
  }
  return { objects, nextCursor: cursor ?? null, skipped };
}

export interface StorageObjectS3TransportSnapshot {
  put: { sockets: number; observedSockets: number; limit: number };
  read: { sockets: number; observedSockets: number; limit: number };
  control: { sockets: number; observedSockets: number; limit: number };
}

export function createStorageObjectS3(options: StorageObjectS3Options): StorageObjectS3 & {
  /** Numeric transport pressure only; never exposes keys, credentials or endpoints. */
  transportSnapshot(): StorageObjectS3TransportSnapshot;
} {
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
  // A PUT stays open across chunk turns. Its socket must not block the GET
  // reserve or control HEAD/DELETE, nor invert chunk/socket acquisition order.
  // 40 is the hard 8-active + 32-queued admission ceiling, not 40 byte buffers.
  const agents = {
    put: {
      http: new HttpAgent({
        keepAlive: true,
        maxSockets: 40,
        maxTotalSockets: 40,
        maxFreeSockets: 2,
      }),
      https: new HttpsAgent({
        keepAlive: true,
        maxSockets: 40,
        maxTotalSockets: 40,
        maxFreeSockets: 2,
      }),
    },
    read: {
      http: new HttpAgent({
        keepAlive: true,
        maxSockets: 8,
        maxTotalSockets: 8,
        maxFreeSockets: 2,
      }),
      https: new HttpsAgent({
        keepAlive: true,
        maxSockets: 8,
        maxTotalSockets: 8,
        maxFreeSockets: 2,
      }),
    },
    control: {
      http: new HttpAgent({
        keepAlive: true,
        maxSockets: 2,
        maxTotalSockets: 2,
        maxFreeSockets: 2,
      }),
      https: new HttpsAgent({
        keepAlive: true,
        maxSockets: 2,
        maxTotalSockets: 2,
        maxFreeSockets: 2,
      }),
    },
  };
  for (const pair of Object.values(agents))
    for (const agent of Object.values(pair)) agent.on('error', ignoreError);
  const transportSockets = {
    put: new Set<object>(),
    read: new Set<object>(),
    control: new Set<object>(),
  };
  const observedSockets = { put: 0, read: 0, control: 0 };
  const active = new Set<() => void>();
  const pendingBySpace = new Map<string, Set<Promise<void>>>();
  function track(space: string, lifecycle: StorageObjectS3Lifecycle) {
    const pending =
      lifecycle === 'space'
        ? (pendingBySpace.get(space) ?? new Set<Promise<void>>())
        : new Set<Promise<void>>();
    let resolve: () => void = ignoreError;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    pending.add(promise);
    if (lifecycle === 'space') pendingBySpace.set(space, pending);
    return {
      promise,
      complete: () => {
        pending.delete(promise);
        if (!pending.size && pendingBySpace.get(space) === pending) pendingBySpace.delete(space);
        resolve();
      },
    };
  }
  const sockets = new WeakSet<object>();
  let closed = false;
  function path(key: string): URL {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(key) || key.length > 1024) throw invalid();
    return new URL(`/${options.bucket}/${key}`, endpoint);
  }
  function operation(
    space: string,
    parent: AbortSignal,
    onProgress?: () => void,
    lifecycle: StorageObjectS3Lifecycle = 'space'
  ) {
    if (closed || parent.aborted) throw unavailable();
    // Track before the custody await: no ClientRequest exists yet, but this
    // operation can still dispatch one unless it completes or is cancelled.
    const ongoing = track(space, lifecycle);
    const controller = new AbortController();
    const requests = new Set<ClientRequest>();
    const requestClosures: Promise<void>[] = [];
    let response: IncomingMessage | undefined;
    let done = false;
    const cancel = (): void => {
      controller.abort();
      for (const request of requests) request.destroy();
      response?.destroy();
      dispose();
    };
    let timer = setTimeout(cancel, timeoutMs);
    timer.unref();
    function progress(): void {
      if (done || controller.signal.aborted) throw unavailable();
      clearTimeout(timer);
      timer = setTimeout(cancel, timeoutMs);
      timer.unref();
      onProgress?.();
    }
    parent.addEventListener('abort', cancel, { once: true });
    active.add(cancel);
    function dispose(): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', cancel);
      active.delete(cancel);
      ongoing.complete();
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
      const pool = method === 'PUT' ? 'put' : method === 'GET' ? 'read' : 'control';
      const pair = agents[pool];
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        { method, headers: signed, agent: url.protocol === 'https:' ? pair.https : pair.http },
        (res) => {
          response = res;
          res.on('error', ignoreError);
          res.on('aborted', ignoreError);
          resolveResponse(res);
        }
      );
      requests.add(req);
      // Register before returning the request: cancellation is not settlement.
      // ClientRequest close also fires on normal completion with a pooled socket;
      // waiting for the reusable socket itself would block successful transfers.
      const closure = track(space, lifecycle);
      req.once('close', () => {
        requests.delete(req);
        closure.complete();
      });
      // Keep this independent of the operation lifetime: an operation timeout
      // must not turn an unclosed transport into successful seal cleanup.
      requestClosures.push(closure.promise);
      req.on('error', () => {
        rejectResponse(unavailable());
      });
      req.on('close', () => {
        if (!response) rejectResponse(unavailable());
      });
      req.on('socket', (socket) => {
        const live = transportSockets[pool];
        if (!live.has(socket)) {
          live.add(socket);
          observedSockets[pool] = Math.max(observedSockets[pool], live.size);
          socket.once('close', () => live.delete(socket));
        }
        if (!sockets.has(socket)) {
          sockets.add(socket);
          socket.on('error', ignoreError);
        }
      });
      return { req, received };
    }
    async function settle(): Promise<void> {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(requestClosures),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              cancel();
              reject(new StorageAccessError(503, 'cleanup_pending'));
            }, 5_000);
            deadline.unref();
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    }
    async function drain(res: IncomingMessage): Promise<void> {
      const iterator = res[Symbol.asyncIterator]();
      while (!(await wait(iterator.next())).done) {
        // Discard error/empty response bodies without treating arbitrary body
        // fragments as successful transfer progress.
      }
    }
    async function verify(url: URL, length: number, sha256: string): Promise<void> {
      const head = await open('HEAD', url, { 'x-amz-checksum-mode': 'ENABLED' });
      head.req.end();
      const verified = await wait(head.received);
      if (verified.statusCode === 404) throw new StorageAccessError(503, 'checksum_mismatch');
      if (verified.statusCode !== 200) throw unavailable();
      if (
        verified.headers['content-length'] !== String(length) ||
        verified.headers['x-amz-checksum-sha256'] !== Buffer.from(sha256, 'hex').toString('base64')
      )
        throw new StorageAccessError(503, 'checksum_mismatch');
      progress();
      await drain(verified);
      if (controller.signal.aborted) throw unavailable();
    }
    return {
      wait,
      progress,
      open,
      drain,
      verify,
      cancel,
      dispose,
      settle,
      live: () => {
        if (controller.signal.aborted) throw unavailable();
      },
    };
  }
  return {
    transportSnapshot() {
      const snapshot = (pool: keyof typeof agents) => ({
        sockets: transportSockets[pool].size,
        observedSockets: observedSockets[pool],
        limit: agents[pool][endpoint.protocol === 'https:' ? 'https' : 'http'].maxTotalSockets,
      });
      return { put: snapshot('put'), read: snapshot('read'), control: snapshot('control') };
    },
    async listPrivate(cursor, signal) {
      if (cursor !== undefined && !validCursor(cursor)) throw invalid();
      const url = new URL(`/${options.bucket}/`, endpoint);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', 'private/');
      url.searchParams.set('max-keys', '100');
      if (cursor !== undefined) url.searchParams.set('continuation-token', cursor);
      // Listing has its own operation scope. It must never hold a space's seal barrier.
      const op = operation('bucket-list', signal);
      try {
        const { req, received } = await op.open('GET', url, {});
        req.end();
        const res = await op.wait(received);
        if (res.statusCode !== 200) throw unavailable();
        const length = res.headers['content-length'];
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_LIST_BYTES))
          throw unavailable();
        const chunks: Buffer[] = [];
        let bytes = 0;
        const iterator = res[Symbol.asyncIterator]();
        for (;;) {
          const next = await op.wait(iterator.next());
          if (next.done) break;
          const value: unknown = next.value;
          if (!(value instanceof Uint8Array)) throw unavailable();
          const chunk = Buffer.from(value);
          bytes += chunk.length;
          if (bytes > MAX_LIST_BYTES) throw unavailable();
          chunks.push(chunk);
          // Keep the original operation deadline: a trickling XML body cannot extend it.
        }
        op.live();
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        const { skipped, ...page } = parsePrivateListing(body);
        if (page.nextCursor !== null && page.nextCursor === cursor) throw unavailable();
        if (skipped > 0)
          options.logger?.warn(
            { code: 'object_key_skipped', count: skipped },
            'storage object listing skipped invalid entries'
          );
        return page;
      } catch (error) {
        op.cancel();
        if (error instanceof StorageAccessError) throw error;
        throw unavailable();
      } finally {
        op.dispose();
        await op.settle();
      }
    },
    async put(space, key, length, sha256, source, signal, guard, onProgress) {
      const url = path(key);
      if (!Number.isSafeInteger(length) || length < 0 || !/^[a-f0-9]{64}$/.test(sha256))
        throw invalid();
      const op = operation(space, signal, onProgress);
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
          let next: IteratorResult<Buffer> | undefined = await op.wait(iterator.next());
          if (next.done) break;
          if (!Buffer.isBuffer(next.value) || count + next.value.length > length) throw invalid();
          for (let offset = 0; offset < next.value.length; offset += chunkBytes) {
            const chunk = next.value.subarray(offset, offset + chunkBytes);
            op.live();
            let written: Promise<void> | undefined;
            // Authority encloses exactly the synchronous socket dispatch. Await
            // the write callback outside SQL, even below the high-water mark:
            // only then can the next acquisition forget this chunk's buffer.
            await op.wait(
              guard(chunk.length, () => {
                op.live();
                written = new Promise<void>((resolve, reject) => {
                  req.write(chunk, (error) => {
                    if (error) reject(unavailable());
                    else resolve();
                  });
                });
                void written.catch(ignoreError);
                return undefined;
              })
            );
            if (!written) throw unavailable();
            await op.wait(written);
            op.progress();
            measured.update(chunk);
            count += chunk.length;
          }
          // Drop dispatched bytes before the source rejoins its metadata queue.
          next = undefined;
        }
        if (count !== length || measured.digest('hex') !== sha256) throw invalid();
        op.live();
        req.end();
        const res = await op.wait(received);
        if (res.statusCode !== 200) throw unavailable();
        op.progress();
        await op.drain(res);
        await op.verify(url, length, sha256);
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
        // Preserve the transfer outcome unless transport settlement itself times
        // out: that is cleanup_pending, never evidence that a DELETE is safe.
        await op.settle();
      }
    },
    async get(space, key, start, end, signal, onProgress, lifecycle = 'space') {
      const url = path(key);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        !Number.isSafeInteger(end - start + 1)
      )
        throw invalid();
      const op = operation(space, signal, onProgress, lifecycle);
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
        op.progress();
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
                  op.progress();
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
            await op.settle();
          }
        })();
      } catch (error) {
        op.cancel();
        op.dispose();
        await op.settle();
        if (error instanceof StorageAccessError) throw error;
        throw unavailable();
      }
    },
    async verify(space, key, length, sha256, signal) {
      const url = path(key);
      if (!Number.isSafeInteger(length) || length < 0 || !/^[a-f0-9]{64}$/.test(sha256))
        throw invalid();
      const op = operation(space, signal);
      try {
        await op.verify(url, length, sha256);
      } catch (error) {
        op.cancel();
        if (error instanceof StorageAccessError) throw error;
        throw unavailable();
      } finally {
        op.dispose();
        await op.settle();
      }
    },
    async delete(space, key, signal) {
      const url = path(key);
      const op = operation(space, signal);
      try {
        const { req, received } = await op.open('DELETE', url, {});
        req.end();
        const res = await op.wait(received);
        if (res.statusCode !== 200 && res.statusCode !== 204 && res.statusCode !== 404)
          throw unavailable();
        op.progress();
        await op.drain(res);
        op.live();
      } catch (error) {
        op.cancel();
        if (error instanceof StorageAccessError) throw error;
        throw unavailable();
      } finally {
        op.dispose();
        await op.settle();
      }
    },
    async settle(space, signal) {
      if (signal.aborted) throw new StorageAccessError(503, 'cleanup_pending');
      // Re-read after each batch: a custody await may become a transport while
      // this barrier waits, and every such request must close before cleanup.
      while (pendingBySpace.has(space)) {
        const pending = [...(pendingBySpace.get(space) ?? [])];
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            signal.removeEventListener('abort', abort);
            reject(new StorageAccessError(503, 'cleanup_pending'));
          };
          signal.addEventListener('abort', abort, { once: true });
          void Promise.all(pending).then(() => {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) reject(new StorageAccessError(503, 'cleanup_pending'));
            else resolve();
          });
        });
      }
    },
    close() {
      closed = true;
      for (const cancel of [...active]) cancel();
      for (const pair of Object.values(agents))
        for (const agent of Object.values(pair)) agent.destroy();
    },
  };
}
