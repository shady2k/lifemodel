/**
 * The kernel rule that confines lifemodel's egress (lifemodel-q4x.3.2, story
 * S5, decisions 2, 4 and 12).
 *
 * lifemodel is the untrusted half of the image: it may rewrite its own code,
 * so nothing that matters is allowed to depend on its good behaviour. The
 * proxy environment (HTTPS_PROXY and friends, built in
 * `lifemodelEnvironment()` in loader/src/agent-vault.ts) is a COOPERATIVE
 * control - a process can unset a variable and call a socket - so the loader
 * adds the one control the process cannot talk its way out of: an iptables
 * owner rule, installed as root BEFORE lifemodel starts.
 *
 * What the rule says, and only that:
 *
 *   uid 1000 (lifemodel's user) may open a connection to 127.0.0.1 - the
 *   Agent Vault proxy on 14322, the loader's own interface, the container's
 *   resolver - and anything else is REJECTed. Every other uid, root included
 *   (the loader, Caddy, Agent Vault), is untouched: the rule names the one uid
 *   it confines, and the traffic that leaves the container through the vault's
 *   proxy is root's.
 *
 * REJECT and not DROP: a bypass must fail at once and say so ("Connection
 * refused"), because lifemodel reads that as a connection error and records
 * it; a DROP would leave it waiting for a timeout and look like a hang.
 *
 * The chain is the loader's own (`LIFEMODEL_EGRESS`) and is FLUSHED and
 * REFILLED on every install, with the jump into it added only when it is not
 * there yet: a start that finds rules from an earlier one - inside the same
 * network namespace, which a container keeps while it is restarted - ends with
 * exactly one copy of the rule, never a growing stack.
 *
 * The two things this needs are the loader's OWN inputs, so a container
 * without them does not come up quietly with lifemodel's egress open: the
 * `iptables` binary the image carries, and CAP_NET_ADMIN (`docker run
 * --cap-add NET_ADMIN`). Either one missing is one line saying what and why,
 * and then a non-zero exit.
 */
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandResult, CommandRunner } from './exec.js';
import type { LoaderLogger } from './logger.js';
import { describe } from './state.js';

/** The address lifemodel's user may still reach: Agent Vault and local services. */
const LOOPBACK = '127.0.0.1';

/** The answer a REJECTed connection gets, and what makes it fail at once. */
const REJECT_WITH = 'icmp-port-unreachable';

/** The capability the container needs for this rule to be installable at all. */
export const EGRESS_CAPABILITY = '--cap-add NET_ADMIN';

export interface EgressDeps {
  runner: CommandRunner;
  logger: LoaderLogger;
  config: LoaderConfig;
}

export interface Egress {
  /** Install the rule; idempotent, and fatal when the container cannot carry it. */
  install(): Promise<void>;
  /** The rule as the loader installs it, for a test and for the log line. */
  rules(): string[][];
}

export function createEgress(deps: EgressDeps): Egress {
  const { runner, logger, config } = deps;
  const binary = config.egress.binary;
  const chain = config.egress.chain;
  const uid = config.lifemodel.uid;

  /** The rule, as iptables arguments: loopback for lifemodel's user, and nothing else. */
  function referenceRules(): string[][] {
    return [
      ['-m', 'owner', '--uid-owner', String(uid), '-d', LOOPBACK, '-j', 'ACCEPT'],
      ['-m', 'owner', '--uid-owner', String(uid), '-j', 'REJECT', '--reject-with', REJECT_WITH],
    ];
  }

  /** The last non-empty line a command printed: the reason, in one line. */
  function lastLine(result: CommandResult): string {
    for (const stream of [result.stderr, result.stdout]) {
      const lines = stream
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const last = lines[lines.length - 1];
      if (last !== undefined) return last;
    }
    return 'it printed nothing';
  }

  /**
   * One iptables call. A command the OS would not run at all (no binary, no
   * permission to execute it) is a different missing input from one iptables
   * ran and refused, and the two are told apart here. `allowFailure` is for the
   * questions this module asks (`does the chain exist?`), whose answer is the
   * failure itself.
   */
  async function iptables(
    args: string[],
    what: string,
    allowFailure = false
  ): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await runner.run(binary, args);
    } catch (error) {
      throw new LoaderFatalError(
        `the egress rule could not be installed: ${binary} could not be run (${describe(error)}), so lifemodel's traffic could not be confined to the Agent Vault proxy`,
        { cause: error }
      );
    }
    if (result.code !== 0 && !allowFailure) {
      throw new LoaderFatalError(
        `the egress rule could not be installed: ${binary} ${args.join(' ')} answered "${lastLine(result)}" (${what}); the container needs the NET_ADMIN capability - ${EGRESS_CAPABILITY}`
      );
    }
    return result;
  }

  async function ensureChain(): Promise<void> {
    // `-L <chain>` answers 1 when the chain is not there: the one failure that
    // is an answer rather than a refusal.
    const listed = await iptables(['-L', chain, '-n'], 'looking for the rule', true);
    if (listed.code === 0) {
      // A chain left by an earlier start in this network namespace: empty it,
      // so the rules below are the rules, once.
      await iptables(['-F', chain], `emptying ${chain}`);
      return;
    }
    await iptables(['-N', chain], `creating ${chain}`);
  }

  async function ensureJump(): Promise<void> {
    // The question first: is the jump into the loader's chain already there?
    const present = await iptables(['-C', 'OUTPUT', '-j', chain], 'checking the jump', true);
    if (present.code === 0) return;
    await iptables(['-A', 'OUTPUT', '-j', chain], `jumping from OUTPUT to ${chain}`);
  }

  async function install(): Promise<void> {
    await ensureChain();
    for (const rule of referenceRules()) {
      await iptables(['-A', chain, ...rule], `adding a rule to ${chain}`);
    }
    await ensureJump();
    logger.info(
      { uid, loopback: LOOPBACK, chain, rules: referenceRules().length },
      `lifemodel's traffic is confined to ${LOOPBACK}: uid ${String(uid)} leaves through the Agent Vault proxy or not at all`
    );
  }

  return { install, rules: referenceRules };
}
