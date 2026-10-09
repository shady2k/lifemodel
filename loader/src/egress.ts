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
 *   uid 1000 (lifemodel's user) may open a connection to the NAMED loopback
 *   services only - the Agent Vault proxy port (14322), the loader's own
 *   interface (7000), the container's resolver's DNS port - each protocol and
 *   destination-port bound, and everything else from that uid is REJECTed.
 *   The parent decision allows the proxy port and the loopback services
 *   lifemodel needs, not every loopback listener: the allows are named in
 *   `referenceRules()` below, with the reason of each. Every other uid, root
 *   included (the loader, Caddy, Agent Vault), is untouched: the rule names
 *   the one uid it confines, and the traffic that leaves the container
 *   through the vault's proxy is root's.
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
import { readFile } from 'node:fs/promises';

import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { CommandResult, CommandRunner } from './exec.js';
import type { LoaderLogger } from './logger.js';
import { describe } from './state.js';

/** The address the named loopback services answer on. */
const LOOPBACK = '127.0.0.1';

/** The answer a REJECTed connection gets, and what makes it fail at once. */
const REJECT_WITH = 'icmp-port-unreachable';
/** The IPv6 family's answer for the same refusal. */
const REJECT_WITH6 = 'icmp6-port-unreachable';

/** The address the named loopback services answer on, in the IPv6 family. */
const LOOPBACK6 = '::1';

/** The capability the container needs for this rule to be installable at all. */
export const EGRESS_CAPABILITY = '--cap-add NET_ADMIN';

/**
 * Whether the container has an IPv6 address or route at all: the kernel
 * reports every address in `/proc/net/if_inet6`, so a read of it is the whole
 * question. An empty file (or no file - a kernel without IPv6 cannot have IPv6
 * traffic either) means there is no IPv6 path to confine and none for a bypass
 * to use. The path is on the loader's configuration (`egress.procPath`), so a
 * test can place its own - and the image carries `ip6tables`, the binary that
 * lets the IPv6 half of the rule be installed when the answer is yes.
 */
export async function ipv6IsPresentAt(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).trim() !== '';
  } catch {
    return false;
  }
}

export interface EgressDeps {
  runner: CommandRunner;
  logger: LoaderLogger;
  config: LoaderConfig;
}

export interface Egress {
  /** Install the rule; idempotent, and fatal when the container cannot carry it. */
  install(): Promise<void>;
  /** The IPv4 rule as the loader installs it, for a test and for the log line. */
  rules(): string[][];
  /** The IPv6 rule, when the container has an address for it to confine. */
  rules6(): Promise<string[][]>;
}

