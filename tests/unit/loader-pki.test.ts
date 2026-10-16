import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { createPkiManager, instanceHosts } from '../../loader/src/pki.js';
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
  });
  return {
    root,
    manager,
    events,
    get secret() {
      return secret;
    },
    get caMap() {
      return caMap;
    },
    clock,
  };
}
describe('loader instance PKI', () => {
  it('creates and reads back CA before identity and publishes the leaf before ready', async () => {
    const s = setup();
    await s.manager.bootstrap();
    expect(s.events).toEqual(['leaf', 'configmap']);
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
});
