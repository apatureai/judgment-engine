import { hasDisplayableConfidence, loadGoldenResult } from "@engine/types";
import type { Critique, Finding, ReviewCoverage } from "@engine/types";
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
    // only the surface knows whether a model was actually called. `coverage`
    // (#165) is supplied by the ORCHESTRATOR for the same kind of reason: only it
    // knows which routes reached a judgment, and a critique with zero findings
    // says nothing about that. The golden fixture carries both because it is a
    // PUBLISHED result; a bare projection is one stage earlier than either.
    const goldenKeys = Object.keys(golden).filter(
      (key) => key !== "provenance" && key !== "coverage",
    );
    // `hallucinationDrops` runs the other way: the projector emits it on every
    // result and the anchor does not carry it yet (the anchor is copied from
    // Gate, whose non-strict schema tolerates and strips a field it does not
    // name). So assert the ADDITIVE relation instead of equality: every anchor
    // key is still emitted, plus the new one. That is what "additive on schema
    // v1" means and it is what keeps an older consumer parsing.
    expect(Object.keys(result).sort()).toEqual([...goldenKeys, "hallucinationDrops"].sort());
    for (const key of goldenKeys) expect(result).toHaveProperty(key);
    expect(Object.keys(result.findings[0]!).sort()).toEqual(Object.keys(golden.findings[0]!).sort());
    expect(Object.keys(result.artifacts).sort()).toEqual(["annotatedScreenshots"]); // engineDebugUrl omitted when absent
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());
  });

  it("#165: emits coverage verbatim when the caller states it, and omits it when it cannot", () => {
    const coverage: ReviewCoverage = {
      routesRequested: ["/pricing", "/checkout"],
      routesReviewed: ["/pricing"],
      viewportsRequested: ["mobile", "tablet", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    };
    const stated = toEngineReviewResult(critique(), {
      screenshotRetentionSeconds: 60,
      coverage,
    });
    expect(stated.coverage).toEqual(coverage);

    // No coverage stated -> the field is absent, never a fabricated "everything".
    const silent = toEngineReviewResult(critique(), { screenshotRetentionSeconds: 60 });
    expect(silent).not.toHaveProperty("coverage");
  });

  it("#32: carries the grounding gate's drop count, so a clean page differs from a fully dropped one", () => {
    const cleanPage = toEngineReviewResult(
      critique({ findings: [], validation: { hallucinationDrops: 0, captureUnstable: false } }),
      { screenshotRetentionSeconds: 60 },
    );
    const allDropped = toEngineReviewResult(
      critique({ findings: [], validation: { hallucinationDrops: 3, captureUnstable: false } }),
      { screenshotRetentionSeconds: 60 },
    );

    expect(cleanPage.hallucinationDrops).toBe(0);
    expect(allDropped.hallucinationDrops).toBe(3);
    // The count is load-bearing: without it these two payloads are the same
    // bytes, and "the page is clean" reads identically to "three findings
    // entered and none of them could be grounded".
    expect({ ...cleanPage, hallucinationDrops: 0 }).toEqual({ ...allDropped, hallucinationDrops: 0 });
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

/**
 * The raw artifact's own consistency (#3).
 *
 * `out/review.json` and the body of `GET /jobs/:id` are the same bytes, and both
 * outlive the terminal report that refuses to print a grade. On a run that
 * judged nothing they read `"grade": "ship"`, `"findings": []` and whatever
 * sentence the run had produced, which on the commonest such path is the triage
 * model's "Triage found no issues warranting a deep review." Gate, Bastion and
 * the CLI report all check coverage first and withhold the grade; a fourth party
 * opening the file got a green verdict nothing had earned.
 */
describe("toEngineReviewResult on a run that reviewed nothing", () => {
  const nothing: ReviewCoverage = {
    routesRequested: ["/pricing", "/checkout"],
    routesReviewed: [],
    viewportsRequested: ["mobile", "desktop"],
    viewportsReviewed: [],
  };
  const something: ReviewCoverage = { ...nothing, routesReviewed: ["/pricing"] };

  const unjudged = critique({
    grade: "ship",
    overall: "Triage found no issues warranting a deep review.",
    findings: [],
    notReviewed: ["/pricing: no baseline, so nothing was compared against anything"],
  });

  it("retracts the grade in band rather than leaving `ship` to speak for itself", () => {
    const result = toEngineReviewResult(unjudged, {
      screenshotRetentionSeconds: 60,
      coverage: nothing,
    });
    // `grade` itself is unchanged: it is a required closed enum in the
    // cross-repo contract and Gate's parser blocks publish on anything else.
    expect(result.grade).toBe("ship");
    expect(result.gradeUnavailableReason).toBe("nothing_reviewed");
  });

  it("stops the run's own prose from reading as a verdict, and keeps it verbatim", () => {
    const result = toEngineReviewResult(unjudged, {
      screenshotRetentionSeconds: 60,
      coverage: nothing,
    });
    expect(result.overall).toContain("Nothing was reviewed: 0 of 2 requested route(s)");
    expect(result.overall).toContain("not a verdict");
    expect(result.overall).toContain("listed in notReviewed");
    expect(result.overall).not.toContain("Triage found no issues");
    expect(result.ungroundedNarrative).toBe("Triage found no issues warranting a deep review.");
  });

  it("does not promise a notReviewed list it does not have", () => {
    const result = toEngineReviewResult(critique({ findings: [], notReviewed: [] }), {
      screenshotRetentionSeconds: 60,
      coverage: nothing,
    });
    expect(result.overall).toContain("Nothing was reviewed");
    expect(result.overall).not.toContain("listed in notReviewed");
  });

  it("omits ungroundedNarrative when there was no prose to preserve", () => {
    const result = toEngineReviewResult(critique({ overall: "  ", findings: [], notReviewed: [] }), {
      screenshotRetentionSeconds: 60,
      coverage: nothing,
    });
    expect(result).not.toHaveProperty("ungroundedNarrative");
  });

  it("leaves a real review alone, including a partial one", () => {
    // A partial review is a real verdict about a smaller surface. Nothing here
    // is retracted, and the result stays byte-identical to before this change.
    const result = toEngineReviewResult(critique(), {
      screenshotRetentionSeconds: 60,
      coverage: something,
    });
    expect(result).not.toHaveProperty("gradeUnavailableReason");
    expect(result).not.toHaveProperty("ungroundedNarrative");
    expect(result.overall).toBe("Mobile layout breaks the design system.");
  });

  it("asserts nothing on behalf of a caller that did not state coverage", () => {
    const result = toEngineReviewResult(unjudged, { screenshotRetentionSeconds: 60 });
    expect(result).not.toHaveProperty("gradeUnavailableReason");
    expect(result.overall).toBe("Triage found no issues warranting a deep review.");
  });

  it("keeps the more specific ungrounded-findings narrative when both conditions hold", () => {
    const result = toEngineReviewResult(
      critique({
        findings: [],
        overall: "No finding in this review survived validation.",
        ungroundedNarrative: "The hero block is misaligned.",
      }),
      { screenshotRetentionSeconds: 60, coverage: nothing },
    );
    expect(result.ungroundedNarrative).toBe("The hero block is misaligned.");
    expect(result.overall).toContain("Nothing was reviewed");
  });

  it("carries the ungrounded narrative through on a normally-covered result", () => {
    const result = toEngineReviewResult(
      critique({ findings: [], ungroundedNarrative: "The hero block is misaligned." }),
      { screenshotRetentionSeconds: 60, coverage: something },
    );
    expect(result.ungroundedNarrative).toBe("The hero block is misaligned.");
  });
});
