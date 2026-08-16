import { describe, expect, it } from "vitest";
import {
  BREAKAGE_KINDS,
  contrastRatio,
  contrastViolations,
  deterministicChecks,
  isBreakage,
  overflowViolations,
  touchTargetViolations,
  type DeterministicFinding,
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

describe("contrast math", () => {
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
    expect(contrastViolations([textNode({ color: "oklch(0.7 0.1 200)" })])).toEqual([]);
  });

  it("stays silent when the backdrop could not be determined", () => {
    // The regression this guards: an unresolved backdrop used to arrive as the
    // transparent string `rgba(0, 0, 0, 0)`, which parsed as opaque black and
    // reported black-on-white body text as 1.00:1.
    expect(contrastViolations([textNode({ backgroundColor: null })])).toEqual([]);
    expect(contrastViolations([textNode({ backgroundColor: "rgba(0, 0, 0, 0)" })])).toEqual([]);
  });

  it("composites translucent text onto the backdrop before measuring", () => {
    // rgba(0,0,0,.45) over white renders as rgb(140,140,140): 3.36:1, a real
    // violation. Read as opaque black it would be 21:1 and silently missed.
    const faded = textNode({ color: "rgba(0, 0, 0, 0.45)", backgroundColor: "#ffffff" });
    const [violation] = contrastViolations([faded]);
    expect(violation?.detail).toBe("text contrast 3.36:1 is below WCAG AA 4.5:1");
    // …and the same text at 55% clears the bar, so this is a measurement, not a
    // blanket "translucent text fails" rule.
    expect(contrastViolations([textNode({ color: "rgba(0, 0, 0, 0.55)" })])).toEqual([]);
  });

  it("ignores fully transparent text rather than measuring an invisible color", () => {
    expect(contrastViolations([textNode({ color: "rgba(0, 0, 0, 0)" })])).toEqual([]);
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

/**
 * Which measurements count as BREAKAGE (#2).
 *
 * The distinction is load-bearing rather than cosmetic: breakage is what
 * overrules a triage pass that declined to look, so widening it changes what
 * gets a deep model call and narrowing it silently loses one.
 */
describe("BREAKAGE_KINDS", () => {
  const measured = (kind: "contrast" | "overflow" | "touch_target"): DeterministicFinding => ({
    kind,
    route: "/",
    viewport: "mobile",
    selector: "#x",
    detail: "detail",
  });

  it("counts overflow: content wider than its container is the page coming apart", () => {
    expect(isBreakage(measured("overflow"))).toBe(true);
  });

  it("does NOT count contrast or touch targets", () => {
    // Both are real, reliably measured defects, and both are already threaded
    // into the deep prompt as facts. Neither is evidence the page rendered
    // wrong: they are properties of a page that rendered exactly as laid out.
    expect(isBreakage(measured("contrast"))).toBe(false);
    expect(isBreakage(measured("touch_target"))).toBe(false);
  });

  it("keeps the classification in one reviewable place", () => {
    expect([...BREAKAGE_KINDS]).toEqual(["overflow"]);
  });
});
