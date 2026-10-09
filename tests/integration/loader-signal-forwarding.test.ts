/**
 * SIGTERM, forwarded for real (lifemodel-q4x.2.1, story S8).
 *
 * The unit tests double the child; this one does not. A tiny stand-in for
 * lifemodel - a real process that traps SIGTERM, does its drain and only then
 * leaves - proves what the contract promises: the loader forwards the signal,
 * WAITS for the exit instead of killing it, and the container then leaves with
 * the code that says whether the drain finished.
 *
 * The whole loader runs here as its own process (loader/src/main.ts through
 * tsx), because the signal it must handle is the one `docker stop` sends to
 * the container's main process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../../loader/src/auth.js';
import { systemClock } from '../../loader/src/clock.js';
import { loadConfig } from '../../loader/src/config.js';
import { createNodeLauncher } from '../../loader/src/exec.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createSupervisor } from '../../loader/src/supervisor.js';
import { createLoaderState } from '../../loader/src/state.js';
import { waitUntil } from '../helpers/loader-doubles.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

/**
 * The stand-in for lifemodel: it writes a file when it is up, and on SIGTERM
 * it does 150 ms of "drain" work before leaving with 0. A loader that killed
 * it would leave no file behind.
 */
const INSTANCE_SOURCE = `
const { writeFileSync } = require('node:fs');
const marker = process.env.LIFEMODEL_MARKER;
writeFileSync(marker + '.up', 'up\\n');
process.on('SIGTERM', () => {
  setTimeout(() => {
    writeFileSync(marker, 'drained and left\\n');
    process.exit(0);
  }, 150);
});
setInterval(() => {}, 1000);
`;

const CADDY_SOURCE = `#!/bin/sh
trap 'exit 0' TERM
while true; do sleep 0.1; done
`;

/**
 * The stand-in for iptables (lifemodel-q4x.3.2): the real loader runs as an
 * ordinary user here, so it cannot install a kernel rule - and what this test
 * is about is the loader's own sequencing, not the kernel. Every command line
 * is written down, which is also how the test sees that the rule was installed
 * before lifemodel was started.
 */
const IPTABLES_SOURCE = `#!/bin/sh
printf '%s\\n' "$*" >> "$LIFEMODEL_EGRESS_LOG"
# A fresh container: the chain and the jump into it are not there yet, and
# those two questions are answered by the failure itself (the -L and -C calls).
case "$*" in
  "-L LIFEMODEL_EGRESS -n") exit 1 ;;
  "-C OUTPUT -j LIFEMODEL_EGRESS") exit 1 ;;
  "-t nat -S DOCKER_OUTPUT")
    printf '%s\n' \
      '-A DOCKER_OUTPUT -d 127.0.0.11/32 -p tcp -m tcp --dport 53 -j DNAT --to-destination 127.0.0.11:38033' \
      '-A DOCKER_OUTPUT -d 127.0.0.11/32 -p udp -m udp --dport 53 -j DNAT --to-destination 127.0.0.11:32878'
    exit 0 ;;
esac
exit 0
`;

/**
 * The stand-in for Agent Vault. Its server answers the loader's readiness
 * probe and leaves on SIGTERM, and its CLI answers what the loader's
 * provisioning asks it - including the session file that proves the account
 * can act for the loader.
 */
const AGENT_VAULT_SOURCE = `#!/usr/bin/env node
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const cliDir = join(process.env.HOME, '.agent-vault');

if (args[0] === 'server') {
  const port = Number(flag('--port'));
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write('agent-vault stand-in listening on 127.0.0.1:' + port + '\\n');
  });
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
} else if (args[0] === 'auth') {
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, 'session.json'), '{"token":"the-stand-in"}');
  process.stdout.write('Login successful.\\n');
} else if (args[0] === 'vault') {
  process.stdout.write('Credential store: builtin\\n');
} else if (args[0] === 'agent') {
  process.stdout.write('av_agt_the-stand-in-token\\n');
} else if (args[0] === 'ca') {
  process.stdout.write('-----BEGIN CERTIFICATE-----\\nMIIBthe-stand-in\\n-----END CERTIFICATE-----\\n');
} else {
  process.stdout.write('the stand-in knows only the server and the provisioning commands\\n');
  process.exit(2);
}
`;

