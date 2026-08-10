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
