#!/usr/bin/env node
// Shared by both installers. Only the public CA ConfigMap is read.
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function execute(command, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data) => {
      if (stdout.length < 1048576) stdout += data;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}
function ready(item) {
  return (
    item?.metadata?.generation != null &&
    item.status?.observedGeneration === item.metadata.generation &&
    item.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
  );
}
export async function waitReady({ name, kubectl, timeoutMs = 600000, pollMs = 2000 }) {
  if (typeof name !== 'string' || name.length > 57 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(name))
    throw new Error('Established instance name is invalid');
  const deadline = performance.now() + Math.min(600000, Math.max(1, timeoutMs));
  const remaining = () => Math.max(1, Math.min(10000, Math.ceil(deadline - performance.now())));
  const dir = await mkdtemp(join(tmpdir(), 'lifemodel-wait-'));
  const caFile = join(dir, 'ca.crt');
  let step = 'k3s';
  let completedScan = false;
  async function get(kind, namespace, resource) {
    if (performance.now() >= deadline) return null;
    const result = await execute(
      kubectl[0],
      [
        ...kubectl.slice(1),
        '--request-timeout=10s',
        'get',
        kind,
        ...(resource ? [resource] : []),
        ...(namespace ? ['-n', namespace] : []),
        '-o',
        'json',
      ],
      remaining()
    );
    try {
      return result.code === 0 ? JSON.parse(result.stdout) : null;
    } catch {
      return null;
    }
  }
  try {
    while (performance.now() < deadline) {
      const previousStep = step;
      step = 'k3s';
      const nodes = await get('nodes');
      if (nodes?.items?.length) {
        step = 'Flux source';
        if (ready(await get('ocirepository', 'flux-system', 'platform'))) {
          step = 'platform-instance';
          if (ready(await get('kustomization', 'flux-system', 'platform-instance'))) {
            step = 'loader pod';
            const pods = await get('pods', 'lifemodel-system');
            if (
              pods?.items?.some(
                (p) =>
                  p.metadata?.labels?.['app.kubernetes.io/name'] === 'loader' &&
                  p.status?.phase === 'Running' &&
                  p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
              )
            ) {
              step = 'certificate';
              const ca = (await get('configmap', 'lifemodel-system', 'lifemodel-ca'))?.data?.[
                'ca.crt'
              ];
              let cert;
              try {
                cert = new X509Certificate(ca);
              } catch {
                /* publication in progress */
              }
              if (cert && performance.now() < deadline) {
                await writeFile(caFile, ca, { mode: 0o600 });
                step = 'route';
                const result = await execute(
                  'curl',
                  [
                    '--silent',
                    '--show-error',
                    '--noproxy',
                    '*',
                    '--request',
                    'GET',
                    '--max-time',
                    String(remaining() / 1000),
                    '--resolve',
                    `boot-${name}.local:443:127.0.0.1`,
                    '--cacert',
                    caFile,
                    '--output',
                    '/dev/null',
                    '--write-out',
                    '%{http_code}',
                    `https://boot-${name}.local/api/state`,
                  ],
                  remaining()
                );
                if (result.code === 0 && result.stdout === '200')
                  return {
                    ready: true,
                    output: `Address: https://${name}.local/\nSHA-256 fingerprint of the CA certificate (DER): ${cert.fingerprint256.replaceAll(':', '').toLowerCase()}\n`,
                  };
                if ([51, 58, 60, 77, 82, 83, 90, 91].includes(result.code)) step = 'certificate';
              }
            }
          }
        }
      }
      // An interrupted rescan cannot erase the last completed diagnosis.
      if (performance.now() >= deadline && completedScan) step = previousStep;
      completedScan = true;
      if (performance.now() < deadline) await delay(Math.min(pollMs, deadline - performance.now()));
    }
    return { ready: false, output: `lifemodel not ready: ${step}; run lifemodel doctor\n` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await waitReady({
      name: process.env.LIFEMODEL_NAME,
      kubectl: (
        process.env.LIFEMODEL_KUBECTL || 'k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml'
      ).split(' '),
    });
    (result.ready ? process.stdout : process.stderr).write(result.output);
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    console.error('lifemodel not ready: certificate or identity unavailable; run lifemodel doctor');
    process.exitCode = 1;
  }
}
