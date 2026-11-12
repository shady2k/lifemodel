import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../deploy/logs/logs-volume.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'collector-volume-'));
  roots.push(root);
  const mount = join(root, 'logs');
  const bin = join(root, 'bin');
  const image = join(root, 'logs.img');
  mkdirSync(mount);
  mkdirSync(bin);
  writeFileSync(image, 'existing image');
  function fake(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/bin/sh
${body}
`
    );
    chmodSync(path, 0o755);
  }
  fake(
    'findmnt',
    'case "$*" in *FSTYPE*) echo "${FAKE_FS:-ext4}" ;; *) [ "$FAKE_MOUNT" != absent ] || exit 1; echo "${FAKE_SOURCE:-/dev/loop7}" ;; esac'
  );
  fake('losetup', `printf '/dev/loop7: []: (%s)\n' "$2"`);
  fake('chown', 'printf "%s\n" "$*" >> "$OWNER_LOG"');
  function prepare(env: Record<string, string | undefined> = {}) {
    return spawnSync('sh', [script, 'prepare', image, mount], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OWNER_LOG: join(root, 'owner.log'),
        ...env,
      },
    });
  }
  return { root, mount, prepare };
}

describe('collector state stays inside the mounted log volume, beside store data', () => {
  it('prepares an existing mounted image and is idempotent without touching store data', () => {
    const { root, mount, prepare } = fixture();
    mkdirSync(join(mount, 'data'));
    writeFileSync(join(mount, 'data', 'record'), 'keep');
    const first = prepare();
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(join(mount, 'collector'))).toBe(true);
    expect(readFileSync(join(root, 'owner.log'), 'utf8')).toContain(
      `0:0 ${join(mount, 'collector')}`
    );
    writeFileSync(join(mount, 'collector', 'checkpoint'), 'keep checkpoint');
    expect(prepare().status).toBe(0);
    expect(readFileSync(join(mount, 'collector', 'checkpoint'), 'utf8')).toBe('keep checkpoint');
    expect(readFileSync(join(mount, 'data', 'record'), 'utf8')).toBe('keep');
  });

  it.each([{ FAKE_MOUNT: 'absent' }, { FAKE_SOURCE: '/dev/loop8' }, { FAKE_FS: 'tmpfs' }])(
    'refuses unmounted or unrelated host storage: %j',
    (env) => {
      const { mount, prepare } = fixture();
      expect(prepare(env).status).not.toBe(0);
      expect(existsSync(join(mount, 'collector'))).toBe(false);
    }
  );

  it('refuses a collector symlink instead of following it outside the volume', () => {
    const { root, mount, prepare } = fixture();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(mount, 'collector'));
    expect(prepare().status).not.toBe(0);
    expect(existsSync(join(root, 'owner.log'))).toBe(false);
  });
});
