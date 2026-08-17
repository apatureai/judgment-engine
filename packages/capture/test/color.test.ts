import { describe, expect, it } from "vitest";
import {
  compositeOver,
  flattenBackground,
  flattenGradientBackdrops,
  isOpaque,
  parseCssColor,
  parseGradientStops,
} from "../src/index.js";

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

/**
 * A gradient is not a photograph.
 *
 * Both arrive as a `background-image`, and declining the pair of them meant a
 * `linear-gradient(#ffffff, #eaf2ff)` whose endpoints are written out in sRGB
 * was treated as unknowable. The rule here is the same one the rest of this
 * file follows: resolve exactly, or return null and let the check stay silent.
 */
describe("parseGradientStops", () => {
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const PALE = { r: 234, g: 242, b: 255, a: 1 };

  it("reads the stops of a plain two-stop gradient", () => {
    expect(parseGradientStops("linear-gradient(rgb(255, 255, 255), rgb(234, 242, 255))")).toEqual([
      WHITE,
      PALE,
    ]);
    // The inner commas of rgb() must not split the stop list.
    expect(parseGradientStops("linear-gradient(#ffffff, #eaf2ff)")).toEqual([WHITE, PALE]);
  });

  it("skips the geometry argument and the stop positions", () => {
    for (const preamble of ["to right", "45deg", "0.25turn", "circle at 50% 50%", "farthest-corner"]) {
      expect(parseGradientStops(`radial-gradient(${preamble}, #ffffff, #eaf2ff)`)).toEqual([
        WHITE,
        PALE,
      ]);
    }
    expect(parseGradientStops("linear-gradient(#ffffff 0%, #eaf2ff 100%)")).toEqual([WHITE, PALE]);
    // Two positions on one stop, and a bare interpolation hint between two.
    expect(parseGradientStops("linear-gradient(#ffffff 0% 20%, 60%, #eaf2ff 100%)")).toEqual([
      WHITE,
      PALE,
    ]);
  });

  it("returns null for an image that is not a gradient", () => {
    expect(parseGradientStops("none")).toBeNull();
    expect(parseGradientStops('url("data:image/png;base64,iVBORw0KGgo=")')).toBeNull();
    expect(parseGradientStops("image-set(url(a.png) 1x)")).toBeNull();
  });

  it("returns null when ONE stop is unreadable, never the stops it did read", () => {
    // The missing stop could be the worst one, so a partial answer here is a
    // fabricated measurement downstream.
    expect(parseGradientStops("linear-gradient(oklch(0.7 0.1 200), #eaf2ff)")).toBeNull();
    expect(parseGradientStops("linear-gradient(#ffffff, var(--brand))")).toBeNull();
    expect(parseGradientStops("linear-gradient(to right, #ffffff, color-mix(in srgb, red, blue))")).toBeNull();
    // And with enough readable stops left over to look like a whole gradient.
    // The unreadable one in the middle could be the darkest point of the run.
    expect(
      parseGradientStops("linear-gradient(#ffffff, oklch(0.2 0.1 200) 50%, #eaf2ff)"),
    ).toBeNull();
  });

  it("returns null for a non-default interpolation method", () => {
    // The stops are readable; the path between them is not the sRGB one this
    // module is entitled to reason about.
    expect(parseGradientStops("linear-gradient(in oklab, #ffffff, #eaf2ff)")).toBeNull();
  });
});

describe("flattenGradientBackdrops", () => {
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  const FADE = "linear-gradient(rgb(27, 58, 107), rgb(234, 242, 255))";

  it("resolves a gradient painted by an ancestor of the text", () => {
    // The shape in real markup: a transparent <p> inside a banner that paints
    // the gradient, over an opaque page.
    expect(
      flattenGradientBackdrops(
        [TRANSPARENT, TRANSPARENT, "rgb(255, 255, 255)"],
        ["none", FADE, "none"],
      ),
    ).toEqual([
      { r: 27, g: 58, b: 107, a: 1 },
      { r: 234, g: 242, b: 255, a: 1 },
    ]);
  });

  it("composites a translucent layer sitting over the gradient onto every stop", () => {
    const [dark, light] = flattenGradientBackdrops(
      ["rgba(0, 0, 0, 0.5)", TRANSPARENT, "rgb(255, 255, 255)"],
      ["none", "linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))", "none"],
    ) as Array<{ r: number; g: number; b: number; a: number }>;
    expect(dark).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(light).toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });

  it("returns null when there is no image, or more than one", () => {
    expect(flattenGradientBackdrops([TRANSPARENT], ["none"])).toBeNull();
    // Which of two painted images a given pixel shows depends on their sizes
    // and positions, which this stack does not carry.
    expect(
      flattenGradientBackdrops([TRANSPARENT, TRANSPARENT], [FADE, "url(photo.png)"]),
    ).toBeNull();
  });

  it("returns null when a stop is translucent: what shows through is not described here", () => {
    expect(
      flattenGradientBackdrops(
        [TRANSPARENT, "rgb(255, 255, 255)"],
        ["none", "linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.55))"],
      ),
    ).toBeNull();
  });

  it("returns null when an unreadable or opaque layer sits over the gradient", () => {
    expect(flattenGradientBackdrops(["oklch(0.7 0.1 200)", TRANSPARENT], ["none", FADE])).toBeNull();
    expect(flattenGradientBackdrops(["rgb(255, 255, 255)", TRANSPARENT], ["none", FADE])).toBeNull();
  });
});
