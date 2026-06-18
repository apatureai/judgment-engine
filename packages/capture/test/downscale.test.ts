import { describe, expect, it } from "vitest";
import {
  DIMENSION_MULTIPLE,
  PIXEL_BUDGETS,
  fitForDepth,
  fitToPixelBudget,
  rescalePoint,
  rescaleRect,
} from "../src/index.js";

describe("fitToPixelBudget", () => {
  it("downscales an over-budget tile under the budget, dims multiples of 32", () => {
    const dims = fitToPixelBudget(3000, 2000, 1_000_000);
    expect(dims.width % DIMENSION_MULTIPLE).toBe(0);
    expect(dims.height % DIMENSION_MULTIPLE).toBe(0);
    expect(dims.width * dims.height).toBeLessThanOrEqual(1_000_000);
    expect(dims.ratioX).toBeGreaterThan(1); // it was shrunk
  });

  it("does not upscale a within-budget tile (ratio ~1) but aligns to patch grid", () => {
    const dims = fitToPixelBudget(1280, 720, 5_000_000);
    expect(dims.width).toBeLessThanOrEqual(1280);
    expect(dims.height).toBeLessThanOrEqual(720);
    expect(dims.width % DIMENSION_MULTIPLE).toBe(0);
    expect(dims.ratioX).toBeCloseTo(1, 1);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => fitToPixelBudget(0, 100, 1000)).toThrow();
  });
});

describe("per-tier budgets", () => {
  it("gives the deep tier a larger budget than triage", () => {
    expect(PIXEL_BUDGETS.deep).toBeGreaterThan(PIXEL_BUDGETS.triage);
    const triage = fitForDepth(4000, 3000, "triage");
    const deep = fitForDepth(4000, 3000, "deep");
    expect(deep.width * deep.height).toBeGreaterThan(triage.width * triage.height);
  });
});

describe("coordinate rescale", () => {
  it("maps a model-space point/rect back to captured space by the ratio", () => {
    const dims = fitToPixelBudget(2000, 1000, 500_000); // shrinks ~2x
    // A point at the sent-image center maps near the captured center.
    const p = rescalePoint({ x: dims.width / 2, y: dims.height / 2 }, dims);
    expect(p.x).toBeCloseTo(1000, 0);
    expect(p.y).toBeCloseTo(500, 0);

    const r = rescaleRect({ x: 0, y: 0, width: dims.width, height: dims.height }, dims);
    expect(r.width).toBeCloseTo(2000, 0);
    expect(r.height).toBeCloseTo(1000, 0);
  });
});
