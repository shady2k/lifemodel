/**
 * The kernel rule that confines lifemodel's egress (lifemodel-q4x.3.2, story
 * S5, decisions 2 and 4).
 *
 * The loader installs it as root before lifemodel starts: uid 1000 reaches
 * 127.0.0.1 (the Agent Vault proxy, the loader's own interface, the container's
 * resolver) and everything else is REJECTed, so a bypass fails at once instead
 * of hanging. The rule is the loader's own chain, refilled on every start, with
 * its jump into OUTPUT added only when it is not there - a container that is
 * restarted ends with one rule, never a stack of them.
 *
 * A container that cannot carry the rule (no iptables, or no CAP_NET_ADMIN) is
 * a missing input of the loader's own: one line saying what and why, and a
 * non-zero exit, with lifemodel never started.
 *
 * Everything here goes through the loader's own interface - the app that
 * installs the rule before it starts lifemodel - and the command boundary is
 * the test's double. Nothing here runs iptables.
 */
import { describe, expect, it } from 'vitest';

import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createLoaderState } from '../../loader/src/state.js';
import {
  createLoaderWorld,
  lifemodelSpawn,
  scriptAgentVault,
  scriptRepository,
  shutdownLoader,
  waitUntil,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

/** The rule this task installs, as the loader runs it. */
const RULE = [
  '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -d 127.0.0.1 -j ACCEPT',
  '-A LIFEMODEL_EGRESS -m owner --uid-owner 1000 -j REJECT --reject-with icmp-port-unreachable',
];

function world(): LoaderWorld {
  const created = createLoaderWorld();
  scriptRepository(created);
  // The vault's own bring-up is not what these tests are about: it is
  // scripted, so what the loader runs for the rule is what they assert on.
  scriptAgentVault(created);
  // A FRESH container is the default: no chain of the loader's yet, and no
  // jump into it. A test that models a restart scripts the other answers.
  const binary = created.config.egress.binary;
  const chain = created.config.egress.chain;
  created.runner.on(`${binary} -L ${chain}`, () => ({
    code: 1,
    stdout: '',
    stderr: `iptables: No chain/target/match by that name.\n`,
  }));
  created.runner.on(`${binary} -C OUTPUT -j ${chain}`, () => ({
    code: 1,
    stdout: '',
    stderr: 'iptables: Bad rule (does a matching rule exist in that chain?).\n',
  }));
  return created;
}

interface Rig {
  app: ReturnType<typeof createLoaderApp>;
  lines: RecordedLine[];
  exits: number[];
}

/** A loader with a password already set, over `found`. */
async function rig(found: LoaderWorld): Promise<Rig> {
  const state = createLoaderState({
    fs: createNodeFileSystem(),
    config: found.config,
    logger: createRecordingLogger([]),
  });
  await state.ensureLayout();
  await state.writeAuth(await hashPassword('right'));
  const lines: RecordedLine[] = [];
  const exits: number[] = [];
  const app = createLoaderApp({
    config: found.config,
    fs: createNodeFileSystem(),
    runner: found.runner,
    launcher: found.launcher,
    logger: createRecordingLogger(lines),
    clock: found.clock,
    exit: (code) => exits.push(code),
    agentVaultProbe: () => Promise.resolve(true),
  });
  await app.start();
  return { app, lines, exits };
}

/** Every iptables command line the loader ran. */
function egressCalls(found: LoaderWorld): string[] {
  const binary = found.config.egress.binary;
  return found.runner.lines().filter((line) => line.startsWith(`${binary} `));
}

describe("the rule that confines lifemodel's egress", () => {
  it('is installed before lifemodel starts: loopback for uid 1000, everything else refused', async () => {
    const found = world();
    const { app, lines, exits } = await rig(found);

    expect(exits).toEqual([]);
    // The chain is made (there was none), filled with the one rule, and
    // OUTPUT jumps into it - in that order, and nothing else.
    const chain = found.config.egress.chain;
    expect(egressCalls(found)).toEqual([
      `iptables -L ${chain} -n`,
      `iptables -N ${chain}`,
      ...RULE.map((rule) => `iptables ${rule}`),
      `iptables -C OUTPUT -j ${chain}`,
      `iptables -A OUTPUT -j ${chain}`,
    ]);
    // The two rules are the rule: only the confined uid is matched, and the
    // refusal is a REJECT (a fail-at-once "connection refused", not a hang).
    const rules = egressCalls(found).filter((line) => line.includes(` -A ${chain} `));
    expect(rules).toHaveLength(RULE.length);
    for (const rule of rules) {
      expect(rule).toContain(`--uid-owner ${String(found.config.lifemodel.uid)}`);
    }
    expect(rules[0]).toContain('-d 127.0.0.1 -j ACCEPT');
    expect(rules[1]).toContain('REJECT --reject-with icmp-port-unreachable');
    // Root is not named anywhere: the rule confines one uid, and the traffic
    // that leaves the container (the vault's own) is root's.
    expect(rules.join('\n')).not.toContain('--uid-owner 0');

    // And it is installed BEFORE lifemodel is started: no lifetime of
    // lifemodel's has an unconfined instant. The instance's own start runs
    // beside this (app.start only asks for it), so it is waited for.
    await waitUntil(() => lifemodelSpawn(found) !== undefined, 'lifemodel is started');
    const installed = lines.findIndex((line) => line.message.includes('traffic is confined'));
    const started = lines.findIndex((line) => line.message.includes('lifemodel started'));
    expect(installed).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(installed);

    await shutdownLoader(found, app);
  });

  it('a chain left behind by an earlier start is emptied, and its jump is not added twice', async () => {
    const found = world();
    const binary = found.config.egress.binary;
    // The state a restart inside the same network namespace leaves: the chain
    // and the jump are there already.
    let chain = true;
    let jump = true;
    found.runner.on(`${binary} -L ${found.config.egress.chain}`, () =>
      chain ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' }
    );
    found.runner.on(`${binary} -N ${found.config.egress.chain}`, () => {
      chain = true;
      return { code: 0, stdout: '', stderr: '' };
    });
    found.runner.on(`${binary} -C OUTPUT -j ${found.config.egress.chain}`, () =>
      jump ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' }
    );
    found.runner.on(`${binary} -A OUTPUT -j ${found.config.egress.chain}`, () => {
      jump = true;
      return { code: 0, stdout: '', stderr: '' };
    });

    const { app } = await rig(found);
    expect(egressCalls(found)).toEqual([
      `iptables -L ${found.config.egress.chain} -n`,
      `iptables -F ${found.config.egress.chain}`,
      ...RULE.map((rule) => `iptables ${rule}`),
      `iptables -C OUTPUT -j ${found.config.egress.chain}`,
    ]);
    await shutdownLoader(found, app);

    // A second start over the same rules: still exactly one jump, still the
    // same two rules (the chain is emptied first, so they cannot stack).
    found.runner.calls.length = 0;
    const second = await rig(found);
    expect(
      egressCalls(found).filter(
        (line) => line === `iptables -A OUTPUT -j ${found.config.egress.chain}`
      )
    ).toEqual([]);
    expect(
      egressCalls(found).filter((line) => line.includes(' -A LIFEMODEL_EGRESS '))
    ).toHaveLength(RULE.length);
    await shutdownLoader(found, second.app);
  });

  it('adds the jump into its chain exactly once, on a container that has none', async () => {
    const found = world();
    const { app } = await rig(found);

    // It asks first, and adds the jump because the answer was no - once.
    expect(found.runner.lines()).toContain(`iptables -C OUTPUT -j ${found.config.egress.chain}`);
    expect(
      found.runner.lines().filter((line) => line === 'iptables -A OUTPUT -j LIFEMODEL_EGRESS')
    ).toHaveLength(1);
    await shutdownLoader(found, app);
  });
});

describe('a container that cannot carry the rule', () => {
  it('says that iptables could not be run, and leaves with a non-zero code', async () => {
    const found = world();
    // The OS has no iptables to run at all: `spawn` fails, it does not answer.
    const inner = found.runner.run.bind(found.runner);
    found.runner.run = (command, args, options) =>
      command === found.config.egress.binary
        ? Promise.reject(new Error('spawn iptables ENOENT'))
        : inner(command, args, options);

    const { lines, exits } = await rig(found);

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('spawn iptables ENOENT');
    expect(errors[0]?.message).toContain('the egress rule could not be installed');
    // lifemodel is never started: no unconfined lifetime exists.
    expect(lifemodelSpawn(found)).toBeUndefined();
  });

  it('names the capability the container is missing when iptables is refused', async () => {
    const found = world();
    // No chain yet, and making it is what the capability is needed for.
    found.runner.on(`iptables -L ${found.config.egress.chain}`, () => ({
      code: 1,
      stdout: '',
      stderr: 'iptables: No chain/target/match by that name.\n',
    }));
    found.runner.on(`iptables -N ${found.config.egress.chain}`, () => ({
      code: 1,
      stdout: '',
      stderr:
        'iptables v1.8.9 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)\n',
    }));

    const { lines, exits } = await rig(found);

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Permission denied (you must be root)');
    expect(errors[0]?.message).toContain('--cap-add NET_ADMIN');
    expect(lifemodelSpawn(found)).toBeUndefined();
  });
});
