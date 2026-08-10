import resolveConfig from "tailwindcss-v3/resolveConfig.js";
import type { TokenMap } from "./tokens.js";

/**
 * Tailwind v3 token extraction (TRD §6, #56). The fully-resolved theme is
 * produced by Tailwind's own `resolveConfig`, never static-AST-parsed, which
 * would miss preset/required defaults. Returns the flattened design tokens.
 *
 * `tailwind.config.{js,ts}` is executable code, so the real worker LOADS it in
 * the same isolation class as capture (#22) and passes the resulting config
 * object here; on any throw the caller degrades to CSS-property extraction (#58).
 * This function is the pure resolve + flatten, fully testable with a config
 * object, with no untrusted code execution in tests.
 */

const CATEGORIES = [
  "colors",
  "spacing",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "lineHeight",
  "borderRadius",
  "screens",
  "boxShadow",
] as const;

function flatten(prefix: string, value: unknown, out: TokenMap): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    out[prefix] = String(value);
    return;
  }
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === "string");
    // fontFamily -> join the stack; fontSize tuple [size, {...}] -> the size.
    if (strings.length > 0) out[prefix] = strings.length > 1 ? strings.join(", ") : (strings[0] as string);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // Tailwind's DEFAULT key collapses onto the parent (e.g. borderRadius.DEFAULT).
      flatten(k === "DEFAULT" ? prefix : `${prefix}.${k}`, v, out);
    }
  }
}

/** Flatten a resolved Tailwind theme object into the shared TokenMap. */
export function extractTailwindTokens(theme: Record<string, unknown>): TokenMap {
  const out: TokenMap = {};
  for (const category of CATEGORIES) {
    if (theme[category] !== undefined) flatten(category, theme[category], out);
  }
  return out;
}

/**
 * Resolve a Tailwind v3 config object and extract its tokens, or null on throw
 * (the caller then degrades to CSS-property extraction #58).
 */
export function resolveTailwindV3Tokens(userConfig: unknown): TokenMap | null {
  try {
    const full = resolveConfig(userConfig);
    return extractTailwindTokens(full.theme);
  } catch {
    return null;
  }
}
