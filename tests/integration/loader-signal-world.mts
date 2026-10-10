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
// The observer allocates the world root before this process starts.
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { hashPassword } from '../../loader/src/auth.js';
import { systemClock } from '../../loader/src/clock.js';
import { loadConfig } from '../../loader/src/config.js';
import { createNodeLauncher } from '../../loader/src/exec.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createSupervisor } from '../../loader/src/supervisor.js';
import { createLoaderState } from '../../loader/src/state.js';
import { waitUntil } from '../helpers/loader-doubles.js';

const ownedRoot = process.argv[4];
assert.ok(typeof ownedRoot === 'string' && ownedRoot.length > 0);
const roots: string[] = [ownedRoot];
let volumeConstructed = false;

// A Node fixture, not a nested Vitest worker.
function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.strictEqual(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toBeDefined: () => assert.notStrictEqual(actual, undefined),
    toContain: (expected: string) => {
      assert.equal(typeof actual, 'string');
      assert.ok((actual as string).includes(expected));
    },
    toBeNull: () => assert.strictEqual(actual, null),
  };
}

type RequiredProcess = { pid: number | undefined; role: string };
function markedProcess(path: string, role: string): RequiredProcess {
  const marker = JSON.parse(readFileSync(path, 'utf8')) as {
    pid?: number; role?: string;
  };
  assert.equal(marker.role, role);
  assert.ok(Number.isSafeInteger(marker.pid) && Number(marker.pid) > 0);
  return { pid: marker.pid, role };
}

// Never reject the readiness wait into either case's finally block.
// Parent loss, timeout and interruption leave the ownership anchor paused.
let release: (() => void) | undefined;
let readinessTimer: ReturnType<typeof setTimeout> | undefined;
let paused = false;
function parentGone() {
  paused = true;
  release = undefined;
  clearTimeout(readinessTimer);
}
function send(message: unknown) {
  try {
    if (!process.connected || !process.send) return parentGone();
    process.send(message, error => { if (error) parentGone(); });
  } catch {
    parentGone();
  }
}
process.on('error', parentGone);
process.on('disconnect', parentGone);
process.stdout.on('error', parentGone);
process.stderr.on('error', parentGone);
process.on('message', (message: { type?: string }) => {
  if (message.type !== 'continue' || paused || !release) return;
  if (process.argv[3] !== 'pass' && process.argv[3] !== 'failure') return;
  clearTimeout(readinessTimer);
  const resume = release;
  release = undefined;
  resume();
});
async function ready(root: string, required: RequiredProcess[]) {
  assert.equal(root, ownedRoot);
  await new Promise<void>(resolve => {
    if (paused) return;
    release = resolve;
    readinessTimer = setTimeout(() => {
      parentGone();
      send({ type: 'barrierFault', error: 'observer continuation timed out' });
    }, 30_000);
    send({ type: 'ready', root, required });
  });
  if (process.argv[3] === 'failure') assert.fail('deliberate failure after readiness');
}

/**
 * The stand-in for lifemodel: it writes a file when it is up, and on SIGTERM
 * it does 150 ms of "drain" work before leaving with 0. A loader that killed
 * it would leave no file behind. Its marker path is BAKED IN, not passed
 * through the environment: the supervisor builds the child's environment from
 * the explicit boundary of loader/src/env-boundary.ts now - the named
 * variables the product reads - and a stand-in's marker path is not one of
 * them (finding 6 residual).
 */
const INSTANCE_SOURCE = (marker: string, role: string): string => `
const { writeFileSync } = require('node:fs');
const marker = ${JSON.stringify(marker)};
writeFileSync(marker + '.identity.json', JSON.stringify({
  pid: process.pid, role: ${JSON.stringify(role)}
}));
writeFileSync(marker + '.up', 'up\\n');
process.on('SIGTERM', () => {
  setTimeout(() => {
    writeFileSync(marker, 'drained and left\\n');
    process.exit(0);
  }, 150);
});
setInterval(() => {}, 1000);
`;

