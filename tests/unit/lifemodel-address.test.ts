import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'deploy/cli/lifemodel.mjs');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('lifemodel address', () => {
  it('prints the established instance address and DER CA fingerprint without reading a key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifemodel-address-'));
    dirs.push(dir);
    const ca = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'ca.key'),
        '-out',
        join(dir, 'ca.crt'),
        '-subj',
        '/CN=fixture-ca',
        '-days',
        '1',
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    expect(ca.status, ca.stderr).toBe(0);
    const cert = readFileSync(join(dir, 'ca.crt'), 'utf8');
    const fake = join(dir, 'kubectl');
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = --kubeconfig ]; then shift 2; fi
case "$*" in *lifemodel-instance*) printf '%s' '{"data":{"LIFEMODEL_NAME":"home"}}';; *lifemodel-ca*) printf '%s' "$FAKE_CA";; *lifemodel-pki-status*) printf '%s' '{"data":{"identity":"present","ca":"present-matching"}}';; *) exit 1;; esac
`
    );
    chmodSync(fake, 0o755);
    const env = {
      ...process.env,
      LIFEMODEL_KUBECTL: 'kubectl',
      LIFEMODEL_STATE_DIR: dir,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_CA: JSON.stringify({ data: { 'ca.crt': cert } }),
    };
    const result = spawnSync(process.execPath, [cli, 'address'], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Address: https://home.local/');
    const fingerprint = spawnSync(
      'openssl',
      ['x509', '-in', join(dir, 'ca.crt'), '-outform', 'DER'],
      { encoding: 'buffer', timeout: 10000 }
    );
    const expected = spawnSync('sha256sum', [], {
      input: fingerprint.stdout,
      encoding: 'utf8',
    }).stdout.split(' ')[0];
    expect(result.stdout).toContain(`SHA-256 fingerprint of the CA certificate (DER): ${expected}`);
  });
});
