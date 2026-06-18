import { describe, expect, it } from "vitest";
import { decideStorageState, originHost, scopeCookiesToOrigin, type Cookie } from "../src/index.js";

describe("decideStorageState", () => {
  it("injects on non-fork PRs when a secret exists", () => {
    expect(
      decideStorageState({ isFork: false, hasStorageState: true, routes: ["/app"] }),
    ).toEqual({ inject: true, notReviewed: [] });
  });

  it("disables on fork PRs and lists the routes not-reviewed-fork-PR", () => {
    const d = decideStorageState({ isFork: true, hasStorageState: true, routes: ["/app", "/me"] });
    expect(d.inject).toBe(false);
    expect(d.notReviewed).toEqual(["/app: not-reviewed-fork-PR", "/me: not-reviewed-fork-PR"]);
  });

  it("does not inject (or mark) when no storageState is configured", () => {
    expect(
      decideStorageState({ isFork: false, hasStorageState: false, routes: ["/app"] }),
    ).toEqual({ inject: false, notReviewed: [] });
  });
});

describe("scopeCookiesToOrigin", () => {
  const cookies: Cookie[] = [
    { name: "preview_session", domain: "preview.example.com" },
    { name: "sso", domain: ".example.com" }, // org-wide parent-domain cookie
    { name: "okta", domain: ".okta.com" },
  ];

  it("keeps only exact-origin cookies, dropping org-wide SSO", () => {
    const scoped = scopeCookiesToOrigin(cookies, "https://preview.example.com/dashboard");
    expect(scoped.map((c) => c.name)).toEqual(["preview_session"]);
  });

  it("extracts the host from an origin URL", () => {
    expect(originHost("https://preview.example.com/x")).toBe("preview.example.com");
  });
});
