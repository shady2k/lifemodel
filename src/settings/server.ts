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
import type { AgentConfigFile } from '../config/config-schema.js';
import {
  applySettings,
  redactEndpointUrl,
  settingsInputFromBody,
  settingsInputFromFile,
  validateSettings,
} from './settings.js';

/**
 * The config boundary the interface serves: what the page reads and what a
 * save writes, with the write's stop options (`signal`, see
 * `ConfigLoader.writeFile`). Structural, so a test can hold a save in flight
 * with its own writer while the publication contract stays the product's.
 */
export interface SettingsConfig {
  readFile(): Promise<AgentConfigFile | null>;
  writeFile(file: AgentConfigFile, options?: { signal?: AbortSignal }): Promise<void>;
}
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
  config: SettingsConfig;
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
  /**
   * Observed for every incoming connection - a test watches the socket the
   * half-sent request holds (finding I's receipt is an event, not a sleep),
   * and an operator log can name what the close later gave up on.
   */
  onConnection?: (socket: Socket) => void;
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
    options.onConnection?.(socket);
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
    const values = settingsInputFromFile(file);
    // The GET runs the SAVE's rules on what the file holds: a config an older
    // interface (or a hand edit) wrote is REFUSED with its field named and
    // shown redacted - never migrated silently behind the owner's back, and
    // never echoed with the secret part of its endpoint URL (review round 2,
    // finding F).
    return reply.type('text/html; charset=utf-8').send(
      renderSettingsPage({
        values,
        errors: validateSettings(values),
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

  // The ONE publication signal of this interface, aborted once: when the
  // close gives up on its grace, EVERY write still in flight - and every
  // write that starts after - refuses at its publication point (the writer
  // checks the signal before its rename). The stop contracts with the
  // interface to publish nothing the owner has not seen answered; a per-save
  // handle cannot do that (a write admitted a moment later would have no
  // handle in the abort sweep). Destroying an HTTP socket is NOT a
  // cancellation of an async writer; this signal is (review round 2,
  // finding A).
  const stopSignal = new AbortController();

  const closingRefusal = async (reply: FastifyReply): Promise<unknown> =>
    reply
      .code(503)
      .type('text/plain; charset=utf-8')
      .send('lifemodel is restarting; save again when it is up\n');

  /** The request's socket is gone: no answer can reach anybody. */
  const responseGone = (request: FastifyRequest): boolean => request.raw.socket.destroyed;

  const applySave = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    // This save was ADMITTED before the close and sat queued in the chain
    // behind another save. Whatever the close's grace answered or not, the
    // stop does not carry new writes: the admission stands only while the
    // interface is open, and it is RE-checked here, where the queued work
    // actually starts (finding A: a queued save used to run to the end and
    // publish under the close). Named, not silent.
    if (closing) {
      logger.warn(
        { route: '/settings' },
        'Settings refused: a save admitted earlier is still queued into the stop'
      );
      return await closingRefusal(reply);
    }
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
      // The write carries the interface's one stop signal: an abandoned
      // close has it aborted, and the writer stops at its publication point
      // instead of publishing under a process that is leaving (finding A).
      await config.writeFile(applySettings(existing, input), { signal: stopSignal.signal });
    } catch (error) {
      // Nothing was published (the write is atomic, and its publication point
      // is one rename it did not reach or did not pass): the owner is told,
      // and the running lifemodel is left alone rather than restarted onto a
      // config that is not there.
      const socketGone = responseGone(request);
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          published: false,
          socketGone,
          stopRefused: abandoned && stopSignal.signal.aborted,
        },
        socketGone
          ? 'Settings save gave up with the close: nothing was published'
          : 'Settings could not be written'
      );
      if (socketGone) {
        // The socket the answer would go to is destroyed (the close gave up
        // on this request): no reply is possible, and dereferencing one
        // would hide the logged outcome instead.
        return undefined;
      }
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

    // The URL by its nonsecret parts only: it must be able to carry no
    // credential through here (validation refuses credentials), but a log
    // line is no place to gamble on it.
    logger.info(
      { endpoint: redactEndpointUrl(input.endpointBaseUrl), roles: 3 },
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

  /**
   * The Origin the front door serves the page from, as the browser saw it:
   * the scheme of the instance's HTTP publishing (http on the root host) and
   * the request's own Host. The loader's session cookie is SameSite=Lax, not
   * port-scoped, so another local service could drive this POST cross-origin
   * with the owner's ambient cookie (review finding 2, measured: 200 through
   * such a probe). A CSRF check on the write closes it: the browser's Origin
   * must be exactly this front door, or the save does not happen.
   */
  const isThisFrontDoor = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    return (
      typeof origin === 'string' &&
      origin.length > 0 &&
      typeof host === 'string' &&
      origin === `http://${host}`
    );
  };

  app.post('/settings', async (request, reply) => {
    // The write route before anything else: no save is driven from another
    // origin, and a request with no Origin at all is a cross-origin tool, not
    // the page.
    if (!isThisFrontDoor(request)) {
      logger.warn(
        {
          route: '/settings',
          hasOrigin: typeof request.headers.origin === 'string' && request.headers.origin !== '',
        },
        'Settings refused: the write route rejects a request that is not from this front door'
      );
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send('Save refused: /settings accepts only same-origin writes\n');
    }
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
  // Set when the close GAVE UP on the grace: from here, nothing still running
  // may publish - the pending writes are stopped at their publication points.
  let abandoned = false;

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
      const deadline = Date.now() + closeGraceMs;
      const runsOutWithin = (ms: number): Promise<false> =>
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => {
            resolve(false);
          }, ms);
          timer.unref?.();
        });
      const giveUp = (): void => {
        // The grace is over. The stop contracts the interface to publish
        // nothing the owner has not seen answered (review round 2, finding
        // A): every write still in flight is stopped at its publication
        // point - the writer checks the signal before its rename - and
        // whoever is still holding a socket half-open (a POST with a
        // Content-Length and no body) is destroyed. Destroying an HTTP
        // socket is NOT a cancellation of an async writer; the signal is.
        abandoned = true;
        stopSignal.abort();
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
      };

      // Stage 1 - DRAIN the saves, while their sockets are still alive: a
      // save already running publishes and answers, and a save queued behind
      // it is refused by its own start (applySave re-checks `closing` where
      // the queued work begins). fastify's close is NOT called first: it
      // swallows the queued requests before their refusal could reach the
      // owner (measured: a queued save answered as a dead socket, no 503),
      // and that is what the refusal is for.
      const drained = await Promise.race([
        saveChain.then(
          () => true,
          () => true
        ),
        runsOutWithin(closeGraceMs),
      ]);
      if (drained) {
        // Everything admitted settled: whatever it answered, refused or
        // stopped, NOTHING can still publish past this point. Hand the
        // listen socket back, inside the budget that is left.
        const finished = app.close().then(
          () => true,
          () => true
        );
        if (await Promise.race([finished, runsOutWithin(deadline - Date.now())])) {
          return;
        }
      }
      giveUp();
      // Do NOT wait for the stopped writes here: the abandonment is recorded
      // (nothing they do can publish any more - stage 1 drained what it
      // could, stage 2's stragglers have nothing live to refuse), and a stop
      // that hangs past this point belongs to lifemodel's one stop deadline,
      // not to this interface's grace.
    },
    address: () => `http://${host}:${String(boundPort)}`,
  };
}
