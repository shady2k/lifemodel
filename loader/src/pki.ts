/** Loader-owned instance CA and HTTPS leaf lifecycle (ADR-012 Decision 3). */
import 'reflect-metadata';
import { createHash, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { X509Certificate as NodeX509Certificate } from 'node:crypto';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import type { Clock } from './clock.js';
import type { LoaderConfig } from './config.js';
import type { FileSystem } from './fs.js';
import { instanceHosts } from './auth.js';
export { instanceHosts } from './auth.js';

const DAY = 24 * 60 * 60 * 1000;
const CA_LIFETIME = 3650 * DAY;
const LEAF_LIFETIME = 397 * DAY;
const RENEW_WINDOW = 30 * DAY;
const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
export interface TlsSecretStore {
  read(): Promise<{ ca?: string; cert?: string; key?: string }>;
  write(ca: string, cert: string, key: string): Promise<void>;
}
/**
 * The instance-CA leaf the storage module serves its task listener with
 * (ADR-015 S-D1). Its names are in-cluster only: no browser ever reaches it,
 * so it is not part of the edge leaf's host list and gets its own Secret.
 */
export const STORAGE_MODULE_TLS_HOSTS = [
  'storage-module.lifemodel-system.svc',
  'storage-module.lifemodel-system.svc.cluster.local',
] as const;
/** The separate task model/identity listener (ADR-014 D1). */
export const TASK_MODEL_TLS_HOSTS = [
  'model-gateway.lifemodel-system.svc',
  'model-gateway.lifemodel-system.svc.cluster.local',
] as const;
export interface ServiceLeafOptions {
  hosts: readonly string[];
  /** The one Secret the module's pod mounts; the loader is its only writer. */
  secret: TlsSecretStore;
}
export interface CaConfigMapStore {
  read(): Promise<string | null>;
  write(ca: string): Promise<void>;
}
export interface PkiStatusStore {
  write(status: Record<string, unknown>): Promise<void>;
}
export interface PkiReport {
  identity: 'present' | 'missing' | 'invalid';
  ca: 'present-matching' | 'missing' | 'mismatch' | 'invalid';
  leaf: 'valid' | 'missing' | 'invalid' | 'expiring';
  sans: string[];
  /** The storage module's task-listener leaf, issued from the same CA. */
  serviceLeaf: 'valid' | 'missing' | 'invalid' | 'expiring';
  serviceSans: string[];
  taskModelLeaf?: 'valid' | 'missing' | 'invalid' | 'expiring';
  taskModelSans?: string[];
  fingerprint: string | null;
  caFingerprint?: string | null;
  leafNotAfter?: string | null;
  checkedAt?: string;
  error?: string;
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
function validateCaPair(ca: CaDisk, now: number): string {
  const cert = new NodeX509Certificate(ca.cert);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(ca.keyPem);
  } catch (error) {
    throw new Error('PKI CA private key is invalid', { cause: error });
  }
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new Error('PKI CA private key is not P-256');
  if (
    createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .compare(cert.publicKey.export({ format: 'der', type: 'spki' })) !== 0
  )
    throw new Error('PKI CA private key does not match its certificate');
  if (
    !cert.ca ||
    !cert.verify(cert.publicKey) ||
    Date.parse(cert.validFrom) > now ||
    Date.parse(cert.validTo) <= now
  )
    throw new Error('PKI CA certificate is invalid or outside its validity period');
  const parsed = new x509.X509Certificate(ca.cert);
  const constraints = parsed.extensions.find((e) => e.type === '2.5.29.19') as
    | x509.BasicConstraintsExtension
    | undefined;
  const usage = parsed.extensions.find((e) => e.type === '2.5.29.15') as
    | x509.KeyUsagesExtension
    | undefined;
  const subjectKeyId = parsed.getExtension(x509.SubjectKeyIdentifierExtension);
  if (
    !subjectKeyId?.keyId ||
    subjectKeyId.critical ||
    !constraints?.ca ||
    constraints.pathLength !== 0 ||
    !constraints.critical ||
    !usage?.critical ||
    (usage.usages as number) !== (x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign)
  )
    throw new Error('PKI CA certificate does not match the required profile');
  return createHash('sha256').update(cert.raw).digest('hex');
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
  /** The storage module's task-listener leaf (ADR-015 S-D1). */
  service: ServiceLeafOptions;
  /** Additional in-cluster listener, absent for isolated storage-only fixtures. */
  taskModelService?: ServiceLeafOptions;
  status?: PkiStatusStore;
}): PkiManager {
  const { config, fs, clock, secret, configMap, service, taskModelService, status } = options;
  const directory = join(config.volumeRoot, 'pki');
  const caPath = join(directory, 'ca.crt');
  const keyPath = join(directory, 'ca.key');
  const identityPath = join(config.volumeRoot, 'instance.json');
  const hosts = instanceHosts(config.instanceName);
  const serviceHosts = [...service.hosts];
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
  async function issue(ca: CaDisk, names: string[]): Promise<{ cert: string; key: string }> {
    const caKey = await privateCryptoKey(ca.keyPem);
    const issuer = new x509.X509Certificate(ca.cert);
    const issuerKeyId = issuer.getExtension(x509.SubjectKeyIdentifierExtension);
    if (!issuerKeyId?.keyId)
      throw new Error('PKI CA certificate is missing its subject key identifier');
    const leafKeys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: `CN=${names[0] ?? config.instanceName}`,
      issuer: issuer.subject,
      notBefore: new Date(clock.now() - 60 * 60 * 1000),
      notAfter: new Date(clock.now() + LEAF_LIFETIME),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension(
          names.map((value) => ({ type: 'dns' as const, value }))
        ),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
        // RFC 5280 4.2.1.1: identify the issuer by its actual SKI, not a
        // separately derived identifier that could disagree with that CA.
        new x509.AuthorityKeyIdentifierExtension(issuerKeyId.keyId),
      ],
    });
    return { cert: toPem(cert), key: await pemKey(leafKeys.privateKey) };
  }
  function certStatus(
    certPem: string | null,
    keyPem: string | undefined,
    expectedCa: string | undefined,
    names: string[]
  ): PkiReport['leaf'] {
    if (!certPem) return 'missing';
    try {
      const cert = new NodeX509Certificate(certPem);
      if (Date.parse(cert.validTo) - clock.now() <= RENEW_WINDOW) return 'expiring';
      if (Date.parse(cert.validFrom) > clock.now()) return 'invalid';
      const sans = (cert.subjectAltName ?? '')
        .split(', ')
        .map((value) => value.replace(/^DNS:/, ''));
      if (
        sans.length !== names.length ||
        [...sans].sort().join('\0') !== [...names].sort().join('\0')
      )
        return 'invalid';
      if (
        !keyPem ||
        !createPrivateKey(keyPem).asymmetricKeyType ||
        createPublicKey(keyPem)
          .export({ format: 'der', type: 'spki' })
          .compare(cert.publicKey.export({ format: 'der', type: 'spki' })) !== 0
      )
        return 'invalid';
      const parsedLeaf = new x509.X509Certificate(certPem);
      const eku = parsedLeaf.extensions.find((extension) => extension.type === '2.5.29.37') as
        | x509.ExtendedKeyUsageExtension
        | undefined;
      const usage = parsedLeaf.extensions.find((extension) => extension.type === '2.5.29.15') as
        | x509.KeyUsagesExtension
        | undefined;
      const subjectKeyId = parsedLeaf.getExtension(x509.SubjectKeyIdentifierExtension);
      const authorityKeyId = parsedLeaf.getExtension(x509.AuthorityKeyIdentifierExtension);
      if (
        !subjectKeyId?.keyId ||
        subjectKeyId.critical ||
        !authorityKeyId?.keyId ||
        authorityKeyId.critical ||
        !eku?.critical ||
        eku.usages.length !== 1 ||
        eku.usages[0] !== '1.3.6.1.5.5.7.3.1' ||
        !usage?.critical ||
        usage.usages !== x509.KeyUsageFlags.digitalSignature
      )
        return 'invalid';
      if (expectedCa) {
        const ca = new NodeX509Certificate(expectedCa);
        const issuerKeyId = new x509.X509Certificate(expectedCa).getExtension(
          x509.SubjectKeyIdentifierExtension
        );
        if (
          !issuerKeyId?.keyId ||
          issuerKeyId.critical ||
          authorityKeyId.keyId !== issuerKeyId.keyId ||
          cert.issuer !== ca.subject ||
          !cert.verify(ca.publicKey)
        )
          return 'invalid';
      }
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
        const fingerprint = validateCaPair(ca, clock.now());
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
        if (
          validateCaPair({ cert: readbackCert, keyPem: readbackKey }, clock.now()) !==
          pemFingerprint(ca.cert)
        )
          throw new Error('PKI CA read-back did not match');
        ca = { cert: readbackCert, keyPem: readbackKey };
      }
      const fingerprint = validateCaPair(ca, clock.now());
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
      if (certStatus(current.cert ?? null, current.key, ca.cert, hosts) !== 'valid') {
        const leaf = await issue(ca, hosts);
        await secret.write(ca.cert, leaf.cert, leaf.key);
      }
      await configMap.write(ca.cert);
      // The module's own leaf, from this CA and on its own names: its pod
      // mounts this Secret and nothing else reads it. A missing or expiring
      // leaf is reissued the same way the edge leaf is.
      const serviceCurrent = await service.secret.read();
      if (
        certStatus(serviceCurrent.cert ?? null, serviceCurrent.key, ca.cert, serviceHosts) !==
        'valid'
      ) {
        const leaf = await issue(ca, serviceHosts);
        await service.secret.write(ca.cert, leaf.cert, leaf.key);
      }
      if (taskModelService) {
        const names = [...taskModelService.hosts];
        const current = await taskModelService.secret.read();
        if (certStatus(current.cert ?? null, current.key, ca.cert, names) !== 'valid') {
          const leaf = await issue(ca, names);
          await taskModelService.secret.write(ca.cert, leaf.cert, leaf.key);
        }
      }
    },
    report: async () => {
      let identity: Identity | null = null,
        ca: CaDisk | null = null,
        caFingerprint: string | null = null;
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
          caFingerprint = pemFingerprint(ca.cert);
          const fingerprint = validateCaPair(ca, clock.now());
          caState =
            identity && fingerprint !== identity.fingerprint ? 'mismatch' : 'present-matching';
        }
      } catch {
        caState = 'invalid';
      }
      let leaf: PkiReport['leaf'] = 'missing',
        sans: string[] = [];
      let leafNotAfter = '';
      try {
        const current = await secret.read();
        leaf = certStatus(current.cert ?? null, current.key, ca?.cert, hosts);
        if (current.cert) {
          const cert = new NodeX509Certificate(current.cert);
          leafNotAfter = cert.validTo;
          sans = (cert.subjectAltName ?? '')
            .split(', ')
            .filter(Boolean)
            .map((v) => v.replace(/^DNS:/, ''));
          if (hosts.some((host) => !sans.includes(host))) leaf = 'invalid';
        }
      } catch {
        leaf = 'invalid';
      }
      let serviceLeaf: PkiReport['leaf'] = 'missing',
        serviceSans: string[] = [];
      let serviceLeafNotAfter = '';
      try {
        const current = await service.secret.read();
        serviceLeaf = certStatus(current.cert ?? null, current.key, ca?.cert, serviceHosts);
        if (current.cert) {
          const cert = new NodeX509Certificate(current.cert);
          serviceLeafNotAfter = cert.validTo;
          serviceSans = (cert.subjectAltName ?? '')
            .split(', ')
            .filter(Boolean)
            .map((v) => v.replace(/^DNS:/, ''));
          if (serviceHosts.some((host) => !serviceSans.includes(host))) serviceLeaf = 'invalid';
        }
      } catch {
        serviceLeaf = 'invalid';
      }
      let taskModelLeaf: PkiReport['leaf'] = 'missing';
      let taskModelSans: string[] = [];
      let taskModelLeafNotAfter = '';
      if (taskModelService) {
        try {
          const current = await taskModelService.secret.read();
          taskModelLeaf = certStatus(current.cert ?? null, current.key, ca?.cert, [
            ...taskModelService.hosts,
          ]);
          if (current.cert) {
            const cert = new NodeX509Certificate(current.cert);
            taskModelLeafNotAfter = cert.validTo;
            taskModelSans = (cert.subjectAltName ?? '')
              .split(', ')
              .filter(Boolean)
              .map((value) => value.replace(/^DNS:/, ''));
          }
        } catch {
          taskModelLeaf = 'invalid';
        }
      }
      const taskModelReport = taskModelService ? { taskModelLeaf, taskModelSans } : {};
      const result: PkiReport = {
        identity: identityState,
        ca: caState,
        leaf,
        sans,
        serviceLeaf,
        serviceSans,
        ...taskModelReport,
        fingerprint: caFingerprint,
      };
      await status?.write({
        identity: identityState,
        ca: caState,
        leaf,
        caFingerprint: result.fingerprint,
        leafNotAfter,
        leafSans: sans,
        serviceLeaf,
        serviceSans,
        serviceLeafNotAfter,
        ...taskModelReport,
        ...(taskModelService ? { taskModelLeafNotAfter } : {}),
        checkedAt: new Date(clock.now()).toISOString(),
        ...(caState === 'invalid' ? { error: 'invalid CA pair' } : {}),
      });
      return result;
    },
    caPem: async () => {
      const { ca } = await caAndIdentity();
      if (!ca) throw new Error('PKI CA is not ready');
      return ca.cert;
    },
  };
}
