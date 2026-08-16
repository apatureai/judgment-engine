import { describe, expect, it } from "vitest";
import {
  hasDisplayableConfidence,
  loadGoldenResult,
  loadPreCalibrationResult,
  nothingReviewed,
  SCHEMA_VERSION,
} from "../src/index.js";
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

  it("carries the engine-owned result-level confidence: the min over finding confidences (#150)", () => {
    expect(hasDisplayableConfidence(golden)).toBe(true);
    expect(golden.calibration?.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(golden.blockingEnabled).toBe(true);
    expect(typeof golden.confidence).toBe("number");
    const least = Math.min(...golden.findings.map((f) => f.confidence ?? 1));
    expect(golden.confidence).toBe(least);
  });

  it("keeps historical numeric confidence parseable but explicitly unavailable (#160)", () => {
    const historical = loadPreCalibrationResult();
    expect(typeof historical.confidence).toBe("number");
    expect(historical.findings.every((finding) => typeof finding.confidence === "number")).toBe(true);
    expect(historical.calibration).toBeUndefined();
    expect(hasDisplayableConfidence(historical)).toBe(false);
  });

  it("rejects malformed provenance and partially calibrated results (#160)", () => {
    expect(hasDisplayableConfidence({
      ...golden,
      calibration: { ...golden.calibration!, reportHash: "sha256:not-a-digest" },
    })).toBe(false);
    expect(hasDisplayableConfidence({
      ...golden,
      findings: golden.findings.map((finding, index) =>
        index === 0 ? { ...finding, confidence: undefined } : finding),
    })).toBe(false);
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
    // Engine-produced confidence (#150): additive on schema v1, always emitted.
    expect(typeof f.confidence).toBe("number");
    expect(f.confidence).toBeGreaterThanOrEqual(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
    // Rubric dimension (#159): the closed eight-value enum, additive on schema v1.
    expect([
      "visual_hierarchy", "spacing", "color_contrast", "typography",
      "consistency", "responsiveness", "accessibility", "brand",
    ]).toContain(f.dimension);
    // No extra/renamed keys vs the WireFinding contract.
    expect(Object.keys(f).sort()).toEqual(
      ["confidence", "description", "dimension", "element", "id", "route", "screenshotId", "severity", "suggestion", "title", "viewport"],
    );
    // annotatedScreenshots entries keep their {findingId, url} shape.
    const a = golden.artifacts.annotatedScreenshots[0];
    if (a) expect(Object.keys(a).sort()).toEqual(["findingId", "url"]);
  });

  it("#165: is the cross-repo PARTIAL-coverage anchor (skipped route + skipped viewport, real findings)", () => {
    const coverage = golden.coverage;
    if (!coverage) throw new Error("the golden fixture must state coverage");
    expect(coverage.routesRequested).toEqual(["/pricing", "/checkout"]);
    expect(coverage.routesReviewed).toEqual(["/pricing"]);
    expect(coverage.viewportsRequested).toEqual(["mobile", "tablet", "desktop"]);
    expect(coverage.viewportsReviewed).toEqual(["mobile", "desktop"]);
    // Reviewed is a subset of requested: no producer may report reviewing
    // something nobody asked for.
    for (const route of coverage.routesReviewed) expect(coverage.routesRequested).toContain(route);
    for (const vp of coverage.viewportsReviewed) expect(coverage.viewportsRequested).toContain(vp);
    // Partial, but NOT empty: something was reviewed, so the grade is a verdict.
    expect(nothingReviewed(coverage)).toBe(false);
    // ...and every skipped item is named in prose too, so a consumer reading only
    // `notReviewed` still sees it.
    expect(golden.notReviewed.some((line) => line.includes("/checkout"))).toBe(true);
    expect(golden.notReviewed.some((line) => line.includes("tablet"))).toBe(true);
  });

  it("#165: reads an EMPTY reviewed-route set as 'nothing was reviewed', whatever the grade says", () => {
    // The exact state the field exists for: a `ship` grade with zero findings,
    // byte-identical to a clean page apart from this one field.
    expect(
      nothingReviewed({
        routesRequested: ["/pricing"],
        routesReviewed: [],
        viewportsRequested: ["mobile"],
        viewportsReviewed: [],
      }),
    ).toBe(true);
  });

  it("carries the version stamp (engine/model/prompt/capture/ui-dna)", () => {
    const m = golden.metadata;
    expect(typeof m.engineVersion).toBe("string");
    expect(typeof m.model).toBe("string");
    expect(typeof m.promptVersion).toBe("string");
    expect(typeof m.captureVersion).toBe("string");
    expect(typeof m.rubricVersion).toBe("string");
    expect(m.uiDnaVersion === null || typeof m.uiDnaVersion === "string").toBe(true);
  });

  it("is engine-neutral (no Claude/Anthropic hard-coding) and schema v1", () => {
    expect(SCHEMA_VERSION).toBe("1");
    const s = JSON.stringify(golden).toLowerCase();
    expect(s).not.toContain("claude");
    expect(s).not.toContain("anthropic");
  });
});
