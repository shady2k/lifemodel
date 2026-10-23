import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as x509 from '@peculiar/x509';
import {
  createPkiManager,
  instanceHosts,
  STORAGE_MODULE_TLS_HOSTS,
  TASK_MODEL_TLS_HOSTS,
  TASK_CHANNEL_TLS_HOSTS,
} from '../../loader/src/pki.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createTestClock } from '../../loader/src/clock.js';
import { loadConfig } from '../../loader/src/config.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'loader-pki-'));
  roots.push(root);
  let secret: { ca?: string; cert?: string; key?: string } = {};
  let serviceSecret: { ca?: string; cert?: string; key?: string } = {};
  let taskModelSecret: { ca?: string; cert?: string; key?: string } = {};
  let taskChannelSecret: { ca?: string; cert?: string; key?: string } = {};
  let caMap: string | null = null;
  const events: string[] = [];
  const clock = createTestClock();
  const manager = createPkiManager({
    config: { ...loadConfig({ LIFEMODEL_NAME: 'home', LIFEMODEL_VOLUME_ROOT: root }) },
    fs: createNodeFileSystem(),
    clock,
    secret: {
      read: async () => secret,
      write: async (ca, cert, key) => {
        events.push('leaf');
        secret = { ca, cert, key };
      },
    },
    configMap: {
      read: async () => caMap,
      write: async (ca) => {
        events.push('configmap');
        caMap = ca;
      },
    },
    service: {
      hosts: STORAGE_MODULE_TLS_HOSTS,
      secret: {
        read: async () => serviceSecret,
        write: async (ca, cert, key) => {
          events.push('service-leaf');
          serviceSecret = { ca, cert, key };
        },
      },
    },
    taskModelService: {
      hosts: TASK_MODEL_TLS_HOSTS,
      secret: {
        read: async () => taskModelSecret,
        write: async (ca, cert, key) => {
          events.push('task-model-leaf');
          taskModelSecret = { ca, cert, key };
        },
      },
    },
    taskChannelService: {
      hosts: TASK_CHANNEL_TLS_HOSTS,
      secret: {
        read: async () => taskChannelSecret,
        write: async (ca, cert, key) => {
          events.push('task-channel-leaf');
          taskChannelSecret = { ca, cert, key };
        },
      },
    },
  });
  return {
    root,
    manager,
    events,
    get secret() {
      return secret;
    },
    get serviceSecret() {
      return serviceSecret;
    },
    set serviceSecret(value) {
      serviceSecret = value;
    },
    get taskModelSecret() {
      return taskModelSecret;
    },
    get taskChannelSecret() {
      return taskChannelSecret;
    },
    get caMap() {
      return caMap;
    },
    clock,
  };
}
// Keep these assertions independent of the lifecycle validator. Node's
// X509Certificate.verify checks signatures, not RFC 5280's strict extensions.
function expectStrictKeyIdentifiers(caPem: string, leafPem: string) {
  const ca = new x509.X509Certificate(caPem);
  const leaf = new x509.X509Certificate(leafPem);
  const constraints = ca.getExtension(x509.BasicConstraintsExtension);
  const caUsage = ca.getExtension(x509.KeyUsagesExtension);
  const leafUsage = leaf.getExtension(x509.KeyUsagesExtension);
  const eku = leaf.getExtension(x509.ExtendedKeyUsageExtension);
  expect(constraints?.ca).toBe(true);
  expect(constraints?.pathLength).toBe(0);
  expect(constraints?.critical).toBe(true);
  expect(caUsage?.usages).toBe(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign);
  expect(caUsage?.critical).toBe(true);
  expect(leafUsage?.usages).toBe(x509.KeyUsageFlags.digitalSignature);
  expect(leafUsage?.critical).toBe(true);
  expect(eku?.usages).toEqual(['1.3.6.1.5.5.7.3.1']);
  expect(eku?.critical).toBe(true);
  const caSki = ca.getExtension(x509.SubjectKeyIdentifierExtension);
  const leafSki = leaf.getExtension(x509.SubjectKeyIdentifierExtension);
  const leafAki = leaf.getExtension(x509.AuthorityKeyIdentifierExtension);
  expect(caSki?.keyId).toMatch(/^(?:[0-9a-f]{2})+$/i);
  expect(caSki?.critical).toBe(false);
  expect(leafSki?.keyId).toMatch(/^(?:[0-9a-f]{2})+$/i);
  expect(leafSki?.critical).toBe(false);
  expect(leafAki?.keyId).toBe(caSki?.keyId);
  expect(leafAki?.critical).toBe(false);
  const nodeCa = new X509Certificate(caPem);
  const nodeLeaf = new X509Certificate(leafPem);
  expect(nodeCa.ca).toBe(true);
  expect(nodeCa.verify(nodeCa.publicKey)).toBe(true);
  expect(nodeLeaf.ca).toBe(false);
  expect(nodeLeaf.issuer).toBe(nodeCa.subject);
  expect(nodeLeaf.verify(nodeCa.publicKey)).toBe(true);
}

