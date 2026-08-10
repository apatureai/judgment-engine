/**
 * Capture egress policy (TRD §4.4/§11). The capture browser runs hostile PR
 * preview code, so it must never reach internal/cloud-metadata addresses
 * (SSRF), while still fetching public fonts/images so the page renders.
 *
 * This module is the pure POLICY decision, applied to the *resolved* IP. The
 * worker re-resolves DNS and re-checks here right before connect to defeat
 * rebinding. The kernel-level enforcement (nftables in the guest namespace) is
 * #73; this is the testable allow/deny core plus per-domain rate/size caps.
 */

/**
 * Denied IPv4 ranges: RFC-1918, loopback, link-local (incl. 169.254.169.254, the
 * AWS/GCP/Azure/DO metadata address), unspecified, PLUS the cloud-metadata endpoints that
 * do NOT live in link-local space (the module's purpose is to block ALL cloud
 * metadata, not just the 169.254 ones):
 *   - 100.64.0.0/10 (RFC-6598 shared/CGN): Alibaba Cloud metadata 100.100.100.200,
 *     directly relevant given the DashScope/Qwen dependency; also not globally
 *     routable, so no legitimate public font/image lives there.
 *   - 192.0.0.0/24 (RFC-6890 IETF protocol assignments): Oracle Cloud metadata
 *     192.0.0.192; likewise never a legitimate public resource.
 */
const PRIVATE_V4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
] as const;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inCidrV4(ipInt: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const baseInt = ipv4ToInt(base ?? "");
  const bits = Number(bitsStr);
  if (baseInt === null || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True for any private / loopback / link-local / metadata / reserved address. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const host = ip.trim().toLowerCase();

  const v4 = ipv4ToInt(host);
  if (v4 !== null) return PRIVATE_V4_CIDRS.some((cidr) => inCidrV4(v4, cidr));

  // IPv6
  if (host === "::" || host === "::1") return true; // unspecified / loopback
  // v4-mapped/compat: check the embedded v4 in EITHER form:
  //   dotted  (::ffff:169.254.169.254, ::169.254.169.254)
  //   hex     (::ffff:a9fe:a9fe)  ← the metadata-SSRF bypass if only dotted is checked
  const embedded = embeddedV4(host);
  if (embedded !== null) return PRIVATE_V4_CIDRS.some((cidr) => inCidrV4(embedded, cidr));
  // ULA fc00::/7 (fc/fd) and link-local fe80::/10 (fe8-feb).
  if (/^f[cd]/.test(host)) return true;
  if (/^fe[89ab]/.test(host)) return true;
  return false;
}

/** Extract the embedded IPv4 (as a uint32) from a v4-mapped/compat IPv6, or null. */
function embeddedV4(host: string): number | null {
  // Dotted forms: ::ffff:a.b.c.d  or  ::a.b.c.d
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted?.[1]) return ipv4ToInt(dotted[1]);
  // Hex form: ::ffff:HHHH:HHHH  (the two trailing 16-bit groups are the v4).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return (((high << 16) >>> 0) + low) >>> 0;
  }
  return null;
}

export interface EgressPolicyOptions {
  /** Extra denied exact IPs / v4 CIDRs (known-bad blocklist). */
  blocklist?: string[];
  /** If set, only these hostnames (exact or suffix `.example.com`) may egress. */
  allowedDomains?: string[];
}

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Decide whether the capture browser may connect to `ip` (for `host`). Denies
 * private/reserved ranges and the blocklist; honors an optional domain allowlist.
 */
export function evaluateEgress(
  ip: string,
  host: string | null,
  opts: EgressPolicyOptions = {},
): EgressDecision {
  if (isPrivateOrReservedIp(ip)) {
    return { allowed: false, reason: `private/reserved address ${ip}` };
  }
  const v4 = ipv4ToInt(ip);
  for (const entry of opts.blocklist ?? []) {
    if (entry === ip || (v4 !== null && entry.includes("/") && inCidrV4(v4, entry))) {
      return { allowed: false, reason: `blocklisted ${ip}` };
    }
  }
  if (opts.allowedDomains && host && !hostAllowed(host.toLowerCase(), opts.allowedDomains)) {
    return { allowed: false, reason: `domain not allowlisted: ${host}` };
  }
  return { allowed: true };
}

/** Resolve a hostname to its current A/AAAA addresses (injected; node `dns` in prod). */
export type Resolver = (host: string) => Promise<string[]>;

/**
 * Connect-time egress check for a hostname (TRD §4.4/§11). Re-resolves `host`
 * RIGHT BEFORE connect and applies {@link evaluateEgress} to EVERY resolved
 * address, so a DNS-rebind that flips a name from a public record (at
 * validation) to an internal one (at connect) is caught here and fails closed.
 * Denies if resolution is empty/throws or ANY address is internal, so a name that
 * round-robins a public and a private record never passes. The worker must pin
 * the socket to an address this approved (no third resolution before connect).
 */
export async function checkEgressForHost(
  host: string,
  resolve: Resolver,
  opts: EgressPolicyOptions = {},
): Promise<EgressDecision> {
  const lower = host.toLowerCase();
  if (opts.allowedDomains && !hostAllowed(lower, opts.allowedDomains)) {
    return { allowed: false, reason: `domain not allowlisted: ${host}` };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { allowed: false, reason: `dns resolution failed for ${host}` };
  }
  if (addresses.length === 0) return { allowed: false, reason: `no DNS resolution for ${host}` };
  for (const ip of addresses) {
    const decision = evaluateEgress(ip, host, opts);
    if (!decision.allowed) return decision; // fail closed on any internal address
  }
  return { allowed: true };
}

export interface DomainCaps {
  /** Max requests per domain for one capture. */
  maxRequests: number;
  /** Max total bytes per domain for one capture. */
  maxBytes: number;
}

/**
 * Per-domain rate + size cap tracker for a single capture, so one preview can't
 * exfiltrate or DoS via the browser. `tryConsume` returns false once a cap is hit.
 */
export class DomainBudget {
  private readonly requests = new Map<string, number>();
  private readonly bytes = new Map<string, number>();

  constructor(private readonly caps: DomainCaps) {}

  tryConsume(domain: string, byteCount: number): boolean {
    const reqs = (this.requests.get(domain) ?? 0) + 1;
    const total = (this.bytes.get(domain) ?? 0) + byteCount;
    if (reqs > this.caps.maxRequests || total > this.caps.maxBytes) return false;
    this.requests.set(domain, reqs);
    this.bytes.set(domain, total);
    return true;
  }
}
