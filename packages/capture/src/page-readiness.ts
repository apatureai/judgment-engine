/**
 * Deterministic page-readiness protocol for capture (TRD §4.1, #12). Settling on
 * `networkidle` is the single biggest source of hallucinated critiques: an
 * analytics beacon or a long-poll keeps the network busy forever (timeout →
 * capture mid-render) or a tracking pixel fires early (idle → capture before
 * fonts/layout settle). So readiness here NEVER uses networkidle. It settles on
 * EXPLICIT signals in a fixed order:
 *
 *   goto(domcontentloaded, 30s budget)
 *     → [ready_selector override, if provided]
 *     → document.fonts.ready
 *     → layout-stable idle window (no layout shift for `quietMs`)
 *
 * After the lazy-load scroll (#14) the worker re-checks fonts once (late lazy
 * content can pull in a new web font), mirroring the #13/#102 re-injection
 * discipline; `recheckFontsAfterScroll` is that step.
 *
 * This module is the PURE ordering + budget seam: the real Playwright ops
 * (`page.goto`, `page.waitForSelector`, `page.evaluate(() => document.fonts.ready)`,
 * a layout-shift observer) are injected, so the protocol is fully unit-testable
 * with fakes and no real browser. The live worker (#11) binds the ops.
 */

/** `goto` budget: never `networkidle`, just a fixed wall-clock cap on navigation. */
export const GOTO_BUDGET_MS = 30_000;

/** The Playwright `waitUntil` the protocol uses. `networkidle` is deliberately absent. */
export type ReadyWaitUntil = "domcontentloaded";
export const READY_WAIT_UNTIL: ReadyWaitUntil = "domcontentloaded";

/**
 * Browser operations the protocol drives, injected so the protocol is pure. The
 * live worker (#11) binds these to Playwright.
 */
export interface ReadinessOps {
  /** Navigate; resolves on `domcontentloaded` within `timeoutMs` (never networkidle). */
  goto(options: { waitUntil: ReadyWaitUntil; timeoutMs: number }): Promise<void>;
  /** Wait for a caller-supplied readiness selector (the `ready_selector` override). */
  waitForSelector(selector: string): Promise<void>;
  /** Resolve when `document.fonts.ready` resolves (fires even on a blocked/substituted font). */
  waitForFontsReady(): Promise<void>;
  /**
   * Resolve once no layout shift has occurred for `quietMs` (a CLS-style idle
   * window), or `timeoutMs` elapses, whichever comes first. Never blocks forever.
   */
  waitForLayoutStable(options: { quietMs: number; timeoutMs: number }): Promise<void>;
}

export interface ReadinessOptions {
  /** `ready_selector` override (`.designreview.yml`); when set, awaited after goto. */
  readySelector?: string;
  /** goto budget; defaults to GOTO_BUDGET_MS. */
  gotoBudgetMs?: number;
  /** No-layout-shift idle window; defaults to 500ms. */
  layoutQuietMs?: number;
  /** Cap on the layout-stable wait; defaults to 10s (never networkidle-style hang). */
  layoutTimeoutMs?: number;
}

/**
 * Run the readiness protocol: goto(domcontentloaded, budget) → optional
 * ready_selector → fonts.ready → layout-stable idle window. Resolves when the
 * page is ready to screenshot. Each step is an injected op, so this is the pure,
 * fully-testable ordering.
 */
export async function awaitPageReady(ops: ReadinessOps, options: ReadinessOptions = {}): Promise<void> {
  const gotoBudgetMs = options.gotoBudgetMs ?? GOTO_BUDGET_MS;
  const layoutQuietMs = options.layoutQuietMs ?? 500;
  const layoutTimeoutMs = options.layoutTimeoutMs ?? 10_000;

  await ops.goto({ waitUntil: READY_WAIT_UNTIL, timeoutMs: gotoBudgetMs });
  // A caller-supplied selector is the strongest "page is ready" signal; honor it
  // before the generic font/layout settling.
  if (options.readySelector !== undefined && options.readySelector.length > 0) {
    await ops.waitForSelector(options.readySelector);
  }
  await ops.waitForFontsReady();
  await ops.waitForLayoutStable({ quietMs: layoutQuietMs, timeoutMs: layoutTimeoutMs });
}

/**
 * Re-check `document.fonts.ready` once after the lazy-load scroll (#14): late
 * lazy content can request a new web font, so the post-scroll capture must wait
 * for it too. Kept separate from `awaitPageReady` because it runs AFTER the
 * scroll step the readiness protocol precedes.
 */
export async function recheckFontsAfterScroll(ops: Pick<ReadinessOps, "waitForFontsReady">): Promise<void> {
  await ops.waitForFontsReady();
}
