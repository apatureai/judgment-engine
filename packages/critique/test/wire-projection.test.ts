import { hasDisplayableConfidence, loadGoldenResult } from "@engine/types";
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
  title: "Primary CTA uses an off-brand color on mobile",
  description: "On the mobile viewport the primary button renders with the default blue.",
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
    rubricVersion: "design-rubric@1",
    uiDnaVersion: "ui-dna@2026.06.12",
  },
  calibration: {
    reportId: "calibration_qwen3vl_2026_07",
    reportHash: "sha256:675dcd6a31db1157aa84fce80a00d1dd2a591e15877226697134b79269a9ac08",
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
  },
  blockingEnabled: true,
  ...over,
});

describe("toEngineReviewResult (wire projection — cross-repo contract)", () => {
  it("produces a result whose top-level + finding keys match the golden fixture exactly", () => {
    const golden = loadGoldenResult();
    const result = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 2592000 });

    // `provenance` is stamped by the surface that ran the review
    // (`stampJudgmentProvenance` in @engine/cli), not by the projector, because
    // only the surface knows whether a model was actually called. The golden
    // fixture carries the stamp because it is a PUBLISHED result; a projection is
    // one stage earlier.
    const goldenKeys = Object.keys(golden).filter((key) => key !== "provenance");
    expect(Object.keys(result).sort()).toEqual(goldenKeys.sort());
    expect(Object.keys(result.findings[0]!).sort()).toEqual(Object.keys(golden.findings[0]!).sort());
    expect(Object.keys(result.artifacts).sort()).toEqual(["annotatedScreenshots"]); // engineDebugUrl omitted when absent
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());
  });

  it("passes title/description/confidence/dimension through and DROPS only internal-only introducedByThisPr", () => {
    const result = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60 });
    const f = result.findings[0]!;
    expect(f).toMatchObject({
      id: "f_001",
      severity: "major",
      title: "Primary CTA uses an off-brand color on mobile",
      description: "On the mobile viewport the primary button renders with the default blue.",
      route: "/pricing",
      viewport: "mobile",
      element: "button[data-testid='cta-primary']",
      screenshotId: null,
      suggestion: "Apply the --color-accent token.",
      // #150: the engine's ceiling-capped signal crosses the wire untouched.
      confidence: 0.9,
      // #159: the rubric dimension crosses the wire verbatim (no longer dropped).
      dimension: "color_contrast",
    });
    expect(f).not.toHaveProperty("introducedByThisPr");
    expect(result.grade).toBe("needs_work");
    expect(result.notReviewed).toEqual(["route /checkout (no preview)"]);
    expect(result.screenshotRetentionSeconds).toBe(60);
  });

  it("aggregates calibrated findings and never synthesizes clean-result confidence (#160)", () => {
    const mixed = toEngineReviewResult(
      critique({
        findings: [finding({ confidence: 0.92 }), finding({ confidence: 0.61 }), finding({ confidence: 0.85 })],
      }),
      { screenshotRetentionSeconds: 60 },
    );
    expect(mixed.confidence).toBe(0.61);
    expect(mixed.findings.map((f) => f.confidence)).toEqual([0.92, 0.61, 0.85]);

    const clean = toEngineReviewResult(critique({ findings: [] }), { screenshotRetentionSeconds: 60 });
    expect(clean).not.toHaveProperty("confidence");
    expect(clean).not.toHaveProperty("confidenceUnavailableReason");
    expect(hasDisplayableConfidence(clean)).toBe(false);
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

  it("surfaces a page-health footnote in artifacts when present, never in findings (#20)", () => {
    const note = "Page health: 2 console error(s), 1 failed request(s).";
    const result = toEngineReviewResult(critique(), {
      screenshotRetentionSeconds: 60,
      pageHealthFootnote: note,
    });
    expect(result.artifacts.pageHealthFootnote).toBe(note);
    // The footnote is an artifact, not a design finding.
    expect(result.findings.every((f) => f.description !== note && f.title !== note)).toBe(true);
  });

  it("omits the page-health footnote field entirely when the page is clean (#20, golden-safe)", () => {
    const clean = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60 });
    expect(Object.keys(clean.artifacts).sort()).toEqual(["annotatedScreenshots"]);
    expect(clean.artifacts).not.toHaveProperty("pageHealthFootnote");
    const nullNote = toEngineReviewResult(critique(), {
      screenshotRetentionSeconds: 60,
      pageHealthFootnote: null,
    });
    expect(nullNote.artifacts).not.toHaveProperty("pageHealthFootnote");
  });

  it("carries the version stamp through untouched", () => {
    const result = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60 });
    expect(result.metadata).toEqual(critique().metadata);
  });

  it("withholds raw legacy confidence without report provenance and disables blocking", () => {
    const result = toEngineReviewResult(
      critique({ calibration: undefined, blockingEnabled: false, confidenceUnavailableReason: "missing_calibration_report" }),
      { screenshotRetentionSeconds: 60 },
    );
    expect(result).not.toHaveProperty("confidence");
    expect(result.findings[0]).not.toHaveProperty("confidence");
    expect(result.blockingEnabled).toBe(false);
    expect(result.confidenceUnavailableReason).toBe("missing_calibration_report");
    expect(hasDisplayableConfidence(result)).toBe(false);
  });

  it("falls back to a derived title only when the model emits a blank title (#100 defensive)", () => {
    const blank = toEngineReviewResult(critique({ findings: [finding({ title: "   " })] }), {
      screenshotRetentionSeconds: 60,
    });
    // Derived from the description's first sentence.
    expect(blank.findings[0]!.title).toBe("On the mobile viewport the primary button renders with the default blue");
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

  it("falls back to a generic title on empty input", () => {
    expect(deriveTitle("   ")).toBe("Design finding");
  });

  it("zero-pads finding ids", () => {
    expect([0, 8, 9, 99].map(wireFindingId)).toEqual(["f_001", "f_009", "f_010", "f_100"]);
  });
});
