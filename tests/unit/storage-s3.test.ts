/**
 * The storage module's signed S3 check (ADR-015 S-D1, S-D7).
 *
 * The expected signature is an independent implementation's answer, not this
 * module's: botocore's SigV4Auth, with its clock fixed to 2013-05-24T00:00:00Z,
 * was asked for the same request and returned the string pinned below. A
 * signing bug therefore cannot agree with a test that repeats it.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { checkS3Bucket, signS3Request, type S3Credentials } from '../../loader/src/storage-s3.js';

const credentials: S3Credentials = {
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('the storage module signature', () => {
  it('matches an independent SigV4 implementation for the store check', () => {
    const headers = signS3Request({
      method: 'GET',
      url: new URL(
        'http://seaweedfs.lifemodel-system.svc:8333/lifemodel-storage?list-type=2&max-keys=1'
      ),
      credentials,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers).toEqual({
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=113b39b4a86d27cd0dea87c9af9ce38c557c7e7e60e7da64321d537e95ed8c93',
    });
  });

  it('sorts and encodes the query and never signs an uncanonical path', () => {
    const sorted = signS3Request({
      method: 'GET',
      url: new URL('http://store:8333/bucket?a=1&b=2'),
      credentials,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    const unsorted = signS3Request({
      method: 'GET',
      url: new URL('http://store:8333/bucket?b=2&a=1'),
      credentials,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    // The canonical query is sorted, so the parameter order cannot change it.
    expect(sorted['authorization']).toBe(unsorted['authorization']);
    expect(() =>
      signS3Request({
        method: 'GET',
        url: new URL('http://store:8333/bucket%20with%20space'),
        credentials,
        now: new Date(),
      })
    ).toThrow(/canonical/);
  });

  it('keeps the secret out of the header set it returns', () => {
    const headers = signS3Request({
      method: 'GET',
      url: new URL('http://store:8333/bucket'),
      credentials,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(JSON.stringify(headers)).not.toContain(credentials.secretKey);
  });
});

describe('the authenticated store check', () => {
  it('is ok only for 200 and keeps each failure its own reason', async () => {
    const statuses = [200, 403, 401, 404, 500, 301];
    const endpoint = await listen(
      createServer((_req, res) => {
        res.writeHead(statuses.shift() ?? 500);
        // A body the module must never keep or repeat.
        res.end('<Error><Code>AccessKeyId=AKIA-SECRET-BODY</Code></Error>');
      })
    );
    const answer = async () =>
      checkS3Bucket({ endpoint, bucket: 'lifemodel-storage', credentials });
    expect(await answer()).toEqual({ ok: true });
    expect(await answer()).toEqual({ ok: false, code: 'auth_denied', status: 403 });
    expect(await answer()).toEqual({ ok: false, code: 'auth_denied', status: 401 });
    expect(await answer()).toEqual({ ok: false, code: 'bucket_missing', status: 404 });
    expect(await answer()).toEqual({ ok: false, code: 'unexpected', status: 500 });
    expect(await answer()).toEqual({ ok: false, code: 'unexpected', status: 301 });
  });

  it('signs the request it sends and asks the module bucket only', async () => {
    const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
    const endpoint = await listen(
      createServer((req, res) => {
        seen.push({ url: req.url ?? '', headers: { ...req.headers } });
        res.writeHead(200);
        res.end();
      })
    );
    await expect(
      checkS3Bucket({
        endpoint,
        bucket: 'lifemodel-storage',
        credentials,
        now: () => new Date('2013-05-24T00:00:00Z'),
      })
    ).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/lifemodel-storage?list-type=2&max-keys=1');
    expect(seen[0]?.headers['authorization']).toContain('Signature=');
    expect(seen[0]?.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    // The secret travels in the signature only.
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(credentials.secretKey);
  });

  it('calls a stopped store unreachable rather than empty', async () => {
    // A port that nothing listens on: listening once and closing frees it.
    const endpoint = await listen(createServer((_req, res) => res.end()));
    const port = Number.parseInt(new URL(endpoint).port, 10);
    const server = servers.pop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    const answer = await checkS3Bucket({
      endpoint: `http://127.0.0.1:${String(port)}`,
      bucket: 'lifemodel-storage',
      credentials,
      timeoutMs: 500,
    });
    expect(answer).toEqual({ ok: false, code: 'unreachable', status: null });
  });

  it('refuses an endpoint that is not HTTP', async () => {
    await expect(
      checkS3Bucket({ endpoint: 'ftp://store:8333', bucket: 'b', credentials })
    ).rejects.toThrow(/http/);
  });
});
