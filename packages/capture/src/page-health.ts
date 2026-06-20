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

export interface PageHealthInput {
  console: ConsoleEvent[];
  failedRequests: FailedRequest[];
  /** Stability flag from the phash/structural gate (#15). */
  unstable?: boolean;
}

/** Aggregate raw capture events into the `PageHealth` summary. */
export function buildPageHealth(input: PageHealthInput): PageHealth {
  const consoleErrors = input.console.filter((e) => e.level.toLowerCase() === "error").length;
  return {
    consoleErrors,
    failedRequests: input.failedRequests.length,
    unstable: input.unstable ?? false,
  };
}

/** Render the page-health footnote, or null when the page is clean. */
export function pageHealthFootnote(health: PageHealth): string | null {
  const parts: string[] = [];
  if (health.consoleErrors > 0) parts.push(`${health.consoleErrors} console error(s)`);
  if (health.failedRequests > 0) parts.push(`${health.failedRequests} failed request(s)`);
  if (health.unstable) parts.push("page visually unstable during capture");
  return parts.length > 0 ? `Page health: ${parts.join(", ")}.` : null;
}
