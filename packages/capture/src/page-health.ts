import type { PageHealth } from "@engine/types";

/**
 * Page-health footnote (TRD §4.2). Console errors and failed network requests
 * are collected during capture but kept OUT of the design findings set — a 500
 * or a console exception is an app-health signal, not a design critique. They
 * surface only as a footnote delivery can attach.
 *
 * The browser event listeners are the worker seam; this is the pure aggregation.
 */

export interface ConsoleEvent {
  level: string;
  text: string;
}

export interface FailedRequest {
  url: string;
  status: number | null;
}

/**
 * A `document.fonts` entry sampled by the worker AFTER `fonts.ready` resolves.
 * `fonts.ready` resolves even when a web font was blocked (by the egress policy
 * #24 or a CDN outage) and silently substituted — so a non-"loaded" status is
 * the only signal that the rendered glyphs aren't what real users see (#83).
 */
export interface FontFaceStatus {
  family: string;
  /** The FontFace.status: "unloaded" | "loading" | "loaded" | "error". */
  status: string;
}

/** Web fonts that did not finish loading (silent fallback substitution). */
export function blockedFonts(fonts: FontFaceStatus[]): FontFaceStatus[] {
  return fonts.filter((f) => f.status.toLowerCase() !== "loaded");
}

export interface PageHealthInput {
  console: ConsoleEvent[];
  failedRequests: FailedRequest[];
  /** Stability flag from the phash/structural gate (#15). */
  unstable?: boolean;
  /** `document.fonts` statuses sampled after `fonts.ready` (#83), if collected. */
  fonts?: FontFaceStatus[];
}

/** Aggregate raw capture events into the `PageHealth` summary. */
export function buildPageHealth(input: PageHealthInput): PageHealth {
  const consoleErrors = input.console.filter((e) => e.level.toLowerCase() === "error").length;
  return {
    consoleErrors,
    failedRequests: input.failedRequests.length,
    unstable: input.unstable ?? false,
    blockedFonts: input.fonts ? blockedFonts(input.fonts).length : 0,
  };
}

/** Render the page-health footnote, or null when the page is clean. */
export function pageHealthFootnote(health: PageHealth): string | null {
  const parts: string[] = [];
  if (health.consoleErrors > 0) parts.push(`${health.consoleErrors} console error(s)`);
  if (health.failedRequests > 0) parts.push(`${health.failedRequests} failed request(s)`);
  if (health.unstable) parts.push("page visually unstable during capture");
  if (health.blockedFonts && health.blockedFonts > 0)
    parts.push(`${health.blockedFonts} web font(s) blocked/substituted (rendered glyphs may differ)`);
  return parts.length > 0 ? `Page health: ${parts.join(", ")}.` : null;
}
