/** Owner-private cold-copy artifacts. Layout and backend evidence come from trusted
 * operator policy, never from an archive. These helpers do not prove Seaweed history. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface ColdCopyLayout {
  version: string;
  seaweedImage: string;
  directories: string[];
  files: string[];
  /** Trusted, fully anchored patterns for dynamic DB/volume filenames. */
  filePatterns?: string[];
  directoryPatterns?: string[];
}
export interface BackendPolicyAttestation {
  evidence: string;
  coldStopped: boolean;
  freshModuleOnlyNeverIamNeverSse: boolean;
  filerKekAbsent: boolean;
  dynamicIamAbsent: boolean;
  bucketEncryptionAbsent: boolean;
  encryptedObjectsAbsent: boolean;
}
export interface StorageBackupMetadata {
  backupId: string;
  generation: string;
  sqlCutAt: string;
  schemaVersion: string;
  moduleBuild: string;
  seaweedImage: string;
  layoutVersion: string;
  counts: {
    liveObjects: number;
    liveLogicalBytes: number;
    tombstonedVersions: number;
    unavailableVersions: number;
  };
}
export interface StorageBackupArtifactPolicy {
  layout: ColdCopyLayout;
  attestation: BackendPolicyAttestation;
  compatibility: Pick<
    StorageBackupMetadata,
    'schemaVersion' | 'moduleBuild' | 'seaweedImage' | 'layoutVersion'
  >;
}
export interface StorageBackupManifest extends StorageBackupMetadata {
  formatVersion: 1;
  files: { path: string; length: number; sha256: string }[];
}
export interface StorageBackupArtifactResult {
  manifest: StorageBackupManifest;
  /** Record separately; this detects damage, not replacement by an attacker. */
  manifestSha256: string;
}
export interface SeaweedLayoutInventory {
  supported: boolean;
  reasons: string[];
  entries: {
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'special';
    action: 'copy' | 'exclude' | 'reject';
  }[];
}
const EXCLUDED = new Set(['.mini_kek_passphrase', '.mini_sse_kek', 'mini.options']);
const CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const META_KEYS = [
  'backupId',
  'generation',
  'sqlCutAt',
  'schemaVersion',
  'moduleBuild',
  'seaweedImage',
  'layoutVersion',
  'counts',
];
const COUNT_KEYS = ['liveObjects', 'liveLogicalBytes', 'tombstonedVersions', 'unavailableVersions'];
const CHECKS = [
  'coldStopped',
  'freshModuleOnlyNeverIamNeverSse',
  'filerKekAbsent',
  'dynamicIamAbsent',
  'bucketEncryptionAbsent',
  'encryptedObjectsAbsent',
] as const;
function fail(): never {
  throw new Error('storage_backup_artifact_rejected');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    Array.from(value).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127;
    })
  );
}
function safePath(value: unknown): value is string {
  return (
    text(value) &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function secretPath(path: string): boolean {
  return path
    .split('/')
    .some((part) =>
      /(?:secret|credential|passphrase|password|token|kek|encryption|identity|config|(^|[._-])tls([._-]|$)|(^|[._-])iam([._-]|$)|\.pem$|\.key$|\.json$|\.toml$|\.yaml$|\.yml$|\.conf$|\.config$|\.options$|\.ini$|\.cnf$|\.env$|^s3[._-])/i.test(
        part
      )
    );
}
function privateMode(stat: Stats, directory: boolean): boolean {
  return (stat.mode & 0o7777) === (directory ? 0o700 : 0o600);
}
function identity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}
/** Reject linked path components as well as linked leaves. The caller must own
 * exclusive access to stopped source/staging trees; this is not openat isolation. */
async function checkedRoot(path: string, privatePermissions = false): Promise<string> {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (privatePermissions && !privateMode(await lstat(absolute), true)) fail();
  return absolute;
}
interface TreeEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'special';
  stat: Stats;
}
async function walk(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 32) fail();
    const parent = relative ? join(root, relative) : root;
    const before = await lstat(parent);
    if (!before.isDirectory() || before.isSymbolicLink()) fail();
    const children = (await readdir(parent)).sort();
    for (const child of children) {
      const path = relative ? `${relative}/${child}` : child;
      if (!safePath(path) || entries.length >= MAX_ENTRIES) fail();
      const stat = await lstat(join(root, path));
      const type = stat.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile() && stat.nlink === 1
            ? 'file'
            : 'special';
      entries.push({ path, type, stat });
      if (type === 'directory') await visit(path, depth + 1);
    }
    if (!identity(before, await lstat(parent))) fail();
  }
  await visit('', 0);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function compile(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).map((pattern) => {
    if (!text(pattern) || !pattern.startsWith('^') || !pattern.endsWith('$')) fail();
    return new RegExp(`^(?:${pattern})$`, 'u');
  });
}
function validatePolicy(policy: StorageBackupArtifactPolicy): void {
  const { layout, attestation, compatibility } = policy;
  if (
    !text(layout.version) ||
    !/^.+@sha256:[0-9a-f]{64}$/.test(layout.seaweedImage) ||
    layout.version !== compatibility.layoutVersion ||
    layout.seaweedImage !== compatibility.seaweedImage ||
    !text(compatibility.schemaVersion) ||
    !text(compatibility.moduleBuild)
  )
    fail();
  if (
    !attestation ||
    !text(attestation.evidence) ||
    CHECKS.some((check) => (attestation as unknown as Record<string, unknown>)[check] !== true)
  )
    fail();
  const names = [...layout.files, ...layout.directories];
  if (
    new Set(names).size !== names.length ||
    names.some((path) => !safePath(path) || secretPath(path) || EXCLUDED.has(path))
  )
    fail();
  compile(layout.filePatterns);
  compile(layout.directoryPatterns);
}
function matches(path: string, names: string[], patterns: RegExp[]): boolean {
  return names.includes(path) || patterns.some((pattern) => pattern.test(path));
}
async function inventory(
  source: string,
  policy: StorageBackupArtifactPolicy
): Promise<SeaweedLayoutInventory> {
  validatePolicy(policy);
  const root = await checkedRoot(source);
  const files = compile(policy.layout.filePatterns);
  const directories = compile(policy.layout.directoryPatterns);
  const entries = (await walk(root)).map((entry) => {
    let action: 'copy' | 'exclude' | 'reject' = 'reject';
    if (entry.type === 'file' && EXCLUDED.has(entry.path)) action = 'exclude';
    else if (
      !secretPath(entry.path) &&
      ((entry.type === 'file' && matches(entry.path, policy.layout.files, files)) ||
        (entry.type === 'directory' && matches(entry.path, policy.layout.directories, directories)))
    )
      action = 'copy';
    return { path: entry.path, type: entry.type, action };
  });
  const required = [...policy.layout.files, ...policy.layout.directories];
  const missing = required.some(
    (path) => !entries.some((entry) => entry.path === path && entry.action === 'copy')
  );
  const rejected = entries.some((entry) => entry.action === 'reject');
  return {
    supported: !missing && !rejected,
    reasons: [
      ...(missing ? ['required_layout_missing'] : []),
      ...(rejected ? ['unsupported_layout_entry'] : []),
    ],
    entries,
  };
}
/** Names and type only. No file contents, sizes or key hashes are returned. */
export async function inventorySeaweedLayout(
  source: string,
  policy: StorageBackupArtifactPolicy
): Promise<SeaweedLayoutInventory> {
  try {
    return await inventory(source, policy);
  } catch {
    return { supported: false, reasons: ['invalid_policy_or_tree'], entries: [] };
  }
}
/** Hash and optionally copy one file through a fixed 1 MiB buffer. */
async function streamFile(
  path: string,
  destination?: string
): Promise<{ length: number; sha256: string }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail();
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!identity(before, await input.stat())) fail();
    if (destination !== undefined)
      output = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let length = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (!Number.isSafeInteger(length) || length > before.size) fail();
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          const written = await output.write(buffer, offset, bytesRead - offset, null);
          if (!written.bytesWritten) fail();
          offset += written.bytesWritten;
        }
      }
    }
    if (
      length !== before.size ||
      !identity(before, await input.stat()) ||
      !identity(before, await lstat(path))
    )
      fail();
    if (output) await output.sync();
    return { length, sha256: hash.digest('hex') };
  } finally {
    await output?.close();
    await input.close();
  }
}
function sameInventory(a: SeaweedLayoutInventory, b: SeaweedLayoutInventory): boolean {
  return a.supported && b.supported && JSON.stringify(a.entries) === JSON.stringify(b.entries);
}
/** Excludes mini-generated custody/config BEFORE opening any source file.
 * Requires fresh destination and exclusive operator ownership of both trees. */
