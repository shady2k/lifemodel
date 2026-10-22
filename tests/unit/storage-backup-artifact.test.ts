import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStorageBackupManifest,
  copySanitizedSeaweedTree,
  inventorySeaweedLayout,
  verifyStorageBackupArtifact,
  type BackendPolicyAttestation,
  type ColdCopyLayout,
  type StorageBackupMetadata,
} from '../../loader/src/storage-backup-artifact.js';

const image = `chrislusf/seaweedfs@sha256:${'a'.repeat(64)}`;
// Fixture policy only. This is not evidence of the real pinned Seaweed layout.
const layout: ColdCopyLayout = {
  version: 'fixture-v1',
  seaweedImage: image,
  directories: ['filer', 'master', 'volume'],
  files: ['filer/.hidden.ldb', 'master/log', 'volume/1.dat', 'volume/1.idx'],
};
const attestation: BackendPolicyAttestation = {
  evidence: 'fixture-only:offline-backend-and-history-check',
  coldStopped: true,
  freshModuleOnlyNeverIamNeverSse: true,
  filerKekAbsent: true,
  dynamicIamAbsent: true,
  bucketEncryptionAbsent: true,
  encryptedObjectsAbsent: true,
};
const metadata: StorageBackupMetadata = {
  backupId: 'be524962-7bfa-40d2-9613-5e6b0978aa40',
  generation: '86fffd76-6f60-490b-b0bd-3548f460e7cb',
  sqlCutAt: '2026-10-22T12:00:00.000Z',
  schemaVersion: '20261022000100',
  moduleBuild: 'fixture-module-build',
  seaweedImage: image,
  layoutVersion: layout.version,
  counts: { liveObjects: 2, liveLogicalBytes: 10, tombstonedVersions: 1, unavailableVersions: 1 },
};
const policy = {
  layout,
  attestation,
  compatibility: {
    schemaVersion: metadata.schemaVersion,
    moduleBuild: metadata.moduleBuild,
    seaweedImage: image,
    layoutVersion: layout.version,
  },
};
let base: string;
let source: string;
let artifact: string;
async function put(path: string, value: string | Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}
async function stage(): Promise<void> {
  await mkdir(artifact, { mode: 0o700 });
  await put(join(artifact, 'catalog.dump'), 'storage-only-custom-dump-fixture');
  await copySanitizedSeaweedTree(source, join(artifact, 'seaweed'), policy);
}
// Run a real filesystem mutation after the selected inode has returned EOF, but
// before the reader can perform its post-read checks. No timing or fake stats:
// the original FileHandle.read still supplies every byte to the production code.
type ChunkRead = (
  this: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: null
) => Promise<{ bytesRead: number; buffer: Buffer }>;
async function mutateAtReadEnd(
  path: string,
  mutate: () => Promise<void>,
  operation: () => Promise<void>
): Promise<void> {
  const probe = await open(path, constants.O_RDONLY);
  const target = await probe.stat();
  const prototype = Object.getPrototypeOf(probe) as { read: ChunkRead };
  const originalRead = prototype.read;
  await probe.close();
  let mutations = 0;
  prototype.read = async function (this: FileHandle, ...args: Parameters<ChunkRead>) {
    const result = await originalRead.call(this, ...args);
    if (result.bytesRead === 0 && mutations === 0) {
      const current = await this.stat();
      if (current.dev === target.dev && current.ino === target.ino) {
        mutations += 1;
        await mutate();
      }
    }
    return result;
  };
  try {
    await operation();
    expect(mutations).toBe(1);
  } finally {
    prototype.read = originalRead;
  }
}
async function replaceWithIdenticalBytes(path: string): Promise<void> {
  const bytes = await readFile(path);
  // Keep the old inode alive outside the tree so inode reuse cannot hide replacement.
  await rename(path, join(base, 'replaced-inode'));
  await put(path, bytes);
}
async function manifestEdit(change: (value: Record<string, unknown>) => void): Promise<void> {
  const path = join(artifact, 'manifest.json');
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  change(value);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'storage-backup-artifact-'));
  source = join(base, 'source');
  artifact = join(base, 'artifact');
  for (const file of layout.files) await put(join(source, file), `payload:${file}`);
  await put(join(source, '.mini_kek_passphrase'), 'SECRET-CANARY-PASSPHRASE');
  await put(join(source, '.mini_sse_kek'), 'SECRET-CANARY-KEK');
  await put(join(source, 'mini.options'), 'SECRET-CANARY-OPTIONS');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('sanitized cold-copy policy', () => {
  it('supports exactly the pinned mini VM names and never copies the regenerable admin subtree', async () => {
    const pinned = JSON.parse(
      await readFile('deploy/platform/storage-seaweed-layout.json', 'utf8')
    ) as Pick<typeof policy, 'layout' | 'compatibility'>;
    const approved = { ...pinned, attestation };
    const tree = join(base, 'pinned');
    await mkdir(tree, { mode: 0o700 });
    const names = (await readFile('tests/fixtures/seaweed-mini-layout-names.txt', 'utf8'))
      .trim()
      .split('\n');
    expect(names).toHaveLength(125);
    for (const line of names) {
      const path = join(tree, line.slice(2));
      if (line.startsWith('d ')) await mkdir(path, { recursive: true, mode: 0o700 });
      else await put(path, '');
    }
    const result = await inventorySeaweedLayout(tree, approved);
    expect(result.supported).toBe(true);
    expect(result.entries).toHaveLength(names.length);
    const admin = result.entries.filter(
      (entry) => entry.path === 'admin' || entry.path.startsWith('admin/')
    );
    expect(admin.length).toBeGreaterThan(1);
    expect(admin.every((entry) => entry.action === 'exclude')).toBe(true);
    await chmod(join(tree, 'admin/.session_key'), 0o000);
    await copySanitizedSeaweedTree(tree, join(base, 'pinned-copy'), approved);
    await expect(lstat(join(base, 'pinned-copy/admin'))).rejects.toThrow();
    expect(await readFile(join(base, 'pinned-copy/1.dat'), 'utf8')).toBe('');
    const copied = await inventorySeaweedLayout(join(base, 'pinned-copy'), approved);
    expect(copied.supported).toBe(true);
    expect(copied.entries.every((entry) => entry.action === 'copy')).toBe(true);
  });
  it.each([
    'volume',
    'filer',
    'filerldb2',
    'master',
    'm9333',
    'unknown',
    '../admin',
    'admin/plugin',
  ])('refuses excluding data or an unapproved subtree: %s', async (excluded) => {
    const denied = { ...policy, layout: { ...layout, excludedDirectories: [excluded] } };
    expect((await inventorySeaweedLayout(source, denied)).supported).toBe(false);
  });
  it('refuses exclusions overlapping required paths or copied patterns', async () => {
    await put(join(source, 'admin/job.pb'), '');
    for (const change of [
      { directories: [...layout.directories, 'admin'] },
      { files: [...layout.files, 'admin/job.pb'] },
      { filePatterns: ['^admin/job\\.pb$'] },
      { filePatterns: ['^admin/not-yet-created\\.pb$'] },
      { filePatterns: ['^filer/.*$|^admin/not-yet-created\\.pb$'] },
      { directoryPatterns: ['^admin$'] },
    ]) {
      const denied = {
        ...policy,
        layout: { ...layout, excludedDirectories: ['admin'], ...change },
      };
      expect((await inventorySeaweedLayout(source, denied)).supported).toBe(false);
    }
  });
  it('never copies the admin session key even if explicitly or broadly allowlisted', async () => {
    await put(join(source, 'admin/.session_key'), 'SECRET-CANARY-SESSION');
    for (const change of [
      {
        directories: [...layout.directories, 'admin'],
        files: [...layout.files, 'admin/.session_key'],
      },
      { directoryPatterns: ['^.*$'], filePatterns: ['^.*$'] },
    ]) {
      const denied = { ...policy, layout: { ...layout, ...change } };
      const result = await inventorySeaweedLayout(source, denied);
      expect(result.supported).toBe(false);
      expect(
        result.entries.some(
          (entry) => entry.path === 'admin/.session_key' && entry.action === 'copy'
        )
      ).toBe(false);
      await expect(
        copySanitizedSeaweedTree(source, join(base, 'forbidden-copy'), denied)
      ).rejects.toThrow();
    }
  });
  it('returns names/type-only inventory and a layout verdict, never key hashes or contents', async () => {
    const result = await inventorySeaweedLayout(source, policy);
    expect(result.supported).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.entries).toContainEqual({
      path: '.mini_sse_kek',
      type: 'file',
      action: 'exclude',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET-CANARY');
    for (const entry of result.entries)
      expect(Object.keys(entry).sort()).toEqual(['action', 'path', 'type']);
    await stage();
    expect(await readdir(join(artifact, 'seaweed'))).toEqual(['filer', 'master', 'volume']);
    expect(await readFile(join(artifact, 'seaweed/filer/.hidden.ldb'), 'utf8')).toBe(
      'payload:filer/.hidden.ldb'
    );
  });
  it.each([
    'credentials.json',
    's3.json',
    'filer/kek',
    'filer/iam',
    'filer/bucket.encryption',
    'volume/private.pem',
    'unknown',
  ])('rejects unsupported file %s before creating the copy', async (name) => {
    await put(join(source, name), 'SECRET-CANARY-UNEXPECTED');
    const result = await inventorySeaweedLayout(source, policy);
    expect(result.supported).toBe(false);
    await expect(
      copySanitizedSeaweedTree(source, join(artifact, 'seaweed'), policy)
    ).rejects.toThrow();
    await expect(lstat(join(artifact, 'seaweed'))).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain('SECRET-CANARY');
  });
  it.each([
    'coldStopped',
    'freshModuleOnlyNeverIamNeverSse',
    'filerKekAbsent',
    'dynamicIamAbsent',
    'bucketEncryptionAbsent',
    'encryptedObjectsAbsent',
  ] as const)(
    'requires independent %s evidence even with acceptable filesystem names',
    async (field) => {
      const denied = { ...policy, attestation: { ...attestation, [field]: false } };
      expect((await inventorySeaweedLayout(source, denied)).supported).toBe(false);
      await expect(
        copySanitizedSeaweedTree(source, join(artifact, 'seaweed'), denied)
      ).rejects.toThrow();
    }
  );
  it('does not accept missing attestation or an empty evidence reference', async () => {
    for (const supplied of [undefined, { ...attestation, evidence: '' }]) {
      const denied = { ...policy, attestation: supplied } as typeof policy;
      expect((await inventorySeaweedLayout(source, denied)).supported).toBe(false);
    }
  });
  it('rejects secret/config paths even if the caller tries to allowlist them', async () => {
    await put(join(source, 'filer/credentials.json'), 'secret');
    const denied = {
      ...policy,
      layout: { ...layout, files: [...layout.files, 'filer/credentials.json'] },
    };
    expect((await inventorySeaweedLayout(source, denied)).supported).toBe(false);
  });
  it('rejects source symlinks, including excluded keys and directory links', async () => {
    await rm(join(source, '.mini_sse_kek'));
    await symlink('/etc/passwd', join(source, '.mini_sse_kek'));
    expect((await inventorySeaweedLayout(source, policy)).supported).toBe(false);
    await rm(join(source, '.mini_sse_kek'));
    await symlink(join(source, 'filer'), join(source, 'extra'));
    await expect(
      copySanitizedSeaweedTree(source, join(artifact, 'seaweed'), policy)
    ).rejects.toThrow();
  });
  it('rejects a hardlinked payload even when its other name is outside the source tree', async () => {
    await link(join(source, 'volume/1.dat'), join(base, 'outside-payload'));
    const result = await inventorySeaweedLayout(source, policy);
    expect(result.supported).toBe(false);
    expect(result.entries).toContainEqual({
      path: 'volume/1.dat',
      type: 'special',
      action: 'reject',
    });
    const destination = join(base, 'copy');
    await expect(copySanitizedSeaweedTree(source, destination, policy)).rejects.toThrow(
      'storage_backup_artifact_rejected'
    );
    await expect(lstat(destination)).rejects.toThrow();
  });
  it('rejects same-byte inode replacement during the actual cold copy', async () => {
    const path = join(source, 'volume/1.dat');
    await mutateAtReadEnd(
      path,
      () => replaceWithIdenticalBytes(path),
      async () => {
        await expect(copySanitizedSeaweedTree(source, join(base, 'copy'), policy)).rejects.toThrow(
          'storage_backup_artifact_rejected'
        );
      }
    );
  });
  it('rejects special files without opening them', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(source, 'socket'), resolve));
    try {
      expect((await inventorySeaweedLayout(source, policy)).supported).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  it('accepts dynamic filenames only through explicit anchored versioned patterns', async () => {
    await put(join(source, 'volume/42.dat'), 'dynamic-volume');
    const extended = { ...policy, layout: { ...layout, filePatterns: ['^volume/[0-9]+\\.dat$'] } };
    expect((await inventorySeaweedLayout(source, extended)).supported).toBe(true);
    await copySanitizedSeaweedTree(source, join(base, 'copy'), extended);
    expect(await readFile(join(base, 'copy/volume/42.dat'), 'utf8')).toBe('dynamic-volume');
    const broad = { ...policy, layout: { ...layout, filePatterns: ['.*'] } };
    expect((await inventorySeaweedLayout(source, broad)).supported).toBe(false);
    await put(join(source, 'volume/s3.json'), 'secret-config');
    expect(
      (
        await inventorySeaweedLayout(source, {
          ...policy,
          layout: { ...layout, filePatterns: ['^volume/.*$'] },
        })
      ).supported
    ).toBe(false);
  });
  it('refuses an existing destination and source-directory aliases', async () => {
    await expect(copySanitizedSeaweedTree(source, source, policy)).rejects.toThrow();
    await mkdir(artifact, { mode: 0o700 });
    await expect(copySanitizedSeaweedTree(source, artifact, policy)).rejects.toThrow();
    await symlink(source, join(base, 'source-link'));
    await expect(
      copySanitizedSeaweedTree(join(base, 'source-link'), join(base, 'copy'), policy)
    ).rejects.toThrow();
  });
});

describe('directory backup manifest v1', () => {
  it('streams exact payload hashes, records the SQL cut/counts/versions and verifies independently', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 3, 0x37);
    await writeFile(join(source, 'volume/1.dat'), bytes);
    await stage();
    const built = await buildStorageBackupManifest(artifact, metadata, policy);
    expect(built.manifest.formatVersion).toBe(1);
    expect(built.manifest).toMatchObject(metadata);
    expect(built.manifest.files).toContainEqual({
      path: 'seaweed/volume/1.dat',
      length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(built.manifest.files.map((file) => file.path)).not.toContain('manifest.json');
    expect(built.manifestSha256).toBe(
      createHash('sha256')
        .update(await readFile(join(artifact, 'manifest.json')))
        .digest('hex')
    );
    expect(await verifyStorageBackupArtifact(artifact, policy)).toEqual(built);
    expect((await lstat(artifact)).mode & 0o777).toBe(0o700);
    for (const entry of built.manifest.files)
      expect((await lstat(join(artifact, entry.path))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(artifact, 'manifest.json'))).mode & 0o777).toBe(0o600);
  });
  it.each([
    'change-byte',
    'change-length',
    'missing',
    'extra',
    'empty-directory',
    'secret',
    'symlink',
  ] as const)('rejects payload damage: %s', async (kind) => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    const path = join(artifact, 'seaweed/volume/1.dat');
    if (kind === 'change-byte') {
      const bytes = await readFile(path);
      bytes[0] = bytes[0] === 65 ? 66 : 65;
      await writeFile(path, bytes);
    }
    if (kind === 'change-length') await writeFile(path, 'short');
    if (kind === 'missing') await rm(path);
    if (kind === 'extra') await put(join(artifact, 'extra'), 'extra');
    if (kind === 'empty-directory') await mkdir(join(artifact, 'extra'));
    if (kind === 'secret') await put(join(artifact, 'seaweed/.mini_sse_kek'), 'SECRET-CANARY');
    if (kind === 'symlink') {
      await rm(path);
      await symlink('/etc/passwd', path);
    }
    await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow();
  });
  it.each(['catalog.dump', 'seaweed/volume/1.dat', 'manifest.json'])(
    'rejects hardlinked artifact file %s with an alias outside the artifact',
    async (name) => {
      await stage();
      await buildStorageBackupManifest(artifact, metadata, policy);
      await link(join(artifact, name), join(base, 'outside-artifact-file'));
      await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow(
        'storage_backup_artifact_rejected'
      );
    }
  );
  it('does not publish a manifest if a payload inode changes while it is hashed', async () => {
    await stage();
    const path = join(artifact, 'catalog.dump');
    await mutateAtReadEnd(
      path,
      () => replaceWithIdenticalBytes(path),
      async () => {
        await expect(buildStorageBackupManifest(artifact, metadata, policy)).rejects.toThrow(
          'storage_backup_artifact_rejected'
        );
      }
    );
    await expect(lstat(join(artifact, 'manifest.json'))).rejects.toThrow();
  });
  it('rejects a same-length payload mutation after the verifier has read its bytes', async () => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    const path = join(artifact, 'seaweed/volume/1.dat');
    await mutateAtReadEnd(
      path,
      async () => {
        const bytes = await readFile(path);
        bytes[0] = bytes[0] === 65 ? 66 : 65;
        await writeFile(path, bytes);
        // Force a distinct mtime even on a coarse-resolution filesystem.
        await utimes(path, 0, new Date('2000-01-01T00:00:00.000Z'));
      },
      async () => {
        await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow(
          'storage_backup_artifact_rejected'
        );
      }
    );
  });
  it('rejects a same-length manifest mutation after its bytes have been read', async () => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    const path = join(artifact, 'manifest.json');
    await mutateAtReadEnd(
      path,
      async () => {
        const bytes = await readFile(path);
        expect(bytes[bytes.length - 1]).toBe(10);
        // Valid JSON with identical meaning and length: only identity checks
        // reject this, not manifest parsing or the later payload hashes.
        bytes[bytes.length - 1] = 32;
        await writeFile(path, bytes);
        await utimes(path, 0, new Date('2000-01-01T00:00:00.000Z'));
      },
      async () => {
        await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow(
          'storage_backup_artifact_rejected'
        );
      }
    );
  });
  it.each([
    '/etc/passwd',
    '../escape',
    'seaweed/../escape',
    'seaweed//volume/1.dat',
    './catalog.dump',
    'C:\\escape',
    'seaweed\\escape',
  ])('rejects unsafe manifest path %s', async (badPath) => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    await manifestEdit((value) => {
      (value['files'] as { path: string }[])[0]!.path = badPath;
    });
    await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow();
  });
  it.each([
    'formatVersion',
    'schemaVersion',
    'seaweedImage',
    'moduleBuild',
    'layoutVersion',
  ] as const)('rejects unsupported %s', async (field) => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    await manifestEdit((value) => {
      value[field] = field === 'formatVersion' ? 2 : 'unsupported';
    });
    await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow();
  });
  it.each([
    'duplicate',
    'missing-entry',
    'manifest-entry',
    'invalid-hash',
    'invalid-length',
    'invalid-count',
    'invalid-generation',
    'unknown-field',
  ])('rejects malformed manifest: %s', async (kind) => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    await manifestEdit((value) => {
      const files = value['files'] as { path: string; length: number; sha256: string }[];
      if (kind === 'duplicate') files.push(files[0]!);
      if (kind === 'missing-entry') files.pop();
      if (kind === 'manifest-entry') files[0]!.path = 'manifest.json';
      if (kind === 'invalid-hash') files[0]!.sha256 = 'x'.repeat(64);
      if (kind === 'invalid-length') files[0]!.length = -1;
      if (kind === 'invalid-count')
        (value['counts'] as Record<string, unknown>)['liveObjects'] = -1;
      if (kind === 'invalid-generation') value['generation'] = '0';
      if (kind === 'unknown-field') value['credentials'] = 'SECRET-CANARY';
    });
    await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow();
  });
  it('writes manifest last, never overwrites a final artifact, and leaves no success marker on invalid payload', async () => {
    await stage();
    await put(join(artifact, 'unexpected'), 'extra');
    await expect(buildStorageBackupManifest(artifact, metadata, policy)).rejects.toThrow();
    await expect(lstat(join(artifact, 'manifest.json'))).rejects.toThrow();
    await rm(join(artifact, 'unexpected'));
    await buildStorageBackupManifest(artifact, metadata, policy);
    const previous = await readFile(join(artifact, 'manifest.json'));
    await expect(buildStorageBackupManifest(artifact, metadata, policy)).rejects.toThrow();
    expect(await readFile(join(artifact, 'manifest.json'))).toEqual(previous);
    expect(await readdir(artifact)).toEqual(['catalog.dump', 'manifest.json', 'seaweed']);
  });
  it('refuses loose permissions and manifest links', async () => {
    await stage();
    await buildStorageBackupManifest(artifact, metadata, policy);
    await chmod(join(artifact, 'catalog.dump'), 0o644);
    await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow();
    await chmod(join(artifact, 'catalog.dump'), 0o600);
    await rename(join(artifact, 'manifest.json'), join(base, 'manifest.json'));
    await symlink(join(base, 'manifest.json'), join(artifact, 'manifest.json'));
    await expect(verifyStorageBackupArtifact(artifact, policy)).rejects.toThrow();
    expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });
});
