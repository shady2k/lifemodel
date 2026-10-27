/** Outbound polls share the event channel's fair auth/SQL workers and byte budget. */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { createTaskChannelScheduler, Work } from './task-channel-scheduler.js';
import type { TaskCommandMailbox, TaskMailbox, TaskChannelProof } from '../ports/task-channel.js';
import {
  TaskChannelError,
  validateTaskCommandAck,
  validateTaskCommandReceipt,
} from '../ports/task-channel.js';

const POLL_MS = 25_000;
// Deadline of the ACK POST, not a delivery-to-ACK lease. Native admission is 5 s.
export const TASK_COMMAND_ACK_TIMEOUT_MS = 10_000;
type Scheduler = ReturnType<typeof createTaskChannelScheduler>;
export function createTaskCommandChannel(options: {
  mailbox: Partial<TaskCommandMailbox> &
    Pick<TaskMailbox, 'readBriefing'> &
    Pick<Partial<TaskMailbox>, 'readTraceAuthority'>;
  identity: { verify(token: string, signal?: AbortSignal): Promise<TaskChannelProof> };
  frameLimit: number;
  maxBufferedBytes: number;
  maxUnackedFrames: number;
  maxUnackedBytes: number;
  authentication: Scheduler;
  mailboxScheduler: Scheduler;
  reserveBytes(bytes: number): boolean;
  releaseBytes(bytes: number): void;
  onRefused?: (status: number, code: string, route: string) => void;
}) {
  const controllers = new Set<AbortController>();
  const polls = new Set<string>();
  const sockets = new WeakMap<Socket, { frames: number; bytes: number }>();
  // Credential caps protect pre-authentication memory; verified Job caps prevent
  // token rotation from obtaining more shares. Poll and write reserves are separate.
  const tokens = new Map<string, { polls: number; writes: number }>();
  const jobs = new Map<string, { polls: number; writes: number }>();
  let pollCount = 0;
  let writeCount = 0;
  const laneBytes = { polls: 0, writes: 0 };
  let closed = false;
  function send(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '1' } : {}),
    });
    res.end(JSON.stringify(body));
  }
  return {
    stop() {
      closed = true;
      for (const controller of controllers) controller.abort();
    },
    receive(req: IncomingMessage, res: ServerResponse): boolean {
      const poll = req.method === 'GET' && req.url === '/task/commands';
      const ack = req.method === 'POST' && req.url === '/task/commands/ack';
      const receipt = req.method === 'POST' && req.url === '/task/commands/receipt';
      if (!poll && !ack && !receipt) return false;
      const route = poll
        ? 'GET /task/commands'
        : ack
          ? 'POST /task/commands/ack'
          : 'POST /task/commands/receipt';
      const refuse = (status: number, code: string) => {
        options.onRefused?.(status, code, route);
        send(res, status, { code });
      };
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      if (closed) {
        refuse(503, 'stopped');
        return true;
      }
      const authorization = req.headers.authorization;
      const authCount = req.rawHeaders.filter(
        (v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization'
      ).length;
      if (
        authCount !== 1 ||
        typeof authorization !== 'string' ||
        !/^Bearer [^\s]+$/.test(authorization)
      ) {
        refuse(403, 'identity_denied');
        return true;
      }
      const length = req.headers['content-length'];
      if (
        req.headers['content-encoding'] ||
        (poll
          ? req.headers['transfer-encoding'] !== undefined ||
            (length !== undefined && length !== '0')
          : req.headers['content-type'] !== 'application/json')
      ) {
        refuse(400, 'invalid_input');
        return true;
      }
      // At most half of the common byte budget belongs to commands. The rest is
      // always available to event frames. Tiny configured budgets fail closed.
      const commandBudget = Math.floor(options.maxBufferedBytes / 4);
      const capacity = Math.min(options.frameLimit, options.maxUnackedBytes, commandBudget);
      const reservation = poll
        ? capacity
        : length === undefined
          ? capacity
          : Math.max(1, Number(length));
      if (
        !Number.isSafeInteger(reservation) ||
        reservation < 1 ||
        reservation > capacity ||
        (length !== undefined && !/^\d+$/.test(length))
      ) {
        refuse(413, 'invalid_frame');
        return true;
      }
      const token = authorization.slice(7);
      const tokenKey = createHash('sha256').update(token).digest('hex');
      const tokenCount = tokens.get(tokenKey) ?? { polls: 0, writes: 0 };
      const socketCount = sockets.get(req.socket) ?? { frames: 0, bytes: 0 };
      const lane = poll ? 'polls' : 'writes';
      if (
        (poll
          ? pollCount >= 16 || tokenCount.polls >= 1
          : writeCount >= 32 || tokenCount.writes >= 4) ||
        laneBytes[lane] + reservation > commandBudget ||
        socketCount.frames >= options.maxUnackedFrames ||
        socketCount.bytes + reservation > options.maxUnackedBytes ||
        !options.reserveBytes(reservation)
      ) {
        refuse(429, 'channel_unavailable');
        return true;
      }
      tokenCount[lane]++;
      tokens.set(tokenKey, tokenCount);
      if (poll) pollCount++;
      else writeCount++;
      socketCount.frames++;
      socketCount.bytes += reservation;
      sockets.set(req.socket, socketCount);
      laneBytes[lane] += reservation;
      const controller = new AbortController();
      controllers.add(controller);
      const signal = controller.signal;
      req.socket.setTimeout(poll ? 30_000 : TASK_COMMAND_ACK_TIMEOUT_MS + 1000);
      let key: string | undefined;
      let jobCount: { polls: number; writes: number } | undefined;
      let jobKey: string | undefined;
      let released = false;
      let wake: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      const queued = new Map<Work, () => void>();
      const parts: Buffer[] = [];
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        unsubscribe?.();
        controller.abort();
        wake?.();
        for (const [work, abort] of queued) {
          options.authentication.remove(work);
          options.mailboxScheduler.remove(work);
          signal.removeEventListener('abort', abort);
        }
        queued.clear();
        controllers.delete(controller);
        parts.length = 0;
        laneBytes[lane] -= reservation;
        options.releaseBytes(reservation);
        socketCount.frames--;
        socketCount.bytes -= reservation;
        tokenCount[lane]--;
        if (!tokenCount.polls && !tokenCount.writes) tokens.delete(tokenKey);
        if (poll) pollCount--;
        else writeCount--;
        if (jobCount) {
          jobCount[lane]--;
          if (!jobCount.polls && !jobCount.writes && jobKey) jobs.delete(jobKey);
        }
        if (key) polls.delete(key);
      };
      const timer = setTimeout(
        () => {
          if (poll) send(res, 200, { command: null });
          else refuse(504, 'ack_timeout');
          release();
        },
        poll ? POLL_MS : TASK_COMMAND_ACK_TIMEOUT_MS
      );
      res.once('finish', release);
      res.once('close', release);
      req.once('aborted', release);
      // Shared round robin. A waiting poll owns no work slot or database client.
      function operation<T>(
        scheduler: Scheduler,
        taskId: string,
        run: () => Promise<T>
      ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const abort = () => {
            reject(new TaskChannelError(503, 'cancelled'));
          };
          const work: Work = {
            taskId,
            cancelled: () => signal.aborted,
            run: async () => {
              try {
                signal.throwIfAborted();
                resolve(await run());
              } catch (error) {
                reject(
                  error instanceof Error ? error : new TaskChannelError(503, 'channel_unavailable')
                );
              } finally {
                queued.delete(work);
                signal.removeEventListener('abort', abort);
              }
            },
          };
          queued.set(work, abort);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else scheduler.add(work);
        });
      }
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        if (signal.aborted) return;
        bytes += chunk.length;
        if (bytes > reservation) {
          refuse(413, 'invalid_frame');
          release();
        } else parts.push(chunk);
      });
      req.once('end', () => {
        if (signal.aborted || res.writableEnded) return;
        void (async () => {
          const verify = () =>
            operation(options.authentication, tokenKey, () =>
              options.identity.verify(token, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
            );
          let proof = await verify();
          signal.throwIfAborted();
          jobKey = proof.jobUid;
          const count = jobs.get(jobKey) ?? { polls: 0, writes: 0 };
          if (count[lane] >= (poll ? 1 : 4)) throw new TaskChannelError(429, 'channel_unavailable');
          jobCount = count;
          jobCount[lane]++;
          jobs.set(jobKey, jobCount);
          const sql = <T>(run: () => Promise<T>) =>
            operation(options.mailboxScheduler, proof.jobUid, run);
          if (!poll) {
            const parsed: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
            );
            parts.length = 0;
            if (ack) {
              const input = validateTaskCommandAck(parsed);
              const write = options.mailbox.acknowledgeCommand;
              if (!write) throw new TaskChannelError(503, 'channel_unavailable');
              await sql(() => write(input, proof, signal));
            } else {
              const input = validateTaskCommandReceipt(parsed);
              const write = options.mailbox.recordCommandReceipt;
              if (!write) throw new TaskChannelError(503, 'channel_unavailable');
              await sql(() => write(input, proof, signal));
            }
            signal.throwIfAborted();
            send(res, 200, { stored: true });
            return;
          }
          const readAuthority = options.mailbox.readTraceAuthority ?? options.mailbox.readBriefing;
          const briefing = await sql(() => readAuthority(proof, signal));
          signal.throwIfAborted();
          key = JSON.stringify([briefing.taskId, briefing.attemptId]);
          if (polls.has(key)) {
            key = undefined;
            throw new TaskChannelError(429, 'channel_unavailable');
          }
          polls.add(key);
          // Commit notifications are scoped to the canonical task, never broadcast.
          unsubscribe = options.mailbox.subscribeCommands?.(briefing.taskId, () => wake?.());
          const pollCommand = options.mailbox.pollCommand;
          if (!pollCommand) throw new TaskChannelError(503, 'channel_unavailable');
          let recheckMs = 1000;
          let waited = false;
          while (!signal.aborted) {
            let notified = false;
            let resolveWait: (() => void) | undefined;
            wake = () => {
              notified = true;
              resolveWait?.();
            };
            let command = await sql(() => pollCommand(proof, signal));
            signal.throwIfAborted();
            if (command) {
              // Re-verify live Pod/Job after waiting, but not on empty DB ticks.
              if (waited) {
                proof = await verify();
                command = await sql(() => pollCommand(proof, signal));
                signal.throwIfAborted();
                if (!command) continue;
              }
              if (Buffer.byteLength(JSON.stringify({ command })) > reservation)
                throw new TaskChannelError(413, 'invalid_frame');
              send(res, 200, { command });
              return;
            }
            if (!notified)
              await new Promise<void>((resolve) => {
                const recheck = setTimeout(resolve, recheckMs);
                resolveWait = () => {
                  clearTimeout(recheck);
                  resolve();
                };
                if (notified || signal.aborted) resolveWait();
              });
            signal.throwIfAborted();
            waited = true;
            recheckMs = Math.min(recheckMs * 2, 5000);
          }
        })().catch((error: unknown) => {
          if (signal.aborted) return;
          const safe =
            error instanceof TaskChannelError
              ? error
              : new TaskChannelError(
                  error instanceof SyntaxError ? 400 : 503,
                  error instanceof SyntaxError ? 'invalid_frame' : 'channel_unavailable'
                );
          refuse(safe.status, safe.code);
        });
      });
      return true;
    },
  };
}
