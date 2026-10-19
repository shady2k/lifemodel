import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-nix-paths.sh', import.meta.url));
const producer = fileURLToPath(new URL('../../scripts/ci-product-paths.sh', import.meta.url));
function selectProducerOutput(...paths: string[]): string {
  const output = execFileSync('sh', [producer], {
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(output).toMatch(/product=(?:true|false)\n$/);
  return execFileSync('sh', [script], { input: output, encoding: 'utf8' }).trim();
}

describe('nix flake check CI path classification', () => {
  it.each([
    ['the flake definition itself', ['flake.nix']],
    ['the lock whose inputs nix resolves the flake against', ['flake.lock']],
    [
      'the release workflow the flake reads for the keyless subject',
      ['.github/workflows/release.yml'],
    ],
    ['the deployed platform tree the checks render', ['deploy/platform/a0/kustomization.yaml']],
    ['the exported NixOS module directory', ['deploy/nixos/default.nix']],
    ['the installer the flake renders beside the module', ['scripts/install.sh']],
    ['the k3s command checker a platform check runs', ['scripts/check-k3s-commands.mjs']],
    ['the CRD schema checker a platform check runs', ['scripts/check-platform-crd-schemas.py']],
    [
      'a fixture the flake compares its render against',
      ['tests/fixtures/nixos/kustomization.yaml'],
    ],
  ])('%s selects the nix check through the producer contract', (_name, changed) => {
    expect(selectProducerOutput(...changed)).toBe('nix_flake_check=true');
  });
  it('does not select the nix check for a docs-only change', () => {
    expect(selectProducerOutput('docs/architecture.md', 'README.md')).toBe('nix_flake_check=false');
  });
  it('does not select the nix check for product changes the flake never reads', () => {
    expect(
      selectProducerOutput(
        'src/core/agent.ts',
        'web/app/src/App.tsx',
        'package.json',
        'tests/unit/ci-nix-paths.test.ts'
      )
    ).toBe('nix_flake_check=false');
  });
  it('does not select the nix check for a fixture outside the nixos set', () => {
    expect(selectProducerOutput('tests/fixtures/rss-tech-blog.xml')).toBe('nix_flake_check=false');
  });
  it('does not select the nix check for the workflow and selector that run it', () => {
    expect(selectProducerOutput('.github/workflows/ci.yml', 'scripts/ci-nix-paths.sh')).toBe(
      'nix_flake_check=false'
    );
  });
  it('selects the nix check when the producer supplies no changed-path records', () => {
    // No records: no path was readable, so no path is evidence of safety —
    // the same rule the producer applies to its own empty input.
    expect(selectProducerOutput()).toBe('nix_flake_check=true');
  });
});
