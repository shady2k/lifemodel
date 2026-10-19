import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

describe('resolver command environment', () => {
  it('covers parsed commands in both module paths and installer host requirements', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { inventory } from './scripts/check-k3s-commands.mjs'; console.log(JSON.stringify({ resolv: inventory('k3s-resolv.sh'), 'dns-apply': inventory('k3s-dns-apply.sh') }));`,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    const commands: Record<string, string[]> = JSON.parse(result.stdout);
    const provided: Record<string, string[]> = {
      nodejs: ['node'],
      coreutils: ['mkdir', 'cat', 'rm', 'cp', 'mv', 'sleep'],
      'util-linux': ['flock'],
      systemd: ['systemctl'],
      lifemodelK3s: ['k3s'],
    };
    const module = readFileSync('deploy/nixos/default.nix', 'utf8');
    for (const name of ['resolv', 'dns-apply']) {
      const unit = module.split(`    lifemodel-k3s-${name} = {`)[1].split('unitConfig.')[0];
      const packages = unit
        .match(/path = \[([^\]]+)\]/)![1]
        .trim()
        .split(/\s+/)
        .map((p) => p.replace('pkgs.', ''));
      // The flake check also executes this inventory against these evaluated paths.
      const available = packages.flatMap((p) => provided[p] ?? []);
      const required = readFileSync(`deploy/k3s/lifemodel-k3s-${name}.service.in`, 'utf8')
        .match(/# Host-Commands: (.*)/)![1]
        .split(' ');
      for (const command of commands[name] ?? []) {
        expect(available, `Nix ${name}: ${command}`).toContain(command);
        expect(required, `installer ${name}: ${command}`).toContain(command);
      }
    }
  });
});
