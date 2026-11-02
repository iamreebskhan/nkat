/**
 * Where a clearinghouse connection may point (0120).
 *
 * An org admin types the SFTP host and the CORE and API URLs, and the server
 * then connects to them. Unguarded, that is a way to make Pallio's server
 * reach anything on its own network (the database, a metadata endpoint, an
 * admin port) and report back whether it answered. So a connection may only
 * reach a public address, over TLS for HTTP: the host is resolved and every
 * address it resolves to is checked, and SFTP connects to the very address
 * that was checked, so a second lookup cannot swap it for a private one.
 *
 * Local development needs the opposite, a stand-in clearinghouse on this
 * machine (scripts/dev/mock-clearinghouse.mjs), so CLEARINGHOUSE_ALLOW_PRIVATE_HOSTS=1
 * lifts the check — and is ignored when NODE_ENV is production.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { ValidationError } from "@/lib/api";

export function privateHostsAllowed(): boolean {
  return process.env.CLEARINGHOUSE_ALLOW_PRIVATE_HOSTS === "1" && process.env.NODE_ENV !== "production";
}

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(ip);
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return v4Private(mapped[1]!);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}

/**
 * The address to connect to for `host`, once every address it resolves to is
 * public. Throws a ValidationError naming the host otherwise.
 */
export async function resolvePublicHost(host: string): Promise<string> {
  if (privateHostsAllowed()) return host;
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ValidationError(`${host} is a private address; a clearinghouse is reached at a public host.`);
    return host;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ValidationError(`${host} could not be found. Check the host name the clearinghouse gave you.`);
  }
  if (addresses.length === 0) throw new ValidationError(`${host} could not be found.`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ValidationError(`${host} resolves to a private address; a clearinghouse is reached at a public host.`);
  }
  return addresses[0]!.address;
}

/** An HTTPS URL on a public host (plain HTTP only for the local stand-in). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`${raw} is not a URL.`);
  }
  if (url.protocol !== "https:" && !(privateHostsAllowed() && url.protocol === "http:")) {
    throw new ValidationError("A clearinghouse endpoint is reached over HTTPS.");
  }
  if (url.username || url.password) throw new ValidationError("Put credentials in the connection's fields, not in the URL.");
  await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, ""));
  return url;
}
