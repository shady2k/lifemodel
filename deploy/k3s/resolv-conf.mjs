#!/usr/bin/env node
// The resolv.conf k3s gives the kubelet and CoreDNS (lifemodel-s9v5.1.5).
//
// k3s points the kubelet at one resolv.conf (`--resolv-conf`). The kubelet
// reads that file every time it builds a pod's DNS configuration, so the file
// decides which upstream resolver the cluster's own DNS uses: the CoreDNS pods
// run with `dnsPolicy: Default` and forward to the nameservers copied into them
// from this file, and every other pod asks the cluster DNS, which is CoreDNS.
//
// k3s's own choice of that file rejects a host file unless every `nameserver`
// line is a global unicast address. One link-local address with a zone, or a
// loopback one, makes k3s discard the whole file and use 8.8.8.8, which hides
// the owner's LAN resolver from every pod: a LAN-only model endpoint stops
// resolving inside the cluster.
//
// This script writes the file k3s is pointed at: the host's usable nameserver
// lines, the host's other lines unchanged, and k3s's own fallback nameservers
// when none of them is usable. It adds no per-domain rules: the pods ask the
// host's resolvers themselves.
//
// Usage: resolv-conf.mjs TARGET SOURCE [SOURCE...]
//   Writes TARGET (creating its directory) from the first SOURCE that has a
//   usable nameserver, and from the first SOURCE that can be read when none has
//   one - the order k3s itself uses to choose a file, with the host's own
//   resolv.conf first and systemd-resolved's list of real upstream servers
//   second (its stub file holds only 127.0.0.53). Prints "changed" when TARGET's
//   bytes changed and "unchanged" otherwise, so the caller can decide whether
//   the pods that copied the old nameservers have to be recreated. A SOURCE
//   that cannot be read is reported on stderr and skipped.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

// The pair k3s itself writes when it finds no usable nameserver.
const FALLBACK_NAMESERVERS = ['8.8.8.8', '2001:4860:4860::8888'];
// The one link-local address k3s keeps: instances reach private DNS through it.
const INSTANCE_METADATA = '169.254.169.254';

function usableIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4) return false;
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  if (first === 0 || first === 127) return false; // "this network", loopback
  if (first >= 224) return false; // multicast, reserved, broadcast
  if (first === 169 && second === 254) return address === INSTANCE_METADATA; // link-local
  return true;
}

function ipv6Groups(address) {
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const groups = (part) =>
    part === ''
      ? []
      : part
          .split(':')
          .flatMap((group) =>
            group.includes('.')
              ? [
                  (Number(group.split('.')[0]) << 8) | Number(group.split('.')[1]),
                  (Number(group.split('.')[2]) << 8) | Number(group.split('.')[3]),
                ]
              : [Number.parseInt(group, 16)]
          );
  const headGroups = groups(head);
  if (tail === null) return headGroups;
  const tailGroups = groups(tail);
  const compressed = 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...new Array(Math.max(compressed, 0)).fill(0), ...tailGroups];
}

function usableIpv6(address) {
  const groups = ipv6Groups(address);
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return false;
  const leading = groups.slice(0, 7);
  if (groups.every((group) => group === 0)) return false; // ::
  if (leading.every((group) => group === 0) && groups[7] === 1) return false; // ::1
  const [first] = groups;
  if ((first & 0xffc0) === 0xfe80) return false; // link-local unicast, fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast, ff00::/8
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    // An IPv4-mapped address resolves as the IPv4 address it carries.
    const [, , , , , , high, low] = groups;
    return usableIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return true;
}

// k3s keeps the whole file only when every nameserver in it is a global unicast
// address, so an entry k3s would reject has to leave the file it is given.
function usableNameserver(address) {
  const version = isIP(address);
  if (version === 4) return usableIpv4(address);
  if (version === 6) return usableIpv6(address);
  return false;
}

function hostLines(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The host's usable nameserver lines, every other line as the host wrote it.
function usableLines(hostText) {
  const kept = [];
  let foundNameserver = false;
  for (const line of hostLines(hostText)) {
    const [keyword, address] = line.trim().split(/\s+/);
    if (keyword === 'nameserver') {
      if (address === undefined || !usableNameserver(address)) continue;
      foundNameserver = true;
    }
    kept.push(line);
  }
  return { kept, foundNameserver };
}

function resolvConfFor(sources) {
  const read = sources.map((source) => {
    try {
      return readFileSync(source, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`resolv-conf: cannot read ${source}: ${reason}\n`);
      return null;
    }
  });
  const firstUsable = read.find((text) => text !== null && usableLines(text).foundNameserver);
  // Nothing usable anywhere: k3s's own fallback nameservers, beside whatever the
  // host did set (its search list, its options).
  const chosen = firstUsable ?? read.find((text) => text !== null);
  if (chosen === undefined || chosen === null) {
    return `${FALLBACK_NAMESERVERS.map((address) => `nameserver ${address}`).join('\n')}\n`;
  }
  const { kept, foundNameserver } = usableLines(chosen);
  const lines = foundNameserver
    ? kept
    : [...kept, ...FALLBACK_NAMESERVERS.map((address) => `nameserver ${address}`)];
  return `${lines.join('\n')}\n`;
}

function writeIfChanged(target, content) {
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o644 });
  renameSync(temporary, target);
  return true;
}

const [target, ...sources] = process.argv.slice(2);
if (target === undefined || sources.length === 0) {
  process.stderr.write('usage: resolv-conf.mjs TARGET SOURCE [SOURCE...]\n');
  process.exit(2);
}
const changed = writeIfChanged(target, resolvConfFor(sources));
process.stdout.write(`${changed ? 'changed' : 'unchanged'}\n`);
