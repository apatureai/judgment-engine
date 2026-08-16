import { describe, expect, it } from "vitest";
import {
  animatedExclusions,
  isLandmark,
  normalizeRole,
  serializeGeometry,
  stableSelector,
  type DeterministicFinding,
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

const measurement = (over: Partial<DeterministicFinding> = {}): DeterministicFinding => ({
  kind: "overflow",
  route: "/",
  viewport: "desktop",
  selector: "#plan-blurb",
  detail: "content width 874px exceeds container 200px (horizontal overflow)",
  ...over,
});

describe("serializeGeometry admits measured elements", () => {
  it("includes a non-landmark the deterministic checks measured", () => {
    const blurb = raw({ tag: "p", id: "plan-blurb" });
    // Landmark-only: the element the engine measured is not citable.
    expect(serializeGeometry([blurb]).map((e) => e.selector)).toEqual([]);
    // With the measurement, it is.
    const entries = serializeGeometry([blurb], [measurement()]);
    expect(entries.map((e) => e.selector)).toEqual(["#plan-blurb"]);
    expect(entries[0]!.rect).toEqual(blurb.rect);
    // Role stays honest: a <p> is generic, it is not promoted to a landmark.
    expect(entries[0]!.role).toBe("generic");
  });

  it("does not admit an unmeasured non-landmark alongside a measured one", () => {
    const entries = serializeGeometry(
      [raw({ tag: "p", id: "plan-blurb" }), raw({ tag: "span", id: "footnote" })],
      [measurement()],
    );
    expect(entries.map((e) => e.selector)).toEqual(["#plan-blurb"]);
  });

  it("scopes the admission to the route and viewport actually measured", () => {
    const elements = [
      raw({ tag: "p", id: "plan-blurb", route: "/pricing", viewport: "desktop" }),
      raw({ tag: "p", id: "plan-blurb", route: "/pricing", viewport: "mobile" }),
      raw({ tag: "p", id: "plan-blurb", route: "/", viewport: "desktop" }),
    ];
    const entries = serializeGeometry(elements, [
      measurement({ route: "/pricing", viewport: "desktop" }),
    ]);
    // Only the one page the measurement was taken on.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.route).toBe("/pricing");
    expect(entries[0]!.viewport).toBe("desktop");
  });

  it("admits measured elements for every check kind, not just overflow", () => {
    const entries = serializeGeometry(
      [raw({ tag: "span", id: "muted" }), raw({ tag: "li", id: "row" })],
      [
        measurement({ kind: "contrast", selector: "#muted", detail: "text contrast 2.31:1" }),
        measurement({ kind: "touch_target", selector: "#row", detail: "touch target 28x28px" }),
      ],
    );
    expect(entries.map((e) => e.selector)).toEqual(["#muted", "#row"]);
  });

  it("keeps landmarks when the measurement list is empty", () => {
    const entries = serializeGeometry([raw({ tag: "nav", id: "top" }), raw({ tag: "p", id: "x" })], []);
    expect(entries.map((e) => e.selector)).toEqual(["#top"]);
  });

  it("does not duplicate an element that is both a landmark and measured", () => {
    const entries = serializeGeometry(
      [raw({ tag: "h1", id: "hero-title" })],
      [measurement({ kind: "contrast", selector: "#hero-title" })],
    );
    expect(entries.map((e) => e.selector)).toEqual(["#hero-title"]);
  });
});