export async function copySanitizedSeaweedTree(
  source: string,
  destination: string,
  policy: StorageBackupArtifactPolicy
): Promise<void> {
  try {
    const result = await inventory(source, policy);
    if (!result.supported) fail();
    const sourceRoot = await checkedRoot(source);
    const destinationRoot = resolve(destination);
    if (
      destinationRoot === sourceRoot ||
      destinationRoot.startsWith(`${sourceRoot}/`) ||
      sourceRoot.startsWith(`${destinationRoot}/`)
    )
      fail();
    await checkedRoot(dirname(destinationRoot));
    await mkdir(destinationRoot, { mode: 0o700 });
    for (const entry of result.entries
      .filter((entry) => entry.type === 'directory' && entry.action === 'copy')
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length))
      await mkdir(join(destinationRoot, entry.path), { mode: 0o700 });
    const hashes = new Map<string, { length: number; sha256: string }>();
    for (const entry of result.entries)
      if (entry.type === 'file' && entry.action === 'copy')
        hashes.set(
          entry.path,
          await streamFile(join(sourceRoot, entry.path), join(destinationRoot, entry.path))
        );
    if (!sameInventory(result, await inventory(source, policy))) fail();
    for (const [path, hash] of hashes) {
      if (
        JSON.stringify(hash) !== JSON.stringify(await streamFile(join(sourceRoot, path))) ||
        JSON.stringify(hash) !== JSON.stringify(await streamFile(join(destinationRoot, path)))
      )
        fail();
    }
  } catch {
    fail();
  }
}
function validateMetadata(
  value: unknown,
  policy: StorageBackupArtifactPolicy
): asserts value is StorageBackupMetadata {
  if (!record(value) || !keys(value, META_KEYS)) fail();
  if (
    typeof value['backupId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value['backupId']
    ) ||
    typeof value['generation'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value['generation']
    )
  )
    fail();
  const cut = value['sqlCutAt'];
  if (
    typeof cut !== 'string' ||
    !Number.isFinite(Date.parse(cut)) ||
    new Date(cut).toISOString() !== cut
  )
    fail();
  for (const field of ['schemaVersion', 'moduleBuild', 'seaweedImage', 'layoutVersion'] as const)
    if (value[field] !== policy.compatibility[field]) fail();
  const counts = value['counts'];
  if (
    !record(counts) ||
    !keys(counts, COUNT_KEYS) ||
    Object.values(counts).some(
      (count) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
    )
  )
    fail();
}
function validateManifest(
  value: unknown,
  policy: StorageBackupArtifactPolicy
): asserts value is StorageBackupManifest {
  if (
    !record(value) ||
    !keys(value, [...META_KEYS, 'formatVersion', 'files']) ||
    value['formatVersion'] !== 1
  )
    fail();
  const { formatVersion: _version, files, ...metadata } = value;
  validateMetadata(metadata, policy);
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ENTRIES) fail();
  const names = new Set<string>();
  for (const file of files as unknown[]) {
    if (
      !record(file) ||
      !keys(file, ['path', 'length', 'sha256']) ||
      !safePath(file['path']) ||
      file['path'] === 'manifest.json' ||
      names.has(file['path']) ||
      typeof file['length'] !== 'number' ||
      !Number.isSafeInteger(file['length']) ||
      file['length'] < 0 ||
      typeof file['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file['sha256'])
    )
      fail();
    names.add(file['path']);
  }
}
async function payload(
  root: string,
  policy: StorageBackupArtifactPolicy,
  finalized: boolean
): Promise<StorageBackupManifest['files']> {
  validatePolicy(policy);
  await checkedRoot(root, true);
  const seaweed = await inventory(join(root, 'seaweed'), policy);
  if (!seaweed.supported || seaweed.entries.some((entry) => entry.action !== 'copy')) fail();
  const tree = await walk(root);
  const expectedDirs = new Set([
    'seaweed',
    ...seaweed.entries
      .filter((entry) => entry.type === 'directory')
      .map((entry) => `seaweed/${entry.path}`),
  ]);
  const expectedFiles = new Set([
    'catalog.dump',
    ...seaweed.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => `seaweed/${entry.path}`),
    ...(finalized ? ['manifest.json'] : []),
  ]);
  const files: StorageBackupManifest['files'] = [];
  for (const entry of tree) {
    if (entry.type === 'directory') {
      if (!expectedDirs.delete(entry.path) || !privateMode(entry.stat, true)) fail();
    } else if (entry.type === 'file') {
      if (!expectedFiles.delete(entry.path) || !privateMode(entry.stat, false)) fail();
      if (entry.path !== 'manifest.json')
        files.push({ path: entry.path, ...(await streamFile(join(root, entry.path))) });
    } else fail();
  }
  if (expectedDirs.size || expectedFiles.size) fail();
  return files;
}
/** Atomic rename is the final success marker. No overwrite or concurrent builders.
 * Failed staging remains private for diagnosis; never promote a partial artifact. */
