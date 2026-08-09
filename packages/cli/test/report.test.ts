import type { DeterministicFinding } from "@engine/capture";
import type { EngineReviewResult } from "@engine/types";
import { describe, expect, it } from "vitest";
import {
  countByKind,
  displayPath,
  renderFindings,
  renderStability,
  renderSummary,
  type RunSummary,
} from "../src/report.js";

const FACTS: DeterministicFinding[] = [
  { kind: "touch_target", route: "/", viewport: "mobile", selector: "#icon-close", detail: "28x28" },
  { kind: "contrast", route: "/", viewport: "mobile", selector: "#hero-subtitle", detail: "3.23:1" },
  { kind: "contrast", route: "/", viewport: "desktop", selector: "#hero-subtitle", detail: "3.23:1" },
];

const RESULT: EngineReviewResult = {
  grade: "needs_work",
  overall: "one real issue",
  blockingEnabled: false,
  confidenceUnavailableReason: "missing_calibration_report",
  findings: [
    {
      id: "f_001",
      dimension: "accessibility",
      severity: "major",
      title: "Dismiss control is a 28x28 touch target",
      description: "below the 44x44 minimum",
      route: "/",
      viewport: "mobile",
      element: "#icon-close",
      screenshotId: null,
      suggestion: "pad it",
    },
  ],
  notReviewed: [],
  artifacts: { annotatedScreenshots: [] },
  screenshotRetentionSeconds: 0,
  metadata: {
    engineVersion: "0.0.0",
    model: "canned",
    promptVersion: "system-prompt@v3",
    captureVersion: "chromium-playwright@1",
    uiDnaVersion: null,
  },
};

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    target: "http://127.0.0.1:5000",
    targetNote: "(bundled demo site)",
    routes: ["/", "/pricing"],
    viewports: ["mobile", "desktop"],
    modelDescription: "CANNED replay client",
    captureVersion: "chromium-playwright@1",
    screenshotCount: 4,
    screenshotDir: "out/screenshots",
    geometryCount: 57,
    deterministicFindings: FACTS,
    pageHealthFootnote: null,
    stability: null,
    hallucinationDrops: 2,
    modelFindingsSeen: 3,
    result: RESULT,
    files: ["out/review.json"],
    elapsedMs: 8421,
    ...overrides,
  };
}

describe("countByKind", () => {
  it("counts in a stable check order and omits absent kinds", () => {
    expect(countByKind(FACTS)).toEqual([
      ["contrast", 2],
      ["touch_target", 1],
    ]);
    expect(countByKind([])).toEqual([]);
  });
});

describe("displayPath", () => {
  it("prefers the relative form unless it escapes upward", () => {
    expect(displayPath("/repo/out/review.json", "out/review.json")).toBe("out/review.json");
    expect(displayPath("/tmp/x/review.json", "../../tmp/x/review.json")).toBe("/tmp/x/review.json");
  });
});

describe("renderFindings", () => {
  it("prints severity, dimension, title and the grounded address", () => {
    expect(renderFindings(RESULT)[0]).toContain("[major/accessibility] Dismiss control is a 28x28 touch target");
    expect(renderFindings(RESULT)[0]).toContain("/ mobile → #icon-close");
  });

  it("says so when nothing survived", () => {
    expect(renderFindings({ ...RESULT, findings: [] })).toEqual(["  (none)"]);
  });
});

describe("renderSummary", () => {
  it("reports the capture, the gate and the review together", () => {
    const text = renderSummary(summary());
    expect(text).toContain("4 screenshot(s) written to out/screenshots");
    expect(text).toContain("57 DOM element(s) recorded in the geometry map");
    expect(text).toContain("3 deterministic fact(s) (contrast 2, touch_target 1)");
    expect(text).toContain("page health: clean");
    expect(text).toContain("3 model finding(s) parsed, 2 dropped");
    expect(text).toContain("grade       needs_work");
    expect(text).toContain("withheld (missing_calibration_report)");
    expect(text).toContain("Done in 8.4s.");
  });

  it("shows a numeric confidence when a calibration report was bound", () => {
    const text = renderSummary(summary({ result: { ...RESULT, confidence: 0.71 } }));
    expect(text).toContain("confidence  0.71");
  });

  it("surfaces the page-health footnote when the page was not clean", () => {
    const text = renderSummary(summary({ pageHealthFootnote: "Page health: 2 console error(s)." }));
    expect(text).toContain("page health: Page health: 2 console error(s).");
  });

  it("says nothing about stability when the check did not run", () => {
    expect(renderSummary(summary())).not.toContain("stability:");
  });

  it("reports the determinism check when --verify-stability ran", () => {
    const text = renderSummary(summary({ stability: { pagesCompared: 6, unstablePages: 0 } }));
    expect(text).toContain("stability: verified — 6/6 page(s) byte-identical on a repeat capture");
  });
});

describe("renderStability", () => {
  it("emits nothing when the check did not run", () => {
    expect(renderStability(null)).toEqual([]);
  });

  it("states the pass explicitly, so a clean check is visible", () => {
    expect(renderStability({ pagesCompared: 3, unstablePages: 0 })).toEqual([
      "  stability: verified — 3/3 page(s) byte-identical on a repeat capture",
    ]);
  });

  it("names the failure and what it means", () => {
    const lines = renderStability({ pagesCompared: 6, unstablePages: 2 });
    expect(lines[0]).toContain("FAILED — 2/6 page(s) differed on a repeat capture");
    expect(lines[1]).toContain("treat the findings as unstable");
  });
});
