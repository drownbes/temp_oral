import dns from 'node:dns';
import net from 'node:net';
import { SourceFetchError } from '../../domain/errors.ts';

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
const BLOCKED_SUBNETS: readonly [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) needs no rule: BlockList checks it against the IPv4 rules
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

const blockList = new net.BlockList();
for (const [address, prefix, type] of BLOCKED_SUBNETS) blockList.addSubnet(address, prefix, type);

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Fails for URLs whose host is a literal IP in a blocked range (no DNS lookup happens). */
export function assertPublicHost(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedAddress(host)) {
    throw new SourceFetchError(`${url.host} is a private or reserved address`);
  }
}

/**
 * `net.connect` lookup that refuses hostnames resolving to blocked addresses. Checking at
 * connect time (not before the request) also stops DNS rebinding and redirects to them.
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const blocked = addresses.find((a) => isBlockedAddress(a.address));
    if (blocked) {
      return callback(
        new SourceFetchError(`${hostname} resolves to private address ${blocked.address}`),
        '',
        0,
      );
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    if (!first) return callback(new Error(`no addresses for ${hostname}`), '', 0);
    return callback(null, first.address, first.family);
  });
};
