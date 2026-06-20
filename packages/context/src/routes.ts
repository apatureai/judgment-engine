/**
 * Diff -> route mapping (TRD §6). Map a PR's changed files to the affected
 * routes so only relevant pages are reviewed. MVP: Next.js page-file mapping
 * (App Router `app/.../page.tsx` and Pages Router `pages/*.tsx`) + config
 * overrides (`always`, `routes.map`, `max_per_pr`). The import-graph path (v1.5)
 * is gated behind measured need and intentionally not built here.
 */

export interface RouteConfig {
  /** Routes always reviewed regardless of the diff. */
  always?: string[];
  /** Explicit file -> route overrides (exact path match). */
  map?: Record<string, string>;
  /** Cap on routes reviewed per PR. */
  maxPerPr?: number;
}

const PAGE_EXT = "(?:tsx|ts|jsx|js)";

/** Next.js App Router: `app/.../page.ext` -> route (route groups dropped, dynamic kept). */
function appRouterRoute(path: string): string | null {
  const m = new RegExp(`(?:^|/)(?:src/)?app/(.*?)page\\.${PAGE_EXT}$`).exec(path);
  if (!m) return null;
  const segments = (m[1] ?? "").split("/").filter(Boolean);

  const kept: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith("_") || seg.startsWith("@")) return null; // private / parallel slot
    if (/^\(.*\)$/.test(seg)) continue; // route group, not a path segment
    kept.push(seg);
  }
  return "/" + kept.join("/");
}

/** Next.js Pages Router: `pages/**.ext` -> route (index/_app/api excluded). */
function pagesRouterRoute(path: string): string | null {
  const m = new RegExp(`(?:^|/)(?:src/)?pages/(.*)\\.${PAGE_EXT}$`).exec(path);
  if (!m) return null;
  const segments = (m[1] ?? "").split("/");
  if (segments[0] === "api") return null;
  const base = segments[segments.length - 1] ?? "";
  if (base.startsWith("_")) return null; // _app, _document, _error

  const kept = base === "index" ? segments.slice(0, -1) : segments;
  return "/" + kept.join("/");
}

/** Map a single changed file to its route, or null if it isn't a page file. */
export function pageFileToRoute(path: string): string | null {
  const clean = path.replace(/^\.\//, "");
  return appRouterRoute(clean) ?? pagesRouterRoute(clean);
}

/**
 * Map a PR diff (changed file paths) to the routes to review, applying config
 * overrides, the always-list, dedupe + sort, and the per-PR cap.
 */
export function mapDiffToRoutes(changedFiles: string[], config: RouteConfig = {}): string[] {
  const routes = new Set<string>();

  for (const file of changedFiles) {
    const override = config.map?.[file];
    const route = override ?? pageFileToRoute(file);
    if (route) routes.add(route);
  }
  for (const route of config.always ?? []) routes.add(route);

  const sorted = [...routes].sort();
  return config.maxPerPr !== undefined ? sorted.slice(0, config.maxPerPr) : sorted;
}
