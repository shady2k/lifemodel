import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));
const rootTemplates = fileURLToPath(new URL('../../deploy/root/', import.meta.url));
const resolvDir = fileURLToPath(new URL('../../deploy/k3s/', import.meta.url));
const resolvConf = '/run/lifemodel/k3s-resolv.conf';
const resolvScript = '/usr/lib/lifemodel/k3s-resolv.sh';
const resolvGenerator = '/usr/lib/lifemodel/resolv-conf.mjs';

// The host's /etc/resolv.conf differs per machine (Docker answers on
// 127.0.0.11), so the assertions here are about what must hold everywhere and
// the fixtures below pin the filtering itself.
const hostResolvConf = readFileSync('/etc/resolv.conf', 'utf8');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `k3s-resolv-${name}-`));
  roots.push(root);
  return root;
}

describe('the installer hands k3s a resolv.conf it accepts', () => {
  function render(): { root: string; out: string; status: number | null; output: string } {
    const root = workspace('render');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFake(join(bin, 'ip'), `#!/bin/sh\nif [ "$1" = -j ]; then printf '%s\\n' '[{"dev":"eth0","metric":100}]'; else exit 1; fi\n`);
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
    return { root, out, status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('renders the unit, the k3s drop-in and the scripts it installs', () => {
    const { out, status, output } = render();
    expect(status, output).toBe(0);
    const unit = readFileSync(join(out, 'systemd/lifemodel-k3s-resolv.service'), 'utf8');
    // k3s reads the file this unit writes, so the unit has to run first.
    expect(unit).toContain('Before=k3s.service');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart=/usr/lib/lifemodel/k3s-resolv.sh /usr/lib/lifemodel/resolv-conf.mjs ' +
        '/run/lifemodel/k3s-resolv.conf /etc/resolv.conf /run/systemd/resolve/resolv.conf'
    );
    // Enabled, so it runs at boot before k3s: /run is empty then.
    expect(unit).toContain('WantedBy=multi-user.target');
    const pathUnit = readFileSync(join(out, 'systemd/lifemodel-k3s-resolv.path'), 'utf8');
    expect(pathUnit).toContain('PathChanged=/etc/resolv.conf');
    expect(pathUnit).toContain('PathChanged=/run/systemd/resolve/resolv.conf');
    expect(pathUnit).toContain('Unit=lifemodel-k3s-resolv.service');
    expect(readFileSync(join(out, 'k3s/config.yaml.d/lifemodel-resolv-conf.yaml'), 'utf8'))
      .toContain(`resolv-conf: ${resolvConf}`);
    // The rendered scripts are the ones the repository ships, executable.
    for (const name of ['resolv-conf.mjs', 'k3s-resolv.sh']) {
      const rendered = join(out, 'resolv', name);
      expect(readFileSync(rendered)).toEqual(readFileSync(join(resolvDir, name)));
      expect(statSync(rendered).mode & 0o111, name).not.toBe(0);
    }
    expect(`${unit}${pathUnit}`).not.toMatch(/@RESOLV/);
  }, 120_000);

  it('writes the file k3s reads before k3s starts, and installs what the units name', () => {
    const root = workspace('install');
    const first = install(root);
    expect(first.status, first.output).toBe(0);
    const installed = join(root, 'install-root', 'usr/lib/lifemodel');
    for (const name of ['k3s-resolv.sh', 'resolv-conf.mjs']) {
      expect(statSync(join(installed, name)).mode & 0o111, name).not.toBe(0);
    }
    const unit = readFileSync(
      join(root, 'install-root/etc/systemd/system/lifemodel-k3s-resolv.service'),
      'utf8'
    );
    expect(unit).toContain(
      `ExecStart=${resolvScript} ${resolvGenerator} ${resolvConf} ` +
        '/etc/resolv.conf /run/systemd/resolve/resolv.conf'
    );
    expect(
      readFileSync(join(root, 'install-root/etc/rancher/k3s/config.yaml.d/lifemodel-resolv-conf.yaml'), 'utf8')
    ).toContain(`resolv-conf: ${resolvConf}`);
    // k3s reads it once, at start: an installation that was already running does
    // not take the drop-in until it is restarted, and the pods that copied the
    // old nameservers are recreated with it.
    expect(first.systemctl).toContain('restart k3s.service');
    // The service has to run at every boot, before k3s: /run is empty then.
    expect(first.systemctl).toContain('enable lifemodel-k3s-resolv.service');
    expect(first.systemctl).toContain('enable --now lifemodel-k3s-resolv.path');

    const written = readFileSync(join(root, 'install-root', resolvConf), 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    const nameservers = written.split('\n').filter((line) => line.startsWith('nameserver '));
    expect(nameservers.length).toBeGreaterThan(0);
    for (const line of nameservers) {
      const address = line.slice('nameserver '.length).trim();
      expect(address, `k3s would reject ${line}`).not.toBe('');
      expect(address.startsWith('127.'), line).toBe(false);
      expect(address === '::1', line).toBe(false);
      expect(address.startsWith('fe80:'), line).toBe(false);
    }

    // The installed pair filters a host file the way the cluster needs.
    const fixture = join(root, 'fixture.conf');
    writeFileSync(
      fixture,
      '# dhcpcd\nnameserver 192.168.0.30\nnameserver fe80::1a2b:c3ff:fe4d:5e6f%ens18\nsearch inside.shady2k.ru\n'
    );
    const target = join(root, 'applied/k3s-resolv.conf');
    const applied = spawnSync(
      'sh',
      [join(installed, 'k3s-resolv.sh'), join(installed, 'resolv-conf.mjs'), target, fixture],
      { encoding: 'utf8', timeout: 10_000, env: fakeEnv(root, { active: true }) }
    );
    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(
      '# dhcpcd\nnameserver 192.168.0.30\nsearch inside.shady2k.ru\n'
    );
    expect(readFileSync(join(root, 'k3s.log'), 'utf8')).toContain(
      'kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n kube-system delete pod -l k8s-app=kube-dns --wait=false'
    );

    // A second install of the same host changes nothing and restarts nothing.
    const second = install(root);
    expect(second.status, second.output).toBe(0);
    expect(second.systemctl).not.toContain('restart k3s.service');
    expect(second.systemctl).toContain('enable --now lifemodel-k3s-resolv.path');
  }, 120_000);

  function writeFake(path: string, body: string): void {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  function fakeEnv(root: string, options: { active?: boolean } = {}): NodeJS.ProcessEnv {
    const bin = join(root, 'unit-bin');
    if (!existsSync(join(bin, 'systemctl'))) {
      mkdirSync(bin, { recursive: true });
      writeFake(
        join(bin, 'systemctl'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"\ncase "$*" in\n  *is-active*) [ "$K3S_ACTIVE" = 1 ] && exit 0 || exit 3 ;;\nesac\nexit 0\n`
      );
      writeFake(
        join(bin, 'k3s'),
        `#!/bin/sh\nprintf 'k3s %s\\n' "$*" >> "$K3S_LOG"\nexit 0\n`
      );
    }
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SYSTEMCTL_LOG: join(root, 'unit-systemctl.log'),
      K3S_LOG: join(root, 'k3s.log'),
      K3S_ACTIVE: options.active ? '1' : '0',
    };
  }

  // The installer's own path, with only the host commands it shells out to
  // faked: the real script, the real templates and the real resolv.conf filter.
  function install(root: string): { status: number | null; output: string; calls: string; systemctl: string } {
    const bin = join(root, 'bin');
    const systemctlLog = join(root, 'systemctl.log');
    const callsLog = join(root, 'k3s-calls.log');
    if (!existsSync(bin)) {
      mkdirSync(bin, { recursive: true });
      writeFake(join(bin, 'id'), `#!/bin/sh\necho 0\n`);
      writeFake(
        join(bin, 'node'),
        `#!/bin/sh\ncase "$1" in */wait-ready.mjs) exit 0 ;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`
      );
      writeFake(join(bin, 'apt-get'), `#!/bin/sh\necho "$*" >> "$APT_LOG"\nexit 0\n`);
      writeFake(
        join(bin, 'ip'),
        `#!/bin/sh\nif [ "$1" = -j ]; then printf '%s\\n' '[{"dev":"eth0","metric":100}]'; else exit 1; fi\n`
      );
      writeFake(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"\nexit 0\n`);
      writeFake(join(bin, 'curl'), `#!/bin/sh\nfor arg do out=$arg; done\nprintf 'manifest' > "$out"\n`);
      writeFake(join(bin, 'sha256sum'), `#!/bin/sh\nread expected file\necho "$file: OK"\n`);
      writeFake(
        join(bin, 'k3s'),
        `#!/bin/sh
if [ "$1" = --version ]; then echo 'k3s version v1.35.8+k3s1'; exit 0; fi
if [ "$1" != kubectl ]; then echo "unexpected k3s call: $*" >&2; exit 64; fi
printf '%s\\n' "$*" >> "$K3S_CALLS"
case "$*" in
  *'get nodes'*) exit 0 ;;
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
    const previousCalls = existsSync(callsLog) ? readFileSync(callsLog, 'utf8').length : 0;
    const result = spawnSync(
      'sh',
      [installer, '--platform-url', 'oci://example.test/platform', '--tag', 'v1.0.0', '--lan-interface', 'eth0', '--root-templates', rootTemplates],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          APT_LOG: join(root, 'apt.log'),
          SYSTEMCTL_LOG: systemctlLog,
          K3S_CALLS: callsLog,
          LIFEMODEL_INSTALL_ROOT: join(root, 'install-root'),
          LIFEMODEL_STATE_DIR: join(root, 'state'),
          LIFEMODEL_INSTANCE_ENV: join(root, 'absent.env'),
        },
      }
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      systemctl: existsSync(systemctlLog) ? readFileSync(systemctlLog, 'utf8').slice(previous) : '',
      calls: existsSync(callsLog) ? readFileSync(callsLog, 'utf8').slice(previousCalls) : '',
    };
  }
});
