import { describe, expect, it } from "vitest";
import {
  canaryRecall,
  generateCanaries,
  humanRegressionBeyondCI,
  regressionGate,
  type CanaryBaseline,
  type LabeledFinding,
} from "../src/index.js";

const baseline: CanaryBaseline = {
  routes: ["/"],
  tokenNames: ["color.primary"],
  breakpoints: ["md"],
  fontNames: ["fontFamily.sans"],
};

// One canary per defect on "/".
const canaries = generateCanaries(baseline);

/** A finding that catches a canary: same dimension+route, severity >= minSeverity. */
const catchFor = (c: (typeof canaries)[number]): LabeledFinding => ({
  dimension: c.groundTruth.dimension,
  severity: c.groundTruth.minSeverity,
  route: c.groundTruth.route,
  elementRef: null,
});

describe("canaryRecall (#47)", () => {
  it("is 1.0 when every canary's defect is caught", () => {
    const predicted = Object.fromEntries(canaries.map((c) => [c.id, [catchFor(c)]]));
    expect(canaryRecall({ canaries, predicted })).toBe(1);
  });

  it("drops when a canary is missed", () => {
    const predicted = Object.fromEntries(canaries.slice(1).map((c) => [c.id, [catchFor(c)]]));
    expect(canaryRecall({ canaries, predicted })).toBeCloseTo(2 / 3, 5);
  });
});

describe("humanRegressionBeyondCI", () => {
  it("flags only candidates below the baseline CI lower bound", () => {
    expect(humanRegressionBeyondCI({ candidate: 0.7, baselineCI: { lower: 0.8, upper: 0.95 } })).toBe(true);
    expect(humanRegressionBeyondCI({ candidate: 0.82, baselineCI: { lower: 0.8, upper: 0.95 } })).toBe(false);
  });
});

describe("regressionGate", () => {
  it("passes on full canary recall and a within-CI human metric", () => {
    const predicted = Object.fromEntries(canaries.map((c) => [c.id, [catchFor(c)]]));
    const result = regressionGate({
      canary: { canaries, predicted },
      human: { candidate: 0.85, baselineCI: { lower: 0.8, upper: 0.95 } },
    });
    expect(result.passed).toBe(true);
    expect(result.blockedReasons).toEqual([]);
  });

  it("hard-blocks when canary recall drops below target", () => {
    const predicted = Object.fromEntries(canaries.slice(1).map((c) => [c.id, [catchFor(c)]]));
    const result = regressionGate({ canary: { canaries, predicted } });
    expect(result.passed).toBe(false);
    expect(result.blockedReasons[0]).toMatch(/canary recall/);
  });

  it("blocks on a human-set regression beyond the CI even with full canary recall", () => {
    const predicted = Object.fromEntries(canaries.map((c) => [c.id, [catchFor(c)]]));
    const result = regressionGate({
      canary: { canaries, predicted },
      human: { candidate: 0.6, baselineCI: { lower: 0.8, upper: 0.95 } },
    });
    expect(result.passed).toBe(false);
    expect(result.blockedReasons[0]).toMatch(/human-set/);
  });

  it("hard-blocks on an injection-resistance miss; reports the rate; null when no injection canaries (#86)", () => {
    const predicted = Object.fromEntries(canaries.map((c) => [c.id, [catchFor(c)]]));
    const complied = regressionGate({
      canary: { canaries, predicted },
      injection: [
        { canaryId: "i1", clean: { grade: "ship", findingKeys: [] }, observed: { grade: "blocked", findingKeys: [] } },
      ],
    });
    expect(complied.passed).toBe(false);
    expect(complied.injectionResistance).toBe(0);
    expect(complied.blockedReasons.some((r) => /injection resistance/.test(r))).toBe(true);

    expect(regressionGate({ canary: { canaries, predicted } }).injectionResistance).toBeNull();
  });
});
