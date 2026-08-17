import type { Viewport } from "@engine/types";
import type { InteractiveElement, TextNodeStyle } from "./checks.js";
import { flattenBackground } from "./color.js";
import type { ExtractedElement, ExtractedPage } from "./browser-port.js";
import type { RawGeometryElement } from "./geometry.js";

/**
 * In-page DOM extraction (TRD §4.2). One `page.evaluate` round-trip collects
 * everything the grounded prompt needs: landmark rects for the geometry map
 * (#18), computed text styles for the deterministic contrast/overflow checks
 * (#19), pointer-target rects for the touch-target check, and the post-
 * `fonts.ready` font statuses that reveal a silently substituted web font (#83).
 *
 * The script is a plain expression string so the browser port stays a single
 * `evaluate(expression)` method; the normalizers below are pure and unit-tested
 * against recorded extractor payloads, with no browser needed.
 */

/** Elements whose rects are worth recording; anything else is noise in the map. */
const EXTRACT_SELECTOR =
  "h1,h2,h3,h4,h5,h6,nav,button,a,input,select,textarea,p,li,label,span,summary,[role]";

/**
 * The extractor, as an IIFE expression. Deliberately dependency-free and
 * defensive: a page that throws in a getter must not fail the capture.
 */
export const DOM_EXTRACT_EXPRESSION = `(() => {
  const MAX_ELEMENTS = 400;
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html" && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  };
  // The background-color of the element and each ancestor, nearest first, up to
  // and including the first fully opaque one. Reporting the whole stack instead
  // of one pre-resolved color keeps every judgement (is this layer opaque? what
  // does a translucent one composite to?) in the pure, unit-tested normalizer
  // below, where it can be tested without a browser.
  //
  // It also reports whether anything in that stack paints something a flattened
  // COLOR cannot represent: a background-image or a backdrop-filter. White text
  // on a photo over a white base flattens to a 1:1 ratio nobody experiences, so
  // the contrast measurement is still emitted and marked as not gateable.
  const backgroundStack = (el) => {
    const stack = [];
    let obscured = false;
    let node = el;
    while (node && stack.length < 32) {
      const style = getComputedStyle(node);
      const image = style.backgroundImage;
      if (image && image !== "none") obscured = true;
      const filter = style.backdropFilter || style.webkitBackdropFilter;
      if (filter && filter !== "none") obscured = true;
      const bg = style.backgroundColor;
      if (bg) {
        stack.push(bg);
        const alpha = /^rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)$/.exec(bg);
        if (alpha === null || Number(alpha[1]) >= 1) break;
      }
      node = node.parentElement;
    }
    return { stack: stack, obscured: obscured };
  };
  const isAnimated = (el) => {
    const s = getComputedStyle(el);
    if (s.animationName && s.animationName !== "none") return true;
    if (s.transitionDuration && s.transitionDuration !== "0s") return true;
    return typeof el.getAnimations === "function" && el.getAnimations().length > 0;
  };
  const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "summary"]);
  const hasOwnText = (el) =>
    Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const out = [];
  const nodes = document.querySelectorAll(${JSON.stringify(EXTRACT_SELECTOR)});
  for (const el of nodes) {
    if (out.length >= MAX_ELEMENTS) break;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const record = {
      tag: tag,
      id: el.id || null,
      testId: el.getAttribute("data-testid"),
      role: role,
      cssPath: cssPath(el),
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      animated: isAnimated(el),
      interactive: INTERACTIVE.has(tag) || role === "button" || role === "link",
      text: null,
    };
    if (hasOwnText(el)) {
      const backdrop = backgroundStack(el);
      record.text = {
        fontSizePx: parseFloat(style.fontSize) || 0,
        fontWeight: parseInt(style.fontWeight, 10) || 400,
        color: style.color,
        backgroundStack: backdrop.stack,
        backdropObscured: backdrop.obscured,
        contentWidthPx: el.scrollWidth,
        // Reported so the overflow check can tell breakage from a deliberate
        // scroll container: a scrollWidth wider than the box is true of every
        // pre element with a scrollbar and every carousel, and those work.
        overflowX: style.overflowX,
      };
    }
    out.push(record);
  }
  const fonts = [];
  try {
    document.fonts.forEach((f) => fonts.push({ family: f.family, status: f.status }));
  } catch (_) { /* FontFaceSet iteration is optional */ }
  const bodyText = document.body ? String(document.body.innerText || "").slice(0, 4000) : "";
  // What the root element itself composites over. The UA canvas is white unless
  // the page opted into a dark color-scheme, in which case the exact shade is a
  // UA implementation detail, so report it unknown and let the contrast check stay
  // silent rather than publish a guessed measurement as a fact.
  const rootScheme = String(getComputedStyle(document.documentElement).colorScheme || "normal").toLowerCase();
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const darkCanvas = rootScheme.indexOf("dark") >= 0 && (rootScheme.indexOf("light") < 0 || prefersDark);
  return {
    elements: out,
    fonts: fonts,
    bodyText: bodyText,
    canvasBackground: darkCanvas ? null : "rgb(255, 255, 255)",
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ),
  };
})()`;

