import postcss, { type AtRule } from "postcss";
import type { TokenMap } from "./tokens.js";
import { resolveCssVarReferences } from "./css-var-resolve.js";

/**
 * Tailwind v4 token extraction (TRD §6, #57). v4 is CSS-first: design tokens are
 * declared as custom properties inside `@theme { ... }` blocks in CSS, and a
 * `@config "..."` directive can point back to a v3-style JS/TS config. This
 * parses the CSS with PostCSS, collects the `@theme` custom properties as tokens,
 * and surfaces any `@config` path so the caller can also resolve it via #56.
 *
 * Pure (PostCSS only) — fully testable without a build step.
 */
export interface TailwindV4Result {
  tokens: TokenMap;
  /** Path from a `@config "..."` directive, if present (resolve via #56). */
  configPath: string | null;
}

export function extractTailwindV4(css: string): TailwindV4Result {
  const tokens: TokenMap = {};
  let configPath: string | null = null;
  const root = postcss.parse(css);

  root.walkAtRules((atRule: AtRule) => {
    if (atRule.name === "theme") {
      atRule.walkDecls((decl) => {
        if (decl.prop.startsWith("--")) tokens[decl.prop] = decl.value.trim();
      });
    } else if (atRule.name === "config") {
      const m = /["']([^"']+)["']/.exec(atRule.params);
      if (m?.[1]) configPath = m[1];
    }
  });

  // @theme custom properties may reference each other via var(); resolve them so
  // the grounding map carries values, not references (as css-vars does for :root).
  return { tokens: resolveCssVarReferences(tokens), configPath };
}
