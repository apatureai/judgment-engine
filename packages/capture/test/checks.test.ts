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
  const wide = (over: Partial<TextNodeStyle> = {}) =>
    textNode({ contentWidthPx: 260, rect: rect(200, 20), ...over });

  it("flags content wider than its container", () => {
    expect(overflowViolations([wide()])).toHaveLength(1);
    expect(overflowViolations([textNode({ contentWidthPx: 190, rect: rect(200, 20) })])).toHaveLength(0);
  });

  it("says nothing about an element that scrolls on purpose", () => {
    // The `<pre>` with a scrollbar, the carousel, the scrollable table. All
    // three have scrollWidth wider than the box on every render, forever.
    for (const overflowX of ["auto", "scroll", "overlay"]) {
      expect(overflowViolations([wide({ overflowX })])).toEqual([]);
    }
  });

  it("says nothing when an ancestor is the scroller", () => {
    // The commonest shape in real markup: a wide row inside a .table-wrap. The
    // row itself computes `overflow-x: visible` and is entirely reachable.
    expect(overflowViolations([wide({ overflowX: "visible", ancestorScrollsX: true })])).toEqual([]);
  });

  it("still reports clipped content, which no reader can reach", () => {
    // `hidden` and `clip` also declare what happens to the excess, and what
    // happens is that it is cut off. That stays worth reporting.
    for (const overflowX of ["hidden", "clip"]) {
      expect(overflowViolations([wide({ overflowX })])).toHaveLength(1);
    }
  });
});

describe("touch-target violations", () => {
  const el = (w: number, h: number, y: number, n: number): InteractiveElement => ({
    route: "/",
    viewport: "mobile",
    selector: `button:nth-of-type(${n})`,
    role: "button",
    rect: { x: 0, y, width: w, height: h },
    inlineTarget: false,
  });

  /**
   * Two targets stacked 2px apart: close enough that a 24px circle centred on
   * one reaches the other, which is the crowding SC 2.5.8 is about. Without it
   * the Spacing exception applies and neither is a failure.
   */
  const crowded = (w: number, h: number): InteractiveElement[] => [
    el(w, h, 0, 1),
    el(w, h, h + 2, 2),
  ];

  it("flags sub-24px targets and passes large enough ones", () => {
    expect(touchTargetViolations(crowded(20, 20))).toHaveLength(2);
    expect(touchTargetViolations(crowded(48, 48))).toHaveLength(0);
    // One dimension too small is still a violation.
    expect(touchTargetViolations(crowded(48, 20))).toHaveLength(2);
  });

  it("measures AA by default and names the criterion it applied", () => {
    const [violation] = touchTargetViolations(crowded(20, 20));
    expect(violation?.detail).toBe(
      "touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA",
    );
  });

  it("measures 2.5.5 only when asked, and says so", () => {
    // A 30x30 control clears AA and fails the AAA line. Under the default it is
    // not a finding at all, because claiming a 2.5.8 failure here would be false.
    expect(touchTargetViolations(crowded(30, 30))).toHaveLength(0);
    const [strict] = touchTargetViolations(crowded(30, 30), { criterion: "AAA" });
    expect(strict?.detail).toBe(
      "touch target 30x30px is below the 44x44px minimum in WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA",
    );
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
        {
          route: "/",
          viewport: "mobile",
          selector: "a",
          role: "link",
          rect: { x: 0, y: 0, width: 20, height: 20 },
        },
        {
          route: "/",
          viewport: "mobile",
          selector: "a:nth-of-type(2)",
          role: "link",
          rect: { x: 22, y: 0, width: 20, height: 20 },
        },
      ],
    });
    const kinds = [...new Set(findings.map((f) => f.kind))].sort();
    expect(kinds).toEqual(["contrast", "overflow", "touch_target"]);
  });

  it("passes the requested target-size criterion through to the touch check", () => {
    const interactive: InteractiveElement[] = [
      { route: "/", viewport: "mobile", selector: "a", role: "link", rect: rect(30, 30) },
    ];
    expect(deterministicChecks({ textNodes: [], interactive })).toHaveLength(0);
    expect(
      deterministicChecks({ textNodes: [], interactive, touchTargetCriterion: "AAA" }),
    ).toHaveLength(1);
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