/** Round to 2dp so a sub-pixel layout jitter can't churn the serialized geometry. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Project extracted elements into the geometry module's raw input shape. */
export function toRawGeometryElements(
  page: ExtractedPage,
  route: string,
  viewport: Viewport,
): RawGeometryElement[] {
  return page.elements.map((el) => ({
    route,
    viewport,
    tag: el.tag,
    id: el.id,
    testId: el.testId,
    role: el.role,
    cssPath: el.cssPath,
    rect: {
      x: round(el.rect.x),
      y: round(el.rect.y),
      width: round(el.rect.width),
      height: round(el.rect.height),
    },
    animated: el.animated,
  }));
}

/** Stable selector for the deterministic checks; same precedence as the geometry map. */
function selectorFor(el: ExtractedElement): string {
  if (el.id) return `#${el.id}`;
  if (el.testId) return `[data-testid="${el.testId}"]`;
  return el.cssPath.length > 0 ? el.cssPath : el.tag;
}

/**
 * Flatten one element's background stack onto the page canvas, as the CSS
 * string the contrast check consumes. `null` means "not determinable" (the
 * element sits on a chain that never reaches an opaque, parseable color), and
 * the check is required to stay silent about it.
 */
export function resolvedBackground(stack: readonly string[], canvas: string | null): string | null {
  const flat = flattenBackground(stack, canvas);
  return flat === null ? null : `rgb(${flat.r}, ${flat.g}, ${flat.b})`;
}

/** Project text-bearing extracted elements into contrast/overflow check inputs (#19). */
export function toTextNodeStyles(
  page: ExtractedPage,
  route: string,
  viewport: Viewport,
): TextNodeStyle[] {
  const out: TextNodeStyle[] = [];
  for (const el of page.elements) {
    if (!el.text) continue;
    out.push({
      route,
      viewport,
      selector: selectorFor(el),
      fontSizePx: el.text.fontSizePx,
      fontWeight: el.text.fontWeight,
      color: el.text.color,
      backgroundColor: resolvedBackground(el.text.backgroundStack, page.canvasBackground),
      rect: {
        x: round(el.rect.x),
        y: round(el.rect.y),
        width: round(el.rect.width),
        height: round(el.rect.height),
      },
      contentWidthPx: round(el.text.contentWidthPx),
      // Both carried verbatim, both omitted when the extractor did not report
      // them: absent has to stay UNKNOWN all the way to the check, which is the
      // only place that decides what unknown costs.
      ...(el.text.overflowX !== undefined ? { overflowX: el.text.overflowX } : {}),
      ...(el.text.backdropObscured !== undefined
        ? { backdropObscured: el.text.backdropObscured }
        : {}),
    });
  }
  return out;
}

/** Project pointer-targetable extracted elements into touch-target check inputs (#19). */
export function toInteractiveElements(
  page: ExtractedPage,
  route: string,
  viewport: Viewport,
): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  for (const el of page.elements) {
    if (!el.interactive) continue;
    out.push({
      route,
      viewport,
      selector: selectorFor(el),
      role: el.role,
      rect: {
        x: round(el.rect.x),
        y: round(el.rect.y),
        width: round(el.rect.width),
        height: round(el.rect.height),
      },
    });
  }
  return out;
}
