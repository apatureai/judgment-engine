import { describe, expect, it } from "vitest";
import { CANARY_DEFECTS, generateCanaries, type CanaryBaseline } from "../src/index.js";

const baseline: CanaryBaseline = {
  routes: ["/", "/pricing"],
  tokenNames: ["color.primary", "color.bg"],
  breakpoints: ["sm", "md"],
  fontNames: ["fontFamily.sans"],
};

describe("generateCanaries (#44)", () => {
  it("injects all three defect types with ground truth by construction", () => {
    const canaries = generateCanaries(baseline);
    const defects = new Set(canaries.map((c) => c.defect));
    expect([...defects].sort()).toEqual([...CANARY_DEFECTS].sort());

    const token = canaries.find((c) => c.defect === "mutated_token");
    expect(token?.groundTruth.dimension).toBe("color_contrast");
    const bp = canaries.find((c) => c.defect === "broken_breakpoint");
    expect(bp?.groundTruth).toMatchObject({ dimension: "responsiveness", minSeverity: "major" });
    const font = canaries.find((c) => c.defect === "swapped_font");
    expect(font?.groundTruth.dimension).toBe("typography");
    // ground-truth route always matches the canary's route
    for (const c of canaries) expect(c.groundTruth.route).toBe(c.route);
  });

  it("scales into the hundreds cheaply via variants and is deterministic", () => {
    const opts = { variantsPerCombo: 50 };
    const a = generateCanaries(baseline, opts);
    // 2 routes × 3 defects × 50 variants = 300
    expect(a).toHaveLength(300);
    expect(new Set(a.map((c) => c.id)).size).toBe(300); // unique ids
    // Deterministic: same baseline + options -> identical specs.
    expect(generateCanaries(baseline, opts)).toEqual(a);
  });

  it("honors a defect filter", () => {
    const only = generateCanaries(baseline, { defects: ["swapped_font"] });
    expect(only.every((c) => c.defect === "swapped_font")).toBe(true);
    expect(only).toHaveLength(2); // one per route
  });
});
