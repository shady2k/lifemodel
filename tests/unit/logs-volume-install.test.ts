import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    expect(unit).toContain(`ExecStart=${volumeScript} 3G`);
    expect(unit).toContain(`Before=${mountUnit} k3s.service`);
    expect(unit).toContain('DefaultDependencies=no');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).not.toMatch(/@[A-Z_]+@/);
    expect(readFileSync(join(out, 'fstab'), 'utf8').trim()).toBe(
      `${volumeImage} ${volumeDir} ext4 loop,nofail 0 0`
    );
  }, 120_000);

  it('renders a chosen size and refuses one below the 2G minimum with both figures', () => {
    const large = render(workspace('large'), '--logs-volume-size', '5G');
    expect(large.status, large.output).toBe(0);
    expect(readFileSync(join(large.out, 'systemd', volumeUnit), 'utf8')).toContain(
      `ExecStart=${volumeScript} 5G`
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
    expect(mkfs).toContain('-d ');
    // The data directory the store mounts is in the image, mode 0750.
    expect(readFileSync(join(root, 'mkfs-data.log'), 'utf8').trim()).toBe('750');
    expect(readFileSync(join(root, 'chown.log'), 'utf8')).toMatch(/1000:1000 .*\/data\n/);
    const unit = readFileSync(
      join(root, 'install-root/etc/systemd/system', volumeUnit),
      'utf8'
    );
    expect(unit).toContain(`ExecStart=${volumeScript} 3G`);
    expect(first.systemctl).toContain(`enable ${volumeUnit}`);
    expect(first.systemctl).toContain(`start ${mountUnit}`);
    const fstab = join(root, 'install-root/etc/fstab');
    expect(readFileSync(fstab, 'utf8').trim()).toBe(
      `${volumeImage} ${volumeDir} ext4 loop,nofail 0 0`
    );

    const second = install(root);
    expect(second.status, second.output).toBe(0);
    expect(readFileSync(fstab, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 120_000);

  function install(
    root: string,
    options: { size?: string; freeKb?: number } = {}
  ): { status: number | null; output: string; systemctl: string } {
    const bin = join(root, 'bin');
    const systemctlLog = join(root, 'systemctl.log');
    if (!existsSync(bin)) {
      mkdirSync(bin, { recursive: true });
      writeFake(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
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
for arg do target=$arg; done
: > "$target"
`
      );
      writeFake(
        join(bin, 'mkfs.ext4'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$MKFS_LOG"
previous=""
for arg do
  if [ "$previous" = -d ]; then stat -c '%a' "$arg/data" >> "$MKFS_DATA_LOG"; fi
  previous=$arg
done
exit 0
`
      );
      writeFake(join(bin, 'chown'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CHOWN_LOG"\nexit 0\n`);
      writeFake(
        join(bin, 'systemctl'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
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
    const previous = existsSync(systemctlLog) ? readFileSync(systemctlLog, 'utf8').length : 0;
    const args = [installer, '--platform-url', 'oci://example.test/platform', '--tag', 'v1.0.0', '--lan-interface', 'eth0', '--root-templates', rootTemplates];
    if (options.size) args.push('--logs-volume-size', options.size);
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
        MKFS_DATA_LOG: join(root, 'mkfs-data.log'),
        CHOWN_LOG: join(root, 'chown.log'),
        FAKE_FREE_KB: String(options.freeKb ?? 64 * 1024 * 1024),
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