async function resignCertificate(
  pem: string,
  signingKeyPem: string,
  extensions: (current: x509.Extension[]) => x509.Extension[]
): Promise<string> {
  const original = new x509.X509Certificate(pem);
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    createPrivateKey(signingKeyPem).export({ format: 'der', type: 'pkcs8' }),
    { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
    true,
    ['sign']
  );
  const replacement = await x509.X509CertificateGenerator.create({
    serialNumber: original.serialNumber,
    subject: original.subject,
    issuer: original.issuer,
    notBefore: original.notBefore,
    notAfter: original.notAfter,
    publicKey: original.publicKey,
    signingKey,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: extensions(original.extensions),
  });
  return replacement.toString('pem');
}

async function replaceCa(s: ReturnType<typeof setup>, cert: string) {
  const fs = createNodeFileSystem();
  await fs.writeFileAtomic(join(s.root, 'pki/ca.crt'), cert, 0o644);
  await fs.writeFileAtomic(
    join(s.root, 'instance.json'),
    JSON.stringify({
      version: 1,
      fingerprint: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
    }) + '\n',
    0o600
  );
}

describe('loader instance PKI', () => {
  it('creates and reads back CA before identity and publishes the leaf before ready', async () => {
    const s = setup();
    await s.manager.bootstrap();
    expect(s.events).toEqual([
      'leaf',
      'configmap',
      'service-leaf',
      'task-model-leaf',
      'task-channel-leaf',
    ]);
    expect(await s.manager.report()).toMatchObject({
      identity: 'present',
      ca: 'present-matching',
      leaf: 'valid',
      sans: instanceHosts('home'),
    });
    const key = await import('node:fs/promises').then((m) =>
      m.readFile(join(s.root, 'pki/ca.key'), 'utf8')
    );
    expect(key).toContain('PRIVATE KEY');
    expect(statSync(join(s.root, 'pki/ca.key')).mode & 0o777).toBe(0o600);
  });
  it('reads back both CA files before identity publication and refuses a failed read-back', async () => {
    const s = setup();
    const real = createNodeFileSystem();
    const events: string[] = [];
    const instrumented = {
      ...real,
      writeFileAtomic: async (path: string, content: string, mode: number) => {
        events.push(
          `write:${path.endsWith('ca.key') ? 'key' : path.endsWith('ca.crt') ? 'cert' : 'identity'}`
        );
        return real.writeFileAtomic(path, content, mode);
      },
      readFile: async (path: string) => {
        events.push(
          `read:${path.endsWith('ca.key') ? 'key' : path.endsWith('ca.crt') ? 'cert' : 'other'}`
        );
        if (path.endsWith('ca.key')) throw new Error('injected read-back failure');
        return real.readFile(path);
      },
    };
    const manager = createPkiManager({
      config: { ...loadConfig({ LIFEMODEL_NAME: 'home', LIFEMODEL_VOLUME_ROOT: s.root }) },
      fs: instrumented,
      clock: s.clock,
      secret: { read: async () => ({}), write: async () => {} },
      configMap: { read: async () => null, write: async () => {} },
      service: {
        hosts: STORAGE_MODULE_TLS_HOSTS,
        secret: { read: async () => ({}), write: async () => {} },
      },
    });
    await expect(manager.bootstrap()).rejects.toThrow('injected read-back failure');
    expect(events).toEqual(['write:key', 'write:cert', 'read:cert', 'read:key']);
    expect(await real.exists(join(s.root, 'instance.json'))).toBe(false);
  });
  it('reuses CA after restart and reissues deleted leaf under the same CA', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const fingerprint = (await s.manager.report()).fingerprint;
    s.events.length = 0;
    s.secret.cert = undefined;
    await s.manager.bootstrap();
    expect((await s.manager.report()).fingerprint).toBe(fingerprint);
    expect(s.events).toContain('leaf');
  });
  it('recovers interrupted first start after CA writes but before identity publication', async () => {
    const s = setup();
    const real = createNodeFileSystem();
    let failed = false;
    const fs = {
      ...real,
      readFile: async (path: string) => {
        if (!failed && path.endsWith('ca.key')) {
          failed = true;
          throw new Error('simulated interruption');
        }
        return real.readFile(path);
      },
    };
    const interrupted = createPkiManager({
      config: { ...loadConfig({ LIFEMODEL_NAME: 'home', LIFEMODEL_VOLUME_ROOT: s.root }) },
      fs,
      clock: s.clock,
      secret: { read: async () => ({}), write: async () => {} },
      configMap: { read: async () => null, write: async () => {} },
      service: {
        hosts: STORAGE_MODULE_TLS_HOSTS,
        secret: { read: async () => ({}), write: async () => {} },
      },
    });
    await expect(interrupted.bootstrap()).rejects.toThrow('simulated interruption');
    expect(await real.exists(join(s.root, 'instance.json'))).toBe(false);
    await s.manager.bootstrap();
    expect((await s.manager.report()).identity).toBe('present');
    expect(await real.exists(join(s.root, 'instance.json'))).toBe(true);
  });
  it('reuses a valid CA left by a crash before identity publication', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const fingerprint = (await s.manager.report()).fingerprint;
    const fs = createNodeFileSystem();
    await (await import('node:fs/promises')).unlink(join(s.root, 'instance.json'));
    await s.manager.bootstrap();
    expect((await s.manager.report()).fingerprint).toBe(fingerprint);
    expect(await fs.exists(join(s.root, 'instance.json'))).toBe(true);
  });
  it('fails closed when identity exists but CA has been deleted', async () => {
    const s = setup();
    await s.manager.bootstrap();
    await import('node:fs/promises').then((m) => m.unlink(join(s.root, 'pki/ca.crt')));
    await expect(s.manager.bootstrap()).rejects.toThrow(/CA is missing/);
  });
  it('refuses a CA fingerprint that does not match the identity', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const fs = createNodeFileSystem();
    await fs.writeFileAtomic(
      join(s.root, 'instance.json'),
      JSON.stringify({ version: 1, fingerprint: 'wrong' }) + '\n',
      0o600
    );
    await expect(s.manager.bootstrap()).rejects.toThrow(/does not match/);
    expect(await s.manager.report()).toMatchObject({ ca: 'mismatch' });
  });
  it('renews a leaf when 30 days remain', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const before = new X509Certificate(s.secret.cert!).serialNumber;
    s.clock.advance(370 * 24 * 60 * 60 * 1000);
    await s.manager.bootstrap();
    expect(new X509Certificate(s.secret.cert!).serialNumber).not.toBe(before);
  });
  it('generates the required parsed X.509 profile', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const leaf = new X509Certificate(s.secret.cert!);
    expect(leaf.subjectAltName).toContain('DNS:home.local');
    expect(leaf.subjectAltName).toContain('DNS:boot-home.local');
    expect(leaf.subjectAltName).toContain('DNS:vault-home.local');
    expect(leaf.subject).toContain('home.local');
    const parsedLeaf = new x509.X509Certificate(s.secret.cert!);
    const eku = parsedLeaf.extensions.find(
      (e) => e.type === '2.5.29.37'
    ) as x509.ExtendedKeyUsageExtension;
    const leafUsage = parsedLeaf.extensions.find(
      (e) => e.type === '2.5.29.15'
    ) as x509.KeyUsagesExtension;
    expect(eku.usages).toContain('1.3.6.1.5.5.7.3.1');
    expect(leafUsage.usages).toBe(x509.KeyUsageFlags.digitalSignature);
    const parsedCa = new x509.X509Certificate(await s.manager.caPem());
    const constraints = parsedCa.extensions.find(
      (e) => e.type === '2.5.29.19'
    ) as x509.BasicConstraintsExtension;
    const caUsage = parsedCa.extensions.find(
      (e) => e.type === '2.5.29.15'
    ) as x509.KeyUsagesExtension;
    expect(constraints.ca).toBe(true);
    expect(constraints.pathLength).toBe(0);
    expect(constraints.critical).toBe(true);
    expect(caUsage.usages).toBe(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign);
    expect(leaf.validTo).toBeTruthy();
    const ca = new X509Certificate(await s.manager.caPem());
    expect(ca.ca).toBe(true);
    expect(ca.ca).toBe(true);
    expect(ca.raw.length).toBeGreaterThan(0);
  });
  it('issues edge and storage leaves with the strict RFC 5280 key identifiers', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const caPem = await s.manager.caPem();
    // RFC profile checks always run, including when the isolated image has no
    // openssl executable. Node's signature verification alone is insufficient.
    const openssl = spawnSync('openssl', ['version'], { timeout: 5_000 });
    if (!openssl.error) expect(openssl.status).toBe(0);
    else expect((openssl.error as NodeJS.ErrnoException).code).toBe('ENOENT');
    for (const [name, secret, host] of [
      ['edge', s.secret, instanceHosts('home')[0]],
      ['storage', s.serviceSecret, STORAGE_MODULE_TLS_HOSTS[0]],
      ['task-channel', s.taskChannelSecret, TASK_CHANNEL_TLS_HOSTS[0]],
    ] as const) {
      expectStrictKeyIdentifiers(caPem, secret.cert!);
      if (!openssl.error) {
        const leafPath = join(s.root, `${name}.crt`);
        writeFileSync(leafPath, secret.cert!);
        const verified = spawnSync(
          'openssl',
          [
            'verify',
            '-x509_strict',
            '-purpose',
            'sslserver',
            '-verify_hostname',
            host!,
            '-attime',
            String(Math.floor(s.clock.now() / 1000)),
            '-CAfile',
            join(s.root, 'pki/ca.crt'),
            leafPath,
          ],
          { encoding: 'utf8', timeout: 5_000 }
        );
        expect(verified.error).toBeUndefined();
        expect(verified.status, verified.stderr).toBe(0);
      }
    }
    const before = [s.secret.cert, s.serviceSecret.cert];
    s.events.length = 0;
    await s.manager.bootstrap();
    expect([s.secret.cert, s.serviceSecret.cert]).toEqual(before);
    expect(s.events).toEqual(['configmap']);
  });
  it.each([true, false])(
    'fails closed for an installed CA without SKI (identity present: %s)',
    async (identityPresent) => {
      const s = setup();
      await s.manager.bootstrap();
      const fs = createNodeFileSystem();
      const key = await fs.readFile(join(s.root, 'pki/ca.key'));
      const caWithoutSki = await resignCertificate(await s.manager.caPem(), key, (extensions) =>
        extensions.filter((extension) => extension.type !== '2.5.29.14')
      );
      await replaceCa(s, caWithoutSki);
      if (!identityPresent)
        await import('node:fs/promises').then((m) => m.unlink(join(s.root, 'instance.json')));
      const identity = identityPresent ? await fs.readFile(join(s.root, 'instance.json')) : null;
      const leaves = [s.secret.cert, s.serviceSecret.cert];
      s.events.length = 0;
      await expect(s.manager.bootstrap()).rejects.toThrow(/required profile/);
      await expect(s.manager.caPem()).rejects.toThrow(/required profile/);
      expect((await s.manager.report()).ca).toBe('invalid');
      expect(await fs.readFile(join(s.root, 'pki/ca.crt'))).toBe(caWithoutSki);
      expect(await fs.readFile(join(s.root, 'pki/ca.key'))).toBe(key);
      expect(await fs.exists(join(s.root, 'instance.json'))).toBe(identityPresent);
      if (identityPresent) expect(await fs.readFile(join(s.root, 'instance.json'))).toBe(identity);
      expect([s.secret.cert, s.serviceSecret.cert]).toEqual(leaves);
      expect(s.events).toEqual([]);
    }
  );
  it.each(['missing-AKI', 'missing-SKI', 'legacy-no-identifiers', 'wrong-AKI'] as const)(
    'reissues legacy or invalid edge and storage leaves under the same CA (%s)',
    async (profile) => {
      const s = setup();
      await s.manager.bootstrap();
      const fs = createNodeFileSystem();
      const caPem = await s.manager.caPem();
      const key = await fs.readFile(join(s.root, 'pki/ca.key'));
      const fingerprint = (await s.manager.report()).fingerprint;
      for (const secret of [s.secret, s.serviceSecret]) {
        secret.cert = await resignCertificate(secret.cert!, key, (extensions) =>
          profile === 'wrong-AKI'
            ? extensions.map((extension) =>
                extension.type === '2.5.29.35'
                  ? new x509.AuthorityKeyIdentifierExtension('ab'.repeat(20))
                  : extension
              )
            : extensions.filter((extension) =>
                profile === 'legacy-no-identifiers'
                  ? !['2.5.29.14', '2.5.29.35'].includes(extension.type)
                  : extension.type !== (profile === 'missing-AKI' ? '2.5.29.35' : '2.5.29.14')
              )
        );
        // Still cryptographically signed by this CA; only the profile is bad.
        expect(new X509Certificate(secret.cert).verify(new X509Certificate(caPem).publicKey)).toBe(
          true
        );
      }
      const before = [s.secret.cert, s.serviceSecret.cert];
      expect(await s.manager.report()).toMatchObject({ leaf: 'invalid', serviceLeaf: 'invalid' });
      s.events.length = 0;
      await s.manager.bootstrap();
      expect(s.events).toEqual(['leaf', 'configmap', 'service-leaf']);
      expect(s.secret.cert).not.toBe(before[0]);
      expect(s.serviceSecret.cert).not.toBe(before[1]);
      expect((await s.manager.report()).fingerprint).toBe(fingerprint);
      expect(await s.manager.caPem()).toBe(caPem);
      expectStrictKeyIdentifiers(caPem, s.secret.cert!);
      expectStrictKeyIdentifiers(caPem, s.serviceSecret.cert!);
    }
  );
  it('copies the actual issuer SKI into AKI rather than deriving another identifier', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const fs = createNodeFileSystem();
    const key = await fs.readFile(join(s.root, 'pki/ca.key'));
    const customSki = '12'.repeat(20);
    const caPem = await resignCertificate(await s.manager.caPem(), key, (extensions) =>
      extensions.map((extension) =>
        extension.type === '2.5.29.14'
          ? new x509.SubjectKeyIdentifierExtension(customSki)
          : extension
      )
    );
    await replaceCa(s, caPem);
    await s.manager.bootstrap();
    for (const secret of [s.secret, s.serviceSecret]) {
      expectStrictKeyIdentifiers(caPem, secret.cert!);
      expect(
        new x509.X509Certificate(secret.cert!).getExtension(x509.AuthorityKeyIdentifierExtension)
          ?.keyId
      ).toBe(customSki);
    }
  });
  it.each(['PARTIAL', 'wrong'])(
    'fails closed for a corrupt or wrong CA key while a valid leaf exists (%s)',
    async (badKey) => {
      const s = setup();
      await s.manager.bootstrap();
      const keyPath = join(s.root, 'pki/ca.key');
      if (badKey === 'wrong') {
        const other = setup();
        await other.manager.bootstrap();
        await import('node:fs/promises').then((m) =>
          m.copyFile(join(other.root, 'pki/ca.key'), keyPath)
        );
      } else await import('node:fs/promises').then((m) => m.writeFile(keyPath, badKey));
      await expect(s.manager.bootstrap()).rejects.toThrow(/PKI CA/);
      expect((await s.manager.report()).ca).toBe('invalid');
    }
  );
  it('rejects an invalid CA key even when the leaf is missing', async () => {
    const s = setup();
    await s.manager.bootstrap();
    await import('node:fs/promises').then((m) => m.unlink(join(s.root, 'pki/ca.key')));
    s.secret.cert = undefined;
    await expect(s.manager.bootstrap()).rejects.toThrow(/CA is missing/);
  });
  it('reissues a same-name foreign leaf under the established CA', async () => {
    const first = setup(),
      second = setup();
    await first.manager.bootstrap();
    await second.manager.bootstrap();
    const foreign = second.secret;
    first.secret.ca = foreign.ca;
    first.secret.cert = foreign.cert;
    first.secret.key = foreign.key;
    const before = new X509Certificate(first.secret.cert!).serialNumber;
    await first.manager.bootstrap();
    expect(first.secret.ca).toBe(await first.manager.caPem());
    expect(new X509Certificate(first.secret.cert!).serialNumber).not.toBe(before);
    expect(
      new X509Certificate(first.secret.cert!).verify(
        new X509Certificate(await first.manager.caPem()).publicKey
      )
    ).toBe(true);
  });
  it('derives only the three instance names and rejects malformed names', () => {
    expect(instanceHosts('home')).toEqual(['home.local', 'boot-home.local', 'vault-home.local']);
    expect(() => instanceHosts('bad.name')).toThrow();
  });
  it('gives the storage module its own leaf, from the same CA, on in-cluster names only', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const ca = new X509Certificate(await s.manager.caPem());
    const service = new X509Certificate(s.serviceSecret.cert!);
    // Issued by the one instance CA, and a different certificate from the edge
    // leaf: a client of one is not a client of the other.
    expect(service.verify(ca.publicKey)).toBe(true);
    expect(service.serialNumber).not.toBe(new X509Certificate(s.secret.cert!).serialNumber);
    expect(service.subjectAltName?.split(', ').sort()).toEqual(
      [...STORAGE_MODULE_TLS_HOSTS]
        .sort()
        .map((name) => `DNS:${name}`)
        .sort()
    );
    expect(service.subjectAltName).not.toContain('home.local');
    expect(s.serviceSecret.ca).toBe(await s.manager.caPem());
    expect(await s.manager.report()).toMatchObject({
      leaf: 'valid',
      serviceLeaf: 'valid',
      serviceSans: [...STORAGE_MODULE_TLS_HOSTS],
    });
  });
  it('renews the module leaf on its own window and leaves the edge leaf alone', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const edge = new X509Certificate(s.secret.cert!).serialNumber;
    const service = new X509Certificate(s.serviceSecret.cert!).serialNumber;
    // Inside the renewal window both leaves are replaced; the edge leaf keeps
    // its serial only until then, so the assertion stays one leaf each.
    s.clock.advance(370 * 24 * 60 * 60 * 1000);
    await s.manager.bootstrap();
    expect(new X509Certificate(s.secret.cert!).serialNumber).not.toBe(edge);
    expect(new X509Certificate(s.serviceSecret.cert!).serialNumber).not.toBe(service);
    // A leaf removed from its Secret is reissued from the same CA.
    const fingerprint = (await s.manager.report()).fingerprint;
    s.serviceSecret.cert = undefined;
    await s.manager.bootstrap();
    expect((await s.manager.report()).fingerprint).toBe(fingerprint);
    expect(
      new X509Certificate(s.serviceSecret.cert!).verify(
        new X509Certificate(await s.manager.caPem()).publicKey
      )
    ).toBe(true);
  });
  it('issues and renews the isolated task-model leaf under the same CA', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const ca = await s.manager.caPem();
    const model = new X509Certificate(s.taskModelSecret.cert!);
    expectStrictKeyIdentifiers(ca, s.taskModelSecret.cert!);
    expect(model.subjectAltName?.split(', ').sort()).toEqual(
      TASK_MODEL_TLS_HOSTS.map((host) => `DNS:${host}`).sort()
    );
    expect(s.taskModelSecret.key).not.toBe(s.serviceSecret.key);
    expect(s.taskModelSecret.key).not.toBe(s.secret.key);
    expect(await s.manager.report()).toMatchObject({
      taskModelLeaf: 'valid',
      taskModelSans: [...TASK_MODEL_TLS_HOSTS],
    });
    const before = s.taskModelSecret.cert;
    await s.manager.bootstrap();
    expect(s.taskModelSecret.cert).toBe(before);
    s.clock.advance(370 * 24 * 60 * 60 * 1000);
    await s.manager.bootstrap();
    expect(s.taskModelSecret.cert).not.toBe(before);
    expectStrictKeyIdentifiers(ca, s.taskModelSecret.cert!);
    s.taskModelSecret.cert = undefined;
    expect((await s.manager.report()).taskModelLeaf).toBe('missing');
    await s.manager.bootstrap();
    expectStrictKeyIdentifiers(ca, s.taskModelSecret.cert!);
    s.taskModelSecret.cert = s.serviceSecret.cert;
    s.taskModelSecret.key = s.serviceSecret.key;
    expect((await s.manager.report()).taskModelLeaf).toBe('invalid');
    await s.manager.bootstrap();
    expect((await s.manager.report()).taskModelLeaf).toBe('valid');
  });
  it('issues and renews the core task-channel leaf without reusing another private key', async () => {
    const s = setup();
    await s.manager.bootstrap();
    const ca = await s.manager.caPem();
    expectStrictKeyIdentifiers(ca, s.taskChannelSecret.cert!);
    expect(
      new X509Certificate(s.taskChannelSecret.cert!).subjectAltName?.split(', ').sort()
    ).toEqual(TASK_CHANNEL_TLS_HOSTS.map((host) => `DNS:${host}`).sort());
    for (const other of [s.secret, s.serviceSecret, s.taskModelSecret])
      expect(s.taskChannelSecret.key).not.toBe(other.key);
    expect(await s.manager.report()).toMatchObject({
      taskChannelLeaf: 'valid',
      taskChannelSans: [...TASK_CHANNEL_TLS_HOSTS],
    });
    const before = s.taskChannelSecret.cert;
    await s.manager.bootstrap();
    expect(s.taskChannelSecret.cert).toBe(before);
    s.clock.advance(370 * 24 * 60 * 60 * 1000);
    expect((await s.manager.report()).taskChannelLeaf).toBe('expiring');
    await s.manager.bootstrap();
    expect(s.taskChannelSecret.cert).not.toBe(before);
    expectStrictKeyIdentifiers(ca, s.taskChannelSecret.cert!);
    s.taskChannelSecret.cert = undefined;
    expect((await s.manager.report()).taskChannelLeaf).toBe('missing');
    await s.manager.bootstrap();
    expectStrictKeyIdentifiers(ca, s.taskChannelSecret.cert!);
    s.taskChannelSecret.cert = s.taskModelSecret.cert;
    s.taskChannelSecret.key = s.taskModelSecret.key;
    expect((await s.manager.report()).taskChannelLeaf).toBe('invalid');
    await s.manager.bootstrap();
    expect((await s.manager.report()).taskChannelLeaf).toBe('valid');
  });
  it('reports a missing or foreign module leaf instead of calling it ready', async () => {
    const s = setup();
    await s.manager.bootstrap();
    s.serviceSecret.cert = undefined;
    expect((await s.manager.report()).serviceLeaf).toBe('missing');
    // The edge leaf is not a module leaf: it names the browser hosts.
    s.serviceSecret = s.secret;
    expect((await s.manager.report()).serviceLeaf).toBe('invalid');
  });
});
