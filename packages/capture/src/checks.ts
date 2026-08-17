import type { MeasurementKind, MeasurementReport, Viewport, WireMeasurement, WireViewport } from "@engine/types";
import { compositeOver, isOpaque, parseCssColor } from "./color.js";

/**
 * Deterministic, code-computed UI checks (TRD §4.2/§6.3/§6.5). The model must
 * never read hex off pixels or guess element sizes. Contrast, overflow, and
 * touch-target violations are computed here from the captured computed styles +
 * geometry and handed to the critique prompt as FACTS, not questions. This is a
 * primary anti-hallucination lever (#30/#32).
 *
 * The browser-side extraction (a11y snapshot + computed styles) lives in the
 * Playwright worker (#11); these functions are pure so they are fully testable
 * without a browser and run identically on captured data.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Computed style + geometry for a single text node. */
export interface TextNodeStyle {
  route: string;
  viewport: Viewport;
  selector: string;
  /** Effective font size in CSS px. */
  fontSizePx: number;
  fontWeight: number;
  /** Foreground as a CSS color string; may be translucent (`rgba(…, .55)`). */
  color: string;
  /**
   * The FLATTENED, fully opaque backdrop behind the text: the element's own
   * background composited over its ancestors and the page canvas
   * (`toTextNodeStyles` resolves it). `null` when it could not be determined,
   * e.g. nothing in the stack is opaque and the canvas color is unknown. A null
   * backdrop makes the contrast check stay silent instead of guessing: an
   * invented ratio would be published as a measured fact.
   */
  backgroundColor: string | null;
  rect: Rect;
  /** scrollWidth of the node's content; > rect.width means horizontal overflow. */
  contentWidthPx: number;
  /**
   * The element's computed `overflow-x`, when the capture reported it.
   *
   * `contentWidthPx` alone cannot tell breakage from design: a `<pre>` with a
   * scrollbar, a horizontal carousel and a deliberately scrollable table all
   * have `scrollWidth > clientWidth` and are all working exactly as authored.
   * Only `overflow-x: visible` means the content actually escapes its box.
   *
   * Optional because the engine and the capture fleet deploy separately, and a
   * fleet that predates the field sends nothing. Absent is UNKNOWN, never
   * "visible": an unknown value is reported as a measurement and is never
   * block-eligible. The violation itself is still emitted either way, because a
   * measured overflow is worth a look even when it is intentional.
   */
  overflowX?: string;
  /**
   * Whether anything in this element's background stack paints something
   * `resolvedBackground` cannot see: a `background-image` or a `backdrop-filter`.
   *
   * The contrast check flattens background COLORS onto the canvas. White text on
   * a photo sitting over a white base therefore measures as a 1:1 violation that
   * a reader never experiences. The measurement is still emitted, because a
   * flagged element is worth a human look, but it is never block-eligible.
   *
   * Optional for the same reason `overflowX` is, and absent is UNKNOWN, so a
   * pre-upgrade capture yields a reported, non-block-eligible measurement.
   */
  backdropObscured?: boolean;
}

/** An interactive element whose hit target must meet the minimum size. */
export interface InteractiveElement {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string | null;
  rect: Rect;
}

export type CheckKind = "contrast" | "overflow" | "touch_target";

/**
 * The check kinds that count as BREAKAGE: measured evidence that the page did
 * not render the way it was laid out, as opposed to measured evidence that it
 * rendered exactly as intended and the intent was wrong.
 *
 * Only `overflow` qualifies. Content wider than its container is the page coming
 * apart, and it is the same class of fact the triage pass already collects from
 * the model under `obviousBreakage` ("overlap, unstyled HTML, broken images, or
 * overflow"). A contrast failure and an undersized touch target are real
 * defects, measured just as reliably, but they are properties of a page that
 * rendered correctly, so they belong in the deep prompt's fact list (where they
 * already are, via `factsForRoute`) rather than in the signal that overrules a
 * triage pass declining to look.
 *
 * Kept as one named constant because the classification is a judgment call and
 * has to be reviewable in one place rather than inferred from a filter buried in
 * a caller.
 */
