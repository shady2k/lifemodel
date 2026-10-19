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
    expect(unit).not.toContain('network-online.target');
    expect(unit).toContain('TimeoutStartSec=30');
    const prerequisite = readFileSync(
      join(out, 'systemd/k3s.service.d/lifemodel-resolv.conf'),
      'utf8'
    );
    expect(prerequisite).toContain('Requires=lifemodel-k3s-resolv.service');
    expect(prerequisite).toContain('After=lifemodel-k3s-resolv.service');
    expect(prerequisite).toContain('ExecStartPre=/usr/bin/test -s /run/lifemodel/k3s-resolv.conf');
    const apply = readFileSync(join(out, 'systemd/lifemodel-k3s-dns-apply.service'), 'utf8');
    expect(apply).toContain('After=k3s.service');
    expect(apply).toContain('TimeoutStartSec=180');
    expect(apply).toContain('Restart=on-failure');
    expect(apply).toContain('RestartSec=30');
    expect(apply).toContain('WantedBy=multi-user.target');
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
    expect(
      readFileSync(join(out, 'k3s/config.yaml.d/lifemodel-resolv-conf.yaml'), 'utf8')
    ).toContain(`resolv-conf: ${resolvConf}`);
    // The rendered scripts are the ones the repository ships, executable.
    for (const name of ['resolv-conf.mjs', 'k3s-resolv.sh', 'k3s-dns-apply.sh']) {
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
    for (const name of ['k3s-resolv.sh', 'resolv-conf.mjs', 'k3s-dns-apply.sh']) {
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
      readFileSync(
        join(root, 'install-root/etc/rancher/k3s/config.yaml.d/lifemodel-resolv-conf.yaml'),
        'utf8'
      )
    ).toContain(`resolv-conf: ${resolvConf}`);
    // k3s reads it once, at start: an installation that was already running does
    // not take the drop-in until it is restarted, and the pods that copied the
    // old nameservers are recreated with it.
    expect(first.systemctl).toContain('restart k3s.service');
    expect(first.systemctl).toContain('start lifemodel-k3s-dns-apply.service');
    expect(first.systemctl.indexOf('start lifemodel-k3s-dns-apply.service')).toBeGreaterThan(
      first.systemctl.indexOf('restart k3s.service')
    );
    expect(first.calls).toContain('rollout restart deploy/coredns -n kube-system');
    expect(existsSync(join(root, 'install-root/run/lifemodel/k3s-resolv.applied'))).toBe(true);
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

    // A second install of the same host changes nothing and restarts nothing.
    const second = install(root);
    expect(second.status, second.output).toBe(0);
    expect(second.systemctl).not.toContain('restart k3s.service');
    expect(second.systemctl).toContain('enable --now lifemodel-k3s-resolv.path');
  }, 120_000);

  it.each([
    'etc/systemd/system/k3s.service.d/lifemodel-resolv.conf',
    'etc/rancher/k3s/config.yaml.d/lifemodel-resolv-conf.yaml',
  ])(
    'restarts exactly once on a drop-in-only upgrade (%s), then zero times unchanged',
    (relativeDropin) => {
      const root = workspace('dropin-upgrade');
      expect(install(root).status).toBe(0);
      const resolver = join(root, 'install-root', resolvConf);
      const before = readFileSync(resolver);
      const dropin = join(root, 'install-root', relativeDropin);
      writeFileSync(dropin, '# previous installation without prerequisites\n');
      const upgrade = install(root);
      expect(upgrade.status, upgrade.output).toBe(0);
      expect(readFileSync(resolver)).toEqual(before);
      expect(
        upgrade.systemctl.split('\n').filter((call) => call === 'restart k3s.service')
      ).toHaveLength(1);
      const unchanged = install(root);
      expect(unchanged.status, unchanged.output).toBe(0);
      expect(unchanged.systemctl).not.toContain('restart k3s.service');
    },
    120_000
  );

  it('waits through a failed first apply and a successful retry within the installer bound', () => {
    const root = workspace('retry-install');
    mkdirSync(join(root, 'install-root'), { recursive: true });
    writeFileSync(join(root, 'install-root/fail-apply-once'), '');
    const installed = install(root);
    expect(installed.status, installed.output).toBe(0);
    expect(
      installed.systemctl
        .split('\n')
        .filter((call) => call === 'start lifemodel-k3s-dns-apply.service')
    ).toHaveLength(2);
    expect(existsSync(join(root, 'install-root/run/lifemodel/k3s-resolv.applied'))).toBe(true);
  }, 120_000);

  function writeFake(path: string, body: string): void {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  // The installer's own path, with only the host commands it shells out to
  // faked: the real script, the real templates and the real resolv.conf filter.
  function install(root: string): {
    status: number | null;
    output: string;
    calls: string;
    systemctl: string;
  } {
    const bin = join(root, 'bin');
    const systemctlLog = join(root, 'systemctl.log');
    const callsLog = join(root, 'k3s-calls.log');
    if (!existsSync(bin)) {
      mkdirSync(bin, { recursive: true });
      writeFake(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
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
      writeFake(
        join(bin, 'systemctl'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$*" = 'start lifemodel-k3s-dns-apply.service' ]; then
  if [ -f "$LIFEMODEL_INSTALL_ROOT/fail-apply-once" ]; then rm "$LIFEMODEL_INSTALL_ROOT/fail-apply-once"; exit 1; fi
  exec sh "$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel/k3s-dns-apply.sh" "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.conf"
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
  *'exec deploy/coredns -- cat /etc/resolv.conf'*) cat "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.conf" ;;
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
      [
        installer,
        '--platform-url',
        'oci://example.test/platform',
        '--tag',
        'v1.0.0',
        '--lan-interface',
        'eth0',
        '--root-templates',
        rootTemplates,
      ],
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
