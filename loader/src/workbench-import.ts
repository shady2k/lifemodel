/** Release-pinned, byte-identical OCI import. No registry errors or credentials escape this boundary. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PlatformPhaseError, type PlatformPhase } from './platform-bootstrap.js';

import type { WorkbenchImportDetail, WorkbenchImportStep } from './workbench-status.js';

const REPOSITORY =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];
const INDEX_TYPES = new Set([MANIFEST_TYPES[0], MANIFEST_TYPES[2]]);

export interface WorkbenchImportOptions {
  pinnedDigest: string;
  readSource(): Promise<{
    registry: string;
    repository: string;
    username?: string;
    password?: string;
  }>;
  readCredential(): Promise<{ username: string; password: string }>;
  destinationOrigin?: string;
  destinationRepository?: string;
  /** Explicit loopback HTTP transport override for tests; the configured HTTPS source is still validated. */
  originRegistry?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  phaseTimeoutMs?: number;
  maxManifestBytes?: number;
  /** Raw manifest bytes retained across the recursive traversal (parsed JSON adds overhead). */
  maxActiveManifestBytes?: number;
  maxBlobBytes?: number;
  /** Includes origin downloads and destination read-back, not just final image size. */
  maxTotalBytes?: number;
  maxObjects?: number;
  /** Dedicated disk-backed directory. Abandoned files are removed on the next run. */
  tempDirectory?: string;
}

type Reason =
  | 'configuration'
  | 'credential'
  | 'unauthorized'
  | 'unavailable'
  | 'source-missing'
  | 'rejected'
  | 'deadline'
  | 'aborted'
  | 'redirect'
  | 'digest-mismatch'
  | 'size-limit'
  | 'manifest'
  | 'protocol';
