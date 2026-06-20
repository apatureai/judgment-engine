import { describe, expect, it } from "vitest";
import {
  beatsCurrentJudge,
  shadowPromotionDecision,
  type JudgeScorecard,
} from "../src/index.js";

const current: JudgeScorecard = {
  blockerRecall: 0.9,
  nitPrecision: 0.8,
  kappa: 0.7,
  canaryRecall: 0.99,
};

describe("beatsCurrentJudge (#78)", () => {
  it("wins when blocker recall improves and nothing regresses", () => {
    const candidate = { ...current, blockerRecall: 0.95 };
    expect(beatsCurrentJudge(candidate, current).wins).toBe(true);
  });

  it("loses when blocker recall does not improve enough", () => {
    const candidate = { ...current, blockerRecall: 0.905 }; // < +0.01
    const res = beatsCurrentJudge(candidate, current);
    expect(res.wins).toBe(false);
    expect(res.reasons[0]).toMatch(/blocker recall/);
  });

  it("loses when a trust metric regresses beyond tolerance even if recall improved", () => {
    const candidate = { ...current, blockerRecall: 0.95, canaryRecall: 0.9 };
    const res = beatsCurrentJudge(candidate, current);
    expect(res.wins).toBe(false);
    expect(res.reasons).toContain("canary recall regressed beyond tolerance");
  });
});

describe("shadowPromotionDecision (#78)", () => {
  it("promotes only when the gate passed AND it beats the incumbent", () => {
    const candidate = { ...current, blockerRecall: 0.95 };
    expect(shadowPromotionDecision({ candidate, current, candidateGatePassed: true }).promote).toBe(true);
  });

  it("refuses promotion when the quality gate failed", () => {
    const candidate = { ...current, blockerRecall: 0.95 };
    const d = shadowPromotionDecision({ candidate, current, candidateGatePassed: false });
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/quality gate/);
  });

  it("refuses promotion when it does not beat the incumbent", () => {
    const candidate = { ...current }; // no improvement
    expect(shadowPromotionDecision({ candidate, current, candidateGatePassed: true }).promote).toBe(false);
  });

  it("promotes the first model on a gate pass alone (no incumbent)", () => {
    const candidate = { ...current };
    expect(shadowPromotionDecision({ candidate, current: null, candidateGatePassed: true }).promote).toBe(true);
  });
});
