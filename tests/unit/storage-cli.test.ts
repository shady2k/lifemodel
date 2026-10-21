/** ADR-015 S-D3: CLI exercises TLS, real files and the narrow task HTTP protocol. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStorageCli } from '../../loader/src/storage-cli.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

let certificate: TestStorageCertificate;
let server: Server;
let directory: string;
let endpoint: string;
let env: NodeJS.ProcessEnv;
let stdout: string;
let stderr: string;
let calls: { method: string; path: string; headers: IncomingMessage['headers']; body: Buffer }[];
let answer: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
const bytes = Buffer.from('private task bytes\n');
const receipt = {
  id: 'object-a',
  name: 'nested/file.txt',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mark: null,
};

beforeAll(async () => {
  certificate = await createStorageCertificate(['localhost']);
  server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      answer(req, res, body);
    })().catch(() => res.destroy());
  });
  server.on('error', () => undefined);
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture has no port');
  endpoint = `https://localhost:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  certificate.cleanup();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'storage-cli-'));
  await writeFile(join(directory, 'token'), 'task-token-one\n');
  await writeFile(join(directory, 'ca'), certificate.ca);
  env = {
    LIFEMODEL_STORAGE_ENDPOINT: endpoint,
    LIFEMODEL_STORAGE_SPACE: 'space-a',
    LIFEMODEL_STORAGE_TOKEN_FILE: join(directory, 'token'),
    LIFEMODEL_STORAGE_CA_FILE: join(directory, 'ca'),
  };
  calls = [];
  stdout = '';
  stderr = '';
  answer = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(receipt));
  };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function run(args: string[]) {
  return runStorageCli(args, {
    env,
    cwd: directory,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
}
async function source() {
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, receipt.name), bytes);
}

describe('lifemodel-storage', () => {
  it('puts immutable bytes with canonical name, measured length/hash and explicit upload id', async () => {
    await source();
    expect(
      await run(['put', receipt.name, '--upload-id', 'upload-a']),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/spaces/space-a/objects/upload-a',
      body: bytes,
      headers: {
        authorization: 'Bearer task-token-one',
        'x-storage-name': Buffer.from(receipt.name).toString('base64url'),
        'x-storage-length': String(bytes.length),
        'x-storage-sha256': receipt.sha256,
      },
    });
    expect(JSON.parse(stdout)).toEqual(receipt);
    expect(stderr).toBe('');
  });
  it('rereads a projected token (including a rotated symlink) for every invocation', async () => {
    await source();
    await rm(join(directory, 'token'));
    await writeFile(join(directory, 'token-1'), 'first');
    await writeFile(join(directory, 'token-2'), 'second');
    await symlink('token-1', join(directory, 'token'));
    expect(
      await run(['put', receipt.name, '--upload-id', 'upload-a']),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    await rm(join(directory, 'token'));
    await symlink('token-2', join(directory, 'token'));
    expect(
      await run(['put', receipt.name, '--upload-id', 'upload-a']),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    expect(calls.map((call) => call.headers.authorization)).toEqual([
      'Bearer first',
      'Bearer second',
    ]);
  });
  it('gets bytes into a new regular file without treating object ids as paths', async () => {
    await mkdir(join(directory, 'nested'));
    answer = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    };
    expect(
      await run(['get', 'object-a', receipt.name]),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    expect(await readFile(join(directory, receipt.name))).toEqual(bytes);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/spaces/space-a/objects/object-a' });
    expect(stdout).not.toContain(endpoint);
  });
  it('never overwrites an existing destination', async () => {
    await source();
    expect(await run(['get', 'object-a', receipt.name])).toBe(1);
    expect(await readFile(join(directory, receipt.name))).toEqual(bytes);
    expect(calls).toHaveLength(0);
  });
  it('survives a socket dropped before response headers', async () => {
    answer = (req, _res) => {
      req.socket.destroy();
    };
    expect(await run(['list'])).toBe(1);
    expect(calls).toHaveLength(1);
    expect(stderr).toContain('transfer_failed');
  });
  it('removes an incomplete download after the remote socket drops', async () => {
    answer = (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.flushHeaders();
      res.write('partial');
      res.destroy();
    };
    expect(await run(['get', 'object-a', 'download'])).toBe(1);
    await expect(readFile(join(directory, 'download'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('lists a bounded page and passes its opaque cursor without reinterpretation', async () => {
    const page = { objects: [receipt], nextCursor: 'next_cursor' };
    answer = (_req, res) => res.end(JSON.stringify(page));
    expect(
      await run(['list', '--cursor', 'opaque/+=?', '--limit', '12']),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    const url = new URL(calls[0]!.path, endpoint);
    expect(url.pathname).toBe('/spaces/space-a/objects');
    expect(url.searchParams.get('cursor')).toBe('opaque/+=?');
    expect(url.searchParams.get('limit')).toBe('12');
    expect(JSON.parse(stdout)).toEqual(page);
  });
  it.each(['artifact', 'result', 'log'])('marks a completed object as %s', async (role) => {
    answer = (_req, res) => res.end(JSON.stringify({ ...receipt, mark: role }));
    expect(await run(['mark', 'object-a', role]), `${stderr} requestCount=${calls.length}`).toBe(0);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/spaces/space-a/objects/object-a/mark',
      body: Buffer.from(JSON.stringify({ role })),
    });
  });
  it.each([
    '',
    '/absolute',
    'C:/absolute',
    '../escape',
    './file',
    'nested/../file',
    'nested//file',
    'nested/',
    'bad\u0000name',
    'bad\nname',
    'back\\slash',
    'encoded%2Fname',
    'encoded%5cname',
    'encoded%252fname',
    'e\u0301.txt',
    '\ud800',
  ])('rejects a noncanonical or escaping name %j before a request', async (name) => {
    expect(await run(['put', name, '--upload-id', 'upload-a'])).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it('refuses symlink files and every symlink directory component on put and get', async () => {
    await source();
    await symlink('nested/file.txt', join(directory, 'linked'));
    await symlink('nested', join(directory, 'alias'));
    for (const args of [
      ['put', 'linked', '--upload-id', 'upload-a'],
      ['put', 'alias/file.txt', '--upload-id', 'upload-a'],
      ['get', 'object-a', 'alias/new'],
    ])
      expect(await run(args)).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it('refuses a device file without reading it', async () => {
    expect(
      await runStorageCli(['put', 'null', '--upload-id', 'upload-a'], {
        env,
        cwd: '/dev',
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      })
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it('refuses a directory as an upload source', async () => {
    await mkdir(join(directory, 'nested'));
    expect(await run(['put', 'nested', '--upload-id', 'upload-a'])).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it.each([
    ['put', 'file'],
    ['put', 'file', '--upload-id', '../other'],
    ['get', '../other', 'file'],
    ['mark', 'id', 'publish'],
    ['list', '--limit', '0'],
    ['list', '--limit', '101'],
    ['list', '--token', 'secret'],
    ['list', '--endpoint', 'https://elsewhere'],
    ['list', '--limit', '1', '--limit', '2'],
  ])('refuses malformed arguments or credential flags %j', async (...args) => {
    expect(await run(args)).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it.each([
    'http://localhost:80',
    'https://user:secret@localhost',
    'https://localhost/path',
    'https://localhost/?secret=yes',
  ])('rejects non-module endpoint configuration %s without printing it', async (value) => {
    env['LIFEMODEL_STORAGE_ENDPOINT'] = value;
    expect(await run(['list'])).toBe(1);
    expect(stderr).not.toContain(value);
    expect(calls).toHaveLength(0);
  });
  it('requires its configured CA and refuses untrusted TLS without printing details', async () => {
    await writeFile(join(directory, 'ca'), 'not a certificate');
    expect(await run(['list'])).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderr).not.toContain(endpoint);
  });
  it('reports only bounded error codes/status, never remote bodies, URLs or credentials', async () => {
    answer = (_req, res) => {
      res.writeHead(403);
      res.end(`private remote body ${endpoint} task-token-one`);
    };
    expect(await run(['list'])).toBe(1);
    expect(stderr).toContain('403');
    expect(stderr).not.toMatch(/private|https:|task-token-one/);
    expect(stdout).toBe('');
  });
  it('refuses oversized metadata responses and does not print their contents', async () => {
    answer = (_req, res) => res.end('private'.repeat(20000));
    expect(await run(['list'])).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).not.toContain('private');
  });
  it('does not expose unknown response properties in successful JSON', async () => {
    answer = (_req, res) =>
      res.end(JSON.stringify({ ...receipt, upstream: endpoint, token: 'private-token' }));
    expect(
      await run(['mark', 'object-a', 'artifact']),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    expect(stdout).not.toMatch(/https:|private-token|upstream/);
  });
});
