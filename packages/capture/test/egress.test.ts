import { describe, expect, it } from "vitest";
import { DomainBudget, evaluateEgress, isPrivateOrReservedIp } from "../src/index.js";

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