export class WorkbenchImportFailure extends PlatformPhaseError {
  constructor(
    reason: Reason,
    readonly detail: WorkbenchImportDetail
  ) {
    super('workbench-import', `workbench-import:${reason}`);
  }
}
function failure(reason: Reason): PlatformPhaseError {
  return new PlatformPhaseError('workbench-import', `workbench-import:${reason}`);
}
/** Error messages, custom names and arbitrary code strings can contain credentials. */
export function workbenchErrorDetail(
  error: unknown
): Pick<WorkbenchImportDetail, 'errorName' | 'errorCode'> {
  const names = new Set([
    'Error',
    'TypeError',
    'SyntaxError',
    'RangeError',
    'ReferenceError',
    'URIError',
    'EvalError',
    'AggregateError',
  ]);
  const codes = new Set([
    ...Object.keys(constants.errno),
    'ENOTFOUND',
    'EAI_AGAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]);
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return {
    ...(error instanceof Error ? { errorName: names.has(error.name) ? error.name : 'Error' } : {}),
    ...(typeof code === 'string' && codes.has(code) ? { errorCode: code } : {}),
  };
}
/** Re-project injected status too: accept only protocol metadata, not arbitrary strings. */
export function safeWorkbenchImportDetail(value: unknown): WorkbenchImportDetail | undefined {
  if (!record(value)) return undefined;
  const steps = [
    'preparation',
    'source-manifest',
    'source-blob',
    'source-authentication',
    'destination-check',
    'destination-upload',
    'destination-manifest-write',
    'read-back-verify',
  ];
  if (
    typeof value['step'] !== 'string' ||
    !steps.includes(value['step']) ||
    (value['side'] !== 'source' && value['side'] !== 'destination')
  )
    return undefined;
  const detail: WorkbenchImportDetail = {
    step: value['step'] as WorkbenchImportStep,
    side: value['side'],
  };
  if (typeof value['digest'] === 'string' && DIGEST.test(value['digest']))
    detail.digest = value['digest'];
  if (
    typeof value['status'] === 'number' &&
    Number.isInteger(value['status']) &&
    value['status'] >= 100 &&
    value['status'] <= 599
  )
    detail.status = value['status'];
  if (value['side'] === 'source') {
    if (typeof value['sourceOrigin'] === 'string') {
      try {
        detail.sourceOrigin = parseOrigin(value['sourceOrigin']).origin;
      } catch {
        /* Invalid location is private. */
      }
    }
    if (typeof value['sourceRepository'] === 'string' && REPOSITORY.test(value['sourceRepository']))
      detail.sourceRepository = value['sourceRepository'];
  }
  const error = Object.assign(new Error(), { name: value['errorName'], code: value['errorCode'] });
  Object.assign(detail, workbenchErrorDetail(error));
  if (value['errorName'] === undefined) delete detail.errorName;
  return detail;
}
/** Only bounded protocol metadata crosses the import boundary, never URLs or response bodies. */
export class WorkbenchDestinationRejection extends WorkbenchImportFailure {
  readonly mediaType: string;
  constructor(
    readonly status: number,
    mediaType: string | undefined,
    detail: WorkbenchImportDetail
  ) {
    super('rejected', detail);
    this.mediaType =
      mediaType !== undefined && [...MANIFEST_TYPES, 'application/octet-stream'].includes(mediaType)
        ? mediaType
        : 'none';
  }
}
interface Descriptor {
  digest: string;
  size: number;
}
interface Result {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
  digest: string;
  size: number;
}
interface RequestOptions {
  step?: WorkbenchImportStep;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | { path: string; size: number };
  limit?: number;
  file?: string;
  discard?: boolean;
}

/** Copies child manifests before their parent and verifies the complete destination graph. */
export function createWorkbenchImportPhase(options: WorkbenchImportOptions): PlatformPhase {
  return {
    name: 'workbench-import',
    run: async () => {
      const controller = new AbortController();
      let phaseExpired = false;
      const abort = () => {
        controller.abort();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) controller.abort();
      const phaseTimer = setTimeout(
        () => {
          phaseExpired = true;
          controller.abort();
        },
        options.phaseTimeoutMs ?? 30 * 60_000
      );
      const temporary = options.tempDirectory ?? join(tmpdir(), 'lifemodel-workbench-import');
      let workspace: string | undefined;
      let detail: WorkbenchImportDetail = {
        step: 'preparation',
        side: 'source',
        ...(DIGEST.test(options.pinnedDigest) ? { digest: options.pinnedDigest } : {}),
      };
      let sourceOrigin: string | undefined;
      let detailSourceRepository: string | undefined;
      function context(
        step: WorkbenchImportStep,
        side: 'source' | 'destination',
        digest: string
      ): void {
        detail = {
          step,
          side,
          digest,
          ...(side === 'source' && sourceOrigin !== undefined ? { sourceOrigin } : {}),
          ...(side === 'source' && detailSourceRepository !== undefined
            ? { sourceRepository: detailSourceRepository }
            : {}),
        };
      }
      function failure(reason: Reason): WorkbenchImportFailure {
        return new WorkbenchImportFailure(reason, { ...detail });
      }
      try {
        if (!DIGEST.test(options.pinnedDigest)) throw failure('configuration');
        const pinnedDigest = options.pinnedDigest;
        const configuredSource = await readSource();
        const configuredOrigin = parseOrigin(configuredSource.registry);
        const source =
          options.originRegistry === undefined
            ? configuredOrigin
            : parseOrigin(options.originRegistry);
        if (options.originRegistry !== undefined && !loopback(source))
          throw failure('configuration');
        sourceOrigin = configuredOrigin.origin;
        const sourceRepository = configuredSource.repository;
        detailSourceRepository = sourceRepository;
        const destination = parseOrigin(
          options.destinationOrigin ?? 'http://zot.lifemodel-system.svc:5001'
        );
        const repository = options.destinationRepository ?? 'lifemodel/workbench';
        if (!REPOSITORY.test(repository)) throw failure('configuration');
        const timeoutMs = options.requestTimeoutMs ?? 120_000;
        const manifestLimit = options.maxManifestBytes ?? 1024 * 1024;
        const activeManifestLimit = options.maxActiveManifestBytes ?? 8 * 1024 * 1024;
        const blobLimit = options.maxBlobBytes ?? 4 * 1024 ** 3;
        const totalLimit = options.maxTotalBytes ?? 16 * 1024 ** 3;
        const objectLimit = options.maxObjects ?? 2048;
        for (const value of [
          timeoutMs,
          options.phaseTimeoutMs ?? 30 * 60_000,
          manifestLimit,
          activeManifestLimit,
          blobLimit,
          totalLimit,
          objectLimit,
        ]) {
          if (!Number.isSafeInteger(value) || value <= 0) throw failure('configuration');
        }
        checkAbort();
        // A platform phase has one owner. Never accumulate killed-run layer files on its PVC.
        await rm(temporary, { force: true, recursive: true });
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        workspace = await mkdtemp(join(temporary, 'run-'));
        let transferred = 0;
        let activeManifestBytes = 0;
        let objectCount = 0;
        let wrote = false;
        let audit = false;
        let sourceAuthorization: string | undefined;
        const completed = new Map<string, number>();
        const visiting = new Set<string>();

        function checkAbort(): void {
          if (controller.signal.aborted) throw failure(phaseExpired ? 'deadline' : 'aborted');
        }
        function charge(size: number): void {
          transferred += size;
          if (transferred > totalLimit) throw failure('size-limit');
        }
        function checkedUrl(value: string, base: URL): URL {
          const url = new URL(value, base);
          if (
            url.username !== '' ||
            url.password !== '' ||
            url.hash !== '' ||
            url.origin !== base.origin
          )
            throw failure('redirect');
          return url;
        }
        async function readSource(): Promise<
          Awaited<ReturnType<WorkbenchImportOptions['readSource']>>
        > {
          let value: Awaited<ReturnType<WorkbenchImportOptions['readSource']>>;
          try {
            value = await interruptible(options.readSource());
          } catch {
            checkAbort();
            throw failure('credential');
          }
          if (
            !record(value) ||
            typeof value.registry !== 'string' ||
            typeof value.repository !== 'string'
          )
            throw failure('configuration');
          const origin = parseOrigin(value.registry);
          if (origin.protocol !== 'https:' || !REPOSITORY.test(value.repository))
            throw failure('configuration');
          const hasUser = value.username !== undefined;
          const hasPassword = value.password !== undefined;
          if (
            hasUser !== hasPassword ||
            (hasUser &&
              (typeof value.username !== 'string' ||
                value.username.trim() === '' ||
                /[:\r\n]/.test(value.username))) ||
            (hasPassword &&
              (typeof value.password !== 'string' ||
                value.password.trim() === '' ||
                /[\r\n]/.test(value.password)))
          )
            throw failure('configuration');
          return value;
        }
        async function pullCredential(): Promise<string | undefined> {
          // Read the current secret per use. A source change belongs to the next run;
          // it must not send a new registry's secret to the previous registry.
          const current = await readSource();
          if (
            parseOrigin(current.registry).origin !== configuredOrigin.origin ||
            current.repository !== sourceRepository
          )
            throw failure('configuration');
          if (current.username === undefined || current.password === undefined) return undefined;
          return `Basic ${Buffer.from(`${current.username}:${current.password}`).toString('base64')}`;
        }
        async function credentials(): Promise<string> {
          try {
            const credential = await interruptible(options.readCredential());
            if (
              credential.username !== 'loader' ||
              credential.password.trim() === '' ||
              /[\r\n]/.test(credential.password)
            )
              throw failure('credential');
            return `Basic ${Buffer.from(`loader:${credential.password}`).toString('base64')}`;
          } catch {
            checkAbort();
            throw failure('credential');
          }
        }
        async function interruptible<T>(work: Promise<T>): Promise<T> {
          checkAbort();
          return new Promise<T>((resolve, reject) => {
            const onAbort = () => {
              reject(failure(phaseExpired ? 'deadline' : 'aborted'));
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            void work.then(resolve, reject).finally(() => {
              controller.signal.removeEventListener('abort', onAbort);
            });
          });
        }
        async function request(url: URL, spec: RequestOptions = {}): Promise<Result> {
          delete detail.status;
          delete detail.errorName;
          delete detail.errorCode;
          checkAbort();
          return new Promise<Result>((resolve, reject) => {
            const method = spec.method ?? 'GET';
            const limit = spec.limit ?? manifestLimit;
            let expired = false;
            const headers = {
              ...spec.headers,
              'accept-encoding': 'identity',
              ...(spec.body === undefined
                ? {}
                : {
                    'content-length': String(
                      Buffer.isBuffer(spec.body) ? spec.body.length : spec.body.size
                    ),
                  }),
            };
            const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
              url,
              { method, headers },
              (res) => {
                void (async () => {
                  const status = res.statusCode ?? 0;
                  detail = { ...detail, status };
                  if (status !== 200 || method === 'HEAD') {
                    res.destroy();
                    return {
                      status,
                      headers: res.headers,
                      bytes: Buffer.alloc(0),
                      digest: '',
                      size: 0,
                    };
                  }
                  if (
                    res.headers['content-encoding'] !== undefined &&
                    res.headers['content-encoding'] !== 'identity'
                  )
                    throw failure('protocol');
                  const length = Number(res.headers['content-length']);
                  if (Number.isFinite(length) && length > limit) throw failure('size-limit');
                  const hash = createHash('sha256');
                  const chunks: Buffer[] = [];
                  const file =
                    spec.file === undefined ? undefined : await open(spec.file, 'w', 0o600);
                  let size = 0;
                  try {
                    for await (const chunk of res) {
                      checkAbort();
                      const bytes = Buffer.from(chunk as Uint8Array);
                      size += bytes.length;
                      if (size > limit) throw failure('size-limit');
                      charge(bytes.length);
                      hash.update(bytes);
                      if (file !== undefined) await file.writeFile(bytes);
                      else if (!spec.discard) chunks.push(bytes);
                    }
                  } finally {
                    await file?.close();
                  }
                  return {
                    status,
                    headers: res.headers,
                    bytes: Buffer.concat(chunks),
                    digest: `sha256:${hash.digest('hex')}`,
                    size,
                  };
                })()
                  .then(resolve, (error: unknown) => {
                    res.destroy();
                    reject(error instanceof Error ? error : failure('unavailable'));
                  })
                  .finally(cleanup);
              }
            );
            const timer = setTimeout(() => {
              expired = true;
              req.destroy(failure('deadline'));
            }, timeoutMs);
            const onAbort = () => req.destroy(failure(phaseExpired ? 'deadline' : 'aborted'));
            function cleanup(): void {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', onAbort);
            }
            controller.signal.addEventListener('abort', onAbort, { once: true });
            req.on('error', (error) => {
              detail = { ...detail, ...workbenchErrorDetail(error) };
              cleanup();
              reject(
                failure(
                  controller.signal.aborted
                    ? phaseExpired
                      ? 'deadline'
                      : 'aborted'
                    : expired
                      ? 'deadline'
                      : 'unavailable'
                )
              );
            });
            if (spec.body !== undefined && !Buffer.isBuffer(spec.body)) {
              void pipeline(createReadStream(spec.body.path), req).catch((error: unknown) => {
                detail = { ...detail, ...workbenchErrorDetail(error) };
                req.destroy(error instanceof Error ? error : failure('unavailable'));
              });
            } else req.end(spec.body);
          });
        }
        function status(response: Result, expected: number[]): void {
          if (response.status === 401 || response.status === 403) throw failure('unauthorized');
          if (response.status >= 300 && response.status < 400) throw failure('redirect');
          if (!expected.includes(response.status)) {
            if (
              response.status === 404 &&
              detail.side === 'source' &&
              (detail.step === 'source-manifest' || detail.step === 'source-blob')
            )
              throw failure('source-missing');
            throw failure('unavailable');
          }
        }
        async function destinationRequest(
          path: string | URL,
          spec: RequestOptions = {},
          digest = options.pinnedDigest
        ): Promise<Result> {
          const method = spec.method ?? 'GET';
          const pathText = typeof path === 'string' ? path : path.pathname;
          context(
            spec.step ??
              (audit
                ? 'read-back-verify'
                : method === 'GET' || method === 'HEAD'
                  ? 'destination-check'
                  : pathText.includes('manifests/')
                    ? 'destination-manifest-write'
                    : 'destination-upload'),
            'destination',
            digest
          );
          const url =
            typeof path === 'string'
              ? new URL(`/v2/${repository}/${path}`, destination)
              : checkedUrl(path.href, destination);
          const response = await request(url, {
            ...spec,
            headers: { ...spec.headers, authorization: await credentials() },
          });
          if (response.status >= 300 && response.status < 400) throw failure('redirect');
          if (response.status === 401 || response.status === 403) throw failure('unauthorized');
          if (
            (spec.method === 'PUT' || spec.method === 'POST') &&
            response.status >= 400 &&
            response.status < 500
          )
            throw new WorkbenchDestinationRejection(
              response.status,
              spec.headers?.['content-type'],
              { ...detail }
            );
          return response;
        }
        async function sourceRequest(path: string, spec: RequestOptions): Promise<Result> {
          const sourceStep = path.startsWith('blobs/') ? 'source-blob' : 'source-manifest';
          const digest = path.split('/').at(-1) as string;
          context(sourceStep, 'source', digest);
          const url = new URL(`/v2/${sourceRepository}/${path}`, source);
          // Only the registry itself ever receives the cached source authorization.
          const send = async () => {
            if (sourceAuthorization?.startsWith('Basic ')) {
              sourceAuthorization = await pullCredential();
              if (sourceAuthorization === undefined) throw failure('credential');
            }
            return request(url, {
              ...spec,
              headers: {
                ...spec.headers,
                ...(sourceAuthorization === undefined
                  ? {}
                  : { authorization: sourceAuthorization }),
              },
            });
          };
          let response = await send();
          if (response.status === 401) {
            const challenge = response.headers['www-authenticate'];
            if (typeof challenge !== 'string') throw failure('unauthorized');
            if (/^Basic(?:\s|$)/i.test(challenge)) {
              sourceAuthorization = await pullCredential();
              if (sourceAuthorization === undefined) throw failure('unauthorized');
            } else if (/^Bearer /i.test(challenge)) {
              const realm = /(?:^|[,\s])realm="([^"]+)"/.exec(challenge)?.[1];
              const service = /(?:^|[,\s])service="([^"]+)"/.exec(challenge)?.[1];
              const scope = /(?:^|[,\s])scope="([^"]+)"/.exec(challenge)?.[1];
              if (
                realm === undefined ||
                (scope !== undefined && scope !== `repository:${sourceRepository}:pull`)
              )
                throw failure('unauthorized');
              let tokenUrl: URL;
              try {
                tokenUrl = new URL(realm);
              } catch {
                throw failure('redirect');
              }
              if (
                (tokenUrl.protocol !== 'https:' &&
                  !(loopback(source) && tokenUrl.origin === source.origin)) ||
                tokenUrl.username !== '' ||
                tokenUrl.password !== '' ||
                tokenUrl.hash !== ''
              )
                throw failure('redirect');
              const credential = await pullCredential();
              // A registry may name its external HTTPS token service for public pulls.
              // That challenge is not authority to disclose a stored registry secret:
              // require the exact origin (including port), or remain anonymous.
              if (credential !== undefined && tokenUrl.origin !== source.origin)
                throw failure('redirect');
              if (service !== undefined) tokenUrl.searchParams.set('service', service);
              tokenUrl.searchParams.set('scope', `repository:${sourceRepository}:pull`);
              context('source-authentication', 'source', digest);
              const grant = await request(tokenUrl, {
                limit: 64 * 1024,
                ...(credential === undefined ? {} : { headers: { authorization: credential } }),
              });
              status(grant, [200]);
              const parsed: unknown = JSON.parse(grant.bytes.toString('utf8'));
              if (!record(parsed)) throw failure('unauthorized');
              const value = parsed['token'] ?? parsed['access_token'];
              if (
                typeof value !== 'string' ||
                !/^[A-Za-z0-9._~+/-]+=*$/.test(value) ||
                value.length > 32 * 1024
              )
                throw failure('unauthorized');
              sourceAuthorization = `Bearer ${value}`;
            } else throw failure('unauthorized');
            context(sourceStep, 'source', digest);
            response = await send();
          }
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.location;
            if (typeof location !== 'string' || !path.startsWith('blobs/'))
              throw failure('redirect');
            const redirected = new URL(location, source);
            if (
              redirected.protocol !== 'https:' ||
              redirected.username !== '' ||
              redirected.password !== '' ||
              redirected.hash !== ''
            )
              throw failure('redirect');
            // Redirects receive neither Authorization nor Cookie, including headers
            // added to the original request in future. Never follow a second hop.
            const headers = Object.fromEntries(
              Object.entries(spec.headers ?? {}).filter(
                ([name]) =>
                  !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())
              )
            );
            response = await request(redirected, { ...spec, headers });
            if (response.status >= 300 && response.status < 400) throw failure('redirect');
          }
          status(response, [200]);
          return response;
        }
        function verify(response: Result, digest: string, expectedSize?: number): void {
          if (response.digest !== digest) throw failure('digest-mismatch');
          if (expectedSize !== undefined && response.size !== expectedSize)
            throw failure('digest-mismatch');
        }
        function descriptor(value: unknown): Descriptor {
          if (
            !record(value) ||
            typeof value['digest'] !== 'string' ||
            !DIGEST.test(value['digest']) ||
            typeof value['size'] !== 'number' ||
            !Number.isSafeInteger(value['size']) ||
            value['size'] < 0
          )
            throw failure('manifest');
          return { digest: value['digest'], size: value['size'] };
        }
        function begin(key: string, size?: number): boolean {
          const existing = completed.get(key);
          if (existing !== undefined) {
            if (size !== undefined && existing !== size) throw failure('digest-mismatch');
            return false;
          }
          if (visiting.has(key)) throw failure('manifest');
          if (++objectCount > objectLimit) throw failure('size-limit');
          visiting.add(key);
          return true;
        }
        async function blob(item: Descriptor): Promise<void> {
          context(audit ? 'read-back-verify' : 'destination-check', 'destination', item.digest);
          const key = `blob:${item.digest}`;
          if (!begin(key, item.size)) return;
          if (item.size > blobLimit) throw failure('size-limit');
          const path = `blobs/${item.digest}`;
          const head = await destinationRequest(path, { method: 'HEAD' }, item.digest);
          status(head, [200, 404]);
          if (head.status === 404) {
            if (audit) throw failure('unavailable');
            const file = join(workspace as string, 'blob');
            try {
              const original = await sourceRequest(path, { limit: blobLimit, file });
              verify(original, item.digest, item.size);
              const start = await destinationRequest(
                'blobs/uploads/',
                { method: 'POST' },
                item.digest
              );
              status(start, [202]);
              if (start.headers.location === undefined) throw failure('protocol');
              const upload = checkedUrl(
                start.headers.location,
                new URL(`/v2/${repository}/blobs/uploads/`, destination)
              );
              if (!upload.pathname.startsWith(`/v2/${repository}/blobs/uploads/`))
                throw failure('redirect');
              upload.searchParams.set('digest', item.digest);
              const pushed = await destinationRequest(
                upload,
                {
                  method: 'PUT',
                  headers: { 'content-type': 'application/octet-stream' },
                  body: { path: file, size: item.size },
                },
                item.digest
              );
              status(pushed, [201]);
              wrote = true;
            } finally {
              await rm(file, { force: true });
            }
          }
          const stored = await destinationRequest(
            path,
            { limit: blobLimit, discard: true, step: 'read-back-verify' },
            item.digest
          );
          status(stored, [200]);
          verify(stored, item.digest, item.size);
          visiting.delete(key);
          completed.set(key, item.size);
        }
        async function manifest(digest: string, expectedSize?: number, depth = 0): Promise<void> {
          context(audit ? 'read-back-verify' : 'destination-check', 'destination', digest);
          if (depth > 16) throw failure('size-limit');
          const key = `manifest:${digest}`;
          if (!begin(key, expectedSize)) return;
          const path = `manifests/${digest}`;
          let bytes = await destinationRequest(
            path,
            {
              headers: { accept: MANIFEST_TYPES.join(', ') },
            },
            digest
          );
          status(bytes, [200, 404]);
          const missing = bytes.status === 404;
          if (missing) {
            if (audit) throw failure('unavailable');
            bytes = await sourceRequest(path, { headers: { accept: MANIFEST_TYPES.join(', ') } });
          }
          verify(bytes, digest, expectedSize);
          activeManifestBytes += bytes.size;
          if (activeManifestBytes > activeManifestLimit) throw failure('size-limit');
          const document: unknown = JSON.parse(bytes.bytes.toString('utf8'));
          if (
            !record(document) ||
            document['schemaVersion'] !== 2 ||
            typeof document['mediaType'] !== 'string' ||
            !MANIFEST_TYPES.includes(document['mediaType'])
          )
            throw failure('manifest');
          const manifestDetail = { ...detail };
          const mediaType = document['mediaType'];
          if (document['subject'] !== undefined) {
            const subject = descriptor(document['subject']);
            await manifest(subject.digest, subject.size, depth + 1);
          }
          if (INDEX_TYPES.has(mediaType)) {
            if (!Array.isArray(document['manifests'])) throw failure('manifest');
            for (const value of document['manifests']) {
              detail = { ...manifestDetail };
              const child = descriptor(value);
              await manifest(child.digest, child.size, depth + 1);
            }
          } else {
            await blob(descriptor(document['config']));
            detail = { ...manifestDetail };
            if (!Array.isArray(document['layers'])) throw failure('manifest');
            for (const value of document['layers']) {
              detail = { ...manifestDetail };
              await blob(descriptor(value));
            }
          }
          if (missing) {
            const pushed = await destinationRequest(
              path,
              {
                method: 'PUT',
                headers: { 'content-type': mediaType },
                body: bytes.bytes,
              },
              digest
            );
            status(pushed, [201]);
            wrote = true;
            const stored = await destinationRequest(
              path,
              {
                headers: { accept: MANIFEST_TYPES.join(', ') },
                step: 'read-back-verify',
              },
              digest
            );
            status(stored, [200]);
            verify(stored, digest, bytes.size);
          }
          activeManifestBytes -= bytes.size;
          visiting.delete(key);
          completed.set(key, bytes.size);
        }
        await manifest(pinnedDigest);
        if (wrote) {
          // A later manifest write must not hide a blob that changed after its first verification.
          audit = true;
          completed.clear();
          visiting.clear();
          objectCount = 0;
          await manifest(pinnedDigest);
        }
        checkAbort();
      } catch (error) {
        if (controller.signal.aborted) throw failure(phaseExpired ? 'deadline' : 'aborted');
        if (error instanceof WorkbenchImportFailure) throw error;
        if (error instanceof PlatformPhaseError && error.phase === 'workbench-import')
          throw new WorkbenchImportFailure(
            error.message.slice('workbench-import:'.length) as Reason,
            { ...detail }
          );
        detail = { ...detail, ...workbenchErrorDetail(error) };
        throw failure('unavailable');
      } finally {
        clearTimeout(phaseTimer);
        options.signal?.removeEventListener('abort', abort);
        if (workspace !== undefined)
          await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function loopback(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}
function parseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure('configuration');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw failure('configuration');
  return url;
}
