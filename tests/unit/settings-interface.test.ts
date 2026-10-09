/**
 * lifemodel's settings interface, through HTTP (lifemodel-q4x.4.1).
 *
 * The criterion: "tests through the interface (HTTP) show the form renders
 * current values; saving writes the config and triggers the restart path;
 * invalid input (no base URL, an empty model) is refused with the field named
 * (and valid input is accepted)". So every assertion here goes through a real
 * request to a real listening server; the config file is a real file in a
 * temporary directory, and the restart path is the one double (a function the
 * server calls once the answer has gone out).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfigLoader, resolveConfigDir } from '../../src/config/config-loader.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createSettingsServer, type SettingsServer } from '../../src/settings/server.js';

const scratch: string[] = [];
let configDir = '';
let saved: number;
let server: SettingsServer;

async function startServer(): Promise<void> {
  configDir = await mkdtemp(join(tmpdir(), 'lifemodel-settings-'));
  scratch.push(configDir);
  saved = 0;
  server = await createSettingsServer({
    config: createConfigLoader(configDir),
    logger: createTestLogger('silent'),
    port: 0,
    onSaved: () => {
      saved += 1;
    },
  });
  await server.listen();
}

afterEach(async () => {
  await server.close();
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Reply {
  status: number;
  body: string;
}

/**
 * One request the way a browser makes it: through the socket, with the Host
 * header the front door forwards (fetch refuses to set Host, and the loader's
 * link is built from it).
 */
async function request(
  path: string,
  options: { form?: Record<string, string>; host?: string } = {}
): Promise<Reply> {
  const address = server.address();
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  const body = options.form === undefined ? undefined : new URLSearchParams(options.form).toString();
  return await new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Host: options.host ?? 'localhost:8080',
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(Buffer.byteLength(body)),
              }),
        },
      },
      (res) => {
        let answer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          answer += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: answer }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The restart the server asks for, once it runs. */
