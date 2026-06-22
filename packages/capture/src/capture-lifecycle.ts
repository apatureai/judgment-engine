import { CAPTURE_EPOCH_MS, PRELOAD_SKEW_MS, type PageClock } from "./capture-clock.js";
import { MOTION_FREEZE_STYLESHEET, REDUCED_MOTION_MEDIA, type MotionFreezeInjector } from "./motion-freeze.js";
import { awaitPageReady, recheckFontsAfterScroll, type ReadinessOps, type ReadinessOptions } from "./page-readiness.js";
import { autoScrollForLazyLoad, type LazyLoadOps, type LazyLoadResult } from "./lazy-load.js";

/**
 * Canonical capture lifecycle (TRD §4.1/§4.2). The individual determinism seams
 * — clock pin (#102), motion freeze (#13), readiness protocol (#12), lazy-load
 * scroll (#14) — are each pure + independently tested, but until now their ORDER
 * lived only in scattered prose ("re-inject after scroll", "pin after readiness").
 * The live worker (#11) would have to reconstruct that interleave from comments,
 * and a wrong order silently breaks determinism (e.g. scrolling before the freeze
 * re-inject lets a late animation win; pinning the clock before readiness hangs
 * the page on a load timer). This module is the ONE place that encodes the
 * canonical order, composing the existing seams:
 *
 *   emulateMedia(reduce) → freeze-inject → clock.install(epoch − skew)   [pre-nav]
 *   → goto(domcontentloaded,30s) → ready_selector? → fonts.ready → layout-stable  [#12]
 *   → clock.pauseAt(epoch)                                               [#102 freeze time]
 *   → autoScroll (lazy-load, infinite-scroll guard)                      [#14]
 *   → recheckFonts → freeze-RE-inject → clock.pauseAt(epoch)             [post-scroll]
 *   ⇒ page ready to screenshot
 *
 * The two cross-cutting concerns (clock, motion freeze) both wrap the same
 * goto→readiness→scroll spine; their pre-nav setup and post-scroll re-application
 * interleave around it exactly once. Per (viewport, colorScheme) context (#21),
 * the worker runs this whole lifecycle on a fresh context.
 *
 * PURE composition: every browser op is injected (the live worker #11 binds
 * goto/wait/scroll/clock/style to Playwright). Fully unit-testable with fakes —
 * no real browser.
 */

/** All injected browser ops the lifecycle drives, one bundle the worker binds. */
export interface CaptureLifecycleOps {
  clock: PageClock;
  freeze: MotionFreezeInjector;
  readiness: ReadinessOps;
  lazyLoad: LazyLoadOps;
}

export interface CaptureLifecycleOptions {
  /** Viewport height (CSS px) for the lazy-load scroll (#14). */
  viewportHeight: number;
  /** Readiness protocol options (#12): ready_selector, budgets, idle window. */
  readiness?: ReadinessOptions;
  /** Lazy-load: max viewport advances before declaring infinite scroll (#14). */
  maxScrollViewports?: number;
}

export interface CaptureLifecycleResult {
  /** Lazy-load outcome (#14): final height, infinite-scroll flag, coverage marker. */
  lazyLoad: LazyLoadResult;
}

/**
 * Run the full deterministic capture lifecycle on one (already-created, fresh)
 * browser context, leaving the page ready to screenshot: motion frozen, time
 * pinned at the epoch, fonts settled, lazy content loaded, scrolled back to top.
 */
export async function runCaptureLifecycle(
  ops: CaptureLifecycleOps,
  options: CaptureLifecycleOptions,
): Promise<CaptureLifecycleResult> {
  // --- pre-navigation: suppress motion + install the clock BEFORE goto so the
  //     first paint is already frozen and load timers still run (don't hang). ---
  await ops.freeze.emulateMedia(REDUCED_MOTION_MEDIA);
  await ops.freeze.addStyleSheet(MOTION_FREEZE_STYLESHEET);
  await ops.clock.install({ time: CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS });

  // --- navigate + settle on explicit signals (never networkidle, #12). The
  //     readiness protocol owns goto(domcontentloaded,30s) → ready_selector? →
  //     fonts.ready → layout-stable. ---
  await awaitPageReady(ops.readiness, options.readiness);

  // --- freeze time at the epoch now that the page is settled (#102). ---
  await ops.clock.pauseAt(CAPTURE_EPOCH_MS);

  // --- lazy-load: trip IntersectionObserver loads, bound infinite feeds (#14). ---
  const lazyLoad = await autoScrollForLazyLoad(ops.lazyLoad, {
    viewportHeight: options.viewportHeight,
    ...(options.maxScrollViewports !== undefined ? { maxViewports: options.maxScrollViewports } : {}),
  });

  // --- post-scroll re-application: late lazy content can pull a new font, apply
  //     its own animation, or schedule new timers — so re-check fonts (#12),
  //     RE-inject the freeze so it wins the cascade (#13), and re-pin the clock
  //     (#102), in that order, immediately before capture. ---
  await recheckFontsAfterScroll(ops.readiness);
  await ops.freeze.addStyleSheet(MOTION_FREEZE_STYLESHEET);
  await ops.clock.pauseAt(CAPTURE_EPOCH_MS);

  return { lazyLoad };
}
