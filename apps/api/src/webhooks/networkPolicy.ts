import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/*
 * Where outbound webhooks may go. Merchants choose webhook URLs and the
 * server makes requests to them, so in production they must never reach
 * loopback, private, link-local (cloud metadata) or other reserved ranges.
 */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast and reserved, up to 255.255.255.255
];

/** True for addresses an outbound webhook must never connect to. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return IPV4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return false;
}

/** Hostname as URL gives it ("[::1]" -> "::1"). */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Synchronous check for a URL's literal host: localhost names and blocked IPs. */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isBlockedAddress(host);
}

/** Resolves the host and reports whether ANY address it maps to is blocked. */
export async function resolvesToBlockedAddress(hostname: string): Promise<boolean> {
  const host = bareHost(hostname);
  if (isBlockedHostLiteral(host)) return true;
  if (isIP(host)) return false;
  const addresses = await lookup(host, { all: true });
  return addresses.some((a) => isBlockedAddress(a.address));
}