export const BREAKAGE_KINDS: readonly CheckKind[] = ["overflow"];

/** Whether a measured finding is breakage (see `BREAKAGE_KINDS`). */
export function isBreakage(finding: DeterministicFinding): boolean {
  return BREAKAGE_KINDS.includes(finding.kind);
}

export interface DeterministicFinding {
  kind: CheckKind;
  route: string;
  viewport: Viewport;
  selector: string;
  /** A factual statement for the prompt, e.g. "contrast 2.31:1 (needs 4.5:1)". */
  detail: string;
  /**
   * Whether this measurement is precise enough for a consumer to gate a merge
   * on. Set by the check that produced it, from the precision inputs only the
   * check can see (`overflow-x`, the viewport, an obscured backdrop).
   *
   * The engine owns PRECISION; a consumer owns POLICY. `false` never means the
   * measurement is wrong, only that acting on it automatically would be. The
   * violation is reported either way.
   *
   * Optional so a capture service that predates the flag still parses, and
   * absent is read as `false` everywhere: an unknown precision must never
   * authorize a merge block.
   */
  blockEligible?: boolean;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function channelLuminance(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA threshold: 3.0 for large text (>=24px, or >=18.66px bold), else 4.5. */
function contrastThreshold(node: TextNodeStyle): number {
  const isLarge = node.fontSizePx >= 24 || (node.fontSizePx >= 18.66 && node.fontWeight >= 700);
  return isLarge ? 3.0 : 4.5;
}

/**
 * REPORTING threshold for touch-target size, in CSS px.
 *
 * 44 is WCAG 2.5.5 Target Size (Enhanced), which is level **AAA**, and it is
 * also the iOS/Android platform HIG number. It is the right line to REPORT
 * against: a 30px control is worth telling a designer about.
 *
 * It is the wrong line to fail a build on, and this comment used to imply
 * otherwise by citing 2.5.5 without its level. See `AA_TOUCH_TARGET_PX`.
 */
export const MIN_TOUCH_TARGET_PX = 44;

/**
 * The level **AA** touch-target line: WCAG 2.2 SC 2.5.8 Target Size (Minimum),
 * 24x24 CSS px.
 *
 * This, not 44, is what a repo may gate a merge on, and only on a mobile
 * viewport: 2.5.8 is a pointer-target criterion, and applying a phone rule to a
 * 1440px desktop surface with a mouse fails pages that are not failing anyone.
 */
export const AA_TOUCH_TARGET_PX = 24;

export function contrastViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    // Every `continue` below is the same decision: the true ratio is not
    // knowable from what was captured, so no fact is emitted. Silence, never a
    // guess; a wrong number here is published as a measurement.
    if (node.backgroundColor === null) continue;
    const bg = parseCssColor(node.backgroundColor);
    if (bg === null || !isOpaque(bg)) continue;
    const rawFg = parseCssColor(node.color);
    if (rawFg === null || rawFg.a === 0) continue;
    // Translucent text is composited onto the resolved backdrop; its rendered
    // color is what a reader actually sees, and what WCAG is defined over.
    const fg = compositeOver(rawFg, bg);
    const ratio = contrastRatio(fg, bg);
    const threshold = contrastThreshold(node);
    if (ratio < threshold) {
      out.push({
        kind: "contrast",
        route: node.route,
        viewport: node.viewport,
        selector: node.selector,
        detail: `text contrast ${ratio.toFixed(2)}:1 is below WCAG AA ${threshold.toFixed(1)}:1`,
        // The ratio is exact for a flat colour backdrop and meaningless over a
        // photo, and only the extractor can tell which this was. Unknown counts
        // as obscured: the same discipline as the `continue`s above, one step
        // weaker because the fact is still worth reporting.
        blockEligible: node.backdropObscured === false,
      });
    }
  }
  return out;
}

