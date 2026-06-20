import type { TokenMap } from "./tokens.js";

/**
 * Parse a `tokens.json` in W3C Design Tokens or Style Dictionary format into the
 * shared `TokenMap` (TRD §6). Both formats are nested token groups; a node is a
 * token when it carries a value field:
 *   - W3C / Style Dictionary v4: `$value` (and `$type` metadata).
 *   - Style Dictionary (classic): `value`.
 * `$`-prefixed keys are metadata and are not traversed as groups.
 */

function valueToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Composite tokens (shadow/typography/etc.) serialize deterministically.
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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
  return out;
}
