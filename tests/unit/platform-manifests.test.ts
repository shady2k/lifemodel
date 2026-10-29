import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const platformRoot = fileURLToPath(new URL('../../deploy/platform/', import.meta.url));
const installer = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));
const rootTemplates = fileURLToPath(new URL('../../deploy/root/', import.meta.url));
const customOCI = fileURLToPath(
  new URL('../fixtures/nixos/custom-ocirepository.yaml', import.meta.url)
);

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? yamlFiles(path) : entry.name.endsWith('.yaml') ? [path] : [];
  });
}

function parseYamlFiles(files: string[]): Record<string, any>[] {
  return files.flatMap((file) => {
    const documents = YAML.parseAllDocuments(readFileSync(file, 'utf8'));
    expect(documents.flatMap((document) => document.errors)).toEqual([]);
    return documents.map((document) => document.toJSON() as Record<string, any>);
  });
}

function sourceObjects(): Record<string, any>[] {
  // Helm chart templates are Go templates, not standalone Kubernetes YAML.
  // Render the vendored chart in the Nix platform check instead.
  return parseYamlFiles(
    yamlFiles(platformRoot).filter(
      (file) =>
        !file.includes('/charts/') &&
        !file.endsWith('kustomization.yaml') &&
        !file.endsWith('/b/operator/rendered.yaml')
    )
  );
}

function object(objects: Record<string, any>[], kind: string): Record<string, any> {
  const found = objects.find((item) => item.kind === kind);
  expect(found, `missing ${kind}`).toBeDefined();
  return found!;
}

function assertRestrictedNamespace(namespace: Record<string, any>): void {
  for (const level of ['enforce', 'audit', 'warn']) {
    if (namespace.metadata?.labels?.[`pod-security.kubernetes.io/${level}`] !== 'restricted') {
      throw new Error(`namespace is missing restricted ${level} label`);
    }
  }
}

function assertAllowedPolicyPorts(policy: Record<string, any>, allowed: number[]): void {
  const ports = [...(policy.spec?.ingress ?? []), ...(policy.spec?.egress ?? [])]
    .flatMap((rule: any) => rule.ports ?? [])
    .map((port: any) => port.port);
  if (JSON.stringify(ports) !== JSON.stringify(allowed))
    throw new Error('NetworkPolicy ports differ from allowlist');
}

function assertRestrictedContainers(podSpec: Record<string, any>): void {
  const pod = podSpec.securityContext ?? {};
  if (pod.runAsNonRoot !== true)
    throw new Error('pod security context is not restricted-compatible');
  for (const container of [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])]) {
    const context = container.securityContext ?? {};
    const seccompType = (context.seccompProfile ?? pod.seccompProfile)?.type;
    const runAsUser = context.runAsUser ?? pod.runAsUser;
    if (
      (context.runAsNonRoot ?? pod.runAsNonRoot) !== true ||
      runAsUser === 0 ||
      context.privileged === true ||
      context.allowPrivilegeEscalation !== false ||
      (context.capabilities?.add?.length ?? 0) > 0 ||
      context.capabilities?.drop?.includes('ALL') !== true ||
      !['RuntimeDefault', 'Localhost'].includes(seccompType)
    ) {
      throw new Error(`container ${container.name} is not restricted-compatible`);
    }
  }
}

function assertStepANetworkPolicies(objects: Record<string, any>[]): void {
  const expected = {
    openbao: ['openbao-default-deny', 'openbao-server-access'],
    'lifemodel-git': ['gitea-default-deny'],
    // The namespace default deny, the loader's own permits and the model
    // gateway's own routes: three separate objects (ADR-013 D5).
    'lifemodel-system': [
      'lifemodel-system-default-deny',
      'loader-access',
      'zot-access',
      'loader-download-auth-ingress',
      'model-gateway-access',
      'seaweedfs-access',
      'storage-module-access',
      'task-model-ingress',
    ],
  };
  for (const [namespace, names] of Object.entries(expected)) {
    const actual = objects
      .filter((item) => item.kind === 'NetworkPolicy' && item.metadata?.namespace === namespace)
      .map((item) => item.metadata.name)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) {
      throw new Error(`NetworkPolicy inventory differs in ${namespace}`);
    }
  }
}

