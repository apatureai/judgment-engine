import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  bootstrapEceCI,
  brierScore,
  expectedCalibrationError,
  fitMonotonicCalibration,
  type CalibrationPair,
} from "../src/index.js";

/**
 * Judge confidence calibration (#107). Pure stats over `{confidence, correct}`
 * pairs. Reference ECE/Brier/isotonic values are hand-derived from the formulas
 * with independent arithmetic (mirrors #84) and asserted to 1e-6 — not
 * self-referential against the implementation.
 */

// Overconfident: 10 findings all at confidence 0.95 but only 5 correct (50%).
// All land in the [0.9, 1.0] bin: predictedMean 0.95, empiricalRate 0.5.
//   ECE = (10/10) * |0.95 - 0.5| = 0.45
//   Brier = (1/10) * [5*(0.95-1)^2 + 5*(0.95-0)^2]
//         = (1/10) * [5*0.0025 + 5*0.9025] = 4.525/10 = 0.4525
const overconfident: CalibrationPair[] = [
  ...Array.from({ length: 5 }, () => ({ confidence: 0.95, correct: true })),
  ...Array.from({ length: 5 }, () => ({ confidence: 0.95, correct: false })),
];

// Well-calibrated: 5 at conf 0.2 with rate 0.2 (1 correct), 5 at conf 0.8 with
// rate 0.8 (4 correct). Each bin's predictedMean equals its empiricalRate.
//   ECE = 0
//   Brier = (1/10) * [ (0.64 + 4*0.04) + (4*0.04 + 0.64) ] = 1.6/10 = 0.16
const calibrated: CalibrationPair[] = [
  { confidence: 0.2, correct: true },
  ...Array.from({ length: 4 }, () => ({ confidence: 0.2, correct: false })),
  ...Array.from({ length: 4 }, () => ({ confidence: 0.8, correct: true })),
  { confidence: 0.8, correct: false },
];

describe("expectedCalibrationError (#107)", () => {
  it("overconfident fixture has high ECE (hand-derived 0.45, 1e-6)", () => {
    const report = expectedCalibrationError(overconfident);
    expect(report.ece).toBeCloseTo(0.45, 6);
    expect(report.total).toBe(10);
  });

  it("well-calibrated fixture has ~0 ECE (hand-derived 0, 1e-6)", () => {
    expect(expectedCalibrationError(calibrated).ece).toBeCloseTo(0, 6);
  });

  it("reliability table reports per-bin predicted-mean, empirical-rate, count", () => {
    const { reliability } = expectedCalibrationError(overconfident);
    expect(reliability).toHaveLength(10);
    const bin = reliability[9]; // [0.9, 1.0]
    expect(bin).toMatchObject({ count: 10 });
    expect(bin?.predictedMean).toBeCloseTo(0.95, 6);
    expect(bin?.empiricalRate).toBeCloseTo(0.5, 6);
    // every other bin is empty
    const populated = reliability.filter((b) => b.count > 0);
    expect(populated).toHaveLength(1);
  });

  it("honors a custom bin count and empty input", () => {
    expect(expectedCalibrationError([], 5).reliability).toHaveLength(5);
    expect(expectedCalibrationError([]).ece).toBe(0);
  });

  it("places confidence === 1 in the final bin", () => {
    const { reliability } = expectedCalibrationError([{ confidence: 1, correct: true }]);
    expect(reliability[9]?.count).toBe(1);
  });
});

describe("brierScore (#107)", () => {
  it("overconfident fixture (hand-derived 0.4525, 1e-6)", () => {
    expect(brierScore(overconfident)).toBeCloseTo(0.4525, 6);
  });

  it("well-calibrated fixture (hand-derived 0.16, 1e-6)", () => {
    expect(brierScore(calibrated)).toBeCloseTo(0.16, 6);
  });

  it("is 0 on a perfect predictor and 0.25 on a constant 0.5 guess", () => {
    expect(brierScore([{ confidence: 1, correct: true }, { confidence: 0, correct: false }])).toBeCloseTo(0, 6);
    expect(brierScore([{ confidence: 0.5, correct: true }, { confidence: 0.5, correct: false }])).toBeCloseTo(0.25, 6);
    expect(brierScore([])).toBe(0);
  });
});

describe("bootstrapEceCI (#107)", () => {
  it("brackets the point ECE and is deterministic under a fixed seed", () => {
    const a = bootstrapEceCI(overconfident, 10, { seed: 7, iterations: 500 });
    const b = bootstrapEceCI(overconfident, 10, { seed: 7, iterations: 500 });
    expect(a).toEqual(b); // deterministic
    expect(a.lower).toBeLessThanOrEqual(a.ece);
    expect(a.upper).toBeGreaterThanOrEqual(a.ece);
    expect(a.ece).toBeCloseTo(0.45, 6);
  });
});

describe("fitMonotonicCalibration (#107)", () => {
  it("matches a hand-worked PAVA isotonic example (1e-6)", () => {
    // Sorted outcomes y = [0,1,0,1] at conf [0.1,0.2,0.3,0.4]. PAVA pools the
    // middle violating pair -> knots x=[0.1,0.25,0.4], y=[0,0.5,1].
    const map = fitMonotonicCalibration([
      { confidence: 0.1, correct: false },
      { confidence: 0.2, correct: true },
      { confidence: 0.3, correct: false },
      { confidence: 0.4, correct: true },
    ]);
    expect(map(0.1)).toBeCloseTo(0, 6);
    expect(map(0.25)).toBeCloseTo(0.5, 6);
    expect(map(0.4)).toBeCloseTo(1, 6);
    expect(map(0.05)).toBeCloseTo(0, 6); // clamps below first knot
    expect(map(0.325)).toBeCloseTo(0.75, 6); // interpolated between (0.25,0.5) and (0.4,1)
    expect(applyCalibration(map, 0.25)).toBeCloseTo(0.5, 6);
  });

  it("is the identity when it cannot be fit (no pairs / single confidence value)", () => {
    const empty = fitMonotonicCalibration([]);
    expect(empty(0.37)).toBeCloseTo(0.37, 6);
    const flat = fitMonotonicCalibration([
      { confidence: 0.95, correct: true },
      { confidence: 0.95, correct: false },
    ]);
    expect(flat(0.95)).toBeCloseTo(0.95, 6);
    expect(flat(0.2)).toBeCloseTo(0.2, 6);
  });

  it("improves ECE on the overconfident fixture (calibrated < raw)", () => {
    // Two confidence levels so isotonic has a slope to learn: 0.9 mostly wrong,
    // 0.99 mostly right — both saturated/overconfident on the raw scale.
    const pairs: CalibrationPair[] = [
      ...Array.from({ length: 8 }, () => ({ confidence: 0.9, correct: false })),
      ...Array.from({ length: 2 }, () => ({ confidence: 0.9, correct: true })),
      ...Array.from({ length: 7 }, () => ({ confidence: 0.99, correct: true })),
      ...Array.from({ length: 3 }, () => ({ confidence: 0.99, correct: false })),
    ];
    const rawEce = expectedCalibrationError(pairs).ece;
    const map = fitMonotonicCalibration(pairs);
    const recalibrated = pairs.map((p) => ({ confidence: map(p.confidence), correct: p.correct }));
    const calEce = expectedCalibrationError(recalibrated).ece;
    expect(calEce).toBeLessThan(rawEce);
  });
});
