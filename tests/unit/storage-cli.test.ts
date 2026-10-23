/** ADR-015 S-D3: CLI exercises TLS, real files and the narrow task HTTP protocol. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  answer = (req, res) => {
    if (req.method === 'GET' && !req.url?.includes('?')) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-storage-size': String(receipt.size),
        'x-storage-sha256': receipt.sha256,
      });
      res.end(bytes);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(receipt));
    }
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
  it('prints help offline without reading identity or configuration', async () => {
    const code = await runStorageCli(['--help'], {
      env: {},
      cwd: '/nonexistent',
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });
    expect(code).toBe(0);
    expect(stdout).toContain('lifemodel-storage');
    expect(stdout).toContain('put <name> --upload-id <id>');
    expect(stdout).toContain('get <id> <name>');
    expect(stdout).toContain('list [--cursor <cursor>] [--limit <1..100>]');
    expect(stdout).toContain('mark <id> <artifact|result|log>');
    expect(stderr).toBe('');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['no arguments', []],
    ['path escape', ['put', '../escape', '--upload-id', 'escape']],
  ])('omits HTTP status for arguments_invalid: %s', async (_label, args) => {
    expect(await run(args)).toBe(1);
    expect(stderr).toMatch(/^lifemodel-storage: arguments_invalid id=[0-9a-f-]{36}\n$/);
    expect(calls).toHaveLength(0);
    expect(stdout).toBe('');
  });
  it.each(['symlink source', 'existing destination'])(
    'omits HTTP status for local_file_invalid: %s',
    async (failure) => {
      await source();
      await symlink(receipt.name, join(directory, 'linked'));
      const args =
        failure === 'symlink source'
          ? ['put', 'linked', '--upload-id', 'link']
          : ['get', 'object-a', receipt.name];
      expect(await run(args)).toBe(1);
      expect(stderr).toMatch(/^lifemodel-storage: local_file_invalid id=[0-9a-f-]{36}\n$/);
      expect(await readFile(join(directory, receipt.name))).toEqual(bytes);
      expect(calls).toHaveLength(0);
      expect(stdout).toBe('');
    }
  );
  it('omits HTTP status for configuration_invalid before contacting the module', async () => {
    delete env['LIFEMODEL_STORAGE_ENDPOINT'];
    expect(await run(['list'])).toBe(1);
    expect(stderr).toMatch(/^lifemodel-storage: configuration_invalid id=[0-9a-f-]{36}\n$/);
    expect(calls).toHaveLength(0);
  });
  it('omits HTTP status for operation_failed when local stdout fails', async () => {
    expect(
      await runStorageCli(['mark', 'object-a', 'artifact'], {
        env,
        cwd: directory,
        stdout: () => {
          throw new Error('local output failure');
        },
        stderr: (text) => {
          stderr += text;
        },
      })
    ).toBe(1);
    expect(stderr).toMatch(/^lifemodel-storage: operation_failed id=[0-9a-f-]{36}\n$/);
  });
  it.each([403, 404, 409, 500, 503])(
    'preserves the actual HTTP rejection status %s',
    async (status) => {
      answer = (_req, res) => {
        res.writeHead(status);
        res.end('private response');
      };
      expect(await run(['list'])).toBe(1);
      expect(stderr).toMatch(
        new RegExp(
          `^lifemodel-storage: request_rejected id=[0-9a-f-]{36} status=${String(status)}\\n$`
        )
      );
      expect(calls).toHaveLength(1);
      expect(stdout).toBe('');
    }
  );

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
  it.each(['\ufeff', '\ufeffreport.txt', 'invoice\u202etxt.exe', 'invisible\u200b.txt'])(
    'refuses format controls including BOM in put/get names %j',
    async (name) => {
      await writeFile(join(directory, name), bytes);
      expect(await run(['put', name, '--upload-id', 'format-upload'])).toBe(1);
      expect(await run(['get', 'object-a', `download-${name}`])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('arguments_invalid');
    }
  );
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
    expect(
      await run(['get', 'object-a', receipt.name]),
      `${stderr} requestCount=${calls.length}`
    ).toBe(0);
    expect(await readFile(join(directory, receipt.name))).toEqual(bytes);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/spaces/space-a/objects/object-a' });
    expect(JSON.parse(stdout)).toEqual({
      id: receipt.id,
      size: receipt.size,
      sha256: receipt.sha256,
    });
    expect(stdout).not.toContain(endpoint);
    expect(stderr).toBe('');
  });
  it('verifies and reports the catalog metadata for an empty download', async () => {
    const sha256 = createHash('sha256').update('').digest('hex');
    answer = (_req, res) => {
      res.writeHead(200, { 'x-storage-size': '0', 'x-storage-sha256': sha256 });
      res.end();
    };
    expect(await run(['get', 'object-a', 'empty']), stderr).toBe(0);
    expect(await readFile(join(directory, 'empty'))).toEqual(Buffer.alloc(0));
    expect(JSON.parse(stdout)).toEqual({ id: 'object-a', size: 0, sha256 });
    expect(stderr).toBe('');
  });
  it.each([
    ['missing size', undefined, receipt.sha256],
    ['missing hash', String(receipt.size), undefined],
    ['leading zero size', `0${String(receipt.size)}`, receipt.sha256],
    ['signed size', `+${String(receipt.size)}`, receipt.sha256],
    ['negative size', '-1', receipt.sha256],
    ['fractional size', `${String(receipt.size)}.0`, receipt.sha256],
    ['exponent size', '1e1', receipt.sha256],
    ['unsafe size', '9007199254740992', receipt.sha256],
    ['duplicate size', [String(receipt.size), String(receipt.size)], receipt.sha256],
    ['uppercase hash', String(receipt.size), receipt.sha256.toUpperCase()],
    ['short hash', String(receipt.size), receipt.sha256.slice(1)],
    ['invalid hash', String(receipt.size), 'g'.repeat(64)],
    ['duplicate hash', String(receipt.size), [receipt.sha256, receipt.sha256]],
  ])(
    'refuses %s catalog download headers and retains the identified file',
    async (_label, size, sha256) => {
      answer = (_req, res) => {
        if (size !== undefined) res.setHeader('x-storage-size', size);
        if (sha256 !== undefined) res.setHeader('x-storage-sha256', sha256);
        res.end(bytes);
      };
      expect(await run(['get', 'object-a', 'download'])).toBe(1);
      const partial = await stat(join(directory, 'download'));
      expect(stdout).toBe('');
      expect(stderr).toContain('response_invalid');
      expect(stderr).not.toContain('status=');
      expect(stderr).toContain(
        `partial_retained dev=${String(partial.dev)} ino=${String(partial.ino)}`
      );
      expect(stderr).not.toContain(directory);
    }
  );
  it.each([
    ['short bytes', bytes.subarray(1), receipt.size, receipt.sha256],
    ['surplus bytes', Buffer.concat([bytes, Buffer.from('!')]), receipt.size, receipt.sha256],
    ['changed bytes', Buffer.alloc(bytes.length, 'x'), receipt.size, receipt.sha256],
    ['wrong hash', bytes, receipt.size, '0'.repeat(64)],
  ])(
    'refuses %s against catalog metadata before reporting success',
    async (_label, body, size, sha256) => {
      answer = (_req, res) => {
        res.writeHead(200, {
          'content-length': String(body.length),
          'x-storage-size': String(size),
          'x-storage-sha256': sha256,
        });
        res.end(body);
      };
      expect(await run(['get', 'object-a', 'download'])).toBe(1);
      const partial = await stat(join(directory, 'download'));
      expect(stdout).toBe('');
      expect(stderr).toContain('response_invalid');
      expect(stderr).toContain(
        `partial_retained dev=${String(partial.dev)} ino=${String(partial.ino)}`
      );
      expect(stderr).not.toContain(directory);
    }
  );
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
    expect(stderr).not.toContain('status=');
  });
  it('retains and identifies an incomplete inode after the remote socket drops', async () => {
    answer = (_req, res) => {
      res.writeHead(200, {
        'content-length': '1000',
        'x-storage-size': '1000',
        'x-storage-sha256': receipt.sha256,
      });
      res.flushHeaders();
      res.write('partial');
      res.destroy();
    };
    expect(await run(['get', 'object-a', 'download'])).toBe(1);
    const partial = await stat(join(directory, 'download'));
    expect(partial.isFile()).toBe(true);
    expect(stderr).toContain(
      `partial_retained dev=${String(partial.dev)} ino=${String(partial.ino)}`
    );
    expect(stderr).not.toContain(directory);
  });
  it('does not unlink an unrelated replacement after a failed download', async () => {
    const destination = join(directory, 'download');
    const originalPartial = join(directory, 'original-partial');
    const valuable = join(directory, 'valuable.txt');
    const valuableBytes = Buffer.from('valuable unrelated user file');
    await writeFile(valuable, valuableBytes);
    let replacementInstalled = false;
    let fixtureError: unknown;
    answer = (req, _res) => {
      // The request starts only after localFile exclusively created download.
      // Replace the directory entry before failing the in-flight request.
      void (async () => {
        await rename(destination, originalPartial);
        await rename(valuable, destination);
        replacementInstalled = true;
      })()
        .catch((error: unknown) => {
          fixtureError = error;
        })
        .finally(() => {
          req.socket.destroy();
        });
    };
    expect(await run(['get', 'object-a', 'download'])).toBe(1);
    expect(fixtureError).toBeUndefined();
    expect(replacementInstalled).toBe(true);
    // The CLI owns the original inode, not the replacement destination name.
    expect(await readFile(destination)).toEqual(valuableBytes);
    const retained = await stat(originalPartial);
    expect(stderr).toContain(
      `partial_retained dev=${String(retained.dev)} ino=${String(retained.ino)}`
    );
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
  it('awaits stdout completion before returning success', async () => {
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const outcome = runStorageCli(['mark', 'object-a', 'artifact'], {
      env,
      cwd: directory,
      stdout: async () => {
        entered();
        await completion;
      },
      stderr: () => undefined,
    }).then((code) => {
      settled = true;
      return code;
    });
    await writing;
    expect(settled).toBe(false);
    release();
    expect(await outcome).toBe(0);
  });
  it('does not recursively report a rejected stderr write', async () => {
    let writes = 0;
    expect(
      await runStorageCli(['invalid'], {
        env,
        cwd: directory,
        stdout: () => undefined,
        stderr: async () => {
          writes++;
          throw new Error('broken pipe');
        },
      })
    ).toBe(1);
    expect(writes).toBe(1);
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
