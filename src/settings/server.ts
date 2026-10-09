/**
 * The settings interface itself (lifemodel-q4x.4.1): lifemodel's small web
 * server on 127.0.0.1:7100, behind Caddy and the loader's login.
 *
 * It has NO auth of its own by design: the loader checks EVERY request before
 * it is proxied here (forward_auth on the root host), and the session cookie is
 * the loader's. Two routes and nothing else:
 *
 *   GET  /          the form, with the values in lifemodel's config file
 *   POST /settings  validate, write the config file, then restart lifemodel
 *
 * A save that is refused answers 400 with the page again, every bad field named
 * beside it and nothing written. A save that is accepted answers 200 first, and
 * only then does the restart run: the answer is what proves the write, and a
 * response the process never sent because it exited would be nobody's.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Socket } from 'node:net';
import type { Logger } from '../types/index.js';
import type { ConfigLoader } from '../config/config-loader.js';
import {
  applySettings,
  settingsInputFromBody,
  settingsInputFromFile,
  validateSettings,
} from './settings.js';
import { renderSettingsPage } from './page.js';

/** The port Caddy proxies the root host to (docs/features/instance/image.md). */
export const SETTINGS_PORT = 7100;

/** The environment variables that would override what the page saves. */
const OVERRIDING_VARIABLES = [
  'LLM_ENDPOINT_BASE_URL',
  'LLM_ENDPOINT_FAST_MODEL',
  'LLM_ENDPOINT_SMART_MODEL',
  'LLM_ENDPOINT_MOTOR_MODEL',
  'PRIMARY_USER_CHAT_ID',
  'TELEGRAM_BOT_TOKEN',
] as const;

export interface SettingsServerOptions {
  /** The loader of lifemodel's config file: the page reads and writes through it. */
  config: ConfigLoader;
  logger: Logger;
  /** Where lifemodel listens; Caddy reaches it here (default 7100). */
  port?: number;
  host?: string;
  /**
   * Asked for after a save was written: this is the restart path. It is called
   * once the answer has gone out, and the caller does the stopping and the
   * exiting (src/index.ts) - the interface has no power over the process
   * itself.
   */
  onSaved: () => void;
  /**
   * How long `close` waits for an outstanding request before destroying its
   * socket. Kept SMALL on purpose: the close runs INSIDE lifemodel's one stop
   * deadline (src/index.ts), and the drain, the flush and the channels still
   * need their room after it. Default 5 s.
   */
  closeGraceMs?: number;
}

export interface SettingsServer {
  /** Start listening; `address()` reports the port that was really taken. */
  listen: () => Promise<void>;
  close: () => Promise<void>;
  /** The address it listens on, for a test and for a log line. */
  address: () => string;
}

/** The names of the set variables that would override the saved settings. */
function overridingVariables(): string[] {
  return OVERRIDING_VARIABLES.filter((name) => (process.env[name] ?? '') !== '');
}