export function createEgress(deps: EgressDeps): Egress {
  const { runner, logger, config } = deps;
  const binary = config.egress.binary;
  const chain = config.egress.chain;
  const uid = config.lifemodel.uid;

  /**
   * The NAMED loopback services uid 1000 may reach, protocol and port bound,
   * and REJECT for everything else from that uid. The parent decision reads
   * "Agent Vault's proxy port (and loopback services it needs)" - not simply
   * "loopback" - so each allow is named here with its reason, and every
   * loopback listener the loader does not name is unreachable for uid 1000,
   * the vault's own management interface on 14321 among them (which is what
   * uid 1000 must NOT open, without the loader's login):
   *
   *   - the Agent Vault PROXY port (TCP): the one way out the stage exists to
   *     give - lifemodel's https and http traffic leaves through it, key
   *     attached on the way out (story S5);
   *   - the loader's OWN interface port (TCP): the instance's HTTP surface on
   *     loopback - the `lifemodel status|panic|resume` command line talks to
   *     it over loopback, and Caddy asks it about every request; the rule
   *     never refused it before;
   *   - the container's embedded resolver's DNS port (UDP and TCP): a
   *     container user's own name lookups (getaddrinfo: /lib) go there -
   *     resolving a NAME is not egress; the DIAL to a resolved address still
   *     meets the REJECT below, as the gated walk checks directly.
   */
  function referenceRules(): string[][] {
    const allow = (port: number, protocol: 'tcp' | 'udp', destination: string): string[] => [
      '-m',
      'owner',
      '--uid-owner',
      String(uid),
      '-p',
      protocol,
      '-d',
      destination,
      '--dport',
      String(port),
      '-j',
      'ACCEPT',
    ];
    const rules: string[][] = [
      allow(config.agentVault.proxyPort, 'tcp', LOOPBACK),
      allow(config.httpPort, 'tcp', LOOPBACK),
    ];
    // The resolver the container itself points its clients at; empty when a
    // container has none of its own (a name lookup then simply fails as one).
    if (config.egress.resolver !== '') {
      rules.push(allow(53, 'udp', config.egress.resolver));
      rules.push(allow(53, 'tcp', config.egress.resolver));
    }
    rules.push([
      '-m',
      'owner',
      '--uid-owner',
      String(uid),
      '-j',
      'REJECT',
      '--reject-with',
      REJECT_WITH,
    ]);
    return rules;
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
  /**
   * One call of one family's binary. When the IPv6 family's call cannot carry
   * its part while the container HAS an IPv6 address or route, the rule cannot
   * be the boundary that keeps uid 1000's egress inside - so the failure is
   * said in one line that names the unconfined IPv6 path, as the missing input
   * it is, rather than a gap a document could excuse.
   */
  async function iptables(
    binary: string,
    args: string[],
    what: string,
    allowFailure = false,
    ipv6 = false
  ): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await runner.run(binary, args);
    } catch (error) {
      throw new LoaderFatalError(
        ipv6
          ? `the egress rule could not be installed: ${binary} could not be run (${describe(error)}); the container has an IPv6 address or route, so an UNCONFINED IPv6 PATH EXISTS for lifemodel's user - install ip6tables in the image and keep ${EGRESS_CAPABILITY}`
          : `the egress rule could not be installed: ${binary} could not be run (${describe(error)}), so lifemodel's traffic could not be confined to the Agent Vault proxy`,
        { cause: error }
      );
    }
    if (result.code !== 0 && !allowFailure) {
      throw new LoaderFatalError(
        ipv6
          ? `the egress rule could not be installed: ${binary} ${args.join(' ')} answered "${lastLine(result)}" (${what}); the container has an IPv6 address or route, so an UNCONFINED IPv6 PATH EXISTS for lifemodel's user - the container needs the NET_ADMIN capability - ${EGRESS_CAPABILITY}`
          : `the egress rule could not be installed: ${binary} ${args.join(' ')} answered "${lastLine(result)}" (${what}); the container needs the NET_ADMIN capability - ${EGRESS_CAPABILITY}`
      );
    }
    return result;
  }

  async function ensureChain(binary: string, chain: string, ipv6 = false): Promise<void> {
    // `-L <chain>` answers 1 when the chain is not there: the one failure that
    // is an answer rather than a refusal.
    const listed = await iptables(binary, ['-L', chain, '-n'], 'looking for the rule', true, ipv6);
    if (listed.code === 0) {
      // A chain left by an earlier start in this network namespace: empty it,
      // so the rules below are the rules, once.
      await iptables(binary, ['-F', chain], `emptying ${chain}`, false, ipv6);
      return;
    }
    await iptables(binary, ['-N', chain], `creating ${chain}`, false, ipv6);
  }

  async function ensureJump(binary: string, chain: string, ipv6 = false): Promise<void> {
    // The question first: is the jump into the loader's chain already there?
    const present = await iptables(
      binary,
      ['-C', 'OUTPUT', '-j', chain],
      'checking the jump',
      true,
      ipv6
    );
    if (present.code === 0) return;
    await iptables(
      binary,
      ['-A', 'OUTPUT', '-j', chain],
      `jumping from OUTPUT to ${chain}`,
      false,
      ipv6
    );
  }

  /** The IPv6 half of the rule: the same named services over `::1`, by parity
   * with the IPv4 allows (the vault binds 127.0.0.1 today, so the `::1` allow
   * names its port for the day it binds the loopback of that family too), and
   * REJECT for everything else - which is what keeps an address the container
   * was GIVEN by an IPv6-enabled network (the Docker `--ipv6` subnets) from
   * being the way around the whole boundary. */
  function referenceRules6(): string[][] {
    return [
      [
        '-m',
        'owner',
        '--uid-owner',
        String(uid),
        '-p',
        'tcp',
        '-d',
        LOOPBACK6,
        '--dport',
        String(config.agentVault.proxyPort),
        '-j',
        'ACCEPT',
      ],
      ['-m', 'owner', '--uid-owner', String(uid), '-j', 'REJECT', '--reject-with', REJECT_WITH6],
    ];
  }

  async function install(): Promise<void> {
    await ensureChain(binary, chain);
    for (const rule of referenceRules()) {
      await iptables(binary, ['-A', chain, ...rule], `adding a rule to ${chain}`);
    }
    await ensureJump(binary, chain);
    // The IPv6 half: without it the family an IPv6-enabled Docker network
    // gives the container would bypass the rule entirely (a uid-1000 dial to
    // an `fd`-range address would leave, no Authorization header asked). So
    // the half is installed whenever the container HAS an IPv6 address or
    // route, and a container where it cannot be installed does not start
    // lifemodel at all - the two states are "confined" and "not started",
    // never "unconfined and going anyway".
    const ipv6Present = await ipv6IsPresentAt(config.egress.procPath);
    if (!ipv6Present) {
      logger.info(
        { procPath: config.egress.procPath },
        'the container has no IPv6 address or route: the rule has no IPv6 path to confine, and none for a bypass to use'
      );
    } else {
      const binary6 = config.egress.ipv6Binary;
      await ensureChain(binary6, chain, true);
      for (const rule of referenceRules6()) {
        await iptables(binary6, ['-A', chain, ...rule], `adding a rule to ${chain}`, false, true);
      }
      await ensureJump(binary6, chain, true);
    }
    logger.info(
      {
        uid,
        loopback: LOOPBACK,
        chain,
        rules: referenceRules().length,
        proxyPort: config.agentVault.proxyPort,
        loaderPort: config.httpPort,
        resolver: config.egress.resolver === '' ? null : config.egress.resolver,
        ipv6: config.egress.ipv6Binary,
      },
      `lifemodel's traffic is confined to the named loopback services (the vault proxy, the loader interface${config.egress.resolver === '' ? '' : ', the resolver'}${ipv6Present ? `, and for IPv6 ${LOOPBACK6}` : ''}): everything else from uid ${String(uid)} is refused`
    );
  }

  return {
    install,
    rules: referenceRules,
    rules6: async () => {
      const present = await ipv6IsPresentAt(config.egress.procPath);
      return present ? referenceRules6() : [];
    },
  };
}
