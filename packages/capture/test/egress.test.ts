import { describe, expect, it } from "vitest";
import {
  checkEgressForHost,
  DomainBudget,
  evaluateEgress,
  isPrivateOrReservedIp,
  type Resolver,
} from "../src/index.js";

describe("isPrivateOrReservedIp", () => {
  it("denies RFC-1918, loopback, link-local, and metadata", () => {
    expect(isPrivateOrReservedIp("10.1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true); // cloud metadata
  });

  it("allows public addresses", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
  });

  it("handles IPv6 loopback, ULA, link-local, and v4-mapped (dotted, hex, and compat forms)", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    // Hex-form v4-mapped of the cloud-metadata IP (169.254.169.254 = a9fe:a9fe)
    // must be denied too — the SSRF bypass if only dotted form is checked.
    expect(isPrivateOrReservedIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:0a00:0001")).toBe(true); // 10.0.0.1
    expect(isPrivateOrReservedIp("::169.254.169.254")).toBe(true); // IPv4-compat form
    // A public v4-mapped address is still allowed.
    expect(isPrivateOrReservedIp("::ffff:0808:0808")).toBe(false); // 8.8.8.8
    expect(isPrivateOrReservedIp("2606:4700::1111")).toBe(false);
  });
});

describe("evaluateEgress", () => {
  it("denies private IPs and the blocklist, allows public", () => {
    expect(evaluateEgress("169.254.169.254", "metadata.internal").allowed).toBe(false);
    expect(evaluateEgress("8.8.8.8", "dns.google").allowed).toBe(true);
    expect(evaluateEgress("8.8.4.4", "x", { blocklist: ["8.8.4.4"] }).allowed).toBe(false);
    expect(evaluateEgress("203.0.113.5", "x", { blocklist: ["203.0.113.0/24"] }).allowed).toBe(false);
  });

  it("honors a domain allowlist (suffix match)", () => {
    const opts = { allowedDomains: ["fonts.gstatic.com", "example.com"] };
    expect(evaluateEgress("8.8.8.8", "fonts.gstatic.com", opts).allowed).toBe(true);
    expect(evaluateEgress("8.8.8.8", "cdn.example.com", opts).allowed).toBe(true);
    expect(evaluateEgress("8.8.8.8", "evil.test", opts).allowed).toBe(false);
  });
});

describe("DomainBudget", () => {
  it("caps requests and bytes per domain", () => {
    const budget = new DomainBudget({ maxRequests: 2, maxBytes: 1000 });
    expect(budget.tryConsume("a.com", 400)).toBe(true);
    expect(budget.tryConsume("a.com", 400)).toBe(true);
    expect(budget.tryConsume("a.com", 1)).toBe(false); // 3rd request over the cap
    // A different domain has its own budget.
    expect(budget.tryConsume("b.com", 999)).toBe(true);
    expect(budget.tryConsume("b.com", 2)).toBe(false); // byte cap
  });
});

describe("checkEgressForHost — DNS-rebind recheck at connect (#52, §4.4)", () => {
  /** A resolver that returns a different address on each successive call. */
  const sequence = (...batches: string[][]): Resolver => {
    let i = 0;
    return () => Promise.resolve(batches[Math.min(i++, batches.length - 1)] ?? []);
  };

  it("allows a hostname that resolves only to a public address", async () => {
    const r = await checkEgressForHost("fonts.gstatic.com", () => Promise.resolve(["142.250.0.1"]));
    expect(r.allowed).toBe(true);
  });

  it("fails closed when a rebind flips a name to the metadata IP at connect time", async () => {
    // First resolution (validation) is public; the connect-time re-resolution
    // returns the cloud-metadata IP. The recheck must catch the second value.
    const resolve = sequence(["93.184.216.34"], ["169.254.169.254"]);
    const validation = await checkEgressForHost("evil.test", resolve);
    expect(validation.allowed).toBe(true); // looked benign at validation

    const connect = await checkEgressForHost("evil.test", resolve); // re-resolve before connect
    expect(connect.allowed).toBe(false);
    if (!connect.allowed) expect(connect.reason).toContain("169.254.169.254");
  });

  it("denies if ANY resolved address is internal (mixed public/private round-robin)", async () => {
    const r = await checkEgressForHost("rebind.test", () =>
      Promise.resolve(["93.184.216.34", "10.0.0.5"]),
    );
    expect(r.allowed).toBe(false);
  });

  it("denies an RFC-1918 / link-local resolution and fails closed on empty/throwing DNS", async () => {
    expect((await checkEgressForHost("x.test", () => Promise.resolve(["192.168.1.10"]))).allowed).toBe(false);
    expect((await checkEgressForHost("x.test", () => Promise.resolve(["169.254.1.1"]))).allowed).toBe(false);
    expect((await checkEgressForHost("x.test", () => Promise.resolve([]))).allowed).toBe(false);
    expect((await checkEgressForHost("x.test", () => Promise.reject(new Error("nxdomain")))).allowed).toBe(false);
  });

  it("enforces the ownership-verified domain allowlist before resolving", async () => {
    let resolved = false;
    const resolve: Resolver = () => {
      resolved = true;
      return Promise.resolve(["142.250.0.1"]);
    };
    const r = await checkEgressForHost("evil.test", resolve, { allowedDomains: ["example.com"] });
    expect(r.allowed).toBe(false);
    expect(resolved).toBe(false); // short-circuits before a DNS lookup
  });
});
