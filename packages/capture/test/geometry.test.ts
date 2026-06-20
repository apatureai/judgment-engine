import { describe, expect, it } from "vitest";
import {
  animatedExclusions,
  isLandmark,
  normalizeRole,
  serializeGeometry,
  stableSelector,
  type RawGeometryElement,
} from "../src/index.js";

const raw = (over: Partial<RawGeometryElement>): RawGeometryElement => ({
  route: "/",
  viewport: "desktop",
  tag: "div",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  ...over,
});

describe("landmark selection", () => {
  it("keeps nav/headings/buttons/inputs and drops generic elements", () => {
    expect(isLandmark(raw({ tag: "nav" }))).toBe(true);
    expect(isLandmark(raw({ tag: "h2" }))).toBe(true);
    expect(isLandmark(raw({ tag: "button" }))).toBe(true);
    expect(isLandmark(raw({ tag: "input" }))).toBe(true);
    expect(isLandmark(raw({ tag: "div", role: "button" }))).toBe(true);
    expect(isLandmark(raw({ tag: "div" }))).toBe(false);
  });
});

describe("role normalization", () => {
  it("derives implicit roles and prefers explicit ones", () => {
    expect(normalizeRole(raw({ tag: "nav" }))).toBe("navigation");
    expect(normalizeRole(raw({ tag: "h3" }))).toBe("heading");
    expect(normalizeRole(raw({ tag: "input" }))).toBe("textbox");
    expect(normalizeRole(raw({ tag: "div", role: "tablist" }))).toBe("tablist");
  });
});

describe("stable selector", () => {
  it("prefers id, then data-testid, then cssPath, then tag", () => {
    expect(stableSelector(raw({ tag: "button", id: "submit" }))).toBe("#submit");
    expect(stableSelector(raw({ tag: "button", testId: "cta" }))).toBe('[data-testid="cta"]');
    expect(stableSelector(raw({ tag: "button", cssPath: "main > button:nth-of-type(2)" }))).toBe(
      "main > button:nth-of-type(2)",
    );
    expect(stableSelector(raw({ tag: "button" }))).toBe("button");
  });
});

describe("serializeGeometry", () => {
  it("serializes landmarks and surfaces the animated exclusion list", () => {
    const entries = serializeGeometry([
      raw({ tag: "nav", id: "top" }),
      raw({ tag: "div" }), // dropped (not a landmark)
      raw({ tag: "button", testId: "buy", animated: true }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.selector)).toEqual(["#top", '[data-testid="buy"]']);

    const animated = animatedExclusions(entries);
    expect(animated).toHaveLength(1);
    expect(animated[0]!.selector).toBe('[data-testid="buy"]');
  });
});
