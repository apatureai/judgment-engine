import { loadGoldenResult } from "@engine/types";
import type { Critique, Finding } from "@engine/types";
import { describe, expect, it } from "vitest";
import { deriveTitle, toEngineReviewResult, wireFindingId } from "../src/index.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "color_contrast",
  severity: "major",
  confidence: 0.9,
  route: "/pricing",
  viewport: "mobile",
  elementRef: "button[data-testid='cta-primary']",
  evidence: "On the mobile viewport the primary button renders with the default blue.",
  suggestion: "Apply the --color-accent token.",
  introducedByThisPr: true,
  ...over,
});

const critique = (over: Partial<Critique> = {}): Critique => ({
  grade: "needs_work",
  overall: "Mobile layout breaks the design system.",
  findings: [finding()],
  notReviewed: ["route /checkout (no preview)"],
  validation: { hallucinationDrops: 0, captureUnstable: false },
  metadata: {
    engineVersion: "2026.06.0",
    model: "qwen3-vl",
    promptVersion: "gate-design-review@7",
    captureVersion: "playwright-capture@3",
    uiDnaVersion: "ui-dna@2026.06.12",
  },
  ...over,
});

describe("toEngineReviewResult (wire projection — cross-repo contract)", () => {
  it("produces a result whose top-level + finding keys match the golden fixture exactly", () => {
    const golden = loadGoldenResult();
    const result = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 2592000 });

    expect(Object.keys(result).sort()).toEqual(Object.keys(golden).sort());
    expect(Object.keys(result.findings[0]!).sort()).toEqual(Object.keys(golden.findings[0]!).sort());
    expect(Object.keys(result.artifacts).sort()).toEqual(["annotatedScreenshots"]); // engineDebugUrl omitted when absent
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());
  });

  it("maps unambiguous fields and DROPS internal-only ones (dimension/confidence/evidence/introducedByThisPr)", () => {
    const result = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60 });
    const f = result.findings[0]!;
    expect(f).toMatchObject({
      id: "f_001",
      severity: "major",
      description: "On the mobile viewport the primary button renders with the default blue.",
      route: "/pricing",
      viewport: "mobile",
      element: "button[data-testid='cta-primary']",
      screenshotId: null,
      suggestion: "Apply the --color-accent token.",
    });
    expect(f).not.toHaveProperty("dimension");
    expect(f).not.toHaveProperty("confidence");
    expect(f).not.toHaveProperty("evidence");
    expect(f).not.toHaveProperty("introducedByThisPr");
    expect(result.grade).toBe("needs_work");
    expect(result.notReviewed).toEqual(["route /checkout (no preview)"]);
    expect(result.screenshotRetentionSeconds).toBe(60);
  });

  it("assigns stable 1-based ids and wires annotated screenshots for findings that have one", () => {
    const c = critique({ findings: [finding(), finding({ route: "/home" }), finding({ route: "/about" })] });
    const result = toEngineReviewResult(c, {
      screenshotRetentionSeconds: 60,
      // Only the first two findings have a screenshot.
      screenshotIdFor: (_f, i) => (i < 2 ? `shot_${i + 1}` : null),
      artifactUrlFor: (id) => `https://artifacts.internal/${id}.png`,
    });
    expect(result.findings.map((f) => f.id)).toEqual(["f_001", "f_002", "f_003"]);
    expect(result.findings[2]!.screenshotId).toBeNull();
    expect(result.artifacts.annotatedScreenshots).toEqual([
      { findingId: "f_001", url: "https://artifacts.internal/shot_1.png" },
      { findingId: "f_002", url: "https://artifacts.internal/shot_2.png" },
    ]);
  });

  it("includes engineDebugUrl only when provided", () => {
    const withUrl = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60, engineDebugUrl: "https://e/d/1" });
    expect(withUrl.artifacts.engineDebugUrl).toBe("https://e/d/1");
  });

  it("carries the version stamp through untouched", () => {
    const result = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60 });
    expect(result.metadata).toEqual(critique().metadata);
  });
});

describe("deriveTitle / wireFindingId", () => {
  it("uses a short first sentence verbatim as the title", () => {
    expect(deriveTitle("Primary CTA uses an off-brand color on mobile. Details follow.")).toBe(
      "Primary CTA uses an off-brand color on mobile",
    );
  });

  it("word-boundary-truncates + ellipsizes an over-long single sentence", () => {
    const long =
      "The three-column pricing grid does not collapse below the small breakpoint which causes horizontal scrolling on phones";
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(81); // <=80 chars + ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true); // a real prefix, cut at a word
  });

  it("falls back to a generic title on empty evidence", () => {
    expect(deriveTitle("   ")).toBe("Design finding");
  });

  it("zero-pads finding ids", () => {
    expect([0, 8, 9, 99].map(wireFindingId)).toEqual(["f_001", "f_009", "f_010", "f_100"]);
  });
});
