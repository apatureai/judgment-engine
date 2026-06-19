import { describe, expect, it } from "vitest";
import {
  consensusFindings,
  findingKey,
  isUsableForKappa,
  raterGrades,
  type GoldenCase,
  type LabeledFinding,
} from "../src/index.js";

const labeled = (over: Partial<LabeledFinding> = {}) => ({
  dimension: "spacing" as const,
  severity: "minor" as const,
  route: "/pricing",
  elementRef: "#cta",
  ...over,
});

const goldenCase: GoldenCase = {
  id: "pr-1",
  source: "oss",
  labels: [
    { raterId: "r1", grade: "needs_work", findings: [labeled(), labeled({ elementRef: "#only-r1" })] },
    { raterId: "r2", grade: "needs_work", findings: [labeled({ severity: "major" })] },
  ],
};

describe("golden-set labeling tooling (#45)", () => {
  it("keys findings by dimension+route+elementRef", () => {
    expect(findingKey(labeled())).toBe("spacing|/pricing|#cta");
    expect(findingKey(labeled({ elementRef: null }))).toBe("spacing|/pricing|");
  });

  it("requires >=2 distinct raters for kappa usability", () => {
    expect(isUsableForKappa(goldenCase)).toBe(true);
    expect(isUsableForKappa({ ...goldenCase, labels: [goldenCase.labels[0]!] })).toBe(false);
  });

  it("consensus = findings >=2 raters agree on, taking the max severity", () => {
    const consensus = consensusFindings(goldenCase, 2);
    // #cta is labeled by both raters; #only-r1 only by r1 -> dropped.
    expect(consensus).toHaveLength(1);
    expect(consensus[0]?.elementRef).toBe("#cta");
    expect(consensus[0]?.severity).toBe("major"); // max across agreeing raters
  });

  it("exposes per-rater grades for kappa", () => {
    expect(raterGrades(goldenCase)).toEqual({ r1: "needs_work", r2: "needs_work" });
  });
});
