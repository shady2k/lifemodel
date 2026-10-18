#!/usr/bin/env node
// Write only canonical, validated resolver records. Never copy host lines.
// SOURCE order matches k3s: /etc/resolv.conf, then resolved's upstream list.
// The output is kubelet's resolver base; CoreDNS uses dnsPolicy Default.
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
  // Go net.IP.IsGlobalUnicast excludes unspecified, loopback, multicast,
  // link-local and the limited broadcast; it DOES accept 0/8 and 240/4.
  if (address === '0.0.0.0' || address === '255.255.255.255') return false;
  if (first === 127 || (first >= 224 && first <= 239)) return false;
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
  if (address.includes('%') || /[^\x21-\x7e]/.test(address)) return false;
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

// Discard controls (including CR and tabs), non-ASCII and Unicode whitespace
// before classification. Go Fields recognizes U+0085; JS \s does not. None of
// that input can survive, even when it disguises a nameserver keyword.
function usableLines(hostText) {
  const nameservers = [];
  let search = null;
  for (const line of hostLines(hostText)) {
    if (/[^\x20-\x7e]/.test(line)) continue;
    const fields = line.split('#', 1)[0].trim().split(/ +/);
    const [keyword, ...values] = fields;
    if (keyword === 'nameserver' && values.length === 1 && usableNameserver(values[0])) {
      if (nameservers.length < 3) nameservers.push(`nameserver ${values[0]}`);
    } else if (keyword === 'search') {
      const domains = values.map((domain) => domain.toLowerCase());
      const valid =
        domains.length > 0 &&
        domains.length <= 6 &&
        domains.join(' ').length <= 256 &&
        domains.every((domain) =>
          domain
            .split('.')
            .every(
              (label) =>
                label.length >= 1 &&
                label.length <= 63 &&
                /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
            )
        );
      if (valid) search = `search ${domains.join(' ')}`;
    }
  }
  return { nameservers, search };
}

function resolvConfFor(sources) {
  const read = sources.map((source) => {
    try {
      return usableLines(readFileSync(source, 'utf8'));
    } catch (error) {
      process.stderr.write(`resolv-conf: cannot read ${source}: ${error.message}\n`);
      return null;
    }
  });
  const chosen =
    read.find((source) => source !== null && source.nameservers.length > 0) ??
    read.find((source) => source !== null);
  const nameservers =
    chosen?.nameservers.length > 0
      ? chosen.nameservers
      : FALLBACK_NAMESERVERS.map((address) => `nameserver ${address}`);
  return `${[...nameservers, ...(chosen?.search ? [chosen.search] : [])].join('\n')}\n`;
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
