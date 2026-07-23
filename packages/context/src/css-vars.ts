import postcss, { type AtRule, type Container, type Declaration, type Document } from "postcss";
import type { TokenMap } from "./tokens.js";
import { resolveScope } from "./css-var-resolve.js";

/**
 * Extract CSS custom properties (design tokens) from global stylesheets with
 * PostCSS (TRD §6). Collects `--*` declarations from `:root`/`html` (base) and
 * theme-scoped blocks — `[data-theme=...]`, `.dark`/`.light`, and
 * `@media (prefers-color-scheme: ...)`. Component-scoped custom props on other
 * selectors are intentionally ignored — they are not design tokens.
 */
export interface CssCustomProperties {
  /** Tokens from :root / html. */
  base: TokenMap;
  /** Theme-scoped tokens, keyed by theme name (e.g. "dark", "light", "brand"). */
  themes: Record<string, TokenMap>;
}

function themeFromSelector(selector: string): string | null {
  const dataTheme = /\[data-theme=["']?([\w-]+)["']?\]/.exec(selector);
  if (dataTheme?.[1]) return dataTheme[1];
  if (/(^|[^-\w])\.dark\b/.test(selector)) return "dark";
  if (/(^|[^-\w])\.light\b/.test(selector)) return "light";
  return null;
}

/**
 * A selector is "theme-scoped" (a design-token scope) only when it is the theme
 * selector *itself* — `.dark`, `.light`, or `[data-theme=...]` — with no
 * descendant/compound component target. `.dark .button` and `.dark.fancy` are
 * component-scoped and must NOT contribute theme tokens.
 */
function isThemeBaseSelector(selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .every(
      (s) =>
        s === ".dark" ||
        s === ".light" ||
        /^\[data-theme=["']?[\w-]+["']?\]$/.test(s),
    );
}

function isBaseSelector(selector: string): boolean {
  return selector
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === ":root" || s === "html");
}

function enclosingMediaTheme(node: Declaration): string | null {
  let parent: Container | Document | undefined = node.parent;
  while (parent) {
    if (parent.type === "atrule") {
      const atrule = parent as AtRule;
      if (atrule.name === "media") {
        if (/prefers-color-scheme:\s*dark/.test(atrule.params)) return "dark";
        if (/prefers-color-scheme:\s*light/.test(atrule.params)) return "light";
      }
    }
    parent = parent.parent;
  }
  return null;
}

export function extractCssCustomProperties(css: string): CssCustomProperties {
  const base: TokenMap = {};
  const themes: Record<string, TokenMap> = {};
  const root = postcss.parse(css);

  root.walkDecls((decl: Declaration) => {
    if (!decl.prop.startsWith("--")) return;
    const rule = decl.parent;
    if (!rule || rule.type !== "rule") return;
    const selector = "selector" in rule ? (rule.selector as string) : "";

    const value = decl.value.trim();

    // A theme token must come from a theme scope that is NOT also a component
    // scope. The direct path (`.dark`/`[data-theme]`) requires the selector to
    // be the theme selector itself; the media path (`prefers-color-scheme`)
    // requires the inner selector to be base (`:root`/`html`). This keeps
    // `.dark .button {}` and `@media(...){ .button {} }` out of the tokens.
    const directTheme = themeFromSelector(selector);
    if (directTheme && isThemeBaseSelector(selector)) {
      (themes[directTheme] ??= {})[decl.prop] = value;
      return;
    }

    if (isBaseSelector(selector)) {
      const mediaTheme = enclosingMediaTheme(decl);
      if (mediaTheme) {
        (themes[mediaTheme] ??= {})[decl.prop] = value;
      } else {
        base[decl.prop] = value;
      }
    }
    // other selectors (component-scoped) are ignored
  });

  // Resolve whole-value var() references so the grounding map carries values, not
  // references. Base resolves against base; a theme resolves against base layered
  // under the theme's own props (the CSS cascade — a theme var overrides :root).
  const resolvedThemes: Record<string, TokenMap> = {};
  for (const [theme, map] of Object.entries(themes)) {
    resolvedThemes[theme] = resolveScope(map, { ...base, ...map });
  }
  return { base: resolveScope(base, base), themes: resolvedThemes };
}
