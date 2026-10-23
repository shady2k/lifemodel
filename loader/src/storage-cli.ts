/** The narrow task storage client. It owns no S3 credentials or signing code. */
import { constants } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';

const CHUNK_BYTES = 4 * 1024 * 1024;
const METADATA_BYTES = 128 * 1024;
const DEADLINE_MS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ROLES = new Set(['artifact', 'result', 'log']);

export interface StorageCliOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
}

class CliError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number
  ) {
    super(code);
  }
}

interface Receipt {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mark: string | null;
}
type Command =
  | { kind: 'put'; name: string; uploadId: string }
  | { kind: 'get'; id: string; name: string }
  | { kind: 'list'; cursor?: string; limit: number }
  | { kind: 'mark'; id: string; role: string };

/** Reject aliases, rather than normalizing them into a different display name. */
function hasControl(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function nameValid(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 1024 &&
    Buffer.from(name, 'utf8').toString('utf8') === name &&
    name.normalize('NFC') === name &&
    !hasControl(name) &&
    !/\p{Cf}/u.test(name) &&
    !name.includes('\\') &&
    !/^[A-Za-z]:/.test(name) &&
    !/%(?:25)*(?:2f|5c)/i.test(name) &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function parse(argv: string[]): Command {
  const [kind, a, b, c] = argv;
  if (
    kind === 'put' &&
    argv.length === 4 &&
    a !== undefined &&
    nameValid(a) &&
    b === '--upload-id' &&
    c !== undefined &&
    ID.test(c)
  )
    return { kind, name: a, uploadId: c };
  if (
    kind === 'get' &&
    argv.length === 3 &&
    a !== undefined &&
    ID.test(a) &&
    b !== undefined &&
    nameValid(b)
  )
    return { kind, id: a, name: b };
  if (
    kind === 'mark' &&
    argv.length === 3 &&
    a !== undefined &&
    ID.test(a) &&
    b !== undefined &&
    ROLES.has(b)
  )
    return { kind, id: a, role: b };
  if (kind === 'list') {
    let limit = 100;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let i = 1; i < argv.length; i += 2) {
      const flag = argv[i];
      const value = argv[i + 1];
      if (flag === undefined || value === undefined || seen.has(flag))
        throw new CliError('arguments_invalid');
      seen.add(flag);
      if (flag === '--limit' && /^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) limit = Number(value);
      else if (
        flag === '--cursor' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= 2048 &&
        !hasControl(value)
      )
        cursor = value;
      else throw new CliError('arguments_invalid');
    }
    return { kind, limit, ...(cursor === undefined ? {} : { cursor }) };
  }
  throw new CliError('arguments_invalid');
}

interface LocalFile {
  file: FileHandle;
  /** Identity of the inode we created, not its replaceable directory entry. */
  identity: { dev: number; ino: number };
  close(): Promise<void>;
}

/**
 * Linux fd-relative traversal: O_NOFOLLOW on every opened component, including
 * the working-directory path. Unlike lstat + open this has no symlink race.
 * /proc/self/fd follows only our held directory descriptor, never a task link.
 * Nonblocking opens let fstat reject devices/FIFOs without waiting for a writer.
 */
async function localFile(cwd: string, name: string, output: boolean): Promise<LocalFile> {
  if (process.platform !== 'linux') throw new CliError('local_platform_unsupported');
  const directories: FileHandle[] = [];
  let file: FileHandle | undefined;
  try {
    let directory = await open(
      '/',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    directories.push(directory);
    const components = [...resolve(cwd).split('/').filter(Boolean), ...name.split('/')];
    const leaf = components.pop();
    if (leaf === undefined) throw new CliError('path_invalid');
    for (const component of components) {
      directory = await open(
        `/proc/self/fd/${String(directory.fd)}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      directories.push(directory);
    }
    const parent = `/proc/self/fd/${String(directory.fd)}/${leaf}`;
    file = await open(
      parent,
      constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (output ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY),
      0o600
    );
    const stat = await file.stat();
    if (!stat.isFile()) throw new CliError('local_file_invalid');
    const openedFile = file;
    return {
      file,
      identity: { dev: stat.dev, ino: stat.ino },
      close: async () => {
        await openedFile.close();
        await Promise.all(directories.map((handle) => handle.close()));
      },
    };
  } catch {
    await file?.close();
    await Promise.all(directories.map((handle) => handle.close()));
    throw new CliError('local_file_invalid');
  }
}

interface Connection {
  endpoint: URL;
  space: string;
  token: string;
  ca: Buffer;
}
async function connection(env: NodeJS.ProcessEnv): Promise<Connection> {
  const address = env['LIFEMODEL_STORAGE_ENDPOINT'];
  const space = env['LIFEMODEL_STORAGE_SPACE'];
  const tokenFile = env['LIFEMODEL_STORAGE_TOKEN_FILE'];
  const caFile = env['LIFEMODEL_STORAGE_CA_FILE'];
  if (!address || !space || !ID.test(space) || !tokenFile || !caFile)
    throw new CliError('configuration_invalid');
  const endpoint = new URL(address);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  )
    throw new CliError('configuration_invalid');
  // Projected token/CA mounts deliberately use Kubernetes-managed symlinks.
  // They are module-owned config, not the untrusted local artifact path.
  const [rawToken, ca] = await Promise.all([readFile(tokenFile, 'utf8'), readFile(caFile)]);
  const token = rawToken.trim();
  if (
    !token ||
    token.length > 16_384 ||
    /[^\x21-\x7e]/u.test(token) ||
    ca.length > 128 * 1024 ||
    !ca.includes('-----BEGIN CERTIFICATE-----')
  )
    throw new CliError('configuration_invalid');
  return { endpoint, space, token, ca };
}

async function hashFile(file: FileHandle): Promise<{ length: number; sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let length = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, length);
    if (!bytesRead) return { length, sha256: hash.digest('hex') };
    hash.update(buffer.subarray(0, bytesRead));
    length += bytesRead;
    if (!Number.isSafeInteger(length)) throw new CliError('local_file_invalid');
  }
}

/** No upstream response body, URL, token or local path ever becomes an error. */
async function transfer(
  config: Connection,
  method: string,
  path: string,
  headers: Record<string, string>,
  send: ((write: (chunk: Buffer) => Promise<void>) => Promise<void>) | undefined,
  receive: (response: IncomingMessage) => Promise<unknown>
): Promise<unknown> {
  return new Promise<unknown>((resolveResult, rejectResult) => {
    let settled = false;
    let incoming: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      incoming?.destroy();
      req.destroy();
      rejectResult(error);
    };
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(new CliError('transfer_timeout'));
      }, DEADLINE_MS);
      timer.unref();
    };
    const req = request(new URL(path, config.endpoint), {
      method,
      ca: config.ca,
      agent: false,
      headers: { authorization: `Bearer ${config.token}`, ...headers },
    });
    req.on('error', () => {
      fail(new CliError('transfer_failed'));
    });
    // The socket emits independently; keep its listener through teardown.
    req.on('socket', (socket) => {
      socket.on('error', () => {
        fail(new CliError('transfer_failed'));
      });
    });
    req.on('response', (response) => {
      incoming = response;
      response.on('error', () => {
        fail(new CliError('transfer_failed'));
      });
      response.on('data', progress);
      if (response.statusCode !== 200 && response.statusCode !== 201) {
        const status = response.statusCode ?? 502;
        response.destroy();
        fail(new CliError('request_rejected', status));
        return;
      }
      void receive(response).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveResult(result);
        },
        () => {
          fail(new CliError('response_invalid'));
        }
      );
    });
    progress();
    void (async () => {
      if (send)
        await send(async (chunk) => {
          if (settled) throw new CliError('transfer_failed');
          await new Promise<void>((done, reject) =>
            req.write(chunk, (error) => {
              if (error) reject(error);
              else done();
            })
          );
          progress();
        });
      req.end();
    })().catch(() => {
      fail(new CliError('transfer_failed'));
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function receipt(value: unknown): Receipt {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !ID.test(value['id']) ||
    typeof value['name'] !== 'string' ||
    !nameValid(value['name']) ||
    typeof value['size'] !== 'number' ||
    !Number.isSafeInteger(value['size']) ||
    value['size'] < 0 ||
    typeof value['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['sha256']) ||
    !(value['mark'] === null || (typeof value['mark'] === 'string' && ROLES.has(value['mark'])))
  )
    throw new CliError('response_invalid');
  // Rebuild the allowed shape. Untrusted extra properties are never printed.
  return {
    id: value['id'],
    name: value['name'],
    size: value['size'],
    sha256: value['sha256'],
    mark: value['mark'],
  };
}
/** The catalog is the reference; transport Content-Length is not an object receipt. */
function downloadMetadata(response: IncomingMessage): { size: number; sha256: string } {
  const size = response.headers['x-storage-size'];
  const sha256 = response.headers['x-storage-sha256'];
  if (
    typeof size !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(size) ||
    !Number.isSafeInteger(Number(size)) ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    throw new CliError('response_invalid');
  return { size: Number(size), sha256 };
}

async function metadata(response: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of response) {
    const bytes = Buffer.from(part as Uint8Array);
    length += bytes.length;
    if (length > METADATA_BYTES) {
      response.destroy();
      throw new CliError('response_invalid');
    }
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

export async function runStorageCli(argv: string[], options: StorageCliOptions): Promise<number> {
  let local: LocalFile | undefined;
  let partial = false;
  try {
    // Offline CLI discovery needs neither service identity nor network access.
    if (argv.length === 1 && argv[0] === '--help') {
      await options.stdout(
        'lifemodel-storage (this workbench release)\n' +
          '  put <name> --upload-id <id>\n' +
          '  get <id> <name>\n' +
          '  list [--cursor <cursor>] [--limit <1..100>]\n' +
          '  mark <id> <artifact|result|log>\n'
      );
      return 0;
    }
    const command = parse(argv);
    const config = await connection(options.env);
    const base = `/spaces/${config.space}/objects`;
    let result: unknown;
    if (command.kind === 'put') {
      local = await localFile(options.cwd, command.name, false);
      const file = local.file;
      const measured = await hashFile(file);
      result = receipt(
        await transfer(
          config,
          'PUT',
          `${base}/${command.uploadId}`,
          {
            'content-type': 'application/octet-stream',
            'content-length': String(measured.length),
            'x-storage-name': Buffer.from(command.name).toString('base64url'),
            'x-storage-length': String(measured.length),
            'x-storage-sha256': measured.sha256,
          },
          async (write) => {
            const buffer = Buffer.alloc(CHUNK_BYTES);
            let offset = 0;
            while (offset < measured.length) {
              const { bytesRead } = await file.read(
                buffer,
                0,
                Math.min(buffer.length, measured.length - offset),
                offset
              );
              if (!bytesRead) throw new CliError('local_file_changed');
              await write(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
          },
          metadata
        )
      );
    } else if (command.kind === 'get') {
      local = await localFile(options.cwd, command.name, true);
      partial = true;
      const file = local.file;
      result = await transfer(
        config,
        'GET',
        `${base}/${command.id}`,
        {},
        undefined,
        async (response) => {
          const catalog = downloadMetadata(response);
          const hash = createHash('sha256');
          let length = 0;
          for await (const part of response) {
            const bytes = Buffer.from(part as Uint8Array);
            length += bytes.length;
            if (!Number.isSafeInteger(length) || length > catalog.size)
              throw new CliError('response_invalid');
            hash.update(bytes);
            let offset = 0;
            while (offset < bytes.length) {
              const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
              if (!bytesWritten) throw new CliError('local_write_failed');
              offset += bytesWritten;
            }
          }
          if (length !== catalog.size || hash.digest('hex') !== catalog.sha256)
            throw new CliError('response_invalid');
          await file.sync();
          return { id: command.id, size: catalog.size, sha256: catalog.sha256 };
        }
      );
      partial = false;
    } else if (command.kind === 'mark') {
      result = receipt(
        await transfer(
          config,
          'POST',
          `${base}/${command.id}/mark`,
          { 'content-type': 'application/json' },
          async (write) => write(Buffer.from(JSON.stringify({ role: command.role }))),
          metadata
        )
      );
    } else {
      const query = new URLSearchParams({ limit: String(command.limit) });
      if (command.cursor !== undefined) query.set('cursor', command.cursor);
      const page = await transfer(
        config,
        'GET',
        `${base}?${query.toString()}`,
        {},
        undefined,
        metadata
      );
      if (
        !record(page) ||
        !Array.isArray(page['objects']) ||
        page['objects'].length > command.limit ||
        !(
          page['nextCursor'] === null ||
          (typeof page['nextCursor'] === 'string' &&
            page['nextCursor'].length <= 2048 &&
            /^[A-Za-z0-9_-]+$/.test(page['nextCursor']))
        )
      )
        throw new CliError('response_invalid');
      result = {
        objects: page['objects'].map((value: unknown) => receipt(value)),
        nextCursor: page['nextCursor'],
      };
    }
    await options.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof CliError ? error : new CliError('operation_failed');
    // Node has no linkat(AT_EMPTY_PATH)/renameat2(RENAME_NOREPLACE) interface.
    // A named staging entry or a stat-then-unlink would still race a same-task
    // writer. Fail safely: retain the exclusively created inode, identify it,
    // and NEVER unlink a caller-visible name, even if it still looks like ours.
    const retained =
      partial && local
        ? ` partial_retained dev=${String(local.identity.dev)} ino=${String(local.identity.ino)}`
        : '';
    // Only an actual HTTP rejection has a status. Local/transport failures
    // must not invent a module failure code.
    const status = safe.status === undefined ? '' : ` status=${String(safe.status)}`;
    try {
      await options.stderr(
        `lifemodel-storage: ${safe.code} id=${randomUUID()}${status}${retained}\n`
      );
    } catch {
      // In particular, never report a broken stderr by writing to it again.
    }
    return 1;
  } finally {
    await local?.close().catch(() => undefined);
  }
}