export async function buildStorageBackupManifest(
  root: string,
  metadata: StorageBackupMetadata,
  policy: StorageBackupArtifactPolicy
): Promise<StorageBackupArtifactResult> {
  let temporary: string | undefined;
  let published = false;
  try {
    validatePolicy(policy);
    validateMetadata(metadata, policy);
    const files = await payload(root, policy, false);
    const manifest: StorageBackupManifest = { formatVersion: 1, ...metadata, files };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (bytes.length > MAX_MANIFEST_BYTES) fail();
    temporary = join(root, `.manifest-${randomUUID()}.tmp`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Exclusive operator ownership is mandatory: rename must not race another builder.
    try {
      await lstat(join(root, 'manifest.json'));
      fail();
    } catch (error) {
      if (!record(error) || error['code'] !== 'ENOENT') throw error;
    }
    await rename(temporary, join(root, 'manifest.json'));
    temporary = undefined;
    published = true;
    const directory = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return await verifyStorageBackupArtifact(root, policy);
  } catch {
    if (published) await rm(join(root, 'manifest.json'), { force: true }).catch(() => undefined);
    return fail();
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
export async function verifyStorageBackupArtifact(
  root: string,
  policy: StorageBackupArtifactPolicy
): Promise<StorageBackupArtifactResult> {
  try {
    validatePolicy(policy);
    await checkedRoot(root, true);
    const path = join(root, 'manifest.json');
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      !privateMode(before, false) ||
      before.size > MAX_MANIFEST_BYTES
    )
      fail();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!identity(before, await file.stat())) fail();
      // Bounded even if an untrusted writer grows the manifest after lstat.
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const next = await file.read(buffer, length, buffer.length - length, null);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (
        length !== before.size ||
        !identity(before, await file.stat()) ||
        !identity(before, await lstat(path))
      )
        fail();
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    const manifest: unknown = JSON.parse(bytes.toString('utf8'));
    validateManifest(manifest, policy);
    const files = await payload(root, policy, true);
    const sorted = [...manifest.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );
    if (
      files.length !== sorted.length ||
      files.some((file, index) => {
        const wanted = sorted[index];
        return (
          file.path !== wanted?.path ||
          file.length !== wanted.length ||
          file.sha256 !== wanted.sha256
        );
      })
    )
      fail();
    if (!identity(before, await lstat(path))) fail();
    return { manifest, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return fail();
  }
}
