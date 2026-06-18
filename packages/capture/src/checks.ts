import type { Viewport } from "@engine/types";

/**
 * Deterministic, code-computed UI checks (TRD §4.2/§6.3/§6.5). The model must
 * never read hex off pixels or guess element sizes — contrast, overflow, and
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
  /** Foreground/background as CSS color strings (hex or rgb()/rgba()). */
  color: string;
  backgroundColor: string;
  rect: Rect;
  /** scrollWidth of the node's content; > rect.width means horizontal overflow. */
  contentWidthPx: number;
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

export interface DeterministicFinding {
  kind: CheckKind;
  route: string;
  viewport: Viewport;
  selector: string;
  /** A factual statement for the prompt, e.g. "contrast 2.31:1 (needs 4.5:1)". */
  detail: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse a CSS color (#rgb, #rrggbb, rgb()/rgba()) to 0..255 channels, or null. */
export function parseColor(css: string): Rgb | null {
  const s = css.trim().toLowerCase();

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hexMatch?.[1]) {
    const hex = hexMatch[1];
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(s);
  if (rgbMatch) {
    return { r: Number(rgbMatch[1]), g: Number(rgbMatch[2]), b: Number(rgbMatch[3]) };
  }

  return null;
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

/** Minimum touch-target size in CSS px (WCAG 2.5.5 / platform HIG). */
export const MIN_TOUCH_TARGET_PX = 44;

export function contrastViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    const fg = parseColor(node.color);
    const bg = parseColor(node.backgroundColor);
    if (!fg || !bg) continue; // can't assert -> stay silent rather than guess
    const ratio = contrastRatio(fg, bg);
    const threshold = contrastThreshold(node);
    if (ratio < threshold) {
      out.push({
        kind: "contrast",
        route: node.route,
        viewport: node.viewport,
        selector: node.selector,
        detail: `text contrast ${ratio.toFixed(2)}:1 is below WCAG AA ${threshold.toFixed(1)}:1`,
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
