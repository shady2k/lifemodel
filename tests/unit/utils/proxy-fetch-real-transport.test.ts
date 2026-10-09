import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const stand = path.join(repoRoot, 'tests/fixtures/proxy-fetch-tls/proof-stand.mts');

/** This box's own LAN address: a real-socket stand dials a non-loopback name. */
function thisLanAddress(): string {
  return new Promise((resolve, reject) => {
    const probe = net.connect({ host: '8.8.8.8', port: 53 });
    probe.on('connect', () => {
      const address = probe.address();
      probe.destroy();
      if (typeof address !== 'object' || address.address === undefined) {
        reject(new Error('the LAN probe gave no local address'));
      } else {
        resolve(address.address);
      }
    });
    probe.on('error', reject);
  });
}

describe('proxyFetch against the real grammY Bot over real sockets', () => {
  let certDir: string;
  let lanAddress: string;

  beforeAll(async () => {
    lanAddress = await thisLanAddress();
    certDir = await mkdtemp(path.join(os.tmpdir(), 'q4xtf2-certs-'));
    await run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        certDir + '/ca.key',
        '-out',
        certDir + '/ca.pem',
        '-days',
        '30',
        '-nodes',
        '-subj',
        '/CN=q4xtf2 proof CA',
      ],
      { timeout: 30_000 }
    );
    await run(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-keyout',
        certDir + '/server.key',
        '-out',
        certDir + '/server.csr',
        '-nodes',
        '-subj',
        '/CN=' + lanAddress,
      ],
      { timeout: 30_000 }
    );
    await writeFile(
      certDir + '/ext.cnf',
      'subjectAltName=IP:' +
        lanAddress +
        ',IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n',
      'utf8'
    );
    await run(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        certDir + '/server.csr',
        '-CA',
        certDir + '/ca.pem',
        '-CAkey',
        certDir + '/ca.key',
        '-CAcreateserial',
        '-out',
        certDir + '/server.pem',
        '-days',
        '30',
        '-extfile',
        certDir + '/ext.cnf',
      ],
      { timeout: 30_000 }
    );
  });

  afterAll(async () => {
    if (certDir !== undefined) await rm(certDir, { recursive: true, force: true });
  });

  it(
    'reaches an https API with the shim polyfill signal through CONNECT and the pinned CA, ' +
      'cancels before the headers and mid-body, and upgrades an http endpoint through 307 onto an https hop',
    { timeout: 130_000 },
    async () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env['HTTP_PROXY'];
      delete env['HTTPS_PROXY'];
      delete env['http_proxy'];
      delete env['https_proxy'];
      // NO_PROXY must not decide the loopback question here: the stand runs
      // without it, and the runner's env gets its shape from the loader.
      delete env['NO_PROXY'];
      delete env['no_proxy'];
      env['NODE_USE_ENV_PROXY'] = '1';
      env['NODE_EXTRA_CA_CERTS'] = certDir + '/ca.pem';
      env['LAN'] = lanAddress;
      env['PROOF_CERT_DIR'] = certDir;

      const child = execFile('node', ['--import', 'tsx', stand], {
        cwd: repoRoot,
        env,
        timeout: 120_000,
      });
      const lines: string[] = [];
      const output: string[] = [];
      child.stderr?.on('data', (chunk: Buffer) => {
        output.push(chunk.toString());
        for (const line of chunk.toString().split('\n')) {
          if (line.startsWith('PROOF')) lines.push(line);
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                'the proof stand left with ' +
                  String(code) +
                  '; its output:' +
                  output.join('').slice(-4000)
              )
            );
        });
        child.on('error', (error: Error) => reject(error));
      });

      for (const line of lines) {
        if (line.includes('FAILED')) throw new Error(line);
      }
      expect(lines.some((l) => l.includes('PROOF N3a bot-getMe-https: ok'))).toBe(true);
      expect(lines.some((l) => l.startsWith('PROOF N3b pre-header abort: rejected'))).toBe(true);
      expect(lines.some((l) => l.startsWith('PROOF N3c mid-body abort: rejected'))).toBe(true);
      expect(lines.some((l) => l.includes('PROOF N4 http-to-https-307: ok'))).toBe(true);
      expect(lines.some((l) => l.includes('PROOF RUNNER ALL OK'))).toBe(true);

      const record = lines.find((l) => l.startsWith('PROOF STAND RECORD'));
      expect(record).toBeDefined();
      const connects = Number(/connects (\d+) absolute-form (\d+)/.exec(record ?? '')?.[1] ?? '0');
      const absoluteForm = Number(/absolute-form (\d+)/.exec(record ?? '')?.[1] ?? '0');
      expect(connects).toBeGreaterThanOrEqual(4);
      expect(absoluteForm).toBe(1);
      const absUrls = lines.filter((l) => l.startsWith('PROOF STAND ABS:'));
      for (const line of absUrls) expect(line).toContain('http://127.0.0.2:');
      const connectTargets = lines.filter((l) => l.startsWith('PROOF STAND CONNECT:'));
      expect(connectTargets.length).toBe(connects);
      for (const line of connectTargets) expect(line).contains(lanAddress + ':');
    }
  );
});
