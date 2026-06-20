import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  contrastViolations,
  deterministicChecks,
  overflowViolations,
  parseColor,
  touchTargetViolations,
  type InteractiveElement,
  type TextNodeStyle,
} from "../src/index.js";

const rect = (width: number, height: number) => ({ x: 0, y: 0, width, height });

const textNode = (over: Partial<TextNodeStyle> = {}): TextNodeStyle => ({
  route: "/",
  viewport: "desktop",
  selector: "p",
  fontSizePx: 16,
  fontWeight: 400,
  color: "#000000",
  backgroundColor: "#ffffff",
  rect: rect(200, 20),
  contentWidthPx: 180,
  ...over,
});

describe("color + contrast math", () => {
  it("parses hex and rgb()/rgba()", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("currentColor")).toBeNull();
  });

  it("computes the WCAG contrast ratio (black on white = 21:1)", () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBeCloseTo(21, 0);
  });
});

describe("contrast violations", () => {
  it("flags low-contrast text and passes high-contrast text", () => {
    const low = textNode({ color: "#aaaaaa", backgroundColor: "#ffffff" }); // ~2.3:1
    const high = textNode({ color: "#000000", backgroundColor: "#ffffff" });
    expect(contrastViolations([low, high])).toHaveLength(1);
    expect(contrastViolations([low, high])[0]?.kind).toBe("contrast");
  });

  it("applies the relaxed large-text threshold", () => {
    // ratio ~3.3:1 fails for normal text but passes large text (>=24px).
    const color = "#949494";
    expect(contrastViolations([textNode({ color, fontSizePx: 16 })])).toHaveLength(1);
    expect(contrastViolations([textNode({ color, fontSizePx: 28 })])).toHaveLength(0);
  });

  it("stays silent when a color cannot be parsed (no guessing)", () => {
    expect(contrastViolations([textNode({ color: "var(--fg)" })])).toEqual([]);
  });
});

describe("overflow violations", () => {
  it("flags content wider than its container", () => {
    expect(overflowViolations([textNode({ contentWidthPx: 260, rect: rect(200, 20) })])).toHaveLength(1);
    expect(overflowViolations([textNode({ contentWidthPx: 190, rect: rect(200, 20) })])).toHaveLength(0);
  });
});

describe("touch-target violations", () => {
  const el = (w: number, h: number): InteractiveElement => ({
    route: "/",
    viewport: "mobile",
    selector: "button",
    role: "button",
    rect: rect(w, h),
  });

  it("flags sub-44px targets and passes large enough ones", () => {
    expect(touchTargetViolations([el(30, 30)])).toHaveLength(1);
    expect(touchTargetViolations([el(48, 48)])).toHaveLength(0);
    expect(touchTargetViolations([el(48, 20)])).toHaveLength(1); // one dimension too small
  });
});

describe("deterministicChecks", () => {
  it("aggregates all check kinds as facts for the prompt", () => {
    const findings = deterministicChecks({
      textNodes: [
        textNode({ color: "#bbbbbb", backgroundColor: "#ffffff" }), // contrast
        textNode({ contentWidthPx: 300, rect: rect(200, 20) }), // overflow
      ],
      interactive: [
        { route: "/", viewport: "mobile", selector: "a", role: "link", rect: rect(20, 20) },
      ],
    });
    const kinds = findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(["contrast", "overflow", "touch_target"]);
  });
});
