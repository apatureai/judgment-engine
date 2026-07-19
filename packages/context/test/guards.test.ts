/**
 * isRecord, extracted from the byte-identical copies in brand.ts and
 * tokens-json.ts. Pins the plain-object check both extractors depend on.
 */
import { describe, expect, it } from "vitest";
import { isRecord } from "../src/guards.js";

describe("isRecord", () => {
  it("is true only for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it("is false for null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
