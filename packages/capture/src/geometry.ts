import type { Viewport } from "@engine/types";
import type { Rect } from "./checks.js";

/**
 * DOM geometry map (TRD §4.2/§6.5). Landmark element rects are serialized as
 * stable `{selector, role, rect}` entries so the model picks an `element_ref`
 * and CODE draws the annotation box from the real rect — we never trust VLM
 * pixel coordinates. Animated elements are flagged so the phash stability gate
 * (#15) can exclude them.
 *
 * The browser-side `getBoundingClientRect` extraction is the worker seam; this
 * module is the pure selection/serialization, fully testable without a browser.
 */

/** Raw element as captured by the in-page extractor. */
export interface RawGeometryElement {
  route: string;
  viewport: Viewport;
  /** Lowercased tagName. */
  tag: string;
  id?: string | null;
  testId?: string | null;
  /** Explicit ARIA role, if any. */
  role?: string | null;
  /** Deterministic CSS path from the extractor, used when id/testId are absent. */
  cssPath?: string | null;
  rect: Rect;
  /** Flagged by the extractor (CSS animation/transition or known carousel). */
  animated?: boolean;
}

export interface GeometryEntry {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string;
  rect: Rect;
  animated: boolean;
}

const LANDMARK_TAGS = new Set([
  "nav",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "button",
  "input",
  "select",
  "textarea",
  "a",
]);

const LANDMARK_ROLES = new Set(["navigation", "heading", "button", "textbox", "link"]);

/** Map a tag to its implicit ARIA role; explicit role wins. */
export function normalizeRole(el: RawGeometryElement): string {
  if (el.role) return el.role;
  if (el.tag === "nav") return "navigation";
  if (/^h[1-6]$/.test(el.tag)) return "heading";
  if (el.tag === "button") return "button";
  if (el.tag === "input" || el.tag === "select" || el.tag === "textarea") return "textbox";
  if (el.tag === "a") return "link";
  return "generic";
}

export function isLandmark(el: RawGeometryElement): boolean {
  return LANDMARK_TAGS.has(el.tag) || (el.role !== null && el.role !== undefined && LANDMARK_ROLES.has(el.role));
}

/** Build a stable selector: id > data-testid > extractor cssPath > tag. */
export function stableSelector(el: RawGeometryElement): string {
  if (el.id) return `#${el.id}`;
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.cssPath) return el.cssPath;
  return el.tag;
}

/** Serialize landmark elements into stable geometry entries. */
export function serializeGeometry(elements: RawGeometryElement[]): GeometryEntry[] {
  return elements.filter(isLandmark).map((el) => ({
    route: el.route,
    viewport: el.viewport,
    selector: stableSelector(el),
    role: normalizeRole(el),
    rect: el.rect,
    animated: el.animated ?? false,
  }));
}

/** The animated subset, for the phash exclusion list (#15). */
export function animatedExclusions(entries: GeometryEntry[]): GeometryEntry[] {
  return entries.filter((e) => e.animated);
}
