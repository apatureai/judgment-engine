import { describe, expect, it } from "vitest";
import {
  toInteractiveElements,
  toRawGeometryElements,
  toTextNodeStyles,
  type ExtractedElement,
  type ExtractedPage,
} from "../src/index.js";

/** A recorded extractor payload: what one `page.evaluate` round-trip returns. */
function element(overrides: Partial<ExtractedElement> = {}): ExtractedElement {
  return {
    tag: "p",
    id: null,
    testId: null,
    role: null,
    cssPath: "body > main > p",
    rect: { x: 32.004, y: 100.999, width: 300.5, height: 20.126 },
    animated: false,
    interactive: false,
    text: null,
    ...overrides,
  };
}

function page(elements: ExtractedElement[]): ExtractedPage {
  return {
    elements,
    fonts: [],
    documentHeight: 1200,
    bodyText: "hello",
    canvasBackground: "rgb(255, 255, 255)",
  };
}

describe("toRawGeometryElements", () => {
  it("stamps route and viewport and rounds rects to 2dp", () => {
    const [raw] = toRawGeometryElements(page([element()]), "/pricing", "tablet");
    expect(raw).toMatchObject({
      route: "/pricing",
      viewport: "tablet",
      tag: "p",
      cssPath: "body > main > p",
      rect: { x: 32, y: 101, width: 300.5, height: 20.13 },
    });
  });

  it("carries the animated flag through for the stability exclusion list", () => {
    const [raw] = toRawGeometryElements(page([element({ animated: true })]), "/", "mobile");
    expect(raw?.animated).toBe(true);
  });
});

describe("toTextNodeStyles", () => {
  it("only includes elements that carry their own text", () => {
    const withText = element({
      id: "hero-subtitle",
      text: {
        fontSizePx: 17,
        fontWeight: 400,
        color: "rgb(143, 143, 143)",
        backgroundStack: ["rgb(255, 255, 255)"],
        contentWidthPx: 345.4,
      },
    });
    const nodes = toTextNodeStyles(page([withText, element()]), "/", "desktop");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      selector: "#hero-subtitle",
      fontSizePx: 17,
      color: "rgb(143, 143, 143)",
      backgroundColor: "rgb(255, 255, 255)",
      contentWidthPx: 345.4,
    });
  });

  it("flattens the background stack onto the canvas", () => {
    const onCanvas = element({
      id: "plain",
      // What Chromium reports for a page that never declares a background: the
      // element, its ancestors and the root are all fully transparent.
      text: {
        fontSizePx: 32,
        fontWeight: 700,
        color: "rgb(0, 0, 0)",
        backgroundStack: ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"],
        contentWidthPx: 200,
      },
    });
    const [node] = toTextNodeStyles(page([onCanvas]), "/", "desktop");
    expect(node?.backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("reports an undeterminable backdrop as null instead of a default", () => {
    const dark: ExtractedPage = { ...page([]), canvasBackground: null };
    const onCanvas = element({
      text: {
        fontSizePx: 16,
        fontWeight: 400,
        color: "rgb(255, 255, 255)",
        backgroundStack: ["rgba(0, 0, 0, 0)"],
        contentWidthPx: 100,
      },
    });
    const [node] = toTextNodeStyles({ ...dark, elements: [onCanvas] }, "/", "desktop");
    expect(node?.backgroundColor).toBeNull();
  });

  it("prefers id, then data-testid, then the extractor css path", () => {
    const text = {
      fontSizePx: 14,
      fontWeight: 400,
      color: "#000",
      backgroundStack: ["#fff"],
      contentWidthPx: 100,
    };
    const nodes = toTextNodeStyles(
      page([
        element({ id: "a", testId: "b", text }),
        element({ testId: "b", text }),
        element({ cssPath: "body > span", text }),
        element({ cssPath: "", tag: "span", text }),
      ]),
      "/",
      "mobile",
    );
    expect(nodes.map((n) => n.selector)).toEqual(["#a", '[data-testid="b"]', "body > span", "span"]);
  });
});

describe("toInteractiveElements", () => {
  it("only includes pointer targets", () => {
    const button = element({ tag: "button", id: "icon-close", interactive: true, role: "button" });
    const elements = toInteractiveElements(page([button, element()]), "/", "mobile");
    expect(elements).toEqual([
      {
        route: "/",
        viewport: "mobile",
        selector: "#icon-close",
        role: "button",
        rect: { x: 32, y: 101, width: 300.5, height: 20.13 },
      },
    ]);
  });
});
