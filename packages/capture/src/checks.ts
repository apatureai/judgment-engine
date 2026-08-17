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
   *
   * Optional because the engine and the capture fleet deploy separately, and a
   * fleet that predates the field sends nothing. Absent is UNKNOWN, never
   * "visible": an unknown value is reported as a measurement and is never
   * block-eligible.
   */
  overflowX?: string;
  /**
   * Whether an ANCESTOR of this element scrolls horizontally.
   *
   * The scroller is usually not the element that overflows. A wide row inside a
   * `.table-wrap`, a long line inside a scrolling code shell: the text itself
   * computes `overflow-x: visible` and looks exactly like a page coming apart,
   * and the reader can reach every pixel of it.
   *
   * Optional for the same reason, and absent is UNKNOWN: the measurement is
   * reported and not block-eligible, because an unseen ancestor scroller could
   * be the whole explanation.
   */
  ancestorScrollsX?: boolean;
  /**
   * Whether anything in this element's background stack paints something
   * `resolvedBackground` cannot see: a `background-image` or a `backdrop-filter`.
   *
   * The contrast check flattens background COLORS onto the canvas. White text on
   * a photo sitting over a white base would therefore measure as a 1:1 failure
   * no reader experiences. A ratio against an image is not computable from a
   * flattened colour at all, so a KNOWN-obscured backdrop is declined rather
   * than measured, exactly like an unparseable colour: the check emits nothing.
   *
   * Optional for the same reason `overflowX` is, and absent is UNKNOWN, which
   * still yields a reported, non-block-eligible measurement.
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
  /**
   * Whether this target is an inline element inside a run of non-target text,
   * i.e. a link in a sentence.
   *
   * Both target-size criteria exempt that shape by name ("Inline"), because
   * such a target's height is the line-height of the prose around it. Optional,
   * and absent is UNKNOWN: reported, never block-eligible, because an
   * unevaluated exception could be the entire finding.
   */
  inlineTarget?: boolean;
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
 * The two WCAG target-size criteria, with the level each one belongs to.
 *
 * This table exists because the emitted text has to name the criterion it
 * actually applied. The check used to measure against 44 and cite "2.5.5"
 * without its level, which reads as a conformance failure and is not one: 2.5.5
 * Target Size (Enhanced) is level AAA, a line almost no product commits to. The
 * level **AA** criterion, the one a repository plausibly conforms to, is 2.5.8
 * Target Size (Minimum) at 24x24 CSS px.
 *
 * So AA is the default, and 44 stays available for a team that has chosen the
 * stricter line. Whichever is applied, its number, id, name and level go into
 * the sentence, so a reader can check the claim against the spec.
 */
export const TOUCH_TARGET_CRITERIA = {
  AA: { sc: "2.5.8", name: "Target Size (Minimum)", level: "AA", minPx: 24 },
  AAA: { sc: "2.5.5", name: "Target Size (Enhanced)", level: "AAA", minPx: 44 },
} as const;

/** Which target-size criterion to measure against. */
export type TouchTargetCriterion = keyof typeof TOUCH_TARGET_CRITERIA;

/**
 * AA, not AAA. The engine measures what a team is likely to have committed to,
 * and reports it as what it is.
 */
export const DEFAULT_TOUCH_TARGET_CRITERION: TouchTargetCriterion = "AA";

/** WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA. */
export const AA_TOUCH_TARGET_PX = TOUCH_TARGET_CRITERIA.AA.minPx;

/** WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA. Also the iOS/Android HIG number. */
export const AAA_TOUCH_TARGET_PX = TOUCH_TARGET_CRITERIA.AAA.minPx;

/**
 * The viewports where a target-size criterion applies.
 *
 * Both criteria are about POINTER targets, and the hazard they describe is a
 * finger. A 1440px desktop capture is driven with a mouse, where a 20px control
 * is a design note and not an accessibility failure, so the check does not run
 * there at all. Measuring it and then quietly refusing to gate on it would
 * still put a sentence in front of a reader claiming a WCAG failure that the
 * criterion does not assert.
 *
 * Tablet counts: it is an 834px touch surface, and a finger on it is the same
 * finger.
 */
export const TOUCH_VIEWPORTS: readonly Viewport[] = ["mobile", "tablet"];

export function contrastViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    // Every `continue` below is the same decision: the true ratio is not
    // knowable from what was captured, so no fact is emitted. Silence, never a
    // guess; a wrong number here is published as a measurement.
    if (node.backgroundColor === null) continue;
    // A background-image or a backdrop-filter paints something no flattened
    // colour represents. White text on a photograph over a white page flattens
    // to 1.00:1, a number that is not merely imprecise but false, and this
    // engine publishes its measurements as facts. Not measurable here.
    if (node.backdropObscured === true) continue;
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
        // Exact when the extractor confirmed a flat colour backdrop. A capture
        // that never reported the field could be sitting on an image nobody
        // looked for, so it is reported and not gated on.
        blockEligible: node.backdropObscured === false,
      });
    }
  }
  return out;
}

/**
 * The computed `overflow-x` values that make an element a scroll container: the
 * excess is reachable, by wheel, swipe, drag or keyboard.
 *
 * `hidden` and `clip` are deliberately NOT here. They also declare what happens
 * to the excess, but what happens is that the reader never gets it, so those
 * stay reportable (and, being a common and usually deliberate authoring tool,
 * not gateable).
 */
const SCROLLABLE_OVERFLOW_X: readonly string[] = ["auto", "scroll", "overlay"];

