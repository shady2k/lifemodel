import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));
const rootTemplates = fileURLToPath(new URL('../../deploy/root/', import.meta.url));
const volumeDir = '/var/lib/lifemodel-logs';
const volumeImage = '/var/lib/lifemodel-logs.img';
const volumeScript = '/usr/lib/lifemodel/logs-volume.sh';
const volumeUnit = 'lifemodel-logs-volume.service';
const collectorUnit = 'lifemodel-logs-collector-volume.service';
const mountUnit = 'var-lib-lifemodel\\x2dlogs.mount';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `logs-volume-${name}-`));
  roots.push(root);
  return root;
}

function writeFake(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// The script writes the data directory into the fresh image with debugfs, which
// needs no host chown (lifemodel-vbog.4.2). The fake records the commands and
// answers the read-back with the inode a formatted image would hold.
const debugfsFake = `#!/bin/sh
printf '%s\\n' "$*" >> "$DEBUGFS_LOG"
case "$*" in
  *'stat /data'*) printf '%s\\n' 'Inode: 12   Type: directory    Mode:  0750   Flags: 0x80000' 'User:  1000   Group:  1000   Project:     0   Size: 4096' ;;
esac
exit 0
`;

function render(root: string, ...args: string[]) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFake(
    join(bin, 'ip'),
    `#!/bin/sh\nif [ "$1" = -j ]; then printf '%s\\n' '[{"dev":"eth0","metric":100}]'; else exit 1; fi\n`
  );
  const out = join(root, 'out');
  const result = spawnSync(
    'sh',
    [
      installer,
      '--platform-url',
      'oci://example.test/platform',
      '--tag',
      'v1.0.0',
      '--verify',
      'keyless',
      '--render-only',
      out,
      '--root-templates',
      rootTemplates,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LIFEMODEL_INSTANCE_ENV: join(root, 'absent.env'),
      },
    }
  );
  return { out, status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the installers create the file-backed log volume', () => {
  it('renders the unit that creates the image and the fstab line that mounts it', () => {
    const root = workspace('render');
    const { out, status, output } = render(root);
    expect(status, output).toBe(0);
    const unit = readFileSync(join(out, 'systemd', volumeUnit), 'utf8');
    expect(unit).toContain(`ExecStart=${volumeScript} 3G ${volumeImage} ${volumeDir}`);
    expect(unit).toContain(`Before=${mountUnit} k3s.service`);
    expect(unit).toContain('DefaultDependencies=no');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    const collector = readFileSync(join(out, 'systemd', collectorUnit), 'utf8');
    expect(collector).toContain(`Requires=${mountUnit}`);
    expect(collector).toContain(`After=${mountUnit}`);
    expect(collector).toContain('Before=k3s.service');
    expect(collector).toContain(`WantedBy=multi-user.target ${mountUnit}`);
    expect(collector).toContain(`ExecStart=${volumeScript} prepare ${volumeImage} ${volumeDir}`);
    expect(collector).toContain('Type=oneshot');
    expect(collector).toContain('RemainAfterExit=yes');
    expect(collector).not.toMatch(/@[A-Z_]+@/);
    expect(readFileSync(join(out, 'fstab'), 'utf8').trim()).toBe(
      `${volumeImage} ${volumeDir} ext4 loop,nofail 0 0`
    );
  }, 120_000);

  it('renders a chosen size and refuses one below the 2G minimum with both figures', () => {
    const large = render(workspace('large'), '--logs-volume-size', '5G');
    expect(large.status, large.output).toBe(0);
    expect(readFileSync(join(large.out, 'systemd', volumeUnit), 'utf8')).toContain(
      `ExecStart=${volumeScript} 5G ${volumeImage} ${volumeDir}`
    );

    const small = render(workspace('small'), '--logs-volume-size', '1G');
    expect(small.status, small.output).not.toBe(0);
    expect(small.output).toContain('1G');
    expect(small.output).toContain('2G');
    expect(small.output).toContain('minimum');

    const malformed = render(workspace('malformed'), '--logs-volume-size', '4GiB');
    expect(malformed.status, malformed.output).not.toBe(0);
    expect(malformed.output).toContain('4GiB');
  }, 120_000);

  it('runs the rendered unit line against a temporary image', () => {
    const root = workspace('unit-runs');
    const { out, status, output } = render(root);
    expect(status, output).toBe(0);
    const execStart = readFileSync(join(out, 'systemd', volumeUnit), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('ExecStart='))!
      .slice('ExecStart='.length);
    // At boot the host runs this exact line. The repository copy of the script
    // is the one the installer installs, so only the image and mount point move.
    const image = join(root, 'volume.img');
    const mount = join(root, 'mnt');
    const args = execStart
      .replace(volumeScript, '')
      .replace(volumeImage, image)
      .replace(volumeDir, mount)
      .split(' ')
      .filter((arg) => arg !== '');
    const bin = join(root, 'bin');
    writeFake(join(bin, 'df'), `#!/bin/sh\nprintf 'fakefs 100000000 1 67108864 1%% /\\n'\n`);
    writeFake(
      join(bin, 'fallocate'),
      `#!/bin/sh
previous=""
for arg do
  if [ "$previous" = -l ]; then size=$arg; fi
  previous=$arg
  target=$arg
done
truncate -s "$size" "$target"
`
    );
    writeFake(join(bin, 'mkfs.ext4'), `#!/bin/sh\nexit 0\n`);
    writeFake(join(bin, 'debugfs'), debugfsFake);
    const result = spawnSync(
      'sh',
      [fileURLToPath(new URL('../../deploy/logs/logs-volume.sh', import.meta.url)), ...args],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEBUGFS_LOG: join(root, 'debugfs.log'),
        },
      }
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(statSync(image).size).toBe(3 * 1024 ** 3);
    expect(existsSync(mount)).toBe(true);
  }, 120_000);

  it('refuses a size the disk cannot hold, naming the size and the free space', () => {
    const root = workspace('too-big');
    const result = install(root, { size: '8G', freeKb: 4 * 1024 * 1024 });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('8G');
    expect(result.output).toContain('4096 MiB free');
    expect(existsSync(join(root, 'fallocate.log'))).toBe(false);
  }, 120_000);

  it('creates the image as uid 1000, installs the unit, mounts it once and keeps one fstab line', () => {
    const root = workspace('install');
    const first = install(root);
    expect(first.status, first.output).toBe(0);
    expect(existsSync(join(root, 'install-root', volumeScript))).toBe(true);
    expect(readFileSync(join(root, 'fallocate.log'), 'utf8')).toContain('-l 3G');
    const mkfs = readFileSync(join(root, 'mkfs.log'), 'utf8');
    expect(mkfs).toContain('-E root_owner=1000:1000');
    // The data directory the store mounts is written into the image with
    // debugfs, mode 0750; a sandboxed builder cannot chown a staging tree.
    expect(mkfs).not.toContain('-d ');
    const debugfs = readFileSync(join(root, 'debugfs.log'), 'utf8');
    expect(debugfs).toContain('-w -R mkdir /data ');
    expect(debugfs).toContain('-w -R sif /data uid 1000 ');
    expect(debugfs).toContain('-w -R sif /data gid 1000 ');
    expect(debugfs).toContain('-w -R sif /data mode 040750 ');
    expect(existsSync(join(root, 'chown.log'))).toBe(false);
    const unit = readFileSync(join(root, 'install-root/etc/systemd/system', volumeUnit), 'utf8');
    expect(unit).toContain(`ExecStart=${volumeScript} 3G ${volumeImage} ${volumeDir}`);
    expect(first.systemctl).toContain(`enable ${volumeUnit}`);
    const collector = readFileSync(
      join(root, 'install-root/etc/systemd/system', collectorUnit),
      'utf8'
    );
    expect(collector).toContain(`ExecStart=${volumeScript} prepare ${volumeImage} ${volumeDir}`);
    expect(first.systemctl).toContain(`enable ${collectorUnit}`);
    expect(first.systemctl.indexOf(`enable ${collectorUnit}`)).toBeLessThan(
      first.systemctl.indexOf(`start ${mountUnit}`)
    );
    expect(first.systemctl).toContain(`start ${mountUnit}`);
    expect(existsSync(join(root, 'install-root', volumeDir, 'collector'))).toBe(true);
    const fstab = join(root, 'install-root/etc/fstab');
    expect(readFileSync(fstab, 'utf8').trim()).toBe(
      `${volumeImage} ${volumeDir} ext4 loop,nofail 0 0`
    );

    const second = install(root);
    expect(second.status, second.output).toBe(0);
    expect(readFileSync(fstab, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 120_000);

  it('retries collector preparation at boot after an ENOSPC failure without writing outside the mount', () => {
    const root = workspace('collector-boot');
    const installed = install(root, { failPrepare: true });
    expect(installed.status, installed.output).toBe(0);
    expect(installed.output).toContain('No space left on device');
    expect(installed.output).toContain(collectorUnit);
    const host = join(root, 'install-root');
    const mount = join(host, volumeDir);
    const collector = join(mount, 'collector');
    expect(existsSync(collector)).toBe(false);
    const execStart = readFileSync(join(host, 'etc/systemd/system', collectorUnit), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('ExecStart='))!
      .slice('ExecStart='.length);
    const [script, ...args] = execStart.split(' ').map((arg) =>
      arg.startsWith('/') ? join(host, arg) : arg
    );
    const bin = join(root, 'bin');
    const ownership = join(root, 'collector-chown.log');
    writeFake(join(bin, 'chown'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CHOWN_LOG"\n`);
    const boot = () =>
      spawnSync('sh', [script, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LIFEMODEL_INSTALL_ROOT: host,
          LOSETUP_LOG: join(root, 'losetup.log'),
          CHOWN_LOG: ownership,
        },
      });
    const retried = boot();
    expect(retried.status, `${retried.stdout}${retried.stderr}`).toBe(0);
    expect(statSync(collector).mode & 0o777).toBe(0o750);
    expect(readFileSync(ownership, 'utf8')).toContain(`0:0 ${collector}`);
    const repeated = boot();
    expect(repeated.status, `${repeated.stdout}${repeated.stderr}`).toBe(0);
    expect(statSync(collector).mode & 0o777).toBe(0o750);
    rmSync(collector, { recursive: true });
    rmSync(join(host, 'logs-mounted'));
    const unmounted = boot();
    expect(unmounted.status).not.toBe(0);
    expect(unmounted.stderr).toContain('requires the mounted log volume');
    expect(existsSync(collector)).toBe(false);
  }, 120_000);

  it('grows an existing image, refuses a smaller size and leaves an equal one alone', () => {
    const root = workspace('grow');
    const image = join(root, 'install-root/var/lib/lifemodel-logs.img');
    expect(install(root).status).toBe(0);
    expect(statSync(image).size).toBe(3 * 1024 ** 3);
    const grown = install(root, { size: '4G' });
    expect(grown.status, grown.output).toBe(0);
    expect(statSync(image).size).toBe(4 * 1024 ** 3);
    expect(readFileSync(join(root, 'fallocate.log'), 'utf8')).toContain('-l 4G');
    expect(readFileSync(join(root, 'resize2fs.log'), 'utf8')).toContain(image);
    // An equal size changes nothing at all.
    const allocated = readFileSync(join(root, 'fallocate.log'), 'utf8');
    expect(install(root, { size: '4G' }).status).toBe(0);
    expect(readFileSync(join(root, 'fallocate.log'), 'utf8')).toBe(allocated);
    // A smaller size is refused with both figures and never shrinks the image.
    const shrink = install(root, { size: '2G' });
    expect(shrink.status, shrink.output).not.toBe(0);
    expect(shrink.output).toContain('2G');
    expect(shrink.output).toContain('4096 MiB');
    expect(shrink.output).toContain('never shrunk');
    expect(statSync(image).size).toBe(4 * 1024 ** 3);
    // A mounted image is grown online through the loop device that carries it.
    const online = install(root, { size: '5G', loopDevice: '/dev/loop7' });
    expect(online.status, online.output).toBe(0);
    expect(statSync(image).size).toBe(5 * 1024 ** 3);
    expect(readFileSync(join(root, 'losetup.log'), 'utf8')).toContain('-c /dev/loop7');
    expect(readFileSync(join(root, 'resize2fs.log'), 'utf8')).toContain('/dev/loop7');
  }, 120_000);

  it('finishes a filesystem an interrupted resize left short of the image', () => {
    const root = workspace('reconcile');
    const image = join(root, 'install-root/var/lib/lifemodel-logs.img');
    const resized = join(root, 'resize2fs.log');
    expect(install(root).status).toBe(0);
    // fallocate enlarges the image before resize2fs runs, so a resize2fs that
    // failed or was interrupted leaves the image at its size and the
    // filesystem at the old one. The next run at the same size finishes it.
    truncateSync(image, 4 * 1024 ** 3);
    writeFileSync(join(root, 'fs-bytes'), String(3 * 1024 ** 3));
    const reconciled = install(root, { size: '4G' });
    expect(reconciled.status, reconciled.output).toBe(0);
    expect(existsSync(resized), 'a filesystem short of its image was not resized').toBe(true);
    expect(readFileSync(resized, 'utf8')).toContain(image);
    expect(readFileSync(join(root, 'fs-bytes'), 'utf8').trim()).toBe(String(4 * 1024 ** 3));
    // The run after it finds the filesystem filling the image and does nothing.
    const resizeCalls = readFileSync(resized, 'utf8');
    expect(install(root, { size: '4G' }).status).toBe(0);
    expect(readFileSync(resized, 'utf8')).toBe(resizeCalls);
  }, 120_000);

  function install(
    root: string,
    options: { size?: string; freeKb?: number; loopDevice?: string; failPrepare?: boolean } = {}
  ): { status: number | null; output: string; systemctl: string } {
    const bin = join(root, 'bin');
    const systemctlLog = join(root, 'systemctl.log');
    if (!existsSync(bin)) {
      mkdirSync(bin, { recursive: true });
      writeFake(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
      writeFake(
        join(bin, 'mkdir'),
        `#!/bin/sh
for arg do
  case "$arg" in
    */collector)
      if [ -f "$FAKE_PREPARE_FAILURE" ]; then
        rm -f "$FAKE_PREPARE_FAILURE"
        echo 'mkdir: No space left on device' >&2
        exit 1
      fi ;;
  esac
done
exec /bin/mkdir "$@"
`
      );
      writeFake(join(bin, 'id'), '#!/bin/sh\necho 0\n');
      writeFake(
        join(bin, 'node'),
        `#!/bin/sh\ncase "$1" in */wait-ready.mjs) exit 0 ;; */resolv-conf.mjs) if flock -n "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.lock" true; then echo "installer generator overlaps publication without lock" >&2; exit 73; fi ;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`
      );
      writeFake(join(bin, 'apt-get'), `#!/bin/sh\necho "$*" >> "$APT_LOG"\nexit 0\n`);
      writeFake(
        join(bin, 'ip'),
        `#!/bin/sh\nif [ "$1" = -j ]; then printf '%s\\n' '[{"dev":"eth0","metric":100}]'; else exit 1; fi\n`
      );
      // The image lives on the host's filesystem; the free space it reports
      // decides whether the requested size fits.
      writeFake(
        join(bin, 'df'),
        `#!/bin/sh
for arg do target=$arg; done
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf 'fakefs 100000000 1 %s 1%% %s\\n' "${'$'}{FAKE_FREE_KB:-67108864}" "$target"
`
      );
      writeFake(
        join(bin, 'fallocate'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FALLOCATE_LOG"
previous=""
for arg do
  if [ "$previous" = -l ]; then size=$arg; fi
  previous=$arg
  target=$arg
done
truncate -s "$size" "$target"
`
      );
      writeFake(
        join(bin, 'losetup'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$LOSETUP_LOG"
if [ "$1" = -j ] && { [ -n "$FAKE_LOOP_DEVICE" ] || [ -f "$LIFEMODEL_INSTALL_ROOT/logs-mounted" ]; }; then
  printf '%s: [1]:0 (%s)\\n' "${'$'}{FAKE_LOOP_DEVICE:-/dev/loop7}" "$2"
fi
exit 0
`
      );
      // The filesystem's size has a file of its own: dumpe2fs reads it, the
      // image's size when nothing wrote it yet, and resize2fs makes it the
      // image's size. A missed resize is a size left behind the image's.
      writeFake(
        join(bin, 'dumpe2fs'),
        `#!/bin/sh
for arg do target=$arg; done
if [ -f "$FAKE_FS_BYTES" ]; then bytes=$(cat "$FAKE_FS_BYTES"); else bytes=$(stat -c %s "$target"); fi
printf 'Block count:              %s\\n' "$(( bytes / 4096 ))"
printf 'Block size:               4096\\n'
`
      );
      writeFake(
        join(bin, 'resize2fs'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$RESIZE2FS_LOG"
stat -c %s "$FAKE_IMAGE" > "$FAKE_FS_BYTES"
`
      );
      writeFake(
        join(bin, 'mkfs.ext4'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$MKFS_LOG"
for arg do target=$arg; done
stat -c %s "$target" > "$FAKE_FS_BYTES"
`
      );
      writeFake(join(bin, 'debugfs'), debugfsFake);
      writeFake(join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
      writeFake(
        join(bin, 'findmnt'),
        `#!/bin/sh
[ -f "$LIFEMODEL_INSTALL_ROOT/logs-mounted" ] || exit 1
case "$*" in *FSTYPE*) echo ext4 ;; *) echo "${'$'}{FAKE_LOOP_DEVICE:-/dev/loop7}" ;; esac
`
      );
      writeFake(
        join(bin, 'systemctl'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
case "$*" in *'logs.mount') touch "$LIFEMODEL_INSTALL_ROOT/logs-mounted" ;; esac
if [ "$*" = 'start lifemodel-k3s-dns-apply.service' ]; then
  exec sh "$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel/k3s-dns-apply.sh" "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.conf" "$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel/resolv-conf.mjs" /etc/resolv.conf /run/systemd/resolve/resolv.conf
fi
exit 0
`
      );
      writeFake(
        join(bin, 'curl'),
        `#!/bin/sh\nfor arg do out=$arg; done\nprintf 'manifest' > "$out"\n`
      );
      writeFake(join(bin, 'sha256sum'), `#!/bin/sh\nread expected file\necho "$file: OK"\n`);
      writeFake(
        join(bin, 'k3s'),
        `#!/bin/sh
if [ "$1" = --version ]; then echo 'k3s version v1.35.8+k3s1'; exit 0; fi
if [ "$1" != kubectl ]; then echo "unexpected k3s call: $*" >&2; exit 64; fi
printf '%s\\n' "$*" >> "$K3S_CALLS"
case "$*" in
  *'get nodes'*) exit 0 ;;
  *'get deploy/coredns -o json'*) printf '%s' '{"metadata":{"generation":2},"status":{"observedGeneration":2}}'; exit 0 ;;
  *'get pods -l k8s-app=kube-dns -o json'*) printf '%s' '{"items":[{"metadata":{"creationTimestamp":"2999-01-01T00:00:00Z","labels":{"k8s-app":"kube-dns"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'; exit 0 ;;
  *'get namespace flux-system -o jsonpath='*) echo lifemodel ;;
  *'get namespace flux-system'*) exit 1 ;;
  *'get ocirepository platform'*) printf '{"metadata":{"managedFields":[]}}\\n' ;;
  *'get configmap lifemodel-instance -o jsonpath='*) echo '(NotFound)' >&2; exit 1 ;;
  *' -f -'*) cat >/dev/null ;;
esac
exit 0
`
      );
    }
    // Each invocation starts with the chosen offline/online resize scenario.
    // The fake mount is published only by systemctl later in that invocation.
    rmSync(join(root, 'install-root/logs-mounted'), { force: true });
    const previous = existsSync(systemctlLog) ? readFileSync(systemctlLog, 'utf8').length : 0;
    const args = [
      installer,
      '--platform-url',
      'oci://example.test/platform',
      '--tag',
      'v1.0.0',
      '--lan-interface',
      'eth0',
      '--root-templates',
      rootTemplates,
    ];
    if (options.size) args.push('--logs-volume-size', options.size);
    const prepareFailure = join(root, 'prepare-failure');
    if (options.failPrepare) writeFileSync(prepareFailure, '');
    const result = spawnSync('sh', args, {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        APT_LOG: join(root, 'apt.log'),
        SYSTEMCTL_LOG: systemctlLog,
        K3S_CALLS: join(root, 'k3s-calls.log'),
        FALLOCATE_LOG: join(root, 'fallocate.log'),
        MKFS_LOG: join(root, 'mkfs.log'),
        DEBUGFS_LOG: join(root, 'debugfs.log'),
        RESIZE2FS_LOG: join(root, 'resize2fs.log'),
        LOSETUP_LOG: join(root, 'losetup.log'),
        FAKE_LOOP_DEVICE: options.loopDevice ?? '',
        FAKE_FREE_KB: String(options.freeKb ?? 64 * 1024 * 1024),
        FAKE_IMAGE: join(root, 'install-root/var/lib/lifemodel-logs.img'),
        FAKE_PREPARE_FAILURE: prepareFailure,
        FAKE_FS_BYTES: join(root, 'fs-bytes'),
        LIFEMODEL_INSTALL_ROOT: join(root, 'install-root'),
        LIFEMODEL_STATE_DIR: join(root, 'state'),
        LIFEMODEL_INSTANCE_ENV: join(root, 'absent.env'),
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      systemctl: existsSync(systemctlLog) ? readFileSync(systemctlLog, 'utf8').slice(previous) : '',
    };
  }
});
