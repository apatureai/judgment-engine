import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateFiles, fixturesDir, resolveRequestPath, serveDirectory } from "../src/index.js";

const DEMO_SITE = join(fixturesDir(), "demo-site");

describe("resolveRequestPath", () => {
  it("resolves a path inside the served root", () => {
    expect(resolveRequestPath("/srv/site", "/style.css")).toBe("/srv/site/style.css");
  });

  it("neutralises traversal in an absolute request path", () => {
    // A leading slash makes `..` collapse at the root, so these land inside it.
    expect(resolveRequestPath("/srv/site", "/../secrets")).toBe("/srv/site/secrets");
    expect(resolveRequestPath("/srv/site", "/%2e%2e/%2e%2e/etc/passwd")).toBe("/srv/site/etc/passwd");
  });

  it("returns null for any path that still escapes the root", () => {
    expect(resolveRequestPath("/srv/site", "../../etc/passwd")).toBeNull();
  });

  it("ignores the query string", () => {
    expect(resolveRequestPath("/srv/site", "/style.css?v=2")).toBe("/srv/site/style.css");
  });
});

describe("candidateFiles", () => {
  it("tries <path>.html then <path>/index.html for extensionless routes", () => {
    expect(candidateFiles("/srv/site/pricing")).toEqual([
      "/srv/site/pricing.html",
      "/srv/site/pricing/index.html",
    ]);
  });

  it("uses the exact path when it has an extension", () => {
    expect(candidateFiles("/srv/site/style.css")).toEqual(["/srv/site/style.css"]);
  });
});

describe("serveDirectory", () => {
  it("serves the bundled demo site over loopback with correct content types", async () => {
    const site = await serveDirectory(DEMO_SITE);
    try {
      expect(site.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const index = await fetch(`${site.baseUrl}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await index.text()).toContain("Ship dashboards your team actually reads.");

      const pricing = await fetch(`${site.baseUrl}/pricing`);
      expect(pricing.status).toBe(200);
      expect(await pricing.text()).toContain("plan-scale-cta");

      const css = await fetch(`${site.baseUrl}/style.css`);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

      expect((await fetch(`${site.baseUrl}/nope`)).status).toBe(404);
    } finally {
      await site.close();
    }
  });
});
