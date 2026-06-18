import type { RepoContext } from "@engine/types";
import { describe, expect, it } from "vitest";
import { critique } from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: "ui-dna@2026.06.12",
  contentHash: "abc",
};

describe("critique (stub)", () => {
  it("returns a version-stamped Critique implementing the core contract", async () => {
    const result = await critique([], context, { depth: "deep" });
    expect(["ship", "ship_with_nits", "needs_work", "blocked"]).toContain(result.grade);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12"); // passes the genome stamp through
    expect(result.metadata.engineVersion).toBeTruthy();
    expect(result.validation.hallucinationDrops).toBe(0);
  });
});