function runInstallerHarness(
  failFlux: boolean,
  foreign = false,
  existingRoot?: string,
  tag = 'v1.0.0',
  options: {
    unsupportedNode?: boolean;
    metacharState?: boolean;
    digest?: string;
    owner?: string;
    sourceDir?: string;
    avahiConfig?: string;
    ufwActive?: boolean;
    name?: string;
    savedRelease?: boolean;
  } = {}
): { status: number | null; output: string; root: string } {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'lifemodel-installer-test-'));
  const bin = join(root, 'bin');
  const state = join(root, 'namespace-state');
  const log = join(root, 'kubectl.log');
  if (foreign && !existingRoot) writeFileSync(state, 'foreign');
  mkdirSync(bin, { recursive: true });
  const command = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  command('id', 'echo 0');
  if (options.unsupportedNode) command('node', 'echo 14');
  else
    command(
      'node',
      `case "$1" in */wait-ready.mjs) exit 0;; esac
exec ${JSON.stringify(process.execPath)} "$@"`
    );
  command(
    'k3s',
    `if [ "$1" = --version ]; then echo 'k3s version v1.35.8+k3s1'; exit 0; fi
if [ "$1" != kubectl ] || [ "$2" != --kubeconfig ]; then
  printf 'fake k3s rejected argv:' >&2
  printf ' <%s>' "$@" >&2
  printf '\n' >&2
  exit 64
fi
shift 3
printf '%s\n' "$*" >> "$K3S_CALLS"
case "$*" in
  *'get nodes'*) exit 0 ;;
  *'get deploy/coredns -o json'*) printf '%s' '{"metadata":{"generation":2},"status":{"observedGeneration":2}}'; exit 0 ;;
  *'get pods -l k8s-app=kube-dns -o json'*) printf '%s' '{"items":[{"metadata":{"creationTimestamp":"2999-01-01T00:00:00Z","labels":{"k8s-app":"kube-dns"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'; exit 0 ;;
  *'get --raw=/readyz'*|*'rollout restart deploy/coredns'*|*'rollout status deploy/coredns'*) exit 0 ;;
  *'get ocirepository platform'*) printf '{"metadata":{"managedFields":[%s]}}\n' "$K3S_MANAGED_FIELDS" ;;
  *'get configmap lifemodel-instance -o jsonpath='*) [ -f "$K3S_IDENTITY" ] && cat "$K3S_IDENTITY" || { echo '(NotFound)' >&2; exit 1; } ;;
  *'get namespace flux-system -o jsonpath='*) [ "$K3S_FOREIGN" = 1 ] && echo external || echo lifemodel ;;
  *'get namespace flux-system'*) [ -f "$K3S_STATE" ] ;;
  *'--field-manager=lifemodel-namespace'*) cat >/dev/null; echo namespace >> "$K3S_LOG"; touch "$K3S_STATE" ;;
  *'--field-manager=lifemodel-bootstrap'*)
    file=''; for arg do file=$arg; done
    echo "root:$*" >> "$K3S_LOG"
    if grep 'tag:' "$file" >/dev/null; then rm -f "$K3S_APPLIED_REF"; grep 'tag:' "$file" | sed -E "s/.*tag: //; s/[\\\"']//g" > "$K3S_APPLIED_TAG"; fi
    if grep 'digest:' "$file" >/dev/null; then rm -f "$K3S_APPLIED_TAG"; grep 'digest:' "$file" > "$K3S_APPLIED_REF"; fi
    ;;
  *' -f -'*) cat >/dev/null ;;
  *) echo "flux:$*" >> "$K3S_LOG"; if [ "$K3S_FAIL_FLUX" = 1 ] && [ "$(grep -c '^flux:' "$K3S_LOG")" -eq 1 ]; then exit 42; fi ;;
esac`
  );
  command('apt-get', 'echo "$*" >> "$APT_LOG"; exit 0');
  command('ip', `if [ "$1" = -j ]; then printf '%s\n' "$ROUTES"; else exit 0; fi`);
  command(
    'systemctl',
    `echo "$*" >> "$SYSTEMCTL_LOG"
if [ "$*" = 'start lifemodel-k3s-dns-apply.service' ]; then
  exec sh "$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel/k3s-dns-apply.sh" "$LIFEMODEL_INSTALL_ROOT/run/lifemodel/k3s-resolv.conf" "$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel/resolv-conf.mjs" /etc/resolv.conf /run/systemd/resolve/resolv.conf
fi
exit 0`
  );
  command(
    'ufw',
    `if [ "$1" = status ]; then echo Status: ${options.ufwActive ? 'active' : 'inactive'}; else echo "$*" >> "$UFW_LOG"; fi`
  );
  command('curl', 'for arg do output=$arg; done; printf manifest > "$output"');
  command('sha256sum', 'read expected file; echo "$file: OK"');
  if (options.avahiConfig) {
    mkdirSync(join(root, 'install-root/etc/avahi'), { recursive: true });
    writeFileSync(join(root, 'install-root/etc/avahi/avahi-daemon.conf'), options.avahiConfig);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ROUTES: '[{\"dev\":\"eth0\",\"metric\":100}]',
    APT_LOG: join(root, 'apt.log'),
    K3S_CALLS: join(root, 'kubectl-calls.log'),
    K3S_STATE: state,
    K3S_IDENTITY: join(root, 'instance-name'),
    K3S_LOG: log,
    K3S_APPLIED_TAG: join(root, 'applied-tag'),
    K3S_APPLIED_REF: join(root, 'applied-ref'),
    K3S_FAIL_FLUX: failFlux ? '1' : '0',
    K3S_FOREIGN: foreign ? '1' : '0',
    UFW_LOG: join(root, 'ufw.log'),
    SYSTEMCTL_LOG: join(root, 'systemctl.log'),
    K3S_MANAGED_FIELDS: options.owner
      ? `{\"manager\":\"${options.owner}\",\"fieldsV1\":{\"f:spec\":{\"f:ref\":{\"f:tag\":{}}}}}`
      : '',
    LIFEMODEL_INSTALL_ROOT: join(root, 'install-root'),
    LIFEMODEL_STATE_DIR: options.metacharState
      ? join(root, 'state $(touch SHOULD_NOT_EXIST) `echo nope`')
      : join(root, 'state'),
  };
  delete (env as NodeJS.ProcessEnv).KUBECONFIG;
  const refArgs = options.savedRelease
    ? []
    : options.digest
      ? ['--digest', options.digest]
      : ['--tag', tag];
  const installScript = options.sourceDir
    ? join(options.sourceDir, 'scripts/install.sh')
    : installer;
  const templates = options.sourceDir ? join(options.sourceDir, 'deploy/root') : rootTemplates;
  const result = spawnSync(
    'sh',
    [
      installScript,
      ...(options.savedRelease ? [] : ['--platform-url', 'oci://example.test/platform']),
      ...refArgs,
      ...(options.name ? ['--name', options.name] : []),
      '--root-templates',
      templates,
      '--lan-interface',
      'eth0',
    ],
    { encoding: 'utf8', env, timeout: 30000 }
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}`, root };
}

describe('platform manifests', () => {
  // Snapshot actual host files, package/service/firewall logs and release state.
  // Read-only cluster identity discovery is asserted separately below.
  function hostSnapshot(root: string): Record<string, string> {
    const files = [
      'apt.log',
      'systemctl.log',
      'ufw.log',
      'kubectl.log',
      'applied-tag',
      'applied-ref',
    ];
    for (const directory of ['install-root', 'state']) {
      const walk = (relative: string): void => {
        if (!existsSync(join(root, relative))) return;
        for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
          const child = join(relative, entry.name);
          if (entry.isDirectory()) walk(child);
          else files.push(child);
        }
      };
      walk(directory);
    }
    return Object.fromEntries(
      files
        .sort()
        .filter((file) => existsSync(join(root, file)))
        .map((file) => [file, readFileSync(join(root, file)).toString('base64')])
    );
  }

  it('review: never executes shell syntax from a saved installer record', () => {
    const first = runInstallerHarness(false, false);
    try {
      expect(first.status, first.output).toBe(0);
      const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
      const marker = join(first.root, 'injected');
      writeFileSync(
        envPath,
        `LIFEMODEL_NAME=$(touch "${marker}"; printf lifemodel)\nLIFEMODEL_PLATFORM_URL='oci://example.test/platform'\nLIFEMODEL_PLATFORM_TAG='v1.0.0'\n`
      );
      runInstallerHarness(false, false, first.root, 'unused', { savedRelease: true });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });
  it('review: refuses a changed name before host changes if only established state survives', () => {
    const first = runInstallerHarness(false, false, undefined, 'v1.0.0', { name: 'home' });
    try {
      expect(first.status, first.output).toBe(0);
      rmSync(join(first.root, 'install-root/etc/lifemodel/instance.env'));
      const before = readFileSync(join(first.root, 'systemctl.log'), 'utf8');
      const second = runInstallerHarness(false, false, first.root, 'v1.0.0', { name: 'other' });
      expect(second.status).not.toBe(0);
      expect(second.output).toContain('instance name is fixed as home');
      expect(readFileSync(join(first.root, 'systemctl.log'), 'utf8')).toBe(before);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it.each(['local', 'cluster'])(
    'refuses another name before any host write with only %s identity surviving',
    (source) => {
      const first = runInstallerHarness(false, false, undefined, 'unused', {
        name: 'home',
        digest: `sha256:${'a'.repeat(64)}`,
        ufwActive: true,
      });
      try {
        expect(first.status, first.output).toBe(0);
        const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
        rmSync(envPath);
        if (source === 'cluster') {
          rmSync(join(first.root, 'state/instance-name'));
          writeFileSync(join(first.root, 'instance-name'), 'home');
        }
        const before = hostSnapshot(first.root);
        const calls = readFileSync(join(first.root, 'kubectl-calls.log'), 'utf8');
        const second = runInstallerHarness(false, false, first.root, 'unused', {
          name: 'other',
          digest: `sha256:${'b'.repeat(64)}`,
          ufwActive: true,
        });
        expect(second.status, second.output).not.toBe(0);
        expect(second.output).toContain('instance name is fixed as home');
        expect(existsSync(envPath)).toBe(false);
        expect(hostSnapshot(first.root)).toEqual(before);
        expect(readFileSync(join(first.root, 'kubectl-calls.log'), 'utf8')).toBe(
          calls +
            (source === 'cluster'
              ? '--request-timeout=10s -n flux-system get configmap lifemodel-instance -o jsonpath={.data.LIFEMODEL_NAME}\n'
              : '')
        );
      } finally {
        rmSync(first.root, { recursive: true, force: true });
      }
    }
  );

  it.each(['local', 'cluster'])(
    'recovers the established %s identity on a default-name rerun',
    (source) => {
      const first = runInstallerHarness(false, false, undefined, 'v1.0.0', { name: 'home' });
      try {
        expect(first.status, first.output).toBe(0);
        const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
        rmSync(envPath);
        if (source === 'cluster') {
          rmSync(join(first.root, 'state/instance-name'));
          writeFileSync(join(first.root, 'instance-name'), 'home');
        }
        const second = runInstallerHarness(false, false, first.root);
        expect(second.status, second.output).toBe(0);
        expect(readFileSync(envPath, 'utf8')).toContain("LIFEMODEL_NAME='home'");
      } finally {
        rmSync(first.root, { recursive: true, force: true });
      }
    }
  );

  it.each(['local', 'cluster'])(
    'refuses conflicting %s identity even when the env record survives',
    (source) => {
      const first = runInstallerHarness(false, false, undefined, 'v1.0.0', {
        name: 'home',
        ufwActive: true,
      });
      try {
        expect(first.status, first.output).toBe(0);
        writeFileSync(
          join(first.root, source === 'local' ? 'state/instance-name' : 'instance-name'),
          'other'
        );
        const before = hostSnapshot(first.root);
        const second = runInstallerHarness(false, false, first.root, 'unused', {
          savedRelease: true,
          ufwActive: true,
        });
        expect(second.status, second.output).not.toBe(0);
        expect(second.output).toContain('instance name is fixed');
        expect(hostSnapshot(first.root)).toEqual(before);
      } finally {
        rmSync(first.root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "UNKNOWN='value'\n",
    "LIFEMODEL_NAME='home'\n",
    "LIFEMODEL_PLATFORM_TAG='unterminated\n",
    'LIFEMODEL_PLATFORM_TAG=`printf v1`\n',
    'LIFEMODEL_PLATFORM_TAG=$HOME\n',
    "LIFEMODEL_PLATFORM_TAG='v1'; touch marker\n",
    "LIFEMODEL_PLATFORM_DIGEST='sha256:bad'\n",
    "LIFEMODEL_PLATFORM_URL='https://bad&url'\n",
    "LIFEMODEL_NAME='Bad'\n",
  ])(
    'rejects malformed saved records before writes, including when release flags override them: %j',
    (line) => {
      const first = runInstallerHarness(false, false);
      try {
        expect(first.status, first.output).toBe(0);
        const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
        writeFileSync(envPath, readFileSync(envPath, 'utf8') + line);
        const before = hostSnapshot(first.root);
        const second = runInstallerHarness(false, false, first.root);
        expect(second.status, second.output).not.toBe(0);
        expect(hostSnapshot(first.root)).toEqual(before);
      } finally {
        rmSync(first.root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['LIFEMODEL_NAME', "'Bad'"],
    ['LIFEMODEL_NAME', "''"],
    ['LIFEMODEL_NAME', "'null'"],
    ['LIFEMODEL_PLATFORM_URL', "'https://bad&url'"],
    ['LIFEMODEL_PLATFORM_URL', "''"],
    ['LIFEMODEL_PLATFORM_TAG', "'v1;touch marker'"],
    ['LIFEMODEL_PLATFORM_TAG', "'unterminated"],
    ['LIFEMODEL_PLATFORM_TAG', '`printf v1`'],
    ['LIFEMODEL_PLATFORM_TAG', '$HOME'],
    ['LIFEMODEL_PLATFORM_TAG', "'v1' trailing"],
    ['LIFEMODEL_PLATFORM_TAG', '"v1"'],
    ['LIFEMODEL_PLATFORM_TAG', "''"],
  ])('validates saved value %s=%s even with an explicit release override', (key, value) => {
    const first = runInstallerHarness(false, false);
    try {
      expect(first.status, first.output).toBe(0);
      const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
      const record = readFileSync(envPath, 'utf8').replace(
        new RegExp(`^${key}=.*$`, 'm'),
        `${key}=${value}`
      );
      writeFileSync(envPath, record);
      const before = hostSnapshot(first.root);
      const second = runInstallerHarness(false, false, first.root);
      expect(second.status, second.output).not.toBe(0);
      expect(hostSnapshot(first.root)).toEqual(before);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid saved digest even with an explicit release override', () => {
    const first = runInstallerHarness(false, false, undefined, 'unused', {
      digest: `sha256:${'a'.repeat(64)}`,
    });
    try {
      expect(first.status, first.output).toBe(0);
      const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
      writeFileSync(
        envPath,
        readFileSync(envPath, 'utf8').replace(/sha256:[a-f0-9]{64}/, 'sha256:bad')
      );
      const before = hostSnapshot(first.root);
      const second = runInstallerHarness(false, false, first.root);
      expect(second.status, second.output).not.toBe(0);
      expect(hostSnapshot(first.root)).toEqual(before);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('accepts literal unquoted and single-quoted saved assignments without a final newline', () => {
    const first = runInstallerHarness(false, false);
    try {
      expect(first.status, first.output).toBe(0);
      writeFileSync(
        join(first.root, 'install-root/etc/lifemodel/instance.env'),
        "LIFEMODEL_NAME=lifemodel\nLIFEMODEL_PLATFORM_URL='oci://example.test/platform'\nLIFEMODEL_PLATFORM_TAG=v1.0.0"
      );
      const second = runInstallerHarness(false, false, first.root, 'unused', {
        savedRelease: true,
      });
      expect(second.status, second.output).toBe(0);
      expect(readFileSync(join(first.root, 'applied-tag'), 'utf8').trim()).toBe('v1.0.0');
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('persists the custom name and digest in etc and keeps them on a parameter-free rerun', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const first = runInstallerHarness(false, false, undefined, 'unused', { digest, name: 'home' });
    try {
      expect(first.status, first.output).toBe(0);
      const envPath = join(first.root, 'install-root/etc/lifemodel/instance.env');
      expect(readFileSync(envPath, 'utf8')).toContain(`LIFEMODEL_NAME='home'`);
      expect(readFileSync(envPath, 'utf8')).toContain(`LIFEMODEL_PLATFORM_DIGEST='${digest}'`);
      const second = runInstallerHarness(false, false, first.root, 'unused', {
        savedRelease: true,
      });
      expect(second.status, second.output).toBe(0);
      expect(readFileSync(join(first.root, 'applied-ref'), 'utf8').trim()).toBe(
        `digest: ${digest}`
      );
      expect(readFileSync(envPath, 'utf8')).toContain(`LIFEMODEL_NAME='home'`);
      expect(readFileSync(envPath, 'utf8')).toContain(`LIFEMODEL_PLATFORM_DIGEST='${digest}'`);
      expect(readFileSync(envPath, 'utf8')).not.toContain('LIFEMODEL_PLATFORM_TAG=');
      const nextDigest = `sha256:${'b'.repeat(64)}`;
      const next = runInstallerHarness(false, false, first.root, 'unused', { digest: nextDigest });
      expect(next.status, next.output).toBe(0);
      expect(readFileSync(envPath, 'utf8')).toContain(`LIFEMODEL_NAME='home'`);
      expect(readFileSync(envPath, 'utf8')).toContain(`LIFEMODEL_PLATFORM_DIGEST='${nextDigest}'`);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });
  it('refuses another name even without an explicit release and before host changes', () => {
    const first = runInstallerHarness(false, false, undefined, 'v1.0.0', { name: 'home' });
    try {
      expect(first.status, first.output).toBe(0);
      const before = readFileSync(join(first.root, 'kubectl.log'), 'utf8');
      const second = runInstallerHarness(false, false, first.root, 'unused', {
        name: 'other',
        savedRelease: true,
      });
      expect(second.status).not.toBe(0);
      expect(second.output).toContain('instance name is fixed as home');
      expect(readFileSync(join(first.root, 'kubectl.log'), 'utf8')).toBe(before);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or forbidden LAN interfaces in render-only and install modes', () => {
    for (const iface of ['wg0', 'eth&0', 'a'.repeat(16), 'eth0;touch']) {
      const result = spawnSync(
        'sh',
        [
          installer,
          '--platform-url',
          'oci://example.test/platform',
          '--tag',
          'v1.0.0',
          '--lan-interface',
          iface,
          '--render-only',
          join(tmpdir(), `mdns-invalid-${process.pid}`),
          '--root-templates',
          rootTemplates,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status, result.stderr).not.toBe(0);
    }
  });

  it('selects the lowest-metric IPv4 default route and refuses missing or forbidden routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mdns-route-render-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const ip = join(bin, 'ip');
    writeFileSync(ip, `#!/bin/sh\nprintf '%s\n' "$ROUTES"\n`);
    chmodSync(ip, 0o755);
    const run = (routes: string) =>
      spawnSync(
        'sh',
        [
          installer,
          '--platform-url',
          'oci://example.test/platform',
          '--tag',
          'v1.0.0',
          '--render-only',
          join(root, 'out'),
          '--root-templates',
          rootTemplates,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROUTES: routes },
        }
      );
    try {
      const selected = run(
        '[{"dev":"wg0","metric":90},{"dev":"eth1","metric":10},{"dev":"eth0","metric":20}]'
      );
      expect(selected.status, selected.stderr).toBe(0);
      expect(
        readFileSync(join(root, 'out/systemd/lifemodel-mdns-lifemodel-local.service'), 'utf8')
      ).toContain('lifemodel.local eth1');
      const forbidden = run('[{"dev":"wg0","metric":1},{"dev":"eth0","metric":10}]');
      expect(forbidden.status).not.toBe(0);
      const absent = run('[]');
      expect(absent.status).not.toBe(0);
      const overlong = run('[{\"dev\":\"abcdefghijklmnop\",\"metric\":1}]');
      expect(overlong.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders interface-scoped active-UFW rules under a fake root', () => {
    const result = runInstallerHarness(false, false, undefined, 'v1.0.0', { ufwActive: true });
    try {
      expect(result.status, result.output).toBe(0);
      expect(readFileSync(join(result.root, 'ufw.log'), 'utf8').trim().split('\n')).toEqual([
        'allow in on eth0 to any port 80 proto tcp',
        'allow in on eth0 to any port 443 proto tcp',
        'allow in on eth0 to any port 5353 proto udp',
      ]);
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('normalizes every effective Avahi server key once and is byte-idempotent', () => {
    const config =
      '# keep comment\n  [Server]\n  Allow-Interfaces=eth1\n[wide-area]\nenable-wide-area=no\n[server] ; later group\nallow-interfaces=eth2\n[other]\nallow-interfaces=untouched\n';
    const expected =
      '# keep comment\n  [Server]\nallow-interfaces=eth0\n[wide-area]\nenable-wide-area=no\n[server] ; later group\n[other]\nallow-interfaces=untouched\n';
    const result = runInstallerHarness(false, false, undefined, 'v1.0.0', { avahiConfig: config });
    try {
      expect(result.status, result.output).toBe(0);
      const configPath = join(result.root, 'install-root/etc/avahi/avahi-daemon.conf');
      expect(readFileSync(configPath, 'utf8')).toBe(expected);
      const firstLog = readFileSync(join(result.root, 'systemctl.log'), 'utf8');
      expect(firstLog).toContain('restart avahi-daemon.service');
      const second = runInstallerHarness(false, false, result.root, 'v1.0.0');
      expect(second.status, second.output).toBe(0);
      expect(readFileSync(configPath, 'utf8')).toBe(expected);
      const secondLog = readFileSync(join(result.root, 'systemctl.log'), 'utf8');
      expect(secondLog.match(/restart avahi-daemon\.service/g)).toHaveLength(1);
      expect(
        readFileSync(
          join(
            result.root,
            'install-root/etc/systemd/system/lifemodel-mdns-lifemodel-local.service'
          ),
          'utf8'
        )
      ).toContain('ExecStart=/usr/lib/lifemodel/publish-name lifemodel.local eth0');
      expect(existsSync(join(result.root, 'install-root/usr/lib/lifemodel/publish-name'))).toBe(
        true
      );
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });
  it('does not render Helm hook resources in step A', () => {
    const rendered = parseYamlFiles([
      join(platformRoot, 'a/openbao/rendered.yaml'),
      join(platformRoot, 'a/gitea/rendered.yaml'),
    ]);
    expect(
      rendered.filter((item) => item.metadata?.annotations?.['helm.sh/hook'] !== undefined)
    ).toEqual([]);
  });
  it('rejects privileged, added-capability, and root-user containers', () => {
    const rendered = parseYamlFiles([join(platformRoot, 'a/gitea/rendered.yaml')]);
    const pod = rendered.find(
      (item) => item.kind === 'Deployment' && item.metadata?.name === 'gitea'
    )!.spec.template.spec;
    const cases = [
      (copy: any) => {
        copy.containers[0].securityContext.privileged = true;
      },
      (copy: any) => {
        copy.containers[0].securityContext.capabilities.add = ['SYS_ADMIN'];
      },
      (copy: any) => {
        copy.containers[0].securityContext.runAsUser = 0;
      },
      (copy: any) => {
        delete copy.containers[0].securityContext.runAsUser;
        copy.securityContext.runAsUser = 0;
      },
    ];
    for (const mutate of cases) {
      const copy = structuredClone(pod);
      mutate(copy);
      expect(() => assertRestrictedContainers(copy)).toThrow();
    }
  });

  it('rejects extra step-A NetworkPolicies in either protected namespace', () => {
    const objects = sourceObjects();
    expect(() => assertStepANetworkPolicies(objects)).not.toThrow();
    for (const namespace of ['openbao', 'lifemodel-git', 'lifemodel-system']) {
      const mutated = structuredClone(objects);
      mutated.push({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'unexpected-allow', namespace },
        spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [{}] }] },
      });
      expect(() => assertStepANetworkPolicies(mutated)).toThrow(/inventory/);
    }
  });

  it('deploys Gitea with explicit SQLite, admin Secret, persistence, and restricted access', () => {
    const giteaRoot = join(platformRoot, 'a/gitea');
    const kustomization = YAML.parse(
      readFileSync(join(platformRoot, 'a/kustomization.yaml'), 'utf8')
    ) as { resources: string[] };
    expect(kustomization.resources).toContain('gitea');
    const giteaKustomization = YAML.parse(
      readFileSync(join(giteaRoot, 'kustomization.yaml'), 'utf8')
    ) as { resources: string[]; configMapGenerator?: any[] };
    expect(giteaKustomization.resources).toContain('rendered.yaml');
    expect(giteaKustomization.resources).not.toContain('release.yaml');
    expect(giteaKustomization.configMapGenerator).toBeUndefined();
    const rendered = parseYamlFiles([join(giteaRoot, 'rendered.yaml')]);
    const giteaPodSpec = rendered.find(
      (item) => item.kind === 'Deployment' && item.metadata?.name === 'gitea'
    )!.spec.template.spec;
    assertRestrictedContainers(giteaPodSpec);
    expect(rendered.some((item) => item.kind === 'HelmRelease')).toBe(false);
    expect(
      rendered.some((item) => item.kind === 'ConfigMap' && item.metadata?.name === 'gitea-values')
    ).toBe(false);
    expect(
      rendered.some((item) => item.kind === 'Deployment' && item.metadata?.name === 'gitea')
    ).toBe(true);
    expect(sourceObjects().some((item) => item.kind === 'HelmRelease')).toBe(false);
    const values = YAML.parse(readFileSync(join(giteaRoot, 'values.yaml'), 'utf8')) as Record<
      string,
      any
    >;
    expect(values).toMatchObject({
      postgresql: { enabled: false },
      'postgresql-ha': { enabled: false },
      valkey: { enabled: false },
      'valkey-cluster': { enabled: false },
      gitea: {
        admin: {
          username: '',
          password: '',
          existingSecret: 'gitea-admin',
          passwordMode: 'initialOnlyNoReset',
        },
        config: {
          database: { DB_TYPE: 'sqlite3', PATH: '/data/gitea/gitea.db' },
          repository: { ROOT: '/data/git/repositories' },
          queue: { TYPE: 'level' },
          cache: { ADAPTER: 'memory' },
          server: {
            DOMAIN: 'gitea-http.lifemodel-git.svc.cluster.local',
            SSH_DOMAIN: 'gitea-http.lifemodel-git.svc.cluster.local',
            ROOT_URL: 'http://gitea-http.lifemodel-git.svc.cluster.local:3000/',
          },
        },
      },
      persistence: {
        enabled: true,
        create: true,
        claimName: 'gitea-shared-storage',
        annotations: { 'kustomize.toolkit.fluxcd.io/prune': 'disabled' },
      },
      ingress: { enabled: false },
      podSecurityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containerSecurityContext: {
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
        seccompProfile: { type: 'RuntimeDefault' },
      },
    });
    const namespace = YAML.parse(readFileSync(join(giteaRoot, 'namespace.yaml'), 'utf8')) as Record<
      string,
      any
    >;
    expect(namespace.metadata.name).toBe('lifemodel-git');
    expect(namespace.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    expect(namespace.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(namespace.metadata.labels['pod-security.kubernetes.io/audit']).toBe('restricted');
    expect(namespace.metadata.labels['pod-security.kubernetes.io/warn']).toBe('restricted');
    expect(() => assertRestrictedNamespace(namespace)).not.toThrow();
    const missingEnforce = structuredClone(namespace);
    delete missingEnforce.metadata.labels['pod-security.kubernetes.io/enforce'];
    expect(() => assertRestrictedNamespace(missingEnforce)).toThrow(/enforce/);
    expect(rendered.some((item) => item.kind === 'Ingress')).toBe(false);
    const inlineConfig = rendered.find(
      (item) => item.kind === 'Secret' && item.metadata?.name === 'gitea-inline-config'
    );
    expect(inlineConfig?.stringData?.server).toContain(
      'ROOT_URL=http://gitea-http.lifemodel-git.svc.cluster.local:3000/'
    );
    const pvc = rendered.find((item) => item.kind === 'PersistentVolumeClaim');
    expect(pvc?.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe('disabled');
    const policy = YAML.parse(
      readFileSync(join(giteaRoot, 'network-policy.yaml'), 'utf8')
    ) as Record<string, any>;
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec.ingress).toHaveLength(2);
    const admitted = policy.spec.ingress.map(
      (rule: any) => rule.from[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name']
    );
    expect(admitted).toEqual(['lifemodel-system', 'flux-system']);
    expect(policy.spec.ingress.map((rule: any) => rule.from[0].podSelector.matchLabels)).toEqual([
      { 'app.kubernetes.io/name': 'loader' },
      { app: 'source-controller' },
    ]);
    expect(policy.spec.ingress.map((rule: any) => rule.ports)).toEqual([
      [{ protocol: 'TCP', port: 3000 }],
      [{ protocol: 'TCP', port: 3000 }],
    ]);
    expect(policy.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 3000 }],
        },
        {
          from: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'flux-system' } },
              podSelector: { matchLabels: { app: 'source-controller' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 3000 }],
        },
      ],
      egress: [],
    });
    assertAllowedPolicyPorts(policy, [3000, 3000]);
    const extraPort = structuredClone(policy);
    extraPort.spec.ingress[0].ports.push({ protocol: 'TCP', port: 3001 });
    expect(() => assertAllowedPolicyPorts(extraPort, [3000, 3000])).toThrow(/allowlist/);
    expect(readFileSync(join(platformRoot, 'charts/gitea/Chart.yaml'), 'utf8')).toContain(
      'version: 12.7.0'
    );
  });
  it('keeps the platform workload confined and digest-pinned', () => {
    const instanceName = 'lifemodel';
    const sourceFiles = yamlFiles(platformRoot);
    const objects = sourceObjects();
    const instanceObjects = parseYamlFiles(yamlFiles(join(platformRoot, 'instance')));
    expect(objects.length).toBeGreaterThan(0);
    const deployment = objects.find(
      (item) => item.kind === 'Deployment' && item.metadata?.name === 'loader'
    );
    expect(deployment, 'missing loader Deployment').toBeDefined();
    expect(deployment!.spec.replicas).toBe(1);
    expect(deployment!.spec.strategy.type).toBe('Recreate');
    const pod = deployment!.spec.template.spec;
    const container = pod.containers[0];
    expect(container.image).toBe('ghcr.io/shady2k/lifemodel-loader:release-placeholder');
    expect(container.ports).toContainEqual(expect.objectContaining({ containerPort: 7000 }));
    expect(container.env ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'LIFEMODEL_LOADER_MODE' })
    );
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(container.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'state', mountPath: '/var/lib/loader' }),
        expect.objectContaining({ name: 'tmp', mountPath: '/tmp' }),
      ])
    );
    expect(pod.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'state', persistentVolumeClaim: expect.any(Object) }),
        expect.objectContaining({ name: 'tmp', emptyDir: expect.any(Object) }),
      ])
    );
    expect(container.readinessProbe).toBeDefined();
    expect(container.livenessProbe).toBeDefined();
    const loaderNamespace = objects.find(
      (item) => item.kind === 'Namespace' && item.metadata?.name === 'lifemodel-system'
    );
    expect(loaderNamespace?.metadata.labels['pod-security.kubernetes.io/enforce']).toBe(
      'restricted'
    );
    expect(object(objects, 'PersistentVolumeClaim').spec.storageClassName).toBe('local-path');
    expect(
      objects.find(
        (item) => item.kind === 'ServiceAccount' && item.metadata.namespace === 'lifemodel-system'
      )?.automountServiceAccountToken
    ).toBe(true);
    expect(
      objects.find(
        (item) => item.kind === 'ServiceAccount' && item.metadata.namespace === 'openbao'
      )?.automountServiceAccountToken
    ).toBe(true);
    const loaderRole = objects.find(
      (item) => item.kind === 'Role' && item.metadata?.name === 'loader-bootstrap'
    );
    expect(loaderRole?.rules).toContainEqual({
      apiGroups: [''],
      resources: ['secrets'],
      resourceNames: expect.arrayContaining(['lifemodel-tls']),
      verbs: ['get', 'update'],
    });
    expect(loaderRole?.rules).toContainEqual({
      apiGroups: [''],
      resources: ['configmaps'],
      resourceNames: expect.arrayContaining(['lifemodel-ca']),
      verbs: ['get', 'update'],
    });
    expect(loaderRole?.rules).toContainEqual({
      apiGroups: [''],
      resources: ['configmaps'],
      resourceNames: expect.arrayContaining(['lifemodel-pki-status']),
      verbs: ['get', 'update'],
    });
    expect(
      objects.some(
        (item) =>
          ['Role', 'RoleBinding'].includes(item.kind) &&
          item.metadata.namespace === 'lifemodel-system'
      )
    ).toBe(true);
    expect(
      instanceObjects.some(
        (item) =>
          item.kind === 'Ingress' &&
          item.metadata?.name === 'web-auth-handoff' &&
          item.metadata?.namespace === 'lifemodel-system' &&
          item.spec.rules[0].host === '${LIFEMODEL_NAME}.local'
      )
    ).toBe(true);
    expect(
      instanceObjects.some(
        (item) =>
          item.kind === 'Ingress' &&
          item.metadata?.namespace === 'lifemodel-system' &&
          item.spec.rules.some((rule: any) => rule.host === 'boot-${LIFEMODEL_NAME}.local')
      )
    ).toBe(true);
    // Storage, task model and task channel define cluster roles, each
    // limited to TokenReview create, never broad auth-delegator access.
    expect(objects.filter((item) => item.kind === 'ClusterRole')).toEqual(
      [
        'model-gateway-token-review',
        'core-task-channel-token-review',
        'storage-module-token-review',
      ].map((name) => ({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name },
        rules: [
          { apiGroups: ['authentication.k8s.io'], resources: ['tokenreviews'], verbs: ['create'] },
        ],
      }))
    );
    const moduleSubject = {
      kind: 'ServiceAccount',
      name: 'storage-module',
      namespace: 'lifemodel-system',
    };
    const clusterRoleBindings = objects
      .filter((item) => item.kind === 'ClusterRoleBinding')
      .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
    expect(clusterRoleBindings).toEqual([
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: 'core-task-channel-token-review' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'core-task-channel-token-review',
        },
        subjects: [{ kind: 'ServiceAccount', name: 'core', namespace: 'lifemodel' }],
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: 'model-gateway-token-review' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'model-gateway-token-review',
        },
        subjects: [
          { kind: 'ServiceAccount', name: 'model-gateway', namespace: 'lifemodel-system' },
        ],
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: 'openbao-auth-delegator' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'system:auth-delegator',
        },
        subjects: [{ kind: 'ServiceAccount', name: 'openbao', namespace: 'openbao' }],
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: 'storage-module-token-review' },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'storage-module-token-review',
        },
        subjects: [moduleSubject],
      },
    ]);
    const identityRoles = objects
      .filter(
        (item) => item.kind === 'Role' && item.metadata?.name === 'storage-module-identity-read'
      )
      .sort((left, right) => left.metadata.namespace.localeCompare(right.metadata.namespace));
    expect(identityRoles).toEqual(
      ['lifemodel', 'lifemodel-motor'].map((namespace) => ({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: 'storage-module-identity-read', namespace },
        rules: [
          { apiGroups: [''], resources: ['pods'], verbs: ['get'] },
          ...(namespace === 'lifemodel-motor'
            ? [{ apiGroups: ['batch'], resources: ['jobs'], verbs: ['get'] }]
            : []),
        ],
      }))
    );
    const moduleBindings = objects
      .filter(
        (item) =>
          item.kind === 'RoleBinding' &&
          (item.subjects ?? []).some(
            (subject: any) =>
              subject.kind === 'ServiceAccount' &&
              subject.name === 'storage-module' &&
              subject.namespace === 'lifemodel-system'
          )
      )
      .sort((left, right) => left.metadata.namespace.localeCompare(right.metadata.namespace));
    expect(moduleBindings).toEqual(
      ['lifemodel', 'lifemodel-motor'].map((namespace) => ({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: 'storage-module-identity-read', namespace },
        subjects: [moduleSubject],
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'storage-module-identity-read',
        },
      }))
    );
    expect(sourceFiles.some((file) => file.endsWith('/a0/kustomization.yaml'))).toBe(true);
  });

  it('protects loader bootstrap Secrets from Flux overwrite and pruning', () => {
    const objects = sourceObjects();
    const bootstrap = objects.filter(
      (item) =>
        item.kind === 'Secret' &&
        ['loader-bootstrap-state', 'openbao-unseal-custody', 'lifemodel-tls'].includes(
          item.metadata?.name
        )
    );
    expect(bootstrap).toHaveLength(3);
    for (const secret of bootstrap) {
      expect(secret.metadata.namespace).toBe('lifemodel-system');
      expect(secret.type).toBe(
        secret.metadata.name === 'lifemodel-tls' ? 'kubernetes.io/tls' : 'Opaque'
      );
      if (secret.type === 'kubernetes.io/tls') {
        expect(secret.data).toEqual({ 'tls.crt': '', 'tls.key': '' });
        expect(Object.hasOwn(secret.data, 'tls.crt') && Object.hasOwn(secret.data, 'tls.key')).toBe(
          true
        );
      } else expect(secret.data).toBeUndefined();
      expect(secret.metadata.annotations).toMatchObject({
        'kustomize.toolkit.fluxcd.io/ssa': 'IfNotPresent',
        'kustomize.toolkit.fluxcd.io/prune': 'disabled',
      });
    }
    const a0Kustomization = YAML.parse(
      readFileSync(join(platformRoot, 'a0/kustomization.yaml'), 'utf8')
    ) as { resources: string[] };
    expect(a0Kustomization.resources).toContain('bootstrap-secrets.yaml');
    const tls = bootstrap.find((item) => item.metadata.name === 'lifemodel-tls')!;
    expect(Object.keys(tls.data).sort()).toEqual(['tls.crt', 'tls.key']); // kubernetes.io/tls required-keys validation; live apply is VM-walk item
  });

  it('bounds platform-a0 health checks with an explicit timeout', () => {
    const a0 = sourceObjects().find(
      (item) => item.kind === 'Kustomization' && item.metadata?.name === 'platform-a0'
    );
    expect(a0, 'missing platform-a0 Kustomization').toBeDefined();
    expect(a0!.spec.timeout).toBe('2m0s');
  });

  it('orders OpenBao step A after A0 and applies the committed chart render', () => {
    const objects = sourceObjects();
    const stepA = objects.find(
      (item) => item.kind === 'Kustomization' && item.metadata?.name === 'platform-a'
    );
    expect(stepA?.spec).toMatchObject({
      dependsOn: [{ name: 'platform-a0' }],
      wait: true,
      timeout: '10m0s',
    });
    const kustomization = YAML.parse(
      readFileSync(join(platformRoot, 'a/kustomization.yaml'), 'utf8')
    ) as { resources: string[]; configMapGenerator?: any[] };
    expect(kustomization.resources).toContain('openbao/rendered.yaml');
    expect(kustomization.resources).not.toContain('openbao-release.yaml');
    // The chart render is applied verbatim: no generator re-packages OpenBao's
    // configuration, so its config keeps the chart's own fixed name.
    expect(
      (kustomization.configMapGenerator ?? []).filter((generator) =>
        String(generator.name).startsWith('openbao')
      )
    ).toEqual([]);
    const rendered = parseYamlFiles([join(platformRoot, 'a/openbao/rendered.yaml')]);
    const openbaoPodSpec = rendered.find(
      (item) => item.kind === 'StatefulSet' && item.metadata?.name === 'openbao'
    )!.spec.template.spec;
    assertRestrictedContainers(openbaoPodSpec);
    expect(rendered.some((item) => item.kind === 'HelmRelease')).toBe(false);
    expect(
      rendered.some((item) => item.kind === 'ConfigMap' && item.metadata?.name === 'openbao-values')
    ).toBe(false);
    expect(
      rendered.some((item) => item.kind === 'StatefulSet' && item.metadata?.name === 'openbao')
    ).toBe(true);
    const statefulSet = rendered.find(
      (item) => item.kind === 'StatefulSet' && item.metadata?.name === 'openbao'
    )!;
    expect(statefulSet.spec.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: 'Retain',
      whenScaled: 'Retain',
    });
    expect(statefulSet.spec.persistentVolumeClaimRetentionPolicy.whenDeleted).toBe('Retain');
    expect(statefulSet.spec.persistentVolumeClaimRetentionPolicy.whenScaled).toBe('Retain');
    const openbaoNamespace = objects.find(
      (item) => item.kind === 'Namespace' && item.metadata?.name === 'openbao'
    )!;
    assertRestrictedNamespace(openbaoNamespace);
    expect(openbaoNamespace.metadata.annotations['kustomize.toolkit.fluxcd.io/prune']).toBe(
      'disabled'
    );
    assertStepANetworkPolicies(objects);
    const stepANetworkPolicies = objects.filter(
      (item) =>
        item.kind === 'NetworkPolicy' &&
        ['openbao', 'lifemodel-git'].includes(item.metadata?.namespace)
    );
    expect(
      stepANetworkPolicies.find((item) => item.metadata.name === 'openbao-default-deny')?.spec
    ).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] });
    expect(
      stepANetworkPolicies.find((item) => item.metadata.name === 'openbao-server-access')?.spec
    ).toEqual({
      podSelector: {
        matchLabels: {
          'app.kubernetes.io/name': 'openbao',
          'app.kubernetes.io/instance': 'openbao',
          component: 'server',
        },
      },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
            },
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
            },
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storage-module' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 8200 }],
        },
      ],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      ],
    });
    expect(
      objects.some((item) => item.kind === 'HelmRelease' && item.metadata?.name === 'openbao')
    ).toBe(false);
  });

  it('parses the numeric OCI tag as a string and preserves custom regex text', () => {
    const parsed = YAML.parse(readFileSync(customOCI, 'utf8'));
    expect(parsed.spec.ref.tag).toBe('20261013');
    expect(typeof parsed.spec.ref.tag).toBe('string');
    expect(parsed.spec.verify.matchOIDCIdentity[0]).toEqual({
      issuer: '^issuer\\.path/\'quoted"$',
      subject: '^subject\\\\literal/\'quote"$',
    });
  });

  it('resumes after Flux apply fails with the owned namespace already created', () => {
    const first = runInstallerHarness(true);
    try {
      expect(first.status).not.toBe(0);
      expect(readFileSync(join(first.root, 'namespace-state'), 'utf8')).toBe('');
      expect(readFileSync(join(first.root, 'kubectl.log'), 'utf8').split('\n')[0]).toBe(
        'namespace'
      );
      const second = runInstallerHarness(false, false, first.root);
      try {
        expect(second.status, second.output).toBe(0);
        expect(readFileSync(join(second.root, 'kubectl.log'), 'utf8')).toContain('flux');
        expect(readFileSync(join(second.root, 'state', 'platform-history'), 'utf8')).toBe(
          'tag=v1.0.0\n'
        );
      } finally {
        /* the shared root is removed by the outer finally */
      }
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('lets a second installer run reclaim doctor-pinned root fields and record its configured tag', () => {
    const first = runInstallerHarness(false);
    try {
      expect(first.status, first.output).toBe(0);
      const second = runInstallerHarness(false, false, first.root, 'v2.0.0');
      expect(second.status, second.output).toBe(0);
      const installed = join(second.root, 'install-root/usr/local/bin/lifemodel');
      const recovery = spawnSync(installed, ['doctor', '--repin', 'previous'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(second.root, 'bin')}:${process.env.PATH}`,
          ROUTES: '[{\"dev\":\"eth0\",\"metric\":100}]',
          LIFEMODEL_INSTALL_ROOT: join(second.root, 'install-root'),
          LIFEMODEL_STATE_DIR: join(second.root, 'state'),
          K3S_STATE: join(second.root, 'namespace-state'),
          K3S_LOG: join(second.root, 'kubectl.log'),
          K3S_APPLIED_TAG: join(second.root, 'applied-tag'),
          K3S_FAIL_FLUX: '0',
          K3S_FOREIGN: '0',
        },
      });
      expect(recovery.status, recovery.stderr).toBe(0);
      const log = readFileSync(join(second.root, 'kubectl.log'), 'utf8');
      const rootApplies = log.split('\n').filter((line) => line.startsWith('root:'));
      expect(rootApplies).toHaveLength(9);
      expect(
        rootApplies.every((line) =>
          line.includes('--server-side --field-manager=lifemodel-bootstrap')
        )
      ).toBe(true);
      expect(readFileSync(join(second.root, 'applied-tag'), 'utf8').trim()).toBe('v1.0.0');
      expect(readFileSync(join(second.root, 'state', 'platform-history'), 'utf8')).toBe(
        'tag=v1.0.0\ntag=v2.0.0\n'
      );
      expect(
        JSON.parse(readFileSync(join(second.root, 'state', 'platform-override'), 'utf8'))
      ).toEqual({ ref: 'tag=v1.0.0', configuredRef: 'tag=v2.0.0' });
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('binds the installed CLI to its state directory and quotes metacharacter paths', () => {
    const result = runInstallerHarness(false, false, undefined, 'v1.0.0', { metacharState: true });
    try {
      expect(result.status, result.output).toBe(0);
      const bin = join(result.root, 'install-root/usr/local/bin/lifemodel');
      const env = { ...process.env, PATH: `${join(result.root, 'bin')}:${process.env.PATH}` };
      for (const key of ['LIFEMODEL_STATE_DIR', 'LIFEMODEL_HISTORY', 'LIFEMODEL_INSTALL_ROOT'])
        delete (env as NodeJS.ProcessEnv)[key];
      const record = spawnSync(bin, ['record-applied', 'tag=v2.0.0'], { encoding: 'utf8', env });
      expect(record.status, record.stderr).toBe(0);
      expect(
        readFileSync(
          join(result.root, 'state $(touch SHOULD_NOT_EXIST) `echo nope`', 'platform-history'),
          'utf8'
        )
      ).toBe('tag=v2.0.0\ntag=v1.0.0\n');
      expect(existsSync(join(result.root, 'SHOULD_NOT_EXIST'))).toBe(false);
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('refuses a root ref owned by another manager before applying either root object', () => {
    const result = runInstallerHarness(false, false, undefined, 'v1.0.0', {
      owner: 'lifemodel-doctor',
    });
    try {
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Root OCIRepository spec.ref is owned by lifemodel-doctor');
      expect(result.output).toContain('delete ocirepository platform');
      const log = readFileSync(join(result.root, 'kubectl.log'), 'utf8');
      expect(log.split('\n').filter((line) => line.startsWith('root:'))).toHaveLength(0);
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('installs a configured digest through the generic-Linux writer', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const result = runInstallerHarness(false, false, undefined, 'unused', { digest });
    try {
      expect(result.status, result.output).toBe(0);
      expect(readFileSync(join(result.root, 'state', 'platform-history'), 'utf8')).toBe(
        `digest=${digest}\n`
      );
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('reapplies digest overrides and clears back to the configured digest', () => {
    const firstDigest = `sha256:${'a'.repeat(64)}`;
    const configuredDigest = `sha256:${'b'.repeat(64)}`;
    const first = runInstallerHarness(false, false, undefined, 'unused', { digest: firstDigest });
    try {
      const second = runInstallerHarness(false, false, first.root, 'unused', {
        digest: configuredDigest,
      });
      expect(second.status, second.output).toBe(0);
      const installed = join(first.root, 'install-root/usr/local/bin/lifemodel');
      const env = {
        ...process.env,
        PATH: `${join(first.root, 'bin')}:${process.env.PATH}`,
        ROUTES: '[{\"dev\":\"eth0\",\"metric\":100}]',
        LIFEMODEL_INSTALL_ROOT: join(first.root, 'install-root'),
        LIFEMODEL_STATE_DIR: join(first.root, 'state'),
        K3S_STATE: join(first.root, 'namespace-state'),
        K3S_LOG: join(first.root, 'kubectl.log'),
        K3S_APPLIED_TAG: join(first.root, 'applied-tag'),
        K3S_APPLIED_REF: join(first.root, 'applied-ref'),
        K3S_FAIL_FLUX: '0',
        K3S_FOREIGN: '0',
        K3S_MANAGED_FIELDS: '',
      };
      const previous = spawnSync(installed, ['doctor', '--repin', 'previous'], {
        encoding: 'utf8',
        env,
      });
      expect(previous.status, previous.stderr).toBe(0);
      expect(readFileSync(join(first.root, 'applied-ref'), 'utf8').trim()).toBe(
        `digest: ${firstDigest}`
      );
      const clear = spawnSync(installed, ['doctor', '--repin', 'clear'], { encoding: 'utf8', env });
      expect(clear.status, clear.stderr).toBe(0);
      expect(readFileSync(join(first.root, 'applied-ref'), 'utf8').trim()).toBe(
        `digest: ${configuredDigest}`
      );
    } finally {
      rmSync(first.root, { recursive: true, force: true });
    }
  });

  it('recovers from the installed bootstrap bundle after its source checkout is removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'lifemodel-removed-source-'));
    const sourceDir = join(root, 'checkout');
    mkdirSync(join(sourceDir, 'scripts'), { recursive: true });
    mkdirSync(join(sourceDir, 'deploy/cli'), { recursive: true });
    mkdirSync(join(sourceDir, 'deploy/mdns'), { recursive: true });
    mkdirSync(join(sourceDir, 'deploy/k3s'), { recursive: true });
    cpSync(installer, join(sourceDir, 'scripts/install.sh'));
    cpSync(rootTemplates, join(sourceDir, 'deploy/root'), { recursive: true });
    cpSync(
      fileURLToPath(new URL('../../deploy/mdns/', import.meta.url)),
      join(sourceDir, 'deploy/mdns'),
      { recursive: true }
    );
    cpSync(
      fileURLToPath(new URL('../../deploy/k3s/', import.meta.url)),
      join(sourceDir, 'deploy/k3s'),
      { recursive: true }
    );
    cpSync(
      fileURLToPath(new URL('../../deploy/cli/lifemodel.mjs', import.meta.url)),
      join(sourceDir, 'deploy/cli/lifemodel.mjs')
    );
    cpSync(
      fileURLToPath(new URL('../../deploy/cli/wait-ready.mjs', import.meta.url)),
      join(sourceDir, 'deploy/cli/wait-ready.mjs')
    );
    const first = runInstallerHarness(false, false, root, 'v1.0.0', { sourceDir });
    const second = runInstallerHarness(false, false, root, 'v2.0.0', { sourceDir });
    try {
      expect(first.status, first.output).toBe(0);
      expect(second.status, second.output).toBe(0);
      rmSync(sourceDir, { recursive: true, force: true });
      const installed = join(root, 'install-root/usr/local/bin/lifemodel');
      const recovery = spawnSync(installed, ['doctor', '--repin', 'previous'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          ROUTES: '[{\"dev\":\"eth0\",\"metric\":100}]',
          LIFEMODEL_INSTALL_ROOT: join(root, 'install-root'),
          LIFEMODEL_STATE_DIR: join(root, 'state'),
          K3S_STATE: join(root, 'namespace-state'),
          K3S_LOG: join(root, 'kubectl.log'),
          K3S_APPLIED_TAG: join(root, 'applied-tag'),
          K3S_FAIL_FLUX: '0',
          K3S_FOREIGN: '0',
          K3S_MANAGED_FIELDS: '',
        },
      });
      expect(recovery.status, recovery.stderr).toBe(0);
      expect(readFileSync(join(root, 'applied-tag'), 'utf8').trim()).toBe('v1.0.0');
      expect(readFileSync(join(root, 'state', 'platform-history'), 'utf8')).toBe(
        'tag=v1.0.0\ntag=v2.0.0\n'
      );
      expect(readFileSync(join(root, 'install-root/usr/local/bin/lifemodel'), 'utf8')).toContain(
        'bootstrap/root'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported existing Node runtime before cluster writes', () => {
    const result = runInstallerHarness(false, false, undefined, 'v1.0.0', {
      unsupportedNode: true,
    });
    try {
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Node.js 18 or newer is required');
      expect(existsSync(join(result.root, 'kubectl.log'))).toBe(false);
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('still refuses a foreign flux-system namespace', () => {
    const result = runInstallerHarness(false, true);
    try {
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('namespace is not labelled as managed by lifemodel');
      expect(existsSync(join(result.root, 'kubectl.log'))).toBe(false);
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  });

  it('permits the download-session check only between web and loader pods on TCP 7000', () => {
    const policies = sourceObjects().filter((item) => item.kind === 'NetworkPolicy');
    // Both halves of one path: the web pod's egress and the loader pod's ingress.
    const egress = policies.find(
      (item) =>
        item.metadata.namespace === 'lifemodel' && item.metadata.name === 'web-download-auth-egress'
    );
    expect(egress, 'missing web-download-auth-egress NetworkPolicy').toBeDefined();
    expect(egress!.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'web' } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
              },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 7000 }],
        },
      ],
    });
    const ingress = policies.find(
      (item) =>
        item.metadata.namespace === 'lifemodel-system' &&
        item.metadata.name === 'loader-download-auth-ingress'
    );
    expect(ingress, 'missing loader-download-auth-ingress NetworkPolicy').toBeDefined();
    expect(ingress!.spec).toEqual({
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'loader' } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel' } },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'web' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 7000 }],
        },
      ],
    });
  });

  it('limits the original loader ingress permit to Traefik pods in kube-system', () => {
    const policies = sourceObjects().filter(
      (item) => item.kind === 'NetworkPolicy' && item.metadata.namespace === 'lifemodel-system'
    );
    // The namespace default deny is its own object, so a second platform
    // workload there inherits none of the loader's permits (ADR-013 D5).
    const denyAll = policies.find((item) => item.metadata.name === 'lifemodel-system-default-deny');
    expect(denyAll?.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
    });
    const policy = policies.find((item) => item.metadata.name === 'loader-access');
    expect(policy, 'missing loader NetworkPolicy').toBeDefined();
    expect(policy!.spec.podSelector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'loader' },
    });
    expect(policy!.spec.policyTypes).toEqual(expect.arrayContaining(['Ingress', 'Egress']));
    expect(policy!.spec.ingress).toEqual([
      expect.objectContaining({
        from: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } },
          },
        ],
        ports: [expect.objectContaining({ port: 7000 })],
      }),
    ]);
    expect(policy!.spec.egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'zot' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 5001 }],
      },
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
      { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'openbao' } } }],
        ports: [{ protocol: 'TCP', port: 8200 }],
      },
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8081 }],
      },
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-system' },
            },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'storage-module' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8081 }],
      },
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: ['10.42.0.0/16', '10.43.0.0/16', '169.254.0.0/16'],
            },
          },
        ],
      },
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ollama' } } }],
        ports: [{ protocol: 'TCP', port: 11434 }],
      },
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'lifemodel-git' } },
            podSelector: {
              matchLabels: {
                'app.kubernetes.io/name': 'gitea',
                'app.kubernetes.io/instance': 'gitea',
              },
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: 3000 }],
      },
    ]);
    const yaml = readFileSync(join(platformRoot, 'a0/network-policy.yaml'), 'utf8');
    expect(yaml).toContain('k3s DNATs the in-cluster API Service to the node address');
    expect(yaml).toContain('The API port is the only egress restriction');
    const unrestrictedModelEgress = policy!.spec.egress.find(
      (rule: any) =>
        rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0' &&
        rule.to?.[0]?.ipBlock?.except?.includes('10.42.0.0/16')
    );
    expect(unrestrictedModelEgress?.ports).toBeUndefined();
    expect(unrestrictedModelEgress?.to[0].ipBlock.except).toEqual([
      '10.42.0.0/16',
      '10.43.0.0/16',
      '169.254.0.0/16',
    ]);
    // No port selector admits LAN Ollama at 192.168.1.20:11434 and custom HTTPS ports.
    expect(unrestrictedModelEgress?.ports).toBeUndefined();
    expect(yaml).toContain(
      'The Kubernetes API server authenticates the projected ServiceAccount token'
    );
    expect(
      policy!.spec.egress
        .flatMap((rule: any) =>
          (rule.ports ?? []).map((port: any) => `${port.protocol}/${port.port}`)
        )
        .sort()
    ).toEqual([
      'TCP/11434',
      'TCP/3000',
      'TCP/5001',
      'TCP/53',
      'TCP/6443',
      // The model gateway's health listener and the storage module's.
      'TCP/8081',
      'TCP/8081',
      'TCP/8200',
      'UDP/53',
    ]);
  });
});
