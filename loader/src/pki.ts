/** Loader-owned instance CA and HTTPS leaf lifecycle (ADR-012 Decision 3). */
import 'reflect-metadata';
import { createHash, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { X509Certificate as NodeX509Certificate } from 'node:crypto';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import type { FileSystem } from './fs.js';

const DAY = 24 * 60 * 60 * 1000;
const CA_LIFETIME = 3650 * DAY;
const LEAF_LIFETIME = 397 * DAY;
const RENEW_WINDOW = 30 * DAY;
const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
export function instanceHosts(name: string): string[] {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?$/.test(name))
    throw new Error('invalid LIFEMODEL_NAME');
  return [`${name}.local`, `boot-${name}.local`, `vault-${name}.local`];
}
export interface TlsSecretStore {
  read(): Promise<{ ca?: string; cert?: string; key?: string }>;
  write(ca: string, cert: string, key: string): Promise<void>;
}
export interface CaConfigMapStore {
  read(): Promise<string | null>;
  write(ca: string): Promise<void>;
}
export interface PkiReport {
  identity: 'present' | 'missing' | 'invalid';
  ca: 'present-matching' | 'missing' | 'mismatch' | 'invalid';
  leaf: 'valid' | 'missing' | 'invalid' | 'expiring';
  sans: string[];
  fingerprint: string | null;
}
export interface PkiManager {
  bootstrap(): Promise<void>;
  report(): Promise<PkiReport>;
  caPem(): Promise<string>;
}
interface Identity {
  version: 1;
  fingerprint: string;
}
interface CaDisk {
  keyPem: string;
  cert: string;
}
function toPem(cert: x509.X509Certificate): string {
  const base64 =
    Buffer.from(cert.rawData)
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}
function pemFingerprint(pem: string): string {
  return createHash('sha256').update(new NodeX509Certificate(pem).raw).digest('hex');
}
function serial(): string {
  return randomBytes(16).toString('hex').replace(/^0+/, '') || '1';
}
function pemKey(key: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey('pkcs8', key).then(
    (v) =>
      `-----BEGIN PRIVATE KEY-----\n${
        Buffer.from(v)
          .toString('base64')
          .match(/.{1,64}/g)
          ?.join('\n') ?? ''
      }\n-----END PRIVATE KEY-----\n`
  );
}
function privateCryptoKey(keyPem: string): Promise<CryptoKey> {
  const der = Buffer.from(keyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
  return crypto.subtle.importKey('pkcs8', der, alg, true, ['sign']);
}
export function createPkiManager(options: {
  config: LoaderConfig;
  fs: FileSystem;
  clock: Clock;
  secret: TlsSecretStore;
  configMap: CaConfigMapStore;
}): PkiManager {
  const { config, fs, clock, secret, configMap } = options;
  const directory = join(config.volumeRoot, 'pki');
  const caPath = join(directory, 'ca.crt');
  const keyPath = join(directory, 'ca.key');
  const identityPath = join(config.volumeRoot, 'instance.json');
  const hosts = instanceHosts(config.instanceName);
  async function readJson<T>(path: string): Promise<T | null> {
    if (!(await fs.exists(path))) return null;
    try {
      return JSON.parse(await fs.readFile(path)) as T;
    } catch {
      throw new Error(`PKI file is corrupt: ${path}`);
    }
  }
  async function createCa(): Promise<CaDisk> {
    const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const keyPem = await pemKey(keys.privateKey);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serial(),
      name: `CN=${config.instanceName} instance CA`,
      notBefore: new Date(clock.now() - 60 * 60 * 1000),
      notAfter: new Date(clock.now() + CA_LIFETIME),
      signingAlgorithm: alg,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    return { keyPem, cert: toPem(cert) };
  }
  async function issue(ca: CaDisk): Promise<{ cert: string; key: string }> {
    const caKey = await privateCryptoKey(ca.keyPem);
    const leafKeys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: `CN=${hosts[0] ?? config.instanceName}`,
      issuer: new x509.X509Certificate(ca.cert).subject,
      notBefore: new Date(clock.now() - 60 * 60 * 1000),
      notAfter: new Date(clock.now() + LEAF_LIFETIME),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension(
          hosts.map((value) => ({ type: 'dns' as const, value }))
        ),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      ],
    });
    return { cert: toPem(cert), key: await pemKey(leafKeys.privateKey) };
  }
  function certStatus(
    certPem: string | null,
    keyPem?: string,
    expectedCa?: string
  ): PkiReport['leaf'] {
    if (!certPem) return 'missing';
    try {
      const cert = new NodeX509Certificate(certPem);
      if (Date.parse(cert.validTo) - clock.now() <= RENEW_WINDOW) return 'expiring';
      if (Date.parse(cert.validFrom) > clock.now()) return 'invalid';
      const sans = (cert.subjectAltName ?? '')
        .split(', ')
        .map((value) => value.replace(/^DNS:/, ''));
      if (hosts.some((host) => !sans.includes(host))) return 'invalid';
      if (
        !keyPem ||
        !createPrivateKey(keyPem).asymmetricKeyType ||
        createPublicKey(keyPem)
          .export({ format: 'der', type: 'spki' })
          .compare(cert.publicKey.export({ format: 'der', type: 'spki' })) !== 0
      )
        return 'invalid';
      if (expectedCa && cert.issuer !== new NodeX509Certificate(expectedCa).subject)
        return 'invalid';
      return 'valid';
    } catch {
      return 'invalid';
    }
  }
  async function caAndIdentity(): Promise<{ ca: CaDisk | null; identity: Identity | null }> {
    const identity = await readJson<Identity>(identityPath);
    if (identity && (identity.version !== 1 || typeof identity.fingerprint !== 'string'))
      throw new Error('PKI identity is invalid');
    let ca: CaDisk | null;
    try {
      const cert = (await fs.exists(caPath)) ? await fs.readFile(caPath) : null;
      const keyPem = (await fs.exists(keyPath)) ? await fs.readFile(keyPath) : null;
      ca = cert && keyPem ? { cert, keyPem } : null;
    } catch (error) {
      if (identity) throw error;
      throw error;
    }
    if (identity && ca === null)
      throw new Error('PKI CA is missing while instance identity exists');
    if (ca) {
      try {
        const fingerprint = pemFingerprint(ca.cert);
        if (identity && identity.fingerprint !== fingerprint)
          throw new Error('PKI CA does not match instance identity');
      } catch (error) {
        if (identity) throw error;
        throw error;
      }
    }
    return { ca, identity };
  }
  return {
    bootstrap: async () => {
      await fs.ensureDir(directory, 0o700);
      await fs.chmod(directory, 0o700);
      let { ca, identity } = await caAndIdentity();
      if (!ca) {
        ca = await createCa();
        await fs.writeFileAtomic(keyPath, ca.keyPem, 0o600);
        await fs.writeFileAtomic(caPath, ca.cert, 0o644);
        const readbackCert = await fs.readFile(caPath);
        const readbackKey = await fs.readFile(keyPath);
        if (pemFingerprint(readbackCert) !== pemFingerprint(ca.cert))
          throw new Error('PKI CA read-back did not match');
        ca = { cert: readbackCert, keyPem: readbackKey };
      }
      const fingerprint = pemFingerprint(ca.cert);
      if (!identity) {
        identity = { version: 1, fingerprint };
        await fs.writeFileAtomic(identityPath, JSON.stringify(identity) + '\n', 0o600);
        const verified = await readJson<Identity>(identityPath);
        if (verified?.fingerprint !== fingerprint)
          throw new Error('PKI identity read-back did not match');
        identity = verified;
      }
      if (identity.fingerprint !== fingerprint)
        throw new Error('PKI CA does not match instance identity');
      const current = await secret.read();
      if (certStatus(current.cert ?? null, current.key, ca.cert) === 'valid') {
        await configMap.write(ca.cert);
        return;
      }
      const leaf = await issue(ca);
      await secret.write(ca.cert, leaf.cert, leaf.key);
      await configMap.write(ca.cert);
    },
    report: async () => {
      let identity: Identity | null = null,
        ca: CaDisk | null = null;
      let identityState: PkiReport['identity'] = 'missing',
        caState: PkiReport['ca'] = 'missing';
      try {
        identity = await readJson<Identity>(identityPath);
        identityState = identity ? 'present' : 'missing';
      } catch {
        identityState = 'invalid';
      }
      try {
        const cert = (await fs.exists(caPath)) ? await fs.readFile(caPath) : null;
        const keyPem = (await fs.exists(keyPath)) ? await fs.readFile(keyPath) : null;
        ca = cert && keyPem ? { cert, keyPem } : null;
        if (ca) {
          caState =
            identity && pemFingerprint(ca.cert) !== identity.fingerprint
              ? 'mismatch'
              : 'present-matching';
        }
      } catch {
        caState = 'invalid';
      }
      let leaf: PkiReport['leaf'] = 'missing',
        sans: string[] = [];
      try {
        const current = await secret.read();
        leaf = certStatus(current.cert ?? null, current.key, ca?.cert);
        if (current.cert) {
          const cert = new NodeX509Certificate(current.cert);
          sans = (cert.subjectAltName ?? '')
            .split(', ')
            .filter(Boolean)
            .map((v) => v.replace(/^DNS:/, ''));
          if (hosts.some((host) => !sans.includes(host))) leaf = 'invalid';
        }
      } catch {
        leaf = 'invalid';
      }
      return {
        identity: identityState,
        ca: caState,
        leaf,
        sans,
        fingerprint: ca ? pemFingerprint(ca.cert) : null,
      };
    },
    caPem: async () => {
      const { ca } = await caAndIdentity();
      if (!ca) throw new Error('PKI CA is not ready');
      return ca.cert;
    },
  };
}
