import type { Finding } from "@engine/types";
import { describe, expect, it } from "vitest";
import { postFilter } from "../src/index.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.8,
  route: "/pricing",
  viewport: "desktop",
  elementRef: "#cta",
  evidence: "uneven gap",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

describe("postFilter (#33)", () => {
  it("drops findings below the 0.55 confidence floor", () => {
    const out = postFilter([finding({ confidence: 0.9 }), finding({ confidence: 0.4, elementRef: "#x" })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.9);
  });

  it("dedupes by elementRef + dimension across viewports, keeping the highest confidence", () => {
    const out = postFilter([
      finding({ viewport: "mobile", confidence: 0.6 }),
      finding({ viewport: "desktop", confidence: 0.85 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.85);
  });

  it("caps at 1 blocker + 6 others with deterministic severity ordering", () => {
    const findings: Finding[] = [
      ...Array.from({ length: 3 }, (_, i) => finding({ severity: "blocker", elementRef: `#b${i}`, confidence: 0.9 - i * 0.01 })),
      ...Array.from({ length: 10 }, (_, i) => finding({ severity: "minor", elementRef: `#m${i}`, confidence: 0.9 - i * 0.01 })),
    ];
    const out = postFilter(findings);
    expect(out.filter((f) => f.severity === "blocker")).toHaveLength(1);
    expect(out.filter((f) => f.severity !== "blocker")).toHaveLength(6);
    expect(out[0]?.severity).toBe("blocker"); // blocker first
    // Deterministic: same input -> same order.
    expect(postFilter(findings)).toEqual(out);
  });
});