interface StandIn {
  root: string;
  repo: string;
  entry: string;
  marker: string;
  commit: string;
}

/** A volume whose instance is already built, on a real commit of a real repository. */
function makeStandInVolume(): StandIn {
  const root = mkdtempSync(join(tmpdir(), 'loader-signal-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'dist'), { recursive: true });
  const marker = join(root, 'lifemodel-marker');
  writeFileSync(join(repo, 'dist', 'index.js'), INSTANCE_SOURCE);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '-q',
      '-m',
      'the instance',
    ],
    { cwd: repo }
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  return { root, repo, entry: join(repo, 'dist', 'index.js'), marker, commit };
}

/** A free port of this test's own: where the stand-in Agent Vault listens. */
async function freePort(): Promise<number> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('the loader as the container main process', () => {
  it('forwards SIGTERM, waits for lifemodel to drain, and leaves with 0', async () => {
    const standIn = makeStandInVolume();
    const vaultApiPort = await freePort();
    const config = loadConfig({
      LIFEMODEL_VOLUME_ROOT: standIn.root,
      LIFEMODEL_HTTP_PORT: '0',
      LIFEMODEL_SEED_BUNDLE: join(standIn.root, 'no-bundle-needed.bundle'),
      LIFEMODEL_CADDY_BINARY: join(standIn.root, 'caddy'),
      LIFEMODEL_CADDY_CONFIG: join(standIn.root, 'Caddyfile'),
      LIFEMODEL_AGENT_VAULT_BINARY: join(standIn.root, 'agent-vault'),
      LIFEMODEL_AGENT_VAULT_API_PORT: String(vaultApiPort),
      LIFEMODEL_DRAIN_WAIT_MS: '4000',
    });
    writeFileSync(config.caddy.binary, CADDY_SOURCE, { mode: 0o755 });
    writeFileSync(config.caddy.config, ':80 {\n}\n');
    writeFileSync(config.agentVault.binary, AGENT_VAULT_SOURCE, { mode: 0o755 });
    const iptables = join(standIn.root, 'iptables');
    const egressLog = join(standIn.root, 'egress.log');
    writeFileSync(iptables, IPTABLES_SOURCE, { mode: 0o755 });
    // The same stand-in answers for ip6tables, and the container's view of its
    // own IPv6 addresses is written here: one line, the way the kernel writes
    // one in an IPv6-enabled Docker network - so the ip6tables half is
    // installed deterministically, and never by the test box's own stack.
    const ifinet6 = join(standIn.root, 'if-inet6');
    writeFileSync(ifinet6, 'fd66:0004:0002:0000:0000:0000:0000:0003 04 40 eth0\n');
    const fs = createNodeFileSystem();
    const state = createLoaderState({ fs, config, logger: createRecordingLogger([]) });
    await state.ensureLayout();
    await state.writeAuth(await hashPassword('a password'));
    // The commit is already built: the loader starts lifemodel, it does not build it.
    await state.writeBuiltCommit(standIn.commit);

    const loader = spawn('./node_modules/.bin/tsx', ['loader/src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LIFEMODEL_VOLUME_ROOT: standIn.root,
        LIFEMODEL_HTTP_PORT: '0',
        LIFEMODEL_SEED_BUNDLE: join(standIn.root, 'no-bundle-needed.bundle'),
        LIFEMODEL_CADDY_BINARY: config.caddy.binary,
        LIFEMODEL_CADDY_CONFIG: config.caddy.config,
        LIFEMODEL_AGENT_VAULT_BINARY: config.agentVault.binary,
        LIFEMODEL_AGENT_VAULT_API_PORT: String(vaultApiPort),
        LIFEMODEL_DRAIN_WAIT_MS: '4000',
        LIFEMODEL_MARKER: standIn.marker,
        LIFEMODEL_EGRESS_IPTABLES: iptables,
        LIFEMODEL_EGRESS_IP6TABLES: iptables,
        LIFEMODEL_EGRESS_IF_INET6: ifinet6,
        LIFEMODEL_EGRESS_LOG: egressLog,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const output: string[] = [];
    let buffered = '';
    loader.stdout.setEncoding('utf8');
    loader.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      output.push(...lines);
    });
    const errors: string[] = [];
    loader.stderr.setEncoding('utf8');
    loader.stderr.on('data', (chunk: string) => errors.push(chunk));

    try {
      await waitUntil(
        () => output.some((line) => line.includes('lifemodel started')),
        'the loader started lifemodel',
        20_000
      );
      expect(output.some((line) => line.includes('caddy is up'))).toBe(true);
      // The kernel rule was installed by the loader's own process, before it
      // started lifemodel: the NAMED loopback services (the vault proxy, the
      // loader's interface - this test's loader listens on the ephemeral port
      // 0, so the rule names port 0 - and the container's resolver), and a
      // REJECT for everything else from that uid.
      expect(readFileSync(egressLog, 'utf8').trim().split('\n')).toEqual([
        '-L LIFEMODEL_EGRESS -n',
        '-N LIFEMODEL_EGRESS',
        '-t nat -S DOCKER_OUTPUT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -p tcp -d 127.0.0.1 --dport 14322 -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -p tcp -d 127.0.0.1 --dport 0 -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -p tcp -d 127.0.0.11 --dport 38033 -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -p udp -d 127.0.0.11 --dport 32878 -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -j REJECT --reject-with icmp-port-unreachable',
        '-C OUTPUT -j LIFEMODEL_EGRESS',
        '-A OUTPUT -j LIFEMODEL_EGRESS',
        '-L LIFEMODEL_EGRESS -n',
        '-N LIFEMODEL_EGRESS',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -p tcp -d ::1 --dport 14322 -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -j REJECT --reject-with icmp6-port-unreachable',
        '-C OUTPUT -j LIFEMODEL_EGRESS',
        '-A OUTPUT -j LIFEMODEL_EGRESS',
      ]);
      await waitUntil(() => existsSync(`${standIn.marker}.up`), 'the stand-in for lifemodel is up');

      const exit = new Promise<number | null>((resolve) => {
        loader.on('exit', (code) => resolve(code));
      });
      loader.kill('SIGTERM'); // what `docker stop` sends
      const code = await exit;

      expect(code).toBe(0);
      expect(readFileSync(standIn.marker, 'utf8')).toBe('drained and left\n');
      const stopped = output.find((line) => line.includes('lifemodel stopped'));
      expect(stopped).toBeDefined();
      expect(stopped).toContain('"drainTimedOut":false');
      expect(output.some((line) => line.includes('stopping lifemodel: SIGTERM'))).toBe(true);
      expect(output.some((line) => line.includes('stopping caddy'))).toBe(true);
      expect(errors.join('')).toBe('');
    } finally {
      if (loader.exitCode === null && !loader.killed) loader.kill('SIGKILL');
    }
  }, 30_000);
});

describe('the supervisor with a real child', () => {
  it('waits for the child to leave by itself instead of killing it', async () => {
    const standIn = makeStandInVolume();
    // The supervisor passes its own environment to the child: the stand-in
    // learns where to write its marker from there.
    process.env['LIFEMODEL_MARKER'] = standIn.marker;
    const config = {
      ...loadConfig({}),
      volumeRoot: standIn.root,
      repoDir: standIn.repo,
      dataDir: join(standIn.root, 'data'),
      loaderDir: join(standIn.root, 'loader'),
      lifemodelEntry: standIn.entry,
      drainWaitMs: 4_000,
      privileged: false,
    };
    const supervisor = createSupervisor({
      launcher: createNodeLauncher(),
      logger: createRecordingLogger([]),
      clock: systemClock,
      config,
      isPanicSet: () => Promise.resolve(false),
    });

    try {
      const started = await supervisor.start();
      expect(started).toEqual({ started: true, reason: 'started' });
      await waitUntil(() => existsSync(`${standIn.marker}.up`), 'the child is up');

      const outcome = await supervisor.stop('shutdown');

      expect(outcome).toEqual({ stopped: true, drainTimedOut: false, pending: null });
      expect(readFileSync(standIn.marker, 'utf8')).toBe('drained and left\n');
      // It left by itself: a killed process would have no exit code.
      expect(supervisor.status().lastExit?.code).toBe(0);
      expect(supervisor.status().lastExit?.signal).toBeNull();
    } finally {
      delete process.env['LIFEMODEL_MARKER'];
      await supervisor.stop('the test is over');
    }
  }, 20_000);
});