async function waitForSave(): Promise<void> {
  for (let attempt = 0; attempt < 100 && saved === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const VALID = {
  endpointBaseUrl: 'http://127.0.0.1:1234/v1',
  fastModel: 'fast-small',
  smartModel: 'smart-big',
  motorModel: 'motor-mid',
  telegramChatId: '4242',
  telegramBotToken: '__telegram_bot_token__',
};

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(configDir, 'agent.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe("lifemodel's settings interface", () => {
  beforeEach(startServer);

  it('renders the values in the config file, and says what is missing on a first start', async () => {
    // A first start: no config file at all.
    const empty = await request('/');
    expect(empty.status).toBe(200);
    expect(empty.body).toContain('No model endpoint is configured yet');
    expect(empty.body).toContain('the endpoint base URL');
    expect(empty.body).toContain('the smart model');
    // The placeholder stands in for the token, and the loader's link carries
    // the port the request came on.
    expect(empty.body).toContain('value="__telegram_bot_token__"');
    expect(empty.body).toContain('http://boot.localhost:8080/');
    expect(empty.body).not.toContain('Bearer');
  });

  it('renders the saved values of an existing config file', async () => {
    await writeFile(
      join(configDir, 'agent.json'),
      JSON.stringify({
        version: 1,
        identity: { name: 'Nika' },
        llm: {
          endpoint: {
            baseUrl: 'http://127.0.0.1:9999/v1',
            fastModel: 'a',
            smartModel: 'b',
            motorModel: 'c',
          },
        },
        primaryUser: { telegramChatId: '77' },
        telegram: { botToken: '__telegram_bot_token__' },
      })
    );

    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('value="http://127.0.0.1:9999/v1"');
    expect(page.body).toContain('value="c"');
    expect(page.body).toContain('value="77"');
    // Configured: nothing is missing any more.
    expect(page.body).not.toContain('No model endpoint is configured yet');
  });

  it('writes the config and asks for the restart, keeping every other field', async () => {
    await writeFile(
      join(configDir, 'agent.json'),
      JSON.stringify({ version: 1, identity: { name: 'Nika' }, logging: { level: 'debug' } })
    );

    const answer = await request('/settings', { form: VALID });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('Saved.');
    await waitForSave();
    expect(saved).toBe(1);

    const written = await readConfig();
    expect(written['llm']).toMatchObject({
      endpoint: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        fastModel: 'fast-small',
        smartModel: 'smart-big',
        motorModel: 'motor-mid',
      },
    });
    expect(written['primaryUser']).toMatchObject({ telegramChatId: '4242' });
    expect(written['telegram']).toMatchObject({ botToken: '__telegram_bot_token__' });
    // The owner's other settings are not this interface's to drop.
    expect(written['identity']).toEqual({ name: 'Nika' });
    expect(written['logging']).toEqual({ level: 'debug' });

    // And the next start reads exactly this: the merged config of that file.
    const merged = await createConfigLoader(configDir).load();
    expect(merged.llm.endpoint).toEqual({
      baseUrl: 'http://127.0.0.1:1234/v1',
      fastModel: 'fast-small',
      smartModel: 'smart-big',
      motorModel: 'motor-mid',
    });
    expect(merged.primaryUser.telegramChatId).toBe('4242');
    expect(merged.telegramBotToken).toBe('__telegram_bot_token__');
  });

  it('refuses a model with no endpoint base URL, naming the base URL', async () => {
    const answer = await request('/settings', { form: { ...VALID, endpointBaseUrl: '' } });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain('the endpoint base URL is needed when the endpoint is set');
    expect(saved).toBe(0);
    // Nothing was written: the refusal is not a half-save.
    await expect(readConfig()).rejects.toThrow();
  });

  it('refuses an empty model with a base URL, naming that model', async () => {
    const answer = await request('/settings', { form: { ...VALID, smartModel: '   ' } });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain('the smart model is needed when the endpoint is set');
    expect(saved).toBe(0);

    const fast = await request('/settings', { form: { ...VALID, fastModel: '' } });
    expect(fast.status).toBe(400);
    expect(fast.body).toContain('the fast model is needed when the endpoint is set');
    expect(saved).toBe(0);
  });

  it('refuses a base URL that is not http, and a chat id that is not a number', async () => {
    const url = await request('/settings', {
      form: { ...VALID, endpointBaseUrl: 'ftp://example.test/v1' },
    });
    expect(url.status).toBe(400);
    expect(url.body).toContain('the endpoint base URL must be an http or https URL');

    const chat = await request('/settings', { form: { ...VALID, telegramChatId: 'me' } });
    expect(chat.status).toBe(400);
    expect(chat.body).toContain('the Telegram chat id must be a number');
    expect(saved).toBe(0);
  });

  it('refuses a bot token that is not an Agent Vault placeholder', async () => {
    const answer = await request('/settings', {
      form: { ...VALID, telegramBotToken: '123456:AAH-a-real-looking-token' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain('must be an Agent Vault placeholder');
    expect(saved).toBe(0);
    // The page never echoes it back either.
    expect(answer.body).not.toContain('AAH-a-real-looking-token');
  });

  it('keeps the submitted values in the refused page, and names the field beside it', async () => {
    const answer = await request('/settings', {
      form: { ...VALID, endpointBaseUrl: '', fastModel: 'kept-model' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain('value="kept-model"');
    expect(answer.body).toContain('id="endpointBaseUrl-error"');
  });

  it('accepts an endpoint-less save: the Telegram fields alone are a valid state', async () => {
    const answer = await request('/settings', {
      form: {
        endpointBaseUrl: '',
        fastModel: '',
        smartModel: '',
        motorModel: '',
        telegramChatId: '',
        telegramBotToken: '__telegram_bot_token__',
      },
    });
    expect(answer.status).toBe(200);
    await waitForSave();
    expect(saved).toBe(1);
    const written = await readConfig();
    expect(written['llm']).toMatchObject({
      endpoint: { baseUrl: null, fastModel: null, smartModel: null, motorModel: null },
    });
    expect((written['primaryUser'] as Record<string, unknown>)['telegramChatId']).toBeUndefined();
  });

  it('leaves the file exactly as it was when the write fails', async () => {
    const before = JSON.stringify({
      version: 1,
      llm: { endpoint: { baseUrl: 'http://127.0.0.1:9999/v1' } },
    });
    await writeFile(join(configDir, 'agent.json'), before);

    await chmod(configDir, 0o500);
    try {
      const answer = await request('/settings', { form: VALID });
      expect(answer.status).toBe(500);
      expect(answer.body).toContain('could not be written');
      expect(saved).toBe(0);
      // Byte for byte: a refused save never touched the published file.
      expect(await readFile(join(configDir, 'agent.json'), 'utf-8')).toBe(before);
      // And no half-written temp file was left behind.
      const remaining = await import('node:fs/promises').then((fs) => fs.readdir(configDir));
      expect(remaining).toEqual(['agent.json']);
    } finally {
      await chmod(configDir, 0o700);
    }
  });

  it('pins the save down: overlapping saves never mix, and the file is whole', async () => {
    // Two saves in flight at once (the second fires before the first's answer
    // has arrived). Each one's read-modify-write is serialized, so the file is
    // one save WHOLE - never a mix of the two, never one save authored by the
    // other's failed write.
    const first = request('/settings', { form: { ...VALID, smartModel: 'first-big' } });
    const second = request('/settings', { form: { ...VALID, smartModel: 'second-big', motorModel: 'second-mid' } });
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await waitForSave();

    const endpoint = ((await readConfig())['llm'] as Record<string, unknown>)['endpoint'] as Record<
      string,
      unknown
    >;
    const whole =
      JSON.stringify(endpoint) ===
        JSON.stringify({
          baseUrl: VALID.endpointBaseUrl,
          fastModel: 'fast-small',
          smartModel: 'first-big',
          motorModel: 'motor-mid',
        }) ||
      JSON.stringify(endpoint) ===
        JSON.stringify({
          baseUrl: VALID.endpointBaseUrl,
          fastModel: 'fast-small',
          smartModel: 'second-big',
          motorModel: 'second-mid',
        });
    expect(whole).toBe(true);
  });

  it('does not restart when the config file cannot be written', async () => {
    // A directory nobody may write in: the atomic write fails, so the settings
    // are NOT applied, and lifemodel is not restarted onto a config that is not
    // there. The owner is told instead.
    await chmod(configDir, 0o500);
    try {
      const answer = await request('/settings', { form: VALID });
      expect(answer.status).toBe(500);
      expect(answer.body).toContain('could not be written');
      expect(saved).toBe(0);
    } finally {
      await chmod(configDir, 0o700);
    }
  });

  it('resolves the config file the instance reads: DATA_PATH moves it', () => {
    // The loader gives lifemodel DATA_PATH=<volume>/data, so the config file is
    // <volume>/data/config/agent.json - the path the volume layout names. The
    // interface writes the same file, through the same function.
    expect(resolveConfigDir({ DATA_PATH: '/var/lib/lifemodel/data' })).toBe(
      '/var/lib/lifemodel/data/config'
    );
    expect(resolveConfigDir({})).toBe('data/config');
  });

  it('creates the config directory on the first save (a first start has none)', async () => {
    // The container's first start: the loader makes `data/`, nothing makes
    // `data/config/`, and the first save is what creates both the directory and
    // the file. Found by the gated Docker walk, which got a 500 for ENOENT.
    const root = await mkdtemp(join(tmpdir(), 'lifemodel-settings-fresh-'));
    scratch.push(root);
    const fresh = join(root, 'config');
    const freshServer = createSettingsServer({
      config: createConfigLoader(fresh),
      logger: createTestLogger('silent'),
      port: 0,
      onSaved: () => {
        saved += 1;
      },
    });
    await freshServer.listen();
    try {
      const address = freshServer.address();
      const port = Number(address.slice(address.lastIndexOf(':') + 1));
      const body = new URLSearchParams(VALID).toString();
      const answer = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/settings',
            method: 'POST',
            headers: {
              Host: 'localhost:8080',
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      expect(answer).toBe(200);
      const written = JSON.parse(await readFile(join(fresh, 'agent.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(written['llm']).toMatchObject({
        endpoint: { baseUrl: 'http://127.0.0.1:1234/v1' },
      });
    } finally {
      await freshServer.close();
    }
  });
});
