import type { TokenMap } from "./tokens.js";

/**
 * Whole-value CSS `var()` reference resolution, shared by the CSS-custom-property
 * extractor and the Tailwind v4 `@theme` extractor (both collect design tokens as
 * `--*` custom properties whose values may reference other properties). A token
 * defined by reference (`--button-bg: var(--color-brand)`) must land in the
 * grounding map as its VALUE, not the unresolved reference.
 *
 * Only a value that IS a single reference is resolved (the dominant design-token
 * pattern); a `var()` embedded in a larger value (`0 1px var(--c)`) is left as-is.
 * Pure and deterministic.
 */

/** A whole-value `var()` reference: `var(--ref)` or `var(--ref, fallback)`. */
const VAR_REF_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]+?)\s*)?\)$/;

/**
 * Resolve a whole-value `var()` reference against a scope (custom-property map),
 * following reference chains. An undefined variable falls back to the `var()`
 * fallback when one is given (resolved too), else the property's original literal
 * is kept. A reference cycle is left as the original literal, never looped.
 */
function resolveCssValue(value: string, scope: TokenMap, seen: ReadonlySet<string>, original: string): string {
  const m = VAR_REF_RE.exec(value.trim());
  const ref = m?.[1];
  if (ref === undefined) return value; // concrete value reached
  const fallback = m?.[2];
  if (seen.has(ref)) return original; // reference cycle → the property's own original literal
  const target = scope[ref];
  if (target === undefined) {
    // undefined variable: use the fallback (resolved too) if present, else the original literal
    return fallback !== undefined ? resolveCssValue(fallback, scope, seen, original) : original;
  }
  return resolveCssValue(target, scope, new Set(seen).add(ref), original);
}

/** Resolve every value in `map` against `scope`, seeding the cycle guard with the property itself. */
export function resolveScope(map: TokenMap, scope: TokenMap): TokenMap {
  const out: TokenMap = {};
  for (const [prop, value] of Object.entries(map)) {
    out[prop] = resolveCssValue(value, scope, new Set([prop]), value);
  }
  return out;
}

/** Resolve whole-value `var()` references in a single flat scope (resolved against itself). */
export function resolveCssVarReferences(map: TokenMap): TokenMap {
  return resolveScope(map, map);
}