const CADDY_SOURCE = (identityFile: string): string => `#!/bin/sh
printf '{"pid":%s,"role":"caddy"}\\n' "$$" > ${JSON.stringify(identityFile)}
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
const AGENT_VAULT_SOURCE = (caFile: string, identityFile: string): string => `#!/usr/bin/env node
const { createServer } = require('node:http');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const cliDir = join(process.env.HOME, '.agent-vault');

if (args[0] === 'server') {
  writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({
    pid: process.pid, role: 'vault'
  }));
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
  process.stdout.write(readFileSync(${JSON.stringify(caFile)}, 'utf8'));
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
  assert.equal(volumeConstructed, false);
  volumeConstructed = true;
  // Ownership was registered before startup, including before config can throw.
  const root = ownedRoot;
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'dist'), { recursive: true });
  const marker = join(root, 'lifemodel-marker');
  writeFileSync(
    join(repo, 'dist', 'index.js'),
    INSTANCE_SOURCE(marker, process.argv[2] === 'loader' ? 'lifemodel-standin' : 'instance')
  );
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

async function loaderCase() {
    const standIn = makeStandInVolume();
    const caFile = join(standIn.root, 'synthetic-ca.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(standIn.root, 'synthetic-ca.key'),
        '-out',
        caFile,
        '-days',
        '1',
        '-subj',
        '/CN=loader-signal-test-ca',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
      ],
      { timeout: 10_000, stdio: 'ignore' }
    );
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
    writeFileSync(
      config.caddy.binary,
      CADDY_SOURCE(join(standIn.root, 'caddy.identity.json')),
      { mode: 0o755 }
    );
    writeFileSync(config.caddy.config, ':80 {\n}\n');
    writeFileSync(
      config.agentVault.binary,
      AGENT_VAULT_SOURCE(caFile, join(standIn.root, 'vault.identity.json')),
      { mode: 0o755 }
    );
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
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -j REJECT --reject-with icmp-port-unreachable',
        '-C OUTPUT -j LIFEMODEL_EGRESS',
        '-A OUTPUT -j LIFEMODEL_EGRESS',
        '-L LIFEMODEL_EGRESS -n',
        '-N LIFEMODEL_EGRESS',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -p tcp -d ::1 --dport 14322 -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
        '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -j REJECT --reject-with icmp6-port-unreachable',
        '-C OUTPUT -j LIFEMODEL_EGRESS',
        '-A OUTPUT -j LIFEMODEL_EGRESS',
      ]);
      await waitUntil(() => existsSync(`${standIn.marker}.up`), 'the stand-in for lifemodel is up');
      await ready(standIn.root, [
        { pid: loader.pid, role: 'loader' },
        markedProcess(`${standIn.marker}.identity.json`, 'lifemodel-standin'),
        markedProcess(join(standIn.root, 'caddy.identity.json'), 'caddy'),
        markedProcess(join(standIn.root, 'vault.identity.json'), 'vault'),
      ]);

      const exit = new Promise<number | null>((resolve) => {
        loader.once('close', (code) => resolve(code));
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
      // The external guard owns group cleanup, including assertion failures.
    }
}

async function supervisorCase() {
    const standIn = makeStandInVolume();
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
      await ready(standIn.root, [
        markedProcess(`${standIn.marker}.identity.json`, 'instance'),
      ]);

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
}

// Stay live as the guard's ownership anchor, including while ready is paused.
process.on('SIGINT', parentGone);
process.on('SIGTERM', parentGone);
setInterval(() => undefined, 1000);

try {
  if (process.argv[2] === 'loader') await loaderCase();
  else if (process.argv[2] === 'supervisor') await supervisorCase();
  else throw new Error('unknown signal fixture case');
  send({ type: 'result', code: 0, roots });
} catch (error) {
  send({ type: 'result', code: 1, roots, error: String(error) });
}

// The external guard removes ownedRoot only after proven group settlement.
// Failed settlement retains the root and the observer's control evidence.
