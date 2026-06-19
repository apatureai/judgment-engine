import { describe, expect, it } from "vitest";
import { evaluateSlos } from "../src/index.js";

describe("evaluateSlos (#72)", () => {
  it("passes when both rates are within target", () => {
    const r = evaluateSlos({ hallucinationDrops: 5, totalFindings: 100, unstableCaptures: 2, totalCaptures: 100 });
    expect(r.passed).toBe(true);
    expect(r.hallucinationDropRate).toBeCloseTo(0.05, 5);
    expect(r.captureInstabilityRate).toBeCloseTo(0.02, 5);
    expect(r.breaches).toEqual([]);
  });

  it("breaches when the hallucination-drop rate exceeds target", () => {
    const r = evaluateSlos({ hallucinationDrops: 20, totalFindings: 100, unstableCaptures: 0, totalCaptures: 100 });
    expect(r.passed).toBe(false);
    expect(r.breaches[0]).toMatch(/hallucination-drop rate/);
  });

  it("breaches when the capture-instability rate exceeds target", () => {
    const r = evaluateSlos({ hallucinationDrops: 0, totalFindings: 100, unstableCaptures: 10, totalCaptures: 100 });
    expect(r.passed).toBe(false);
    expect(r.breaches[0]).toMatch(/capture-instability rate/);
  });

  it("treats zero denominators as 0% (no divide-by-zero)", () => {
    const r = evaluateSlos({ hallucinationDrops: 0, totalFindings: 0, unstableCaptures: 0, totalCaptures: 0 });
    expect(r).toMatchObject({ passed: true, hallucinationDropRate: 0, captureInstabilityRate: 0 });
  });
});
