import { describe, expect, it } from "vitest";
import { parseCritiqueOutput, schemaInstruction } from "../src/index.js";

const validFinding = {
  dimension: "spacing",
  severity: "minor",
  confidence: 0.7,
  route: "/pricing",
  viewport: "desktop",
  elementRef: "#cta",
  evidence: "uneven gap above the CTA",
  suggestion: "use the 8px scale",
  introducedByThisPr: true,
};

describe("parseCritiqueOutput (#31)", () => {
  it("validates a well-formed critique JSON", () => {
    const result = parseCritiqueOutput(
      JSON.stringify({ grade: "needs_work", overall: "spacing issues", findings: [validFinding] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings[0]?.dimension).toBe("spacing");
      expect(result.value.notReviewed).toEqual([]); // defaulted
    }
  });

  it("rejects non-JSON (delivery never parses prose)", () => {
    const result = parseCritiqueOutput("Here is my review: the spacing looks off.");
    expect(result).toEqual({ ok: false, error: "invalid_json" });
  });

  it("rejects JSON with wrong field types / unknown enums", () => {
    const badEnum = parseCritiqueOutput(
      JSON.stringify({ grade: "looks_good", overall: "x", findings: [] }),
    );
    expect(badEnum.ok).toBe(false);

    const badField = parseCritiqueOutput(
      JSON.stringify({ grade: "ship", overall: "x", findings: [{ ...validFinding, confidence: "high" }] }),
    );
    expect(badField.ok).toBe(false);
  });
});

describe("schemaInstruction", () => {
  it("contains the literal word JSON (DashScope server-validates it) and the field contract", () => {
    const instruction = schemaInstruction();
    expect(instruction).toContain("JSON");
    expect(instruction).toContain('"dimension"');
    expect(instruction).toContain('"introducedByThisPr"');
  });
});
