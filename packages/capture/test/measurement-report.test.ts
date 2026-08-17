import { describe, expect, it } from "vitest";
import {
  AA_TOUCH_TARGET_PX,
  MIN_TOUCH_TARGET_PX,
  contrastViolations,
  overflowViolations,
  toMeasurementReport,
  touchTargetViolations,
  type DeterministicFinding,
  type InteractiveElement,
  type TextNodeStyle,
} from "../src/index.js";

/**
 * `blockEligible` and the wire report.
 *
 * The engine owns PRECISION and a consumer owns POLICY. A measurement is
 * reported whenever a check computes it; `blockEligible` is the separate, much
 * narrower claim that acting on it automatically would be sound. The three
 * checks fail that claim for three different reasons, and every one of them was
 * a real false-positive class before this existed:
 *
 *   - a `<pre>` with `overflow-x: auto` has content wider than its box on
 *     purpose, and overflow is the ONLY kind the triage override trusts;
 *   - 44px is WCAG 2.5.5, which is level AAA, and it was being applied to a
 *     desktop pointer surface as well as a phone;
 *   - a flattened background COLOUR cannot see a background image, so white text
 *     on a photo over a white base measured as a 1:1 failure nobody experiences.
 */

const rect = (width: number, height: number) => ({ x: 0, y: 0, width, height });

const textNode = (over: Partial<TextNodeStyle> = {}): TextNodeStyle => ({
  route: "/",
  viewport: "desktop",
  selector: "#promo-code",
  fontSizePx: 16,
  fontWeight: 400,
  color: "#000000",
  backgroundColor: "#ffffff",
  rect: rect(140, 20),
  contentWidthPx: 345,
  ...over,
});

const interactive = (over: Partial<InteractiveElement> = {}): InteractiveElement => ({
  route: "/",
  viewport: "desktop",
  selector: "#icon-close",
  role: null,
  rect: rect(28, 28),
  ...over,
});

describe("overflow block-eligibility (P1)", () => {
  it("T8: a scroll container reports the measurement and is never gateable", () => {
    const [violation] = overflowViolations([textNode({ overflowX: "auto" })]);

    expect(violation?.kind).toBe("overflow");
    expect(violation?.detail).toContain("exceeds container");
    expect(violation?.blockEligible).toBe(false);
  });

  it("only `visible` is gateable", () => {
    for (const overflowX of ["auto", "scroll", "hidden", "clip"]) {
      const [violation] = overflowViolations([textNode({ overflowX })]);
      expect(violation?.blockEligible).toBe(false);
    }
    const [visible] = overflowViolations([textNode({ overflowX: "visible" })]);
    expect(visible?.blockEligible).toBe(true);
  });

  it("a capture that did not report overflow-x is reported, not gated", () => {
    // A pre-upgrade capture fleet. Unknown is never read as `visible`.
    const [violation] = overflowViolations([textNode()]);
    expect(violation).toBeDefined();
    expect(violation?.blockEligible).toBe(false);
  });
});

describe("touch-target block-eligibility (P2)", () => {
  it("the reporting threshold is AAA and the gating threshold is AA", () => {
    expect(MIN_TOUCH_TARGET_PX).toBe(44);
    expect(AA_TOUCH_TARGET_PX).toBe(24);
  });

  it("T7: a 28x28 target is reported and is not gateable; a 20x20 mobile one is", () => {
    const [desktop] = touchTargetViolations([interactive()]);
    expect(desktop?.detail).toContain("28x28px");
    expect(desktop?.blockEligible).toBe(false);

    const [mobile] = touchTargetViolations([
      interactive({ viewport: "mobile", rect: rect(20, 20) }),
    ]);
    expect(mobile?.blockEligible).toBe(true);
  });

  it("a 20x20 target on desktop is reported and is not gateable", () => {
    // 2.5.8 is a pointer-target criterion. A mouse on a 1440px page is not the
    // hazard it describes, and failing that build fails nobody's user.
    const [violation] = touchTargetViolations([interactive({ rect: rect(20, 20) })]);
    expect(violation?.blockEligible).toBe(false);
  });

  it("a 28x28 mobile target is reported and is not gateable either", () => {
    // Above the AA line, below the AAA one. This is the case the old comment
    // implied was a WCAG AA failure and is not.
    const [violation] = touchTargetViolations([interactive({ viewport: "mobile" })]);
    expect(violation?.detail).toContain("below 44x44px");
    expect(violation?.blockEligible).toBe(false);
  });
});

describe("contrast block-eligibility (P3)", () => {
  it("text over a flat colour backdrop is gateable", () => {
    const [violation] = contrastViolations([
      textNode({ color: "#8f8f8f", backgroundColor: "#ffffff", backdropObscured: false }),
    ]);
    expect(violation?.detail).toContain("below WCAG AA");
    expect(violation?.blockEligible).toBe(true);
  });

  it("text over a background image is reported and is not gateable", () => {
    const [violation] = contrastViolations([
      textNode({ color: "#8f8f8f", backgroundColor: "#ffffff", backdropObscured: true }),
    ]);
    expect(violation).toBeDefined();
    expect(violation?.blockEligible).toBe(false);
  });

  it("a capture that did not say is reported, not gated", () => {
    const [violation] = contrastViolations([
      textNode({ color: "#8f8f8f", backgroundColor: "#ffffff" }),
    ]);
    expect(violation?.blockEligible).toBe(false);
  });
});

describe("toMeasurementReport", () => {
  const finding = (over: Partial<DeterministicFinding> = {}): DeterministicFinding => ({
    kind: "contrast",
    route: "/",
    viewport: "desktop",
    selector: "#hero-subtitle",
    detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
    blockEligible: true,
    ...over,
  });

  it("collapses one defect measured at three viewports into one row", () => {
    const report = toMeasurementReport([
      finding({ viewport: "mobile" }),
      finding({ viewport: "tablet" }),
      finding({ viewport: "desktop" }),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.viewports).toEqual(["mobile", "tablet", "desktop"]);
    expect(report.violations[0]?.element).toBe("#hero-subtitle");
  });

  it("keeps distinct elements, routes and details apart", () => {
    const report = toMeasurementReport([
      finding(),
      finding({ selector: "#footer-note" }),
      finding({ route: "/pricing" }),
      finding({ detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" }),
    ]);

    expect(report.violations).toHaveLength(4);
  });

  it("one inconclusive viewport makes the whole group inconclusive", () => {
    // The group is one row a reader acts on once, so it inherits the weakest
    // precision claim in it rather than the strongest.
    const report = toMeasurementReport([
      finding({ viewport: "mobile", blockEligible: true }),
      finding({ viewport: "desktop", blockEligible: false }),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.blockEligible).toBe(false);
  });

  it("reads an absent blockEligible as not gateable", () => {
    const { blockEligible: _dropped, ...withoutFlag } = finding();
    const report = toMeasurementReport([withoutFlag]);

    expect(report.violations[0]?.blockEligible).toBe(false);
  });

  it("states which checks ran, so an empty violations list means something", () => {
    const measuredClean = toMeasurementReport([]);
    expect(measuredClean).toEqual({
      checksRun: ["contrast", "overflow", "touch_target"],
      violations: [],
    });

    const measuredNothing = toMeasurementReport([], []);
    expect(measuredNothing).toEqual({ checksRun: [], violations: [] });
  });
});
