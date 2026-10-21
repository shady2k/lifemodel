/** HTTP S3 boundary double. It verifies SigV4 independently of module signing code. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { StorageS3Credentials } from '../../loader/src/storage-custody.js';

export interface FakeStorageObject {
  bytes: Buffer;
  sha256: string;
}
export interface StorageS3Request {
  method: string;
  key: string;
  headers: IncomingHttpHeaders;
  authorized: boolean;
  bytes: number;
}
export type StorageS3Action =
  | undefined
  | 'hang'
  | 'lose-response'
  | { status: number; headers?: Record<string, string> };
export type StorageS3Hook = (
  request: StorageS3Request
) => StorageS3Action | Promise<StorageS3Action>;
export interface StorageS3Hooks {
  beforePut?: StorageS3Hook;
  afterWrite?: StorageS3Hook;
  beforeHead?: StorageS3Hook;
  beforeGet?: StorageS3Hook;
}

export async function createStorageS3Server(
  options: { credentials?: StorageS3Credentials; bucket?: string } = {}
) {
  const credentials = options.credentials ?? {
    accessKey: 'storageTestAccessKey',
    secretKey: 'storageTestSecretKey0123456789012345',
  };
  const bucket = options.bucket ?? 'lifemodel-storage';
  const objects = new Map<string, FakeStorageObject>();
  const requests: StorageS3Request[] = [];
  const hooks: StorageS3Hooks = {};
  let connections = 0;
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const mac = (key: string | Buffer, value: string) =>
    createHmac('sha256', key).update(value).digest();
  const escape = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
  function verify(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? '';
    const parts =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
        auth
      );
    if (!parts || parts[1] !== credentials.accessKey) return false;
    const [, , day, region, names, signature] = parts;
    if (!day || !region || !names || !signature) return false;
    const stamp = req.headers['x-amz-date'];
    const payload = req.headers['x-amz-content-sha256'];
    if (typeof stamp !== 'string' || typeof payload !== 'string' || stamp.slice(0, 8) !== day)
      return false;
    const fields = names.split(';');
    if (
      fields.join(';') !== [...fields].sort().join(';') ||
      !['host', 'x-amz-date', 'x-amz-content-sha256'].every((n) => fields.includes(n))
    )
      return false;
    const url = new URL(req.url ?? '/', 'http://s3.invalid');
    const query = [...url.searchParams.entries()]
      .map(([k, v]) => `${escape(k)}=${escape(v)}`)
      .sort()
      .join('&');
    const headers = fields
      .map(
        (n) =>
          `${n}:${String(req.headers[n] ?? '')
            .trim()
            .replace(/\s+/g, ' ')}\n`
      )
      .join('');
    const canonical = [req.method, url.pathname, query, headers, names, payload].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const key = mac(
      mac(mac(mac(`AWS4${credentials.secretKey}`, day), region), 's3'),
      'aws4_request'
    );
    const expected = mac(key, ['AWS4-HMAC-SHA256', stamp, scope, hash(canonical)].join('\n'));
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }
  async function action(
    hook: StorageS3Hook | undefined,
    record: StorageS3Request,
    req: IncomingMessage,
    res: ServerResponse,
    defaults: Record<string, string> = {}
  ): Promise<boolean> {
    const result = await hook?.(record);
    if (result === undefined) return false;
    if (result === 'lose-response') req.socket.destroy();
    else if (result !== 'hang') {
      res.writeHead(result.status, { ...defaults, ...result.headers });
      res.end('private backend error body');
    }
    return true;
  }
  const server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://s3.invalid');
      const prefix = `/${bucket}/`;
      const record: StorageS3Request = {
        method: req.method ?? '',
        key: decodeURIComponent(url.pathname.slice(prefix.length)),
        headers: { ...req.headers },
        authorized: verify(req),
        bytes: 0,
      };
      requests.push(record);
      if (!record.authorized || !url.pathname.startsWith(prefix)) {
        res.writeHead(403);
        res.end('private credentials rejected');
        return;
      }
      if (req.method === 'PUT') {
        if (await action(hooks.beforePut, record, req, res)) return;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk);
          record.bytes += bytes.length;
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (
          hash(bytes) !== req.headers['x-amz-content-sha256'] ||
          createHash('sha256').update(bytes).digest('base64') !==
            req.headers['x-amz-checksum-sha256']
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        if (req.headers['if-none-match'] !== '*' || objects.has(record.key)) {
          res.writeHead(412);
          res.end();
          return;
        }
        objects.set(record.key, { bytes, sha256: hash(bytes) });
        if (await action(hooks.afterWrite, record, req, res)) return;
        res.writeHead(200);
        res.end();
        return;
      }
      const object = objects.get(record.key);
      if (!object) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        const headers = {
          'content-length': String(object.bytes.length),
          ...(req.headers['x-amz-checksum-mode'] === 'ENABLED'
            ? { 'x-amz-checksum-sha256': Buffer.from(object.sha256, 'hex').toString('base64') }
            : {}),
        };
        if (await action(hooks.beforeHead, record, req, res, headers)) return;
        res.writeHead(200, headers);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        if (await action(hooks.beforeGet, record, req, res)) return;
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
        const start = Number(range?.[1]);
        const end = Number(range?.[2]);
        if (!range || start > end || end >= object.bytes.length) {
          res.writeHead(416);
          res.end();
          return;
        }
        const bytes = object.bytes.subarray(start, end + 1);
        res.writeHead(206, {
          'content-length': String(bytes.length),
          'content-range': `bytes ${start}-${end}/${object.bytes.length}`,
        });
        res.end(bytes);
        return;
      }
      res.writeHead(405);
      res.end();
    })().catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
  server.on('error', () => undefined);
  server.on('connection', (socket) => {
    connections++;
    socket.on('error', () => undefined);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake S3 listen failed');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    credentials,
    bucket,
    objects,
    requests,
    hooks,
    reset() {
      objects.clear();
      requests.splice(0);
      for (const key of Object.keys(hooks) as Array<keyof StorageS3Hooks>) delete hooks[key];
    },
    get connections() {
      return connections;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const createFakeStorageS3 = createStorageS3Server;
