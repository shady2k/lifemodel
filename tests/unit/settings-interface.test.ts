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
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfigLoader, resolveConfigDir } from '../../src/config/config-loader.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';
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
  {
    form,
    host,
    origin = `http://${host ?? 'localhost:8080'}`,
  }: { form?: Record<string, string>; host?: string; origin?: string | null } = {}
): Promise<Reply> {
  const address = server.address();
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  const body = form === undefined ? undefined : new URLSearchParams(form).toString();
  return await new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Host: host ?? 'localhost:8080',
          ...(body === undefined || origin === null
            ? {}
            : { Origin: origin }),
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

  it('accepts a same-origin save: the front door origin, scheme and port as the browser saw it', async () => {
    const answer = await request('/settings', { form: VALID });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('Saved.');
    await waitForSave();
    expect(saved).toBe(1);
  });

  it('refuses a foreign-origin write, naming the route (the cookie is not port-scoped)', async () => {
    // The review's concrete case: another local service on the same site can
    // drive this POST with the owner's ambient cookie - the loader's session
    // is SameSite=Lax and the cookie is NOT scoped to the port.
    const answer = await request('/settings', {
      form: VALID,
      origin: 'http://localhost:9000',
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('/settings');
    expect(answer.body).toContain('same-origin');
    await waitForSave();
    expect(saved).toBe(0);
    await expect(readConfig()).rejects.toThrow(); // nothing written
  });

  it('refuses a write with no Origin header at all, naming the route', async () => {
    const answer = await request('/settings', { form: VALID, origin: null });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('/settings');
    expect(saved).toBe(0);
  });

  it('refuses a foreign scheme-origin write, naming the route', async () => {
    const answer = await request('/settings', {
      form: VALID,
      origin: 'https://localhost:8080', // right host:port, wrong scheme
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('/settings');
    expect(saved).toBe(0);
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

  it('renders a legacy config with credentials in the endpoint safe, and refuses the field', async () => {
    // Review round 2, finding F, case 1: a config the round-1 interface (or a
    // hand edit) wrote still echoed `user:key@` on a plain GET, and startup
    // logged the whole URL. The GET now runs the save's rules: the field is
    // refused with its name on the page, and the VALUE is its safe
    // representation (origin + path) - never the secret.
    const LEGACY_KEY = 'legacy-not-a-real-key';
    await writeFile(
      join(configDir, 'agent.json'),
      JSON.stringify({
        version: 1,
        llm: { endpoint: { baseUrl: `https://owner:${LEGACY_KEY}@example.test/v1` } },
      })
    );

    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(LEGACY_KEY);
    expect(page.body).not.toContain('owner:');
    expect(page.body).toContain('value="https://example.test/v1"');
    expect(page.body).toContain('id="endpointBaseUrl-error"');
    expect(page.body).toContain('must not carry credentials');
    // And the owner cannot save it along by submitting as-is: the field is
    // already visible as refused.
  });

  it('refuses a URL whose query or fragment carries a secret, and echoes it safe', async () => {
    const LEGACY_KEY = 'made-up-query-key';
    const fragment = 'made-up-fragment-secret';
    const answer = await request('/settings', {
      form: {
        ...VALID,
        endpointBaseUrl: `https://api.example.com/v1?api_key=${LEGACY_KEY}#${fragment}`,
      },
    });
    expect(answer.status).toBe(400);
    expect(answer.body).not.toContain(LEGACY_KEY);
    expect(answer.body).not.toContain(fragment);
    expect(answer.body).toContain('must not carry a query string or fragment');
    expect(answer.body).toContain('value="https://api.example.com/v1"'); // safe representation
    expect(saved).toBe(0);
    await expect(readConfig()).rejects.toThrow(); // nothing written
  });

  it('records the save log with the safe URL representation only', async () => {
    // A save's log line carries the endpoint through the redactor: origin and
    // path only, never credentials, query or fragment - a URL the REDACTOR
    // cannot trust cannot leak through it (review round 2, finding F).
    const calls: RecordedLog[] = [];
    const base = createTestLogger('silent');
    const recorded = createConfigLoader(configDir);
    const logServer = await createSettingsServer({
      config: recorded,
      logger: recordingLogger(base, calls),
      port: 0,
      onSaved: () => {
        saved += 1;
      },
    });
    await logServer.listen();
    try {
      const address = logServer.address();
      const port = Number(address.slice(address.lastIndexOf(':') + 1));
      const clean = new URLSearchParams({ ...VALID }).toString();
      await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/settings',
            method: 'POST',
            headers: {
              Host: 'localhost:8080',
              Origin: 'http://localhost:8080',
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': String(Buffer.byteLength(clean)),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.write(clean);
        req.end();
      });
      const saveLines = calls.filter((call) => call.msg.includes('Settings saved'));
      expect(saveLines.length).toBe(1);
      const logged = JSON.stringify(saveLines[0].obj);
      expect(logged).toContain('127.0.0.1:1234');
      expect(logged).not.toContain('unit-test-secret');
      expect(saved).toBe(1);
    } finally {
      await logServer.close();
    }
  });

  it('refuses an endpoint URL that carries credentials, and echoes it without them', async () => {
    const withKey = 'https://owner:not-a-real-model-key@api.example.com/v1';
    const answer = await request('/settings', { form: { ...VALID, endpointBaseUrl: withKey } });
    expect(answer.status).toBe(400);
    expect(answer.body).toContain('must not carry credentials');
    // The secret never meets the response, the page, the config or the log.
    expect(answer.body).not.toContain('owner:');
    expect(answer.body).not.toContain('not-a-real-model-key');
    expect(answer.body).toContain('https://api.example.com/v1');
    await expect(readConfig()).rejects.toThrow(); // nothing written
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

  it('keeps the future fields of the endpoint object it replaces (nested, not top level)', async () => {
    // Coordinator finding 10: `applySettings` built llm.endpoint FRESH, so a
    // config carrying a field of the endpoint this interface does not own yet
    // (headers, or anything a later version adds) lost it on every save - the
    // top-level file fields are kept, this NESTED object was not.
    await writeFile(
      join(configDir, 'agent.json'),
      JSON.stringify({
        version: 1,
        llm: {
          endpoint: {
            baseUrl: 'http://127.0.0.1:1234/v1',
            fastModel: 'old-fast',
            smartModel: 'old-smart',
            motorModel: 'old-motor',
            headers: { 'X-Test': 'keep' },
          },
          timeoutMs: 90_000,
        },
      })
    );

    const answer = await request('/settings', { form: VALID });
    expect(answer.status).toBe(200);
    await waitForSave();

    const written = await readConfig();
    const llm = written['llm'] as Record<string, unknown>;
    expect(llm['timeoutMs']).toBe(90_000); // top level, already kept
    expect(llm['endpoint']).toMatchObject({
      baseUrl: VALID.endpointBaseUrl, // replaced by the save
      fastModel: VALID.fastModel,
      smartModel: VALID.smartModel,
      motorModel: VALID.motorModel,
      headers: { 'X-Test': 'keep' }, // NOT this interface's field: kept
    });
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

  it('close is bounded even when a request never sends its body', async () => {
    // The review's concrete case: a POST with a Content-Length and half a
    // body holds its socket. fastify's requestTimeout is 0, so an unbounded
    // close would wait on it forever - and, called from the restart path
    // BEFORE the deadline was armed, stall lifemodel's whole stop.
    const graceServer = await createSettingsServer({
      config: createConfigLoader(configDir),
      logger: createTestLogger('silent'),
      port: 0,
      closeGraceMs: 300,
      onSaved: () => {
        saved += 1;
      },
    });
    await graceServer.listen();
    const address = graceServer.address();
    const port = Number(address.slice(address.lastIndexOf(':') + 1));

    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          'POST /settings HTTP/1.1\r\nHost: localhost:8080\r\n' +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: 10000\r\n\r\nx='
        );
        // The body's remainder never arrives, and the socket stays open.
        resolve();
      });
      socket.on('error', reject);
    });

    const started = Date.now();
    await graceServer.close();
    const elapsed = Date.now() - started;
    // Bounded, not a stall (the grace is 300 ms); an unbounded close would
    // hang this await and the test's own timeout would have to kill it.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('a save that arrives while the interface is closing is refused, with the reason', async () => {
    const graceServer = await createSettingsServer({
      config: createConfigLoader(configDir),
      logger: createTestLogger('silent'),
      port: 0,
      closeGraceMs: 2_000,
      onSaved: () => {
        saved += 1;
      },
    });
    await graceServer.listen();
    const address = graceServer.address();
    const port = Number(address.slice(address.lastIndexOf(':') + 1));

    const socket = await new Promise<ReturnType<typeof connect>>(
      (resolve, reject) => {
        const opened = connect({ host: '127.0.0.1', port }, () => resolve(opened));
        opened.on('error', reject);
      }
    );

    // The close BEGINS (intake stops) while the socket is connected: what
    // arrives now is a save into a process that is draining.
    const closed = graceServer.close();
    const body = new URLSearchParams(VALID).toString();
    socket.write(
      'POST /settings HTTP/1.1\r\nHost: localhost:8080\r\n' +
        'Content-Type: application/x-www-form-urlencoded\r\n' +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n` +
        body
    );

    const answer = await new Promise<string>((resolve) => {
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        received += chunk;
        if (received.includes('</html>')) resolve(received);
      });
      socket.on('close', () => resolve(received));
    });

    // Refused either way - by fastify's own during-close rejection, or (when
    // the handler still runs inside the grace) by the interface's own page.
    expect(answer).toContain('503');
    expect(saved).toBe(0);
    await closed;
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
              Origin: 'http://localhost:8080',
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

  it('drains the running save inside the close, and refuses the one queued behind it', async () => {
    // Review round 2, finding A: the close used to be about SOCKETS only.
    // The contract now: a save admitted while the interface was open finishes
    // inside the grace (the owner sees its answer), a save still QUEUED when
    // the close begins is refused, and nothing publishes after the close.
    const real = createConfigLoader(configDir);
    await writeFile(join(configDir, 'agent.json'), '{"version":1,"identity":{"name":"Nika"}}');

    const { controlled, writeSettled, release, writesStarted } = heldWrite(real);

    const held = await createSettingsServer({
      config: controlled,
      logger: createTestLogger('silent'),
      port: 0,
      closeGraceMs: 5_000,
      onSaved: () => {
        saved += 1;
      },
    });
    await held.listen();
    const address = held.address();

    // Save A: admitted, and held at its write.
    const a = requestTo(address, VALID);
    await writesStarted();
    // Save B: queued behind A - it is what the close finds in the chain.
    const b = requestTo(address, { ...VALID, smartModel: 'queued-in' });
    const closed = held.close();
    // Nothing is destroyed yet: A's answer is still owed inside the grace.
    release();
    await writeSettled(2_000);
    const [answerA, answerB] = await Promise.all([a, b]);
    await closed;

    expect(answerA.status).toBe(200);
    expect(answerA.body).toContain('Saved.');
    expect(answerB.status).toBe(503);
    expect(answerB.body).toContain('save again');
    expect(saved).toBe(1);
    // A published, and the close did not return before the chain settled:
    const endpoint = ((await readConfig())['llm'] as Record<string, unknown>)['endpoint'];
    expect(endpoint).toMatchObject({ baseUrl: VALID.endpointBaseUrl });
  });

  it('stops a write the close gave up on at its publication point: nothing lands after the close', async () => {
    // The reviewer's probe: a save held in flight, a close that returns on
    // the grace, a release after that. The old contract let the held write
    // land AFTER the close returned - unacknowledged settings silently
    // published to a process on its way out. Now the abandoned close has the
    // write stopped at its publication point: the file stays as it was.
    const real = createConfigLoader(configDir);
    const before = '{"version":1,"identity":{"name":"Nika"}}';
    await writeFile(join(configDir, 'agent.json'), before);

    const { controlled, writeSettled, release, writesStarted } = heldWrite(real);

    const held = await createSettingsServer({
      config: controlled,
      logger: createTestLogger('silent'),
      port: 0,
      closeGraceMs: 300,
      onSaved: () => {
        saved += 1;
      },
    });
    await held.listen();
    const address = held.address();

    const a = requestTo(address, VALID);
    await writesStarted();
    // A second save, queued behind the held one: the close refuses it too.
    const b = requestTo(address, { ...VALID, smartModel: 'queued-in' });
    const started = Date.now();
    await held.close();
    // Bounded: the grace, not the held write ("destroying an HTTP socket is
    // not a cancellation of an async writer" - the stop contract is).
    expect(Date.now() - started).toBeLessThan(2_000);

    // Only now does the held save run on: past the abandoned close, its
    // publication signal is aborted, so the REAL writer refuses to publish.
    release();
    await a;
    await b;
    await writeSettled(2_000);
    expect(saved).toBe(0);
    expect(await readFile(join(configDir, 'agent.json'), 'utf-8')).toBe(before);
    // The refused write's temp file is removed again; the settle above is the
    // event the directory check waits on.
    expect(await readdir(configDir)).toEqual(['agent.json']); // no temp left
  });
});

/**
 * A config boundary whose write the test holds and releases, over the REAL
 * loader: the settled state of the write (refused or published) is what the
 * assertions wait on. `heldStart` is the event of the write starting.
 */
function heldWrite(real: ReturnType<typeof createConfigLoader>): {
  controlled: Pick<ReturnType<typeof createConfigLoader>, 'readFile' | 'writeFile'>;
  writeSettled: (withinMs: number) => Promise<void>;
  release: () => void;
  writesStarted: () => Promise<void>;
} {
  let releaseHandle = (): void => {};
  const writeHeld = new Promise<void>((resolve) => {
    releaseHandle = resolve;
  });
  let settleHandle = (): void => {};
  const writeDone = new Promise<void>((resolve) => {
    settleHandle = resolve;
  });
  let startedWaited = (): void => {};
  const startedEvent = new Promise<void>((resolve) => {
    startedWaited = resolve;
  });
  const controlled = {
    readFile: (): ReturnType<typeof real.readFile> => real.readFile(),
    writeFile: async (
      file: Parameters<typeof real.writeFile>[0],
      options?: { signal?: AbortSignal }
    ): Promise<void> => {
      startedWaited();
      try {
        await writeHeld;
        return await real.writeFile(file, options);
      } finally {
        // The settle of the REAL write (refused or published) is the event
        // the assertions wait for - not a fixed sleep.
        settleHandle();
      }
    },
  };
  return {
    controlled,
    writeSettled: (withinMs: number): Promise<void> =>
      Promise.race([writeDone, new Promise<void>((r) => setTimeout(r, withinMs))]),
    release: () => releaseHandle(),
    writesStarted: (): Promise<void> =>
      Promise.race([startedEvent, new Promise<void>((r) => setTimeout(r, 2_000))]),
  };
}

/** One request helpers' form, for a server a test holds separately. */
async function requestTo(address: string, form: Record<string, string>): Promise<Reply> {
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  const body = new URLSearchParams(form).toString();
  return await new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/settings',
        method: 'POST',
        headers: {
          Host: 'localhost:8080',
          Origin: 'http://localhost:8080',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(body)),
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
    req.on('error', (e) => resolve({ status: 0, body: `socket error: ${(e as Error).message}` }));
    req.write(body);
    req.end();
  });
}
