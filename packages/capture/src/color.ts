/**
 * CSS color parsing and alpha compositing for the deterministic checks (#19).
 *
 * The contrast check publishes its numbers as FACTS the model is told to trust
 * over its own pixels, so the only two acceptable outcomes here are "the exact
 * color" or "I don't know". Guessing is worse than silence: a fabricated
 * measurement poisons the prompt it is supposed to anchor.
 *
 * That is why every function below returns `null` rather than a default, and why
 * translucent layers are composited instead of being read as if they were
 * opaque. Chromium serializes computed colors in the legacy `rgb()/rgba()` form
 * for sRGB colors; a color authored in a wide-gamut space (`oklch(...)`,
 * `color(display-p3 ...)`) serializes in that space and is deliberately NOT
 * parsed here: it yields `null`, and the check stays silent.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 (fully transparent) .. 1 (fully opaque). */
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const RGB_FUNC = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

function expand(hex: string): string {
  return hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
}

/** Parse a CSS color (`transparent`, #rgb[a], #rrggbb[aa], rgb()/rgba()) or null. */
export function parseCssColor(css: string): Rgba | null {
  const s = css.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = HEX.exec(s);
  if (hex?.[1]) {
    const full = expand(hex[1]);
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgb = RGB_FUNC.exec(s);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha };
  }

  return null;
}

/**
 * The gradient functions whose stops are ordinary color stops, so the rendered
 * backdrop at any point of the element is an interpolation BETWEEN two adjacent
 * stops and never outside the set of stops.
 *
 * That property is the whole licence for measuring a gradient at all: each sRGB
 * channel moves monotonically from one stop to the next, relative luminance is
 * monotone in every channel, so no point between two stops is lighter than the
 * lighter of them or darker than the darker one.
 */
const GRADIENT_FUNCTION = /^(?:repeating-)?(?:linear|radial|conic)-gradient$/;

/**
 * The first argument of a gradient may describe its GEOMETRY rather than a
 * color: `to right`, `45deg`, `circle at 50% 50%`, `farthest-corner`.
 *
 * Matched syntactically, and deliberately narrowly. "Whatever fails to parse as
 * a color must be the direction" would silently drop a real stop authored in a
 * color space this module does not read, and measuring the remaining stops as
 * if they were the whole gradient is exactly the invented fact this file exists
 * to prevent.
 *
 * `in oklab` and friends are absent on purpose: an interpolation method other
 * than the default changes the path taken between two stops, and this module is
 * only entitled to the monotonicity argument for the default sRGB path.
 */
const GRADIENT_GEOMETRY =
  /^(?:to\s|at\s|from\s|circle\b|ellipse\b|closest-|farthest-|-?[\d.]+(?:deg|grad|rad|turn)\b)/;

/** A stop's position (`50%`, `12px`, `0`), which carries no color information. */
const STOP_POSITION = /\s+-?[\d.]+(?:%|[a-z]+)?$/;

/**
 * A whole argument that is nothing but a position: an interpolation HINT. It
 * moves the midpoint of the blend between the stops on either side of it and
 * introduces no color, so those stops still bound the whole run.
 */
const INTERPOLATION_HINT = /^-?[\d.]+(?:%|[a-z]+)?$/;

/** Split on commas that are not inside parentheses (`rgb(1, 2, 3)` stays whole). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim());
}

/** Drop the position from a color stop; a stop may carry up to two of them. */
function stripStopPosition(stop: string): string {
  let s = stop.trim();
  for (let i = 0; i < 2 && STOP_POSITION.test(s); i += 1) s = s.replace(STOP_POSITION, "").trim();
  return s;
}

/**
 * The color stops of a computed `background-image` that is a single gradient
 * whose stops are all plain colors, or `null` when the value is anything else.
 *
 * `null` is not "no gradient here": it is "the backdrop this paints is not
 * computable", which is the same answer a photograph gets, and the caller must
 * treat both identically. A gradient with ONE unparseable stop returns `null`
 * rather than the stops it did read, because the missing one could be the worst.
 */
export function parseGradientStops(css: string): Rgba[] | null {
  const value = css.trim();
  const open = value.indexOf("(");
  if (open < 0 || !value.endsWith(")")) return null;
  if (!GRADIENT_FUNCTION.test(value.slice(0, open).trim().toLowerCase())) return null;

  const args = splitTopLevel(value.slice(open + 1, -1));
  const stops: Rgba[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).trim();
    if (i === 0 && GRADIENT_GEOMETRY.test(arg.toLowerCase())) continue;
    if (INTERPOLATION_HINT.test(arg)) continue;
    const stripped = stripStopPosition(arg);
    if (stripped === "") continue;
    const color = parseCssColor(stripped);
    if (color === null) return null;
    stops.push(color);
  }
  return stops.length >= 2 ? stops : null;
}

