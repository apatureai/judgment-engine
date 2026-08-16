import type { CalibrationRuntimeBinding, Finding } from "@engine/types";
import { describe, expect, it } from "vitest";
import { assembleCritique, type DeepPassRouteResult } from "../src/index.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.9,
  route: "/pricing",
  viewport: "desktop",
  elementRef: "#cta",
  title: "Uneven gap",
  description: "uneven gap above the CTA",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

const routeResult = (
  route: string,
  output: DeepPassRouteResult["output"],
): DeepPassRouteResult => ({ route, output });

const calibration: CalibrationRuntimeBinding = {
  reference: {
    reportId: "report-1",
    reportHash: `sha256:${"a".repeat(64)}`,
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
  },
  identity: {
    model: "qwen3-vl-plus",
    promptVersion: "system-prompt@v3",
    engineVersion: "0.1.0",
    captureVersion: "stub@0",
    rubricVersion: "design-rubric@1",
  },
  promotionMode: "blocking",
  thresholds: {
    postFilterMinConfidence: 0.55,
    blockingMinConfidence: 0.8,
    unstableCaptureMaxConfidence: 0.6,
  },
  calibrate: (raw) => raw,
};

const baseDeps = {
  capturedRoutes: ["/pricing", "/home"],
  geometrySelectors: ["#cta", ".grid", "#hero"],
  model: "qwen3-vl-plus",
  captureVersion: "stub@0",
  uiDnaVersion: null,
  calibration,
};

describe("assembleCritique (#29 → Critique aggregation, hardening)", () => {
  it("merges per-route findings and runs the GLOBAL post-filter cap across routes", () => {
    // 2 blockers across 2 routes -> global cap keeps only 1 blocker (#33).
    const out = assembleCritique(
      [
        routeResult("/pricing", {
          grade: "blocked",
          overall: "pricing broken",
          findings: [finding({ severity: "blocker", elementRef: "#cta" })],
          notReviewed: [],
        }),
        routeResult("/home", {
          grade: "needs_work",
          overall: "home spacing",
          findings: [finding({ route: "/home", severity: "blocker", elementRef: "#hero" })],
          notReviewed: [],
        }),
      ],
      baseDeps,
    );
    expect(out.findings.filter((f) => f.severity === "blocker")).toHaveLength(1); // global cap, not per-route
    expect(out.grade).toBe("blocked"); // worst route grade
    expect(out.overall).toContain("pricing broken");
    expect(out.overall).toContain("home spacing");
  });

  it("drops findings on uncaptured routes via the hallucination gate (#32) and counts them", () => {
    const out = assembleCritique(
      [
        routeResult("/pricing", {
          grade: "needs_work",
          overall: "x",
          findings: [finding({ route: "/pricing" }), finding({ route: "/ghost", elementRef: "#cta" })],
          notReviewed: [],
        }),
      ],
      baseDeps,
    );
    expect(out.findings.every((f) => f.route === "/pricing")).toBe(true);
    expect(out.validation.hallucinationDrops).toBe(1);
  });

  it("records routes whose coercion failed (null output) as not-reviewed, no findings", () => {
    const out = assembleCritique(
      [
        routeResult("/pricing", { grade: "ship", overall: "ok", findings: [], notReviewed: [] }),
        routeResult("/broken", null),
      ],
      { ...baseDeps, notReviewed: ["/checkout: no preview"] },
    );
    expect(out.notReviewed).toContain("/broken: no valid critique");
    expect(out.notReviewed).toContain("/checkout: no preview");
    expect(out.grade).toBe("ship");
  });

  it("applies the confidence ceiling (#70) before the filter and flags captureUnstable", () => {
    const out = assembleCritique(
      [
        routeResult("/pricing", {
          grade: "needs_work",
          overall: "x",
          findings: [finding({ confidence: 0.95 })],
          notReviewed: [],
        }),
      ],
      { ...baseDeps, captureUnstable: true },
    );
    expect(out.validation.captureUnstable).toBe(true);
    expect(out.findings[0]?.confidence).toBeLessThanOrEqual(0.6);
  });

  it("fails display confidence and blocking closed after a model swap", () => {
    const out = assembleCritique(
      [
        routeResult("/pricing", {
          grade: "blocked",
          overall: "x",
          findings: [finding({ severity: "blocker" })],
          notReviewed: [],
        }),
      ],
      {
        ...baseDeps,
        calibration: {
          ...calibration,
          identity: { ...calibration.identity, model: "retired-model" },
        },
      },
    );

    expect(out.calibration).toBeUndefined();
    expect(out.blockingEnabled).toBe(false);
    expect(out.confidenceUnavailableReason).toBe("mismatched_calibration_report");
    expect(out.grade).toBe("needs_work");
  });

  it("stamps the version metadata and defaults grade to ship with no valid routes", () => {
    const out = assembleCritique([routeResult("/x", null)], baseDeps);
    expect(out.grade).toBe("ship");
    expect(out.findings).toEqual([]);
    expect(out.metadata.model).toBe("qwen3-vl-plus");
    expect(out.metadata.captureVersion).toBe("stub@0");
  });
});

/**
 * The narrative and the findings list are two halves of one result, and until
 * this they could contradict each other: the gate deleted every finding, the
 * grade floored to `ship`, and the model's paragraph about those findings was
 * published verbatim as the description of the page.
 */
describe("assembleCritique reconciles the narrative with what survived", () => {
  const ungrounded = (route: string) =>
    routeResult(route, {
      grade: "needs_work",
      overall: "The hero block is misaligned and the CTA is off-grid.",
      findings: [finding({ route, elementRef: "#ghost" })],
      notReviewed: [],
    });

  it("stops publishing a narrative about findings the gate deleted", () => {
    const out = assembleCritique([ungrounded("/pricing")], baseDeps);

    expect(out.findings).toEqual([]);
    expect(out.grade).toBe("ship");
    expect(out.validation.hallucinationDrops).toBe(1);
    expect(out.overall).not.toContain("hero block is misaligned");
    expect(out.overall).toContain("No finding in this review survived validation");
    expect(out.ungroundedNarrative).toBe("The hero block is misaligned and the CTA is off-grid.");
  });

  it("keeps the merged narrative when every finding survived", () => {
    const out = assembleCritique(
      [
        routeResult("/pricing", {
          grade: "needs_work",
          overall: "Spacing is uneven.",
          findings: [finding()],
          notReviewed: [],
        }),
      ],
      baseDeps,
    );
    expect(out.overall).toBe("Spacing is uneven.");
    expect(out.ungroundedNarrative).toBeUndefined();
  });

  it("caveats rather than replaces when only some findings were deleted", () => {
    const out = assembleCritique(
      [
        routeResult("/pricing", {
          grade: "needs_work",
          overall: "Two problems, one on each page.",
          findings: [finding(), finding({ route: "/nowhere" })],
          notReviewed: [],
        }),
      ],
      baseDeps,
    );
    expect(out.findings).toHaveLength(1);
    expect(out.validation.hallucinationDrops).toBe(1);
    expect(out.overall).toContain("Two problems, one on each page.");
    expect(out.overall).toContain("1 of the 2 finding(s) the model reported were deleted");
    // Partial is not ungrounded: the surviving finding is real and the prose
    // still describes it, so nothing is moved out of `overall`.
    expect(out.ungroundedNarrative).toBeUndefined();
  });
});
