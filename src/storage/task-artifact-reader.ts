import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { PassThrough, Transform, pipeline } from 'node:stream';
import type { TaskArtifactReader } from '../ports/task-artifact-download.js';
import {
  ARTIFACT_ID,
  ArtifactUnavailableError,
  validArtifactRange,
} from '../ports/task-artifact-download.js';

/** The web's service identity can read one marked artifact, never S3 or object lists. */
export class StorageTaskArtifactReader implements TaskArtifactReader {
  private readonly socketErrors = new WeakSet<import('node:net').Socket>();
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
  private readonly endpoint: URL;
  constructor(
    private readonly options: {
      endpoint: string;
      tokenFile: string;
      caFile: string;
      requestTimeoutMs?: number;
    }
  ) {
    this.endpoint = new URL(options.endpoint);
    if (
      this.endpoint.protocol !== 'https:' ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      this.endpoint.pathname !== '/'
    )
      throw new Error('Invalid storage read endpoint');
  }

  close(): void {
    this.agent.destroy();
  }

  async openTaskArtifact(artifactId: string, range: string | undefined, signal: AbortSignal) {
    if (!ARTIFACT_ID.test(artifactId)) throw new ArtifactUnavailableError(404);
    if (range !== undefined && !validArtifactRange(range)) throw new ArtifactUnavailableError(416);
    try {
      // Directory-mounted projected identities rotate. Read again for every call.
      const [rawToken, ca] = await Promise.all([
        readFile(this.options.tokenFile, 'utf8'),
        readFile(this.options.caFile),
      ]);
      signal.throwIfAborted();
      const token = rawToken.trim();
      if (!token || /\s/.test(token)) throw new ArtifactUnavailableError(503);
      return await new Promise<Awaited<ReturnType<TaskArtifactReader['openTaskArtifact']>>>(
        (resolve, reject) => {
          const fail = () => reject(new ArtifactUnavailableError(503));
          const req = request(new URL(`/artifacts/${artifactId}`, this.endpoint), {
            agent: this.agent,
            ca,
            signal,
            headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) },
          });
          req.on('error', fail);
          req.on('socket', (socket) => {
            if (!this.socketErrors.has(socket)) {
              this.socketErrors.add(socket);
              socket.on('error', () => undefined);
            }
          });
          const timer = setTimeout(
            () => req.destroy(new Error('artifact_deadline')),
            this.options.requestTimeoutMs ?? 15 * 60_000
          );
          timer.unref();
          req.on('close', () => clearTimeout(timer));
          req.on('response', (res) => {
            res.on('error', () => undefined);
            if (res.statusCode !== 200 && res.statusCode !== 206) {
              const status =
                res.statusCode === 404 || res.statusCode === 410
                  ? 404
                  : res.statusCode === 416
                    ? 416
                    : 503;
              res.destroy();
              reject(new ArtifactUnavailableError(status));
              return;
            }
            const sizeHeader = res.headers['x-storage-size'];
            const lengthHeader = res.headers['content-length'];
            const decimal = (value: unknown): number =>
              typeof value === 'string' &&
              /^(0|[1-9][0-9]*)$/.test(value) &&
              Number.isSafeInteger(Number(value))
                ? Number(value)
                : -1;
            const size = decimal(sizeHeader);
            const length = decimal(lengthHeader);
            const partial = range !== undefined;
            const match = partial ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
            const start = match ? Number(match[1]) : 0;
            const end = match ? Number(match[2]) : size - 1;
            if (
              size < 0 ||
              length < 0 ||
              res.headers['content-encoding'] !== undefined ||
              res.statusCode !== (partial ? 206 : 200) ||
              (partial &&
                (start >= size ||
                  end >= size ||
                  res.headers['content-range'] !== `bytes ${start}-${end}/${size}`)) ||
              length !== end - start + 1
            ) {
              res.destroy();
              fail();
              return;
            }
            let received = 0;
            const measured = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                received += chunk.length;
                callback(received > length ? new Error('artifact_length') : null, chunk);
              },
              flush(callback) {
                callback(
                  received === length && res.complete ? null : new Error('artifact_incomplete')
                );
              },
            });
            const body = new PassThrough();
            body.on('error', () => undefined);
            measured.on('error', () => undefined);
            pipeline(res, measured, body, () => undefined);
            resolve({ body, size, start, end, partial });
          });
          req.end();
        }
      );
    } catch (error) {
      if (error instanceof ArtifactUnavailableError) throw error;
      throw new ArtifactUnavailableError(503);
    }
  }
}
