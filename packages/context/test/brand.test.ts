import { describe, expect, it } from "vitest";
import { brandDimensionEnabled, extractBrandBlock } from "../src/index.js";

describe("extractBrandBlock", () => {
  it("parses and normalizes the brand block", () => {
    const yml = `
brand:
  description: A calm budgeting app for freelancers
  tone: friendly, reassuring
  audience: self-employed people
  do:
    - use warm neutral colors
    - keep numbers legible
  dont:
    - use aggressive red for normal balances
`;
    const brand = extractBrandBlock(yml);
    expect(brand?.description).toBe("A calm budgeting app for freelancers");
    expect(brand?.tone).toBe("friendly, reassuring");
    expect(brand?.do).toEqual(["use warm neutral colors", "keep numbers legible"]);
    expect(brand?.dont).toEqual(["use aggressive red for normal balances"]);
    expect(brandDimensionEnabled(brand)).toBe(true);
  });

  it("accepts alternate don't spellings and string-valued lists", () => {
    const brand = extractBrandBlock(`brand:\n  "don't": no clip art\n  do: be consistent`);
    expect(brand?.dont).toEqual(["no clip art"]);
    expect(brand?.do).toEqual(["be consistent"]);
  });

  it("returns null (suppress brand dimension) when absent, empty, or invalid", () => {
    expect(extractBrandBlock("rules:\n  max_per_pr: 5")).toBeNull(); // no brand key
    expect(extractBrandBlock("brand:")).toBeNull(); // empty block
    expect(extractBrandBlock("brand:\n  : : bad")).toBeNull(); // invalid YAML
    expect(brandDimensionEnabled(null)).toBe(false);
  });
});
