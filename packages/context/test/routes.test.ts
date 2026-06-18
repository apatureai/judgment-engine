import { describe, expect, it } from "vitest";
import { mapDiffToRoutes, pageFileToRoute } from "../src/index.js";

describe("pageFileToRoute (App Router)", () => {
  it("maps app page files, dropping route groups and keeping dynamic segments", () => {
    expect(pageFileToRoute("app/page.tsx")).toBe("/");
    expect(pageFileToRoute("app/dashboard/page.tsx")).toBe("/dashboard");
    expect(pageFileToRoute("src/app/settings/page.tsx")).toBe("/settings");
    expect(pageFileToRoute("app/(marketing)/about/page.tsx")).toBe("/about");
    expect(pageFileToRoute("app/blog/[slug]/page.tsx")).toBe("/blog/[slug]");
  });

  it("ignores private (_) and parallel (@) segments and non-page files", () => {
    expect(pageFileToRoute("app/_components/x/page.tsx")).toBeNull();
    expect(pageFileToRoute("app/@modal/page.tsx")).toBeNull();
    expect(pageFileToRoute("components/Button.tsx")).toBeNull();
  });
});

describe("pageFileToRoute (Pages Router)", () => {
  it("maps pages files and excludes index/_app/api", () => {
    expect(pageFileToRoute("pages/index.tsx")).toBe("/");
    expect(pageFileToRoute("pages/about.tsx")).toBe("/about");
    expect(pageFileToRoute("pages/blog/[id].tsx")).toBe("/blog/[id]");
    expect(pageFileToRoute("pages/_app.tsx")).toBeNull();
    expect(pageFileToRoute("pages/api/users.ts")).toBeNull();
  });
});

describe("mapDiffToRoutes", () => {
  it("maps a diff, dedupes + sorts, and honors always/map/maxPerPr", () => {
    const routes = mapDiffToRoutes(
      ["app/dashboard/page.tsx", "components/Button.tsx", "app/page.tsx", "lib/theme.ts"],
      { always: ["/health"], map: { "lib/theme.ts": "/" } },
    );
    expect(routes).toEqual(["/", "/dashboard", "/health"]); // "/" deduped from app/page + map override
  });

  it("caps to max_per_pr", () => {
    const files = ["app/a/page.tsx", "app/b/page.tsx", "app/c/page.tsx"];
    expect(mapDiffToRoutes(files, { maxPerPr: 2 })).toEqual(["/a", "/b"]);
  });

  it("returns an empty list when no page files changed", () => {
    expect(mapDiffToRoutes(["README.md", "lib/util.ts"])).toEqual([]);
  });
});
