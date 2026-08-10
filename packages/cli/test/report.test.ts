import type { DeterministicFinding } from "@engine/capture";
import type { EngineReviewResult } from "@engine/types";
import { describe, expect, it } from "vitest";
import {
  countByKind,
  displayPath,
  groupFacts,
  renderFacts,
  renderFindings,
  renderFixtureCritique,
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
    modelKind: "live",
    modelDescription: "LIVE model client",
    captureVersion: "chromium-playwright@1",
    screenshotCount: 4,
    screenshotDir: "out/screenshots",
    geometryCount: 57,
    deterministicFindings: FACTS,
    factsFile: "out/deterministic-facts.txt",
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

describe("groupFacts", () => {
  it("collapses one defect measured at several viewports into one entry", () => {
    expect(groupFacts(FACTS)).toEqual([
      { kind: "touch_target", route: "/", selector: "#icon-close", detail: "28x28", viewports: ["mobile"] },
      {
        kind: "contrast",
        route: "/",
        selector: "#hero-subtitle",
        detail: "3.23:1",
        viewports: ["mobile", "desktop"],
      },
    ]);
  });

  it("keeps two different measurements on the same element apart", () => {
    const grouped = groupFacts([
      { kind: "contrast", route: "/", viewport: "mobile", selector: "#a", detail: "3.2:1" },
      { kind: "contrast", route: "/", viewport: "desktop", selector: "#a", detail: "4.1:1" },
    ]);
    expect(grouped).toHaveLength(2);
  });
});

describe("renderFacts", () => {
  it("prints the measurement itself, not just a count", () => {
    const lines = renderFacts(summary());
    expect(lines[1]).toBe("  3 measurement(s) (contrast 2, touch_target 1) over 2 distinct element(s)");
    expect(lines.join("\n")).toContain("[contrast] / #hero-subtitle (mobile, desktop)\n      3.23:1");
    expect(lines.at(-1)).toBe("  every measurement: out/deterministic-facts.txt");
  });

  it("truncates a long list and says how many are left", () => {
    const many: DeterministicFinding[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "contrast" as const,
      route: "/",
      viewport: "mobile" as const,
      selector: `#e${i}`,
      detail: "3.0:1",
    }));
    const lines = renderFacts(summary({ deterministicFindings: many }));
    expect(lines.join("\n")).toContain("…and 3 more");
  });

  it("says nothing was measured rather than staying silent", () => {
    expect(renderFacts(summary({ deterministicFindings: [] }))[1]).toContain(
      "no contrast, overflow or touch-target violation was measured",
    );
  });
});

describe("renderFixtureCritique", () => {
  it("labels replayed text as fixture text and does not number it", () => {
    const lines = renderFixtureCritique(summary({ modelKind: "canned" }));
    expect(lines[0]).toContain("FIXTURE TEXT: replayed from the canned client, not a judgment about this page");
    expect(lines.at(-1)).toContain("  - [major/accessibility] Dismiss control is a 28x28 touch target");
  });

  it("says the mock client judged nothing at all", () => {
    const lines = renderFixtureCritique(
      summary({ modelKind: "mock", result: { ...RESULT, findings: [] } }),
    );
    expect(lines.join("\n")).toContain("Nothing above judged this page");
  });
});

describe("renderSummary", () => {
  it("reports the capture, the gate and the review together", () => {
    const text = renderSummary(summary());
    expect(text).toContain("4 screenshot(s) written to out/screenshots");
    expect(text).toContain("57 DOM element(s) recorded in the geometry map");
    expect(text).toContain("3 measurement(s) (contrast 2, touch_target 1) over 2 distinct element(s)");
    expect(text).toContain("page health: clean");
    expect(text).toContain("3 model finding(s) parsed, 2 dropped");
    expect(text).toContain("grade       needs_work");
    expect(text).toContain("withheld (missing_calibration_report)");
    expect(text).toContain("Done in 8.4s.");
  });

  it("refuses to print a grade when no model saw the page", () => {
    for (const kind of ["canned", "mock"] as const) {
      const text = renderSummary(summary({ modelKind: kind }));
      expect(text).toContain(`grade       n/a (${kind} client, no model saw this page)`);
      expect(text).toContain("findings    n/a (no model ran; see the measured facts above)");
      expect(text).toContain("confidence  n/a (no model ran)");
      // The fixture's own grade must not leak into the report in any form.
      expect(text).not.toContain("needs_work");
      expect(text).not.toContain("3 model finding(s) parsed");
      expect(text).toContain("3 replayed finding(s) parsed, 2 dropped");
    }
  });

  it("warns that review.json's grade is the fixture's, not the page's", () => {
    const text = renderSummary(summary({ modelKind: "canned" }));
    expect(text).toContain("note: review.json carries the fixture's own grade field.");
    expect(renderSummary(summary())).not.toContain("note: review.json");
  });

  it("gives the numbered list to the measurements, not to replayed fixture text", () => {
    const text = renderSummary(summary({ modelKind: "canned" }));
    expect(text).toContain("   1. [touch_target] / #icon-close (mobile)");
    expect(text).not.toContain("   1. [major/accessibility]");
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
