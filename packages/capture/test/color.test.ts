import { describe, expect, it } from "vitest";
import { compositeOver, flattenBackground, isOpaque, parseCssColor } from "../src/index.js";

describe("parseCssColor", () => {
  it("parses hex, rgb() and rgba(), keeping the alpha channel", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60, a: 1 });
    expect(parseCssColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it("parses the transparent keyword and 8-digit hex alpha", () => {
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")?.a).toBe(0);
    expect(parseCssColor("#00000080")?.a).toBeCloseTo(0.502, 3);
  });

  it("returns null for anything it cannot measure exactly", () => {
    expect(parseCssColor("currentColor")).toBeNull();
    expect(parseCssColor("var(--fg)")).toBeNull();
    // Wide-gamut computed values are serialized in their own space; parsing
    // them would mean converting color spaces, so the caller stays silent.
    expect(parseCssColor("oklch(0.7 0.1 200)")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
  });
});

describe("isOpaque", () => {
  it("is true only at full alpha", () => {
    expect(isOpaque({ r: 0, g: 0, b: 0, a: 1 })).toBe(true);
    expect(isOpaque({ r: 0, g: 0, b: 0, a: 0.99 })).toBe(false);
    expect(isOpaque({ r: 0, g: 0, b: 0, a: 0 })).toBe(false);
  });
});

describe("compositeOver", () => {
  it("blends a translucent layer onto an opaque backdrop", () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, white)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0 }, white)).toEqual(white);
  });

  it("passes an opaque top layer through untouched", () => {
    const red = { r: 255, g: 0, b: 0, a: 1 };
    expect(compositeOver(red, { r: 255, g: 255, b: 255, a: 1 })).toEqual(red);
  });

  it("refuses a translucent backdrop rather than inventing a color", () => {
    expect(() =>
      compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 0.5 }),
    ).toThrow(/opaque backdrop/);
  });
});

describe("flattenBackground", () => {
  const WHITE = "rgb(255, 255, 255)";

  it("falls through transparent ancestors to the canvas", () => {
    // The regression: `rgba(0, 0, 0, 0)` is truthy, so a body with no declared
    // background used to be read as opaque black.
    expect(flattenBackground(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"], WHITE)).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    });
  });

  it("stops at the first opaque layer", () => {
    expect(flattenBackground(["rgb(20, 20, 20)", WHITE], WHITE)).toEqual({ r: 20, g: 20, b: 20, a: 1 });
  });

  it("composites translucent layers onto what is behind them, nearest last", () => {
    expect(flattenBackground(["rgba(0, 0, 0, 0.5)"], WHITE)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(flattenBackground(["rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)"], WHITE)).toEqual({
      r: 128,
      g: 128,
      b: 128,
      a: 1,
    });
  });

  it("returns null when the canvas color is unknown", () => {
    expect(flattenBackground(["rgba(0, 0, 0, 0)"], null)).toBeNull();
    expect(flattenBackground([], null)).toBeNull();
  });

  it("returns null when a layer cannot be parsed — it may hide what is behind it", () => {
    expect(flattenBackground(["oklch(0.7 0.1 200)"], WHITE)).toBeNull();
  });
});