export function overflowViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    if (node.contentWidthPx > Math.ceil(node.rect.width)) {
      out.push({
        kind: "overflow",
        route: node.route,
        viewport: node.viewport,
        selector: node.selector,
        detail: `content width ${node.contentWidthPx}px exceeds container ${Math.round(node.rect.width)}px (horizontal overflow)`,
        // `scrollWidth` on a deliberate scroll container is not breakage. Only
        // `visible` means the content escapes the box; `auto`, `scroll`,
        // `hidden`, `clip` and unknown are reported and never gated on.
        blockEligible: node.overflowX === "visible",
      });
    }
  }
  return out;
}

export function touchTargetViolations(
  elements: InteractiveElement[],
  minPx: number = MIN_TOUCH_TARGET_PX,
): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const el of elements) {
    if (el.rect.width < minPx || el.rect.height < minPx) {
      out.push({
        kind: "touch_target",
        route: el.route,
        viewport: el.viewport,
        selector: el.selector,
        detail: `touch target ${Math.round(el.rect.width)}x${Math.round(el.rect.height)}px is below ${minPx}x${minPx}px`,
        // Reported at the AAA line, gateable only at the AA one, and only where
        // a finger is the pointer. A 28x28 control on a desktop page is a note
        // for a designer, not grounds to fail somebody's build.
        blockEligible:
          el.viewport === "mobile" &&
          (el.rect.width < AA_TOUCH_TARGET_PX || el.rect.height < AA_TOUCH_TARGET_PX),
      });
    }
  }
  return out;
}

export interface DeterministicCheckInput {
  textNodes: TextNodeStyle[];
  interactive: InteractiveElement[];
}

/** Run all deterministic checks, returning the facts for the critique prompt. */
export function deterministicChecks(input: DeterministicCheckInput): DeterministicFinding[] {
  return [
    ...contrastViolations(input.textNodes),
    ...overflowViolations(input.textNodes),
    ...touchTargetViolations(input.interactive),
  ];
}

/** Every check this module implements, in the order the report lists them. */
export const ALL_MEASUREMENT_KINDS: readonly MeasurementKind[] = [
  "contrast",
  "overflow",
  "touch_target",
];

/**
 * Project the per-(route, viewport) measurements into the wire report a
 * consumer receives.
 *
 * The same 3.23:1 contrast measured at three viewports is ONE defect a reader
 * fixes once, so the grouping key is (kind, route, element, detail) and the
 * viewports accumulate in first-encounter order. That rule is not new: it is
 * exactly what the terminal report's `groupFacts` has always done, and
 * `groupFacts` now delegates here so the sentence a reader sees in a terminal
 * and the sentence a consumer parses off the wire cannot drift apart.
 *
 * `blockEligible` on a group is true only when EVERY measurement in it is
 * block-eligible. A violation that is precise at mobile and inconclusive at
 * desktop is not something to fail a build on, and the group is one row.
 *
 * `checksRun` defaults to every check this module implements, because that is
 * what `deterministicChecks` runs. A caller that ran a subset says so, and a
 * caller that measured nothing passes an empty list, which is the difference
 * between "measured, clean" and "not measured".
 */
export function toMeasurementReport(
  findings: readonly DeterministicFinding[],
  checksRun: readonly MeasurementKind[] = ALL_MEASUREMENT_KINDS,
): MeasurementReport {
  const groups = new Map<string, WireMeasurement>();
  for (const finding of findings) {
    // JSON, so no separator character can collide with a selector or detail.
    const key = JSON.stringify([finding.kind, finding.route, finding.selector, finding.detail]);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.viewports.includes(finding.viewport as WireViewport)) {
        existing.viewports.push(finding.viewport as WireViewport);
      }
      // One inconclusive viewport makes the whole group inconclusive.
      existing.blockEligible = existing.blockEligible && finding.blockEligible === true;
      continue;
    }
    groups.set(key, {
      kind: finding.kind,
      route: finding.route,
      viewports: [finding.viewport as WireViewport],
      element: finding.selector,
      detail: finding.detail,
      blockEligible: finding.blockEligible === true,
    });
  }
  return { checksRun: [...checksRun], violations: [...groups.values()] };
}
