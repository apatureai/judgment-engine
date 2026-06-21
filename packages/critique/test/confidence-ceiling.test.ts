import type { Finding } from "@engine/types";
import type { RepoContext } from "@engine/types";
import { describe, expect, it } from "vitest";
import { applyConfidenceCeiling, critique } from "../src/index.js";

const finding = (confidence: number): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence,
  route: "/",
  viewport: "desktop",
  elementRef: null,
  title: "x",
  description: "x",
  suggestion: null,
  introducedByThisPr: true,
});

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: null,
  contentHash: "abc",
};

describe("applyConfidenceCeiling (#70)", () => {
  it("caps confidences above the ceiling, leaves lower ones untouched", () => {
    const out = applyConfidenceCeiling([finding(0.95), finding(0.5)], 0.6);
    expect(out.map((f) => f.confidence)).toEqual([0.6, 0.5]);
  });
});

describe("critique propagates the capture-unstable ceiling", () => {
  it("marks captureUnstable when a confidence ceiling is supplied", async () => {
    const stable = await critique([], context, { depth: "deep" });
    expect(stable.validation.captureUnstable).toBe(false);

    const unstable = await critique([], context, { depth: "deep", confidenceCeiling: 0.6 });
    expect(unstable.validation.captureUnstable).toBe(true);
  });
});
