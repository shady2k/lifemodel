import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:https';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const dirs: string[] = [];
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'installer-tls-'));
  dirs.push(dir);
  const openssl = (args: string[]) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8', timeout: 10000 });
    expect(r.status, r.stderr).toBe(0);
  };
  for (const prefix of ['ca', 'wrong'])
    openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      `${prefix}.key`,
      '-out',
      `${prefix}.crt`,
      '-subj',
      `/CN=${prefix}`,
      '-days',
      '1',
    ]);
  openssl([
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=boot-home.local',
  ]);
  writeFileSync(
    join(dir, 'ext'),
    'subjectAltName=DNS:boot-home.local,DNS:boot-lifemodel.local\nextendedKeyUsage=serverAuth\n'
  );
  openssl([
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.crt',
    '-days',
    '1',
    '-extfile',
    'ext',
  ]);
  const ready = {
    metadata: { generation: 1 },
    status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' }] },
  };
  const resources: Record<string, unknown> = {
    nodes: { items: [{}] },
    ocirepository: ready,
    kustomization: ready,
    pods: {
      items: [
        {
          metadata: { labels: { 'app.kubernetes.io/name': 'loader' } },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    },
    configmap: { data: { 'ca.crt': readFileSync(join(dir, 'ca.crt'), 'utf8') } },
  };
  const cluster = join(dir, 'cluster.json');
  const save = () => writeFileSync(cluster, JSON.stringify(resources));
  save();
  const kubectl = join(dir, 'kubectl');
  writeFileSync(
    kubectl,
    `#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(join(dir, 'requests'))},JSON.stringify(a)+'\\n'); const kind=a[a.indexOf('get')+1]; const ns=a[a.indexOf('-n')+1]; const id=a[a.indexOf('get')+2]; if(kind==='ocirepository' && (ns!=='flux-system'||id!=='platform')) process.exit(64); if(kind==='kustomization' && (ns!=='flux-system'||id!=='platform-instance')) process.exit(64); if(kind==='pods' && ns!=='lifemodel-system') process.exit(64); if(kind==='configmap' && (ns!=='lifemodel-system'||id!=='lifemodel-ca')) process.exit(64); const r=JSON.parse(fs.readFileSync(${JSON.stringify(cluster)},'utf8'))[a[a.indexOf('get')+1]]; if(!r) process.exit(1); console.log(JSON.stringify(r));\n`
  );
  chmodSync(kubectl, 0o755);
  return { dir, resources, save, kubectl };
}
async function serve(dir: string, status = 200, hang = false) {
  const requests: {
    method: string | undefined;
    url: string | undefined;
    host: string | undefined;
    authorization: string | undefined;
    cookie: string | undefined;
  }[] = [];
  server = createServer(
    { key: readFileSync(join(dir, 'leaf.key')), cert: readFileSync(join(dir, 'leaf.crt')) },
    (req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
      });
      if (!hang) {
        res.writeHead(status);
        res.end('{}');
      }
    }
  );
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(443, '127.0.0.1', resolve);
  });
  return requests;
}
async function run(f: ReturnType<typeof fixture>, timeoutMs = 1500) {
  const curl = spawnSync('curl', ['--version'], { encoding: 'utf8', timeout: 10000 });
  expect(curl.status, String(curl.error) + curl.stderr).toBe(0);
  const probe = spawnSync(f.kubectl, ['get', 'nodes'], { encoding: 'utf8', timeout: 10000 });
  if (f.resources.nodes) expect(probe.status, probe.stderr).toBe(0);
  const { waitReady } = await import(
    pathToFileURL(join(process.cwd(), 'deploy/cli/wait-ready.mjs')).href
  );
  return waitReady({ name: 'home', kubectl: [f.kubectl], timeoutMs, pollMs: 10 });
}
describe('installer verified wait', () => {
  it('installs a stamped release from a clean bundle with no required parameters, then verifies TLS', async () => {
    const f = fixture();
    const requests = await serve(f.dir);
    const digest = `sha256:${'a'.repeat(64)}`;
    const bundle = join(f.dir, 'release');
    const prepared = spawnSync(
      'sh',
      ['scripts/release/prepare-installer-bundle.sh', 'v8.7.6', digest, bundle],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(prepared.status, prepared.stderr).toBe(0);
    const extracted = spawnSync(
      'tar',
      ['-xzf', join(bundle, 'lifemodel-installer-v8.7.6.tar.gz'), '-C', bundle],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(extracted.status, extracted.stderr).toBe(0);
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const command = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    command('id', 'echo 0');
    command('apt-get', 'exit 0');
    command(
      'systemctl',
      `if [ "$*" = 'start lifemodel-k3s-dns-apply.service' ]; then
  exec sh "$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel/k3s-dns-apply.sh" "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.conf"
fi
exit 0`
    );
    command('ip', `printf '%s' '[{"dev":"eth0"}]'`);
    command('ufw', 'echo "Status: inactive"');
    command(
      'k3s',
      `if [ "$1" = --version ]; then echo 'k3s version v1.35.8+k3s1'; exit 0; fi\nshift\nif [ "$1" = --kubeconfig ]; then shift 2; fi\ncase "$*" in\n*'get --raw=/readyz'*|*'rollout restart deploy/coredns'*|*'rollout status deploy/coredns'*) exit 0;;\n*'exec deploy/coredns -- cat /etc/resolv.conf'*) cat "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.conf"; exit 0;;\n*'get namespace flux-system -o jsonpath='*) echo lifemodel; exit 0;;\n*'get namespace flux-system'*) exit 0;;\n*'get configmap lifemodel-instance -o jsonpath='*) echo '(NotFound)' >&2; exit 1;;\n*'get ocirepository platform'*'--show-managed-fields'*) echo '{"metadata":{"managedFields":[]}}'; exit 0;;\n*apply*) for arg do last=$arg; done; if [ "$last" = - ]; then cat >/dev/null; fi; exit 0;;\nesac\nexec ${JSON.stringify(f.kubectl)} "$@"`
    );
    const realCurl = spawnSync('sh', ['-c', 'command -v curl'], {
      encoding: 'utf8',
      timeout: 10000,
    }).stdout.trim();
    command(
      'curl',
      `case "$*" in *github.com/fluxcd*) for arg do output=$arg; done; printf manifest > "$output"; exit 0;; esac\nexec ${JSON.stringify(realCurl)} "$@"`
    );
    command('sha256sum', 'if [ "$1" = -c ]; then cat >/dev/null; exit 0; fi; exit 64');
    const result = await promisify(execFile)('sh', [join(bundle, 'scripts/install.sh')], {
      cwd: f.dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LIFEMODEL_INSTALL_ROOT: join(f.dir, 'host'),
        LIFEMODEL_STATE_DIR: join(f.dir, 'state'),
      },
      timeout: 20000,
    });
    expect(result.stdout).toContain('Address: https://lifemodel.local/');
    expect(result.stdout).toContain('SHA-256 fingerprint of the CA certificate (DER):');
    expect(readFileSync(join(f.dir, 'host/etc/lifemodel/instance.env'), 'utf8')).toContain(
      `LIFEMODEL_PLATFORM_DIGEST='${digest}'`
    );
    expect(requests).toContainEqual({
      method: 'GET',
      url: '/api/state',
      host: 'boot-lifemodel.local',
      authorization: undefined,
      cookie: undefined,
    });
  }, 30000);

  it('uses anonymous HTTPS GET, trusts ConfigMap CA and prints its DER fingerprint', async () => {
    const f = fixture();
    const requests = await serve(f.dir);
    const result = await run(f, 5000);
    expect(result.ready, result.output + readFileSync(join(f.dir, 'requests'), 'utf8')).toBe(true);
    expect(result.output).toContain('Address: https://home.local/');
    const der = spawnSync('openssl', ['x509', '-in', join(f.dir, 'ca.crt'), '-outform', 'DER'], {
      timeout: 10000,
    });
    expect(der.status).toBe(0);
    expect(result.output).toContain(
      `SHA-256 fingerprint of the CA certificate (DER): ${createHash('sha256').update(der.stdout).digest('hex')}`
    );
    expect(requests).toEqual([
      {
        method: 'GET',
        url: '/api/state',
        host: 'boot-home.local',
        authorization: undefined,
        cookie: undefined,
      },
    ]);
    expect(readFileSync(join(f.dir, 'requests'), 'utf8')).not.toContain('secret');
  }, 20000);
  it.each([401, 500, 302, 204])(
    'rejects HTTP %s and names the route',
    async (status) => {
      const f = fixture();
      await serve(f.dir, status);
      const result = await run(f);
      expect(result.ready).toBe(false);
      expect(result.output).toContain('route');
      expect(result.output).toContain('lifemodel doctor');
    },
    20000
  );

  it('does not trust a foreign root from curl default CApath', async () => {
    const f = fixture();
    const requests = await serve(f.dir);
    // The leaf is valid for ca.crt, but the established ConfigMap publishes wrong.crt.
    f.resources.configmap = { data: { 'ca.crt': readFileSync(join(f.dir, 'wrong.crt'), 'utf8') } };
    f.save();
    const trust = join(f.dir, 'trust');
    mkdirSync(trust);
    writeFileSync(join(trust, 'foreign.pem'), readFileSync(join(f.dir, 'ca.crt')));
    expect(spawnSync('openssl', ['rehash', trust], { timeout: 10000 }).status).toBe(0);
    const curl = spawnSync('sh', ['-c', 'command -v curl'], {
      encoding: 'utf8',
      timeout: 10000,
    }).stdout.trim();
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\nexec ${JSON.stringify(curl)} --disable --capath ${JSON.stringify(trust)} "$@"\n`
    );
    chmodSync(join(bin, 'curl'), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    try {
      const result = await run(f);
      expect(result.ready).toBe(false);
      expect(result.output).toContain('certificate');
      expect(requests).toHaveLength(0);
    } finally {
      process.env.PATH = before;
    }
  }, 20000);

  it('ignores curlrc insecure, redirect, cookie and authorization settings', async () => {
    const f = fixture();
    const requests = await serve(f.dir);
    writeFileSync(
      join(f.dir, '.curlrc'),
      'insecure\nlocation\ncookie = "secret=must-not-send"\nheader = "Authorization: secret"\n'
    );
    const before = process.env.CURL_HOME;
    process.env.CURL_HOME = f.dir;
    try {
      const accepted = await run(f, 5000);
      expect(accepted.ready, accepted.output).toBe(true);
      expect(requests[0]).toEqual({
        method: 'GET',
        url: '/api/state',
        host: 'boot-home.local',
        authorization: undefined,
        cookie: undefined,
      });
      f.resources.configmap = {
        data: { 'ca.crt': readFileSync(join(f.dir, 'wrong.crt'), 'utf8') },
      };
      f.save();
      const rejected = await run(f);
      expect(rejected.ready).toBe(false);
      expect(rejected.output).toContain('certificate');
    } finally {
      if (before === undefined) delete process.env.CURL_HOME;
      else process.env.CURL_HOME = before;
    }
  }, 20000);

  it('rejects a foreign certificate even when the route answers 200', async () => {
    const f = fixture();
    await serve(f.dir);
    f.resources.configmap = { data: { 'ca.crt': readFileSync(join(f.dir, 'wrong.crt'), 'utf8') } };
    f.save();
    const result = await run(f);
    expect(result.ready).toBe(false);
    expect(result.output).toContain('certificate');
  }, 20000);

  it.each([undefined, 1200000])(
    'caps the whole production wait at ten minutes (requested %s)',
    async (timeoutMs) => {
      const f = fixture();
      delete f.resources.nodes;
      f.save();
      const { waitReady } = await import(
        pathToFileURL(join(process.cwd(), 'deploy/cli/wait-ready.mjs')).href
      );
      const now = performance.now.bind(performance);
      const start = now();
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now() - start) * 1000);
      try {
        const result = await waitReady({
          name: 'home',
          kubectl: [f.kubectl],
          timeoutMs,
          pollMs: 1,
        });
        expect(result.ready).toBe(false);
        expect(result.output).toContain('k3s');
        expect(now() - start).toBeLessThan(1000);
      } finally {
        clock.mockRestore();
      }
    },
    5000
  );

  it('caps each request at ten seconds even when the overall deadline is later', async () => {
    const f = fixture();
    const requests = await serve(f.dir, 200, true);
    let first = true;
    server!.removeAllListeners('request');
    server!.on('request', (req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
      });
      if (first) {
        first = false;
        return;
      }
      res.writeHead(200);
      res.end('{}');
    });
    const start = performance.now();
    const result = await run(f, 15000);
    expect(result.ready, result.output).toBe(true);
    expect(requests).toHaveLength(2);
    expect(performance.now() - start).toBeLessThan(14000);
  }, 20000);

  it('bounds a stalled request by the overall wait deadline', async () => {
    const f = fixture();
    await serve(f.dir, 200, true);
    const start = performance.now();
    const result = await run(f, 1000);
    expect(result.ready).toBe(false);
    expect(result.output).toContain('route');
    expect(performance.now() - start).toBeLessThan(2500);
  }, 20000);

  it.each(['ocirepository', 'kustomization'])(
    'requires current generation Ready=True for %s',
    async (key) => {
      const f = fixture();
      f.resources[key] = {
        metadata: { generation: 2 },
        status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' }] },
      };
      f.save();
      const result = await run(f, 1500);
      expect(result.ready).toBe(false);
      expect(result.output).toContain(
        key === 'ocirepository' ? 'Flux source' : 'platform-instance'
      );
    },
    20000
  );

  it.each([
    ['nodes', 'k3s'],
    ['ocirepository', 'Flux source'],
    ['kustomization', 'platform-instance'],
    ['pods', 'loader pod'],
    ['configmap', 'certificate'],
  ])(
    'names first unready step %s',
    async (key, step) => {
      const f = fixture();
      delete f.resources[key];
      f.save();
      const result = await run(f, 1500);
      expect(result.ready).toBe(false);
      expect(result.output).toContain(step);
      expect(result.output).toContain('lifemodel doctor');
    },
    20000
  );
});
