import type { TokenMap } from "./tokens.js";
import { isRecord } from "./guards.js";

/**
 * Parse a `tokens.json` in W3C Design Tokens or Style Dictionary format into the
 * shared `TokenMap` (TRD §6). Both formats are nested token groups; a node is a
 * token when it carries a value field:
 *   - W3C / Style Dictionary v4: `$value` (and `$type` metadata).
 *   - Style Dictionary (classic): `value`.
 * `$`-prefixed keys are metadata and are not traversed as groups.
 *
 * DTCG aliases (`"$value": "{color.brand.primary}"`) are RESOLVED to the referenced
 * token's value, so the grounding token map carries real values rather than
 * unresolved references.
 */

function valueToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Composite tokens (shadow/typography/etc.) serialize deterministically.
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

/**
 * A DTCG alias value is a reference whose WHOLE value is `{token.path}`, a dotted
 * token name. The strict pattern (letters/digits/`.`/`-`/`_` only, no quotes,
 * colons, or inner braces) is load-bearing: it must never mistake a JSON-stringified
 * composite token (e.g. `{"x":0,"y":1}`) for a reference.
 */
const ALIAS_RE = /^\{([A-Za-z0-9][A-Za-z0-9._-]*)\}$/;

function aliasTarget(value: string): string | null {
  return ALIAS_RE.exec(value)?.[1] ?? null;
}

/**
 * Resolve DTCG aliases in a flat TokenMap: a value that is a single `{token.path}`
 * reference is replaced by the referenced token's resolved value, following alias
 * chains. A reference to a missing token, or a reference cycle, is left as its
 * ORIGINAL literal, surfaced for debugging and never silently dropped or looped.
 * Pure and deterministic.
 */
export function resolveTokenAliases(map: TokenMap): TokenMap {
  const out: TokenMap = {};
  for (const [name, value] of Object.entries(map)) {
    const first = aliasTarget(value);
    if (first === null) {
      out[name] = value; // concrete value (incl. serialized composites), unchanged
      continue;
    }
    // Follow the alias chain to a concrete value; stop on cycle or dangling ref,
    // keeping the original literal in that case.
    const seen = new Set<string>([name]);
    let target: string | null = first;
    let resolved = value;
    while (target !== null) {
      if (seen.has(target)) break; // cycle → keep original literal
      seen.add(target);
      const next: string | undefined = map[target];
      if (next === undefined) break; // dangling reference → keep original literal
      const nextTarget = aliasTarget(next);
      if (nextTarget === null) {
        resolved = next; // reached a concrete value
        break;
      }
      target = nextTarget;
    }
    out[name] = resolved;
  }
  return out;
}

/** Parse a parsed-JSON tokens document into a flat dotted-name TokenMap. */
export function parseTokensJson(doc: unknown): TokenMap {
  const out: TokenMap = {};

  const walk = (node: unknown, path: string[]): void => {
    if (!isRecord(node)) return;

    // A token node carries `$value` (W3C) or `value` (classic Style Dictionary).
    const raw = "$value" in node ? node.$value : "value" in node ? node.value : undefined;
    if (raw !== undefined) {
      const str = valueToString(raw);
      if (str !== null && path.length > 0) out[path.join(".")] = str;
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$")) continue; // metadata, not a group
      walk(child, [...path, key]);
    }
  };

  walk(doc, []);
  // Resolve DTCG aliases so the grounding map carries values, not references.
  return resolveTokenAliases(out);
}
