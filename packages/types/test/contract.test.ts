import { describe, expect, it } from "vitest";
import { loadGoldenResult, SCHEMA_VERSION } from "../src/index.js";
import type { EngineReviewResult } from "../src/index.js";

describe("wire contract (cross-repo anchor with Gate)", () => {
  const golden: EngineReviewResult = loadGoldenResult();

  it("the engine wire result IS Gate's GateReviewResult shape", () => {
    expect(["ship", "ship_with_nits", "needs_work", "blocked"]).toContain(golden.grade);
    expect(Array.isArray(golden.findings)).toBe(true);
    expect(Array.isArray(golden.notReviewed)).toBe(true);
    expect(Array.isArray(golden.artifacts.annotatedScreenshots)).toBe(true);
    expect(typeof golden.screenshotRetentionSeconds).toBe("number");
  });

  it("guards every WireFinding field name + type (so the wire type can't drift from the fixture)", () => {
    const f = golden.findings[0];
    if (!f) throw new Error("golden fixture must carry at least one finding to anchor the contract");
    // A rename/removal/type-change in WireFinding (wire.ts) or the fixture breaks this.
    expect(typeof f.id).toBe("string");
    expect(["nit", "minor", "major", "blocker"]).toContain(f.severity);
    expect(typeof f.title).toBe("string");
    expect(typeof f.description).toBe("string");
    expect(typeof f.route).toBe("string");
    expect(["mobile", "tablet", "desktop"]).toContain(f.viewport);
    expect(f.element === null || typeof f.element === "string").toBe(true);
    expect(f.screenshotId === null || typeof f.screenshotId === "string").toBe(true);
    expect(f.suggestion === null || typeof f.suggestion === "string").toBe(true);
    // No extra/renamed keys vs the WireFinding contract.
    expect(Object.keys(f).sort()).toEqual(
      ["description", "element", "id", "route", "screenshotId", "severity", "suggestion", "title", "viewport"],
    );
    // annotatedScreenshots entries keep their {findingId, url} shape.
    const a = golden.artifacts.annotatedScreenshots[0];
    if (a) expect(Object.keys(a).sort()).toEqual(["findingId", "url"]);
  });

  it("carries the version stamp (engine/model/prompt/capture/ui-dna)", () => {
    const m = golden.metadata;
    expect(typeof m.engineVersion).toBe("string");
    expect(typeof m.model).toBe("string");
    expect(typeof m.promptVersion).toBe("string");
    expect(typeof m.captureVersion).toBe("string");
    expect(m.uiDnaVersion === null || typeof m.uiDnaVersion === "string").toBe(true);
  });

  it("is engine-neutral (no Claude/Anthropic hard-coding) and schema v1", () => {
    expect(SCHEMA_VERSION).toBe("1");
    const s = JSON.stringify(golden).toLowerCase();
    expect(s).not.toContain("claude");
    expect(s).not.toContain("anthropic");
  });
});
