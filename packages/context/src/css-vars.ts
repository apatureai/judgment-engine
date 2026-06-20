import postcss, { type AtRule, type Container, type Declaration, type Document } from "postcss";
import type { TokenMap } from "./tokens.js";

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

    const theme = themeFromSelector(selector) ?? enclosingMediaTheme(decl);
    const value = decl.value.trim();

    if (theme) {
      (themes[theme] ??= {})[decl.prop] = value;
    } else if (isBaseSelector(selector)) {
      base[decl.prop] = value;
    }
    // other selectors (component-scoped) are ignored
  });

  return { base, themes };
}
