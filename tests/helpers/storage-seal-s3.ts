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
  lastModified?: number;
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
  | { status: number; headers?: Record<string, string>; body?: string };
export type StorageS3Hook = (
  request: StorageS3Request
) => StorageS3Action | Promise<StorageS3Action>;
export interface StorageS3Hooks {
  beforeBucketCheck?: StorageS3Hook;
  beforePut?: StorageS3Hook;
  beforeCommit?: StorageS3Hook;
  duringPut?: (request: StorageS3Request, closed: Promise<void>) => Promise<void>;
  afterWrite?: StorageS3Hook;
  beforeHead?: StorageS3Hook;
  beforeGet?: StorageS3Hook;
  beforeList?: StorageS3Hook;
  beforeDelete?: StorageS3Hook;
  afterDelete?: StorageS3Hook;
}

export async function createSealS3(
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
      res.end(result.body ?? 'private backend error body');
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
      if (record.authorized && req.method === 'GET' && url.pathname === `/${bucket}`) {
        if (await action(hooks.beforeBucketCheck, record, req, res)) return;
      }
      if (!record.authorized || !url.pathname.startsWith(prefix)) {
        res.writeHead(403);
        res.end('private credentials rejected');
        return;
      }
      if (req.method === 'PUT') {
        if (await action(hooks.beforePut, record, req, res)) return;
        const chunks: Buffer[] = [];
        const closed = hooks.duringPut
          ? new Promise<void>((resolve) => req.socket.once('close', () => resolve()))
          : Promise.resolve();
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk);
          record.bytes += bytes.length;
          chunks.push(bytes);
          await hooks.duringPut?.(record, closed);
          if (req.destroyed) return;
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
        // Model an accepted, fully-read backend PUT whose commit can outlive
        // cancellation of the module's TCP connection.
        if (await action(hooks.beforeCommit, record, req, res)) return;
        objects.set(record.key, { bytes, sha256: hash(bytes), lastModified: Date.now() });
        if (await action(hooks.afterWrite, record, req, res)) return;
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        if (await action(hooks.beforeDelete, record, req, res)) return;
        objects.delete(record.key);
        if (await action(hooks.afterDelete, record, req, res)) return;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === prefix && url.searchParams.has('list-type')) {
        if (await action(hooks.beforeList, record, req, res)) return;
        const cursor = url.searchParams.get('continuation-token');
        const after =
          cursor === null ? undefined : Buffer.from(cursor, 'base64url').toString('utf8');
        if (
          url.searchParams.get('list-type') !== '2' ||
          url.searchParams.get('prefix') !== 'private/' ||
          url.searchParams.get('max-keys') !== '100' ||
          [...url.searchParams.keys()].some(
            (key) => !['list-type', 'prefix', 'max-keys', 'continuation-token'].includes(key)
          ) ||
          (cursor !== null && (Buffer.from(after ?? '').toString('base64url') !== cursor || !after))
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith('private/') && (after === undefined || key > after))
          .sort();
        const page = keys.slice(0, 100);
        const truncated = keys.length > page.length;
        const xml = (value: string) =>
          value.replace(/[&<>"']/g, (character) => {
            if (character === '&') return '&amp;';
            if (character === '<') return '&lt;';
            if (character === '>') return '&gt;';
            if (character === '"') return '&quot;';
            return '&apos;';
          });
        const body =
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          `<Name>${xml(bucket)}</Name><Prefix>private/</Prefix><MaxKeys>100</MaxKeys>` +
          `<KeyCount>${page.length}</KeyCount><IsTruncated>${String(truncated)}</IsTruncated>` +
          page
            .map((key) => {
              const object = objects.get(key);
              if (!object) throw new Error('missing fake object');
              object.lastModified ??= Date.now();
              return (
                `<Contents><Key>${xml(key)}</Key><Size>${object.bytes.length}</Size>` +
                `<LastModified>${new Date(object.lastModified).toISOString()}</LastModified></Contents>`
              );
            })
            .join('') +
          (truncated
            ? `<NextContinuationToken>${Buffer.from(page[page.length - 1] ?? '').toString('base64url')}</NextContinuationToken>`
            : '') +
          '</ListBucketResult>';
        res.writeHead(200, {
          'content-type': 'application/xml',
          'content-length': String(Buffer.byteLength(body)),
        });
        res.end(body);
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