export function createSettingsServer(options: SettingsServerOptions): SettingsServer {
  const { config, logger, onSaved } = options;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? SETTINGS_PORT;
  const closeGraceMs = options.closeGraceMs ?? 5_000;
  const app: FastifyInstance = Fastify({ logger: false });

  // Every socket that talks to this interface, kept to be destroyed when the
  // close gives up on a request that will not end. fastify's requestTimeout is
  // 0 here: a POST with a Content-Length and only HALF its body would stall
  // the close forever, and with it lifemodel's whole stop (measured: a close
  // behind such a request never resolved until the socket died).
  const sockets = new Set<Socket>();
  app.server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // A refused socket's error must not escape as an unhandled one.
  app.server.on('clientError', () => undefined);

  // fastify parses JSON on its own; a browser form posts this instead.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const fields: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body as string)) {
        fields[key] = value;
      }
      done(null, fields);
    }
  );

  app.get('/', async (request, reply) => {
    const file = await config.readFile();
    return reply.type('text/html; charset=utf-8').send(
      renderSettingsPage({
        values: settingsInputFromFile(file),
        host: request.headers.host,
        overriddenBy: overridingVariables(),
      })
    );
  });

  // ONE save runs at a time, and its whole read-modify-write is inside the
  // chain: a save that is still running holds the config file alone, and the
  // next save reads what it actually published - never a half-applied mix of
  // the two. The serialized body below is the answer each save describes.
  let saveChain: Promise<unknown> = Promise.resolve();

  const applySave = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = settingsInputFromBody(body);
    const errors = validateSettings(input);

    if (Object.keys(errors).length > 0) {
      logger.warn({ fields: Object.keys(errors) }, 'Settings refused: a field is not valid');
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          renderSettingsPage({
            values: input,
            errors,
            host: request.headers.host,
            overriddenBy: overridingVariables(),
          })
        );
    }

    const existing = await config.readFile();
    try {
      await config.writeFile(applySettings(existing, input));
    } catch (error) {
      // Nothing was written (the write is atomic): the owner is told, and the
      // running lifemodel is left alone rather than restarted onto a config
      // that is not there.
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Settings could not be written'
      );
      return reply
        .code(500)
        .type('text/html; charset=utf-8')
        .send(
          renderSettingsPage({
            values: input,
            host: request.headers.host,
            errors: { endpointBaseUrl: 'the settings file could not be written; see the log' },
          })
        );
    }

    logger.info(
      { endpoint: input.endpointBaseUrl, roles: 3 },
      'Settings saved: lifemodel asks the loader to start it again'
    );

    // The restart runs AFTER the answer is on the wire: the owner sees the
    // page that says so, and a process that left mid-answer would leave the
    // browser with nothing.
    reply.raw.once('finish', () => {
      onSaved();
    });
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(
        renderSettingsPage({
          values: input,
          host: request.headers.host,
          saved: true,
        })
      );
  };

  app.post('/settings', async (request, reply) => {
    // The drain has asked the interface to close (a save started THIS stop, or
    // the process is leaving): a save that arrives now would write a config the
    // exiting process never applies, and the restart it asks for would be
    // swallowed by the stop already running. Named, not silent.
    if (closing) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('lifemodel is restarting; save again when it is up\n');
    }
    // This request's work is the chain's tail: it starts only after the save
    // before it has written (or failed), so its read-modify-write sees the
    // file the earlier save actually published.
    const settled = saveChain.then(
      () => applySave(request, reply),
      () => applySave(request, reply)
    );
    // The chain itself must survive one save's error: the next save still runs.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const forget = (): void => {};
    saveChain = settled.catch(forget);
    return await settled;
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
  });

  // 0 asks the operating system for a free port (a test does that); the
  // instance is given 7100 by Caddy's own configuration.
  let boundPort = port;
  // Set as the FIRST thing close does: the very next save is refused.
  let closing = false;

  return {
    listen: async () => {
      await app.listen({ host, port });
      const bound = app.server.address();
      if (bound !== null && typeof bound === 'object') {
        boundPort = bound.port;
      }
    },
    /**
     * Stop the interface, BOUNDED: new saves are refused at once, the listen
     * socket is dropped, and an outstanding request that does not end within
     * the grace has its socket destroyed. The close can never outlast its
     * grace by more than one check, so it can never stall lifemodel's stop
     * (the drain, the flush and the channels still follow it inside the one
     * stop deadline).
     */
    close: async () => {
      closing = true;
      const finished = app.close().then(
        () => true,
        () => true
      );
      const inGrace = await Promise.race([
        finished,
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => {
            resolve(false);
          }, closeGraceMs);
          timer.unref?.();
        }),
      ]);
      if (!inGrace) {
        // Whoever is still holding a socket half-open (a POST with a
        // Content-Length and no body) is destroyed: the stop goes on.
        logger.warn(
          {
            sockets: sockets.size,
            graceMs: closeGraceMs,
          },
          'Settings close gave up on an unfinished request and destroyed its socket'
        );
        for (const socket of sockets) {
          socket.destroy();
        }
      }
    },
    address: () => `http://${host}:${String(boundPort)}`,
  };
}
