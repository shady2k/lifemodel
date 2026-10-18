import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'deploy/cli/lifemodel.mjs');
const identityRequest = [
  'get',
  'configmaps',
  'lifemodel-instance',
  '-n',
  'flux-system',
  '-o',
  'json',
];
const caRequest = ['get', 'configmaps', 'lifemodel-ca', '-n', 'lifemodel-system', '-o', 'json'];
const dirs: string[] = [];
let certDir: string;
let cert: string;
let fingerprint: string;

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'lifemodel-address-ca-'));
  const ca = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      join(certDir, 'ca.key'),
      '-out',
      join(certDir, 'ca.crt'),
      '-subj',
      '/CN=fixture-ca',
      '-days',
      '1',
    ],
    { encoding: 'utf8', timeout: 10000 }
  );
  expect(ca.status, ca.stderr).toBe(0);
  cert = readFileSync(join(certDir, 'ca.crt'), 'utf8');
  const der = spawnSync('openssl', ['x509', '-in', join(certDir, 'ca.crt'), '-outform', 'DER'], {
    encoding: 'buffer',
    timeout: 10000,
  });
  expect(der.status, der.stderr.toString()).toBe(0);
  fingerprint = createHash('sha256').update(der.stdout).digest('hex');
});
afterAll(() => rmSync(certDir, { recursive: true, force: true }));
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

type Reply = { data?: unknown; error?: string; raw?: string };
function invoke(
  identity: Reply = { data: { LIFEMODEL_NAME: 'home' } },
  ca: Reply = { data: { 'ca.crt': cert } }
) {
  const dir = mkdtempSync(join(tmpdir(), 'lifemodel-address-'));
  dirs.push(dir);
  const fake = join(dir, 'kubectl.mjs');
  const log = join(dir, 'requests.jsonl');
  writeFileSync(log, '');
  writeFileSync(
    fake,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.REQUEST_LOG, JSON.stringify(args) + '\\n');
const replies = JSON.parse(process.env.FAKE_REPLIES);
const reply = replies[JSON.stringify(args)];
if (!reply) { console.error('Unexpected Kubernetes request'); process.exit(1); }
if (reply.error) { console.error(reply.error); process.exit(1); }
console.log(reply.raw === undefined ? JSON.stringify({ data: reply.data }) : reply.raw);
`
  );
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [cli, 'address'], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      LIFEMODEL_KUBECTL: `${process.execPath} ${fake}`,
      LIFEMODEL_STATE_DIR: dir,
      LIFEMODEL_NAME: 'untrusted-env-name',
      REQUEST_LOG: log,
      FAKE_REPLIES: JSON.stringify({
        [JSON.stringify(identityRequest)]: identity,
        [JSON.stringify(caRequest)]: ca,
      }),
    },
  });
  const requests = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  // Exact allowlist: no Secret, pod exec, key read, list request or PKI-status dependency.
  for (const request of requests) expect([identityRequest, caRequest]).toContainEqual(request);
  expect(result.error).toBeUndefined();
  return { ...result, requests };
}
function expectNotReady(result: ReturnType<typeof invoke>, reason: string) {
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`lifemodel address: not ready (${reason}); run lifemodel doctor`);
  expect(result.stderr).not.toContain('not installed');
}

describe('lifemodel address', () => {
  it('prints only the established identity and public CA DER SHA-256, without requiring PKI status', () => {
    const result = invoke();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `Address: https://home.local/\nSHA-256 fingerprint of the CA certificate (DER): ${fingerprint}\n`
    );
    expect(result.stderr).toBe('');
    expect(result.requests).toEqual([identityRequest, caRequest]);
    expect(fingerprint).not.toBe(createHash('sha256').update(cert).digest('hex'));
  });
  it.each(['a', 'a'.repeat(57)])('accepts a valid established name: %s', (name) => {
    const result = invoke({ data: { LIFEMODEL_NAME: name } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Address: https://${name}.local/`);
  });
  it('says not installed only when the identity ConfigMap is absent', () => {
    const result = invoke({
      error: 'Error from server (NotFound): configmaps "lifemodel-instance" not found',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('lifemodel address: not installed');
    expect(result.stderr).not.toContain('not ready');
    expect(result.requests).toEqual([identityRequest]);
  });
  it.each(['Forbidden', 'Unable to connect to the server', 'request timed out'])(
    'treats identity lookup failure as not ready: %s',
    (error) => {
      const result = invoke({ error });
      expectNotReady(result, 'identity unavailable');
      expect(result.requests).toEqual([identityRequest]);
    }
  );
  it.each([undefined, null, 42, '', 'A', '-home', 'home-', 'home.local', 'a'.repeat(58)])(
    'refuses invalid established names rather than using a default: %s',
    (name) => {
      const result = invoke({ data: { LIFEMODEL_NAME: name } });
      expectNotReady(result, 'identity invalid');
      expect(result.requests).toEqual([identityRequest]);
    }
  );
  it.each(['null', '[]', '{'])('reports malformed identity records as not ready: %s', (raw) => {
    const result = invoke({ raw });
    expectNotReady(result, raw === '{' ? 'identity unavailable' : 'identity invalid');
  });
  it.each(['not found', 'Forbidden', 'Unable to connect to the server'])(
    'reports CA lookup failure as not ready: %s',
    (error) => {
      expectNotReady(invoke(undefined, { error }), 'CA unavailable');
    }
  );
  it.each([
    {},
    { 'ca.crt.pem': 'legacy certificate' },
    { 'ca.crt': null },
    { 'ca.crt': 42 },
    { 'ca.crt': '' },
  ])('requires the ca.crt field, with no legacy fallback: %j', (data) => {
    expectNotReady(invoke(undefined, { data }), 'CA unavailable');
  });
  it('rejects legacy-only CA data even when it holds a valid certificate', () => {
    expectNotReady(invoke(undefined, { data: { 'ca.crt.pem': cert } }), 'CA unavailable');
  });
  it('does not hide invalid ca.crt behind a valid legacy field', () => {
    expectNotReady(
      invoke(undefined, { data: { 'ca.crt': 'not a certificate', 'ca.crt.pem': cert } }),
      'CA certificate invalid'
    );
  });
  it.each(['null', '{'])('reports malformed CA records as not ready: %s', (raw) => {
    expectNotReady(invoke(undefined, { raw }), 'CA unavailable');
  });
});