/** True when the color is fully opaque, i.e. nothing behind it can show through. */
export function isOpaque(color: Rgba): boolean {
  return color.a >= 1;
}

function blend(top: number, bottom: number, alpha: number): number {
  return Math.round(top * alpha + bottom * (1 - alpha));
}

/**
 * Source-over composite of `top` onto an OPAQUE `bottom`. Callers must resolve
 * an opaque backdrop first; compositing onto a translucent one would produce a
 * color no user ever saw.
 */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  if (!isOpaque(bottom)) throw new Error("compositeOver requires an opaque backdrop");
  if (isOpaque(top)) return top;
  return {
    r: blend(top.r, bottom.r, top.a),
    g: blend(top.g, bottom.g, top.a),
    b: blend(top.b, bottom.b, top.a),
    a: 1,
  };
}

/**
 * Flatten a background stack (the `background-color` of an element and each of
 * its ancestors, nearest first) onto the page canvas.
 *
 * Returns `null` when no opaque layer is reachable, which is exactly the case
 * the check must stay silent about: a page whose canvas color is unknown (the
 * dark UA default) or that paints its backdrop with something this module
 * cannot parse.
 */
export function flattenBackground(stack: readonly string[], canvas: string | null): Rgba | null {
  const layers: Rgba[] = [];
  let base: Rgba | null = null;

  for (const css of stack) {
    const color = parseCssColor(css);
    if (color === null) return null; // an unparseable layer hides everything behind it
    if (color.a === 0) continue;
    if (isOpaque(color)) {
      base = color;
      break;
    }
    layers.push(color);
  }

  if (base === null) {
    const parsed = canvas === null ? null : parseCssColor(canvas);
    if (parsed === null || !isOpaque(parsed)) return null;
    base = parsed;
  }

  for (let i = layers.length - 1; i >= 0; i -= 1) base = compositeOver(layers[i] as Rgba, base);
  return base;
}

/**
 * Flatten a background stack that paints a COMPUTABLE GRADIENT: one opaque
 * color per gradient stop, in stop order.
 *
 * `flattenBackground` answers "what single color is behind this text", and a
 * gradient has no single answer, which is why a background image used to be
 * declined outright. It does not follow that a gradient is unknowable: a
 * two-stop `linear-gradient(#ffffff, #eaf2ff)` states its endpoints in plain
 * sRGB, and every point between them lies between the two. So the honest
 * resolution of that backdrop is not one color, it is the set of stops, and a
 * caller measures against whichever of them is worst.
 *
 * `images` is the computed `background-image` of each layer in `stack`, same
 * order, `"none"` where a layer paints no image. Returns `null` whenever the
 * backdrop is not computable, which is every other case:
 *
 *   - no image at all, or more than one painted image (which of them a given
 *     pixel shows depends on their sizes and positions, not on this stack),
 *   - an image that is not a gradient, or a gradient with an unparseable stop,
 *   - a gradient with any translucent stop, since what shows through it is the
 *     layer below, which this stack stops describing at the gradient,
 *   - an unparseable or opaque layer NEARER than the gradient, which would sit
 *     between the gradient and the reader.
 */
export function flattenGradientBackdrops(
  stack: readonly string[],
  images: readonly string[],
): Rgba[] | null {
  let index = -1;
  for (let i = 0; i < images.length; i += 1) {
    const image = (images[i] ?? "").trim().toLowerCase();
    if (image === "" || image === "none") continue;
    if (index !== -1) return null;
    index = i;
  }
  if (index === -1) return null;

  const stops = parseGradientStops(images[index] as string);
  if (stops === null || !stops.every(isOpaque)) return null;

  // Layers between the gradient and the reader, nearest first. Each one is
  // painted OVER every stop, so a translucent tint darkens the whole run.
  const over: Rgba[] = [];
  for (let i = 0; i < index; i += 1) {
    const color = parseCssColor(stack[i] ?? "");
    if (color === null || isOpaque(color)) return null;
    if (color.a === 0) continue;
    over.push(color);
  }

  return stops.map((stop) => {
    let base: Rgba = stop;
    for (let i = over.length - 1; i >= 0; i -= 1) base = compositeOver(over[i] as Rgba, base);
    return base;
  });
}
