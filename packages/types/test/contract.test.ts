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
