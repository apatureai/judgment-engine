/**
 * Auto-scroll lazy-load + infinite-scroll detection for capture (TRD §4.1/§4.2,
 * #14). Many pages defer below-the-fold images/sections behind an
 * IntersectionObserver, so a single top-of-page screenshot misses them. The
 * worker scrolls the full height (and back to the top, so the final capture
 * starts clean) to trip every observer, waiting a beat for the lazy content to
 * paint.
 *
 * Some pages grow without bound (infinite feeds): each scroll appends more
 * content, so "scroll to the bottom" never terminates. We detect continuous
 * height growth and STOP after a fixed number of viewport advances, emitting an
 * `infiniteScroll` flag + a not-reviewed-beyond marker so the wire result is
 * honest that only the first N viewports were captured.
 *
 * This module is the PURE control loop: the real `window.scrollTo`, height
 * measurement, and waits are injected (the live Playwright worker, #11, binds
 * them). Fully unit-testable with a fake page model and no real browser. Runs
 * AFTER readiness (#12) and BEFORE the post-scroll font re-check + clock re-pin
 * (#12/#102) and the motion-freeze re-inject (#13).
 */

/** Settle wait after reaching the bottom, for lazy content to paint. */
export const LAZY_SETTLE_MS = 500;

/** Default cap on viewport advances before declaring infinite scroll. */
export const MAX_SCROLL_VIEWPORTS = 15;

/** Min height delta (px) that counts as real growth (ignores sub-pixel jitter). */
const GROWTH_EPSILON_PX = 4;

/** Injected page operations; the live worker (#11) binds these to Playwright. */
export interface LazyLoadOps {
  /** Current scrollable document height in CSS px. */
  measureHeight(): Promise<number>;
  /** Scroll the viewport so its top is at `y` CSS px. */
  scrollTo(y: number): Promise<void>;
  /** Wait `ms` (lazy content settle). */
  wait(ms: number): Promise<void>;
}

export interface LazyLoadOptions {
  /** Viewport height in CSS px (one scroll advance). */
  viewportHeight: number;
  /** Max viewport advances before stopping (infinite-scroll guard). */
  maxViewports?: number;
  /** Settle wait after each advance / at the bottom. */
  settleMs?: number;
}

export interface LazyLoadResult {
  /** Final measured document height after lazy content loaded. */
  finalHeight: number;
  /** Number of viewport advances performed. */
  viewportsScrolled: number;
  /** True when the page kept growing at the cap → only first N viewports captured. */
  infiniteScroll: boolean;
  /** Honest coverage marker when infinite scroll was detected (else null). */
  notReviewedBeyond: string | null;
}

/**
 * Drive the lazy-load scroll. Advance one viewport at a time, settling after
 * each so IntersectionObserver lazy-loads fire; stop when the bottom is reached
 * (height stopped growing AND we've scrolled past it) or the viewport cap is hit
 * (infinite scroll). Always scrolls back to the top at the end so the capture
 * starts from a clean position.
 */
export async function autoScrollForLazyLoad(
  ops: LazyLoadOps,
  options: LazyLoadOptions,
): Promise<LazyLoadResult> {
  const viewportHeight = options.viewportHeight;
  if (viewportHeight <= 0) throw new Error("viewportHeight must be > 0");
  const maxViewports = options.maxViewports ?? MAX_SCROLL_VIEWPORTS;
  const settleMs = options.settleMs ?? LAZY_SETTLE_MS;

  let height = await ops.measureHeight();
  let viewportsScrolled = 0;
  let infiniteScroll = false;

  while (true) {
    const offset = (viewportsScrolled + 1) * viewportHeight;
    // Bottom reached: the next advance would be at/below the current height and
    // the page isn't still growing past it.
    if (offset >= height) {
      await ops.scrollTo(height);
      await ops.wait(settleMs);
      const grown = await ops.measureHeight();
      if (grown - height <= GROWTH_EPSILON_PX) break; // settled, no more lazy content
      height = grown; // late growth from the bottom-settle; keep going
    }

    if (viewportsScrolled >= maxViewports) {
      infiniteScroll = true;
      break;
    }

    await ops.scrollTo(offset);
    await ops.wait(settleMs);
    viewportsScrolled += 1;
    const grown = await ops.measureHeight();
    height = Math.max(height, grown);
  }

  // Return to the top so the capture begins from a clean scroll position.
  await ops.scrollTo(0);

  return {
    finalHeight: height,
    viewportsScrolled,
    infiniteScroll,
    notReviewedBeyond: infiniteScroll
      ? `content below ${maxViewports * viewportHeight}px (infinite scroll — captured first ${maxViewports} viewports)`
      : null,
  };
}
