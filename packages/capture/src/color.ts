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
 * parsed here — it yields `null`, and the check stays silent.
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

/** True when the color is fully opaque, i.e. nothing behind it can show through. */
export function isOpaque(color: Rgba): boolean {
  return color.a >= 1;
}

function blend(top: number, bottom: number, alpha: number): number {
  return Math.round(top * alpha + bottom * (1 - alpha));
}

/**
 * Source-over composite of `top` onto an OPAQUE `bottom`. Callers must resolve
 * an opaque backdrop first — compositing onto a translucent one would produce a
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
 * Flatten a background stack — the `background-color` of an element and each of
 * its ancestors, nearest first — onto the page canvas.
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