export function overflowViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    if (node.contentWidthPx <= Math.ceil(node.rect.width)) continue;
    // A scroll container has content wider than its box by definition and on
    // purpose. Every `<pre>` with a scrollbar and every horizontal carousel
    // measured as breakage before this line existed, and `overflow` is the one
    // kind that overrules a triage pass declining to look, so the noisiest
    // measurement was also the loudest.
    if (node.overflowX !== undefined && SCROLLABLE_OVERFLOW_X.includes(node.overflowX)) continue;
    // The scroller is frequently the wrapper, not the text: a wide row inside a
    // `.table-wrap` computes `overflow-x: visible` on the row itself. The
    // reader can still reach all of it, so it is not the page coming apart.
    if (node.ancestorScrollsX === true) continue;
    out.push({
      kind: "overflow",
      route: node.route,
      viewport: node.viewport,
      selector: node.selector,
      detail: `content width ${node.contentWidthPx}px exceeds container ${Math.round(node.rect.width)}px (horizontal overflow)`,
      // Gateable only when the capture affirmatively established both halves:
      // the box does not scroll, and nothing above it does either. A capture
      // that did not report a field leaves the question open, and an open
      // question must not fail a build.
      blockEligible: node.overflowX === "visible" && node.ancestorScrollsX === false,
    });
  }
  return out;
}

/** Centre of a rect, in the same coordinate space. */
function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Whether a circle overlaps a rect (touching is not overlapping). */
function circleOverlapsRect(
  centre: { x: number; y: number },
  radius: number,
  rect: Rect,
): boolean {
  const nearestX = Math.min(Math.max(centre.x, rect.x), rect.x + rect.width);
  const nearestY = Math.min(Math.max(centre.y, rect.y), rect.y + rect.height);
  const dx = centre.x - nearestX;
  const dy = centre.y - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function isUndersized(rect: Rect, minPx: number): boolean {
  return rect.width < minPx || rect.height < minPx;
}

/**
 * The "Spacing" exception in WCAG 2.2 SC 2.5.8: an undersized target does not
 * fail the criterion when a 24 CSS px diameter circle centred on it touches no
 * other target, and no other undersized target's circle.
 *
 * This is the difference between a 20px icon button crammed against its
 * neighbour, which is the hazard the criterion describes, and a 20px icon
 * button with clear space around it, which is not. Citing 2.5.8 while ignoring
 * its exceptions would be citing it incorrectly, which is the bug this check
 * had in the first place.
 *
 * The exception belongs to 2.5.8 only; 2.5.5 (AAA) has no spacing relief.
 */
function meetsSpacingException(
  target: InteractiveElement,
  peers: readonly InteractiveElement[],
): boolean {
  const radius = AA_TOUCH_TARGET_PX / 2;
  const centre = centreOf(target.rect);
  for (const peer of peers) {
    if (peer === target) continue;
    if (peer.route !== target.route || peer.viewport !== target.viewport) continue;
    if (circleOverlapsRect(centre, radius, peer.rect)) return false;
    if (isUndersized(peer.rect, AA_TOUCH_TARGET_PX)) {
      const peerCentre = centreOf(peer.rect);
      const dx = centre.x - peerCentre.x;
      const dy = centre.y - peerCentre.y;
      if (Math.hypot(dx, dy) < AA_TOUCH_TARGET_PX) return false;
    }
  }
  return true;
}

export interface TouchTargetOptions {
  /**
   * Which criterion to measure against. Defaults to AA (SC 2.5.8, 24x24). Pass
   * `"AAA"` for SC 2.5.5 (44x44) if the repository has committed to it.
   */
  criterion?: TouchTargetCriterion;
}

export function touchTargetViolations(
  elements: InteractiveElement[],
  options: TouchTargetOptions = {},
): DeterministicFinding[] {
  const name = options.criterion ?? DEFAULT_TOUCH_TARGET_CRITERION;
  const criterion = TOUCH_TARGET_CRITERIA[name];
  const out: DeterministicFinding[] = [];
  for (const el of elements) {
    // A pointer-target criterion, on the surfaces it is about.
    if (!TOUCH_VIEWPORTS.includes(el.viewport)) continue;
    if (!isUndersized(el.rect, criterion.minPx)) continue;
    // "Inline": a link in a sentence is sized by the line-height around it, and
    // both criteria exempt it. Enlarging it would damage the paragraph.
    if (el.inlineTarget === true) continue;
    if (name === "AA" && meetsSpacingException(el, elements)) continue;
    out.push({
      kind: "touch_target",
      route: el.route,
      viewport: el.viewport,
      selector: el.selector,
      detail:
        `touch target ${Math.round(el.rect.width)}x${Math.round(el.rect.height)}px is below ` +
        `the ${criterion.minPx}x${criterion.minPx}px minimum in WCAG 2.2 SC ${criterion.sc} ` +
        `${criterion.name}, level ${criterion.level}`,
      // Every exception this check can evaluate has already been applied above.
      // What is left is the one it cannot: a capture that never reported
      // `inlineTarget` leaves the Inline exception unevaluated, and an
      // unevaluated exception could be the whole finding.
      blockEligible: el.inlineTarget === false,
    });
  }
  return out;
}

export interface DeterministicCheckInput {
  textNodes: TextNodeStyle[];
  interactive: InteractiveElement[];
  /** Target-size criterion for the touch-target check. Defaults to AA. */
  touchTargetCriterion?: TouchTargetCriterion;
}

/** Run all deterministic checks, returning the facts for the critique prompt. */
export function deterministicChecks(input: DeterministicCheckInput): DeterministicFinding[] {
  return [
    ...contrastViolations(input.textNodes),
    ...overflowViolations(input.textNodes),
    ...touchTargetViolations(input.interactive, { criterion: input.touchTargetCriterion }),
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
