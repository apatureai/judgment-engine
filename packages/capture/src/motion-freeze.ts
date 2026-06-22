/**
 * Deterministic motion freeze for capture (TRD §4.1, #13). CSS animations,
 * transitions, and scroll-behaviour make a page render differently on every
 * shot — an in-flight fade or a mid-cycle carousel churns the stability gate
 * (#15 → false "unstable" → #70 ceiling) and makes the VLM critique transient
 * motion frames that no real user pauses on. The JS clock pin (#102, see
 * `capture-clock.ts`) freezes time-driven UI; this module freezes the CSS
 * motion that the clock does not touch.
 *
 * Fix: inject a kill stylesheet that zeroes animation/transition/scroll-behaviour
 * and emulate `prefers-reduced-motion: reduce`, then RE-INJECT the stylesheet
 * after the lazy-load scroll (#14). Late JS can append its own styles or mount
 * components after first paint; re-injecting LAST means the freeze rule wins on
 * cascade order (same `!important` specificity → later sheet wins), so a
 * late-applied animation is still frozen at capture. This mirrors the #13
 * re-injection discipline the clock pin (#102) already follows.
 *
 * This is the PURE ordering + stylesheet seam: the real `addStyleTag` /
 * `emulateMedia` and the goto/readiness/scroll phases are injected (the live
 * Playwright worker, #11, binds them). Fully unit-testable with a fake injector
 * + phase spies; no real browser.
 */

/**
 * The kill stylesheet. `*` + `*::before` + `*::after` so pseudo-element motion
 * is caught too. `!important` and the `0.01ms` (not `0`) durations are the
 * standard reduced-motion recipe — a tiny non-zero duration lets animations that
 * gate JS on `animationend`/`transitionend` still fire their end event (so the
 * page doesn't hang) while completing instantly.
 */
export const MOTION_FREEZE_STYLESHEET = [
  "*, *::before, *::after {",
  "  animation-duration: 0.01ms !important;",
  "  animation-delay: 0ms !important;",
  "  animation-iteration-count: 1 !important;",
  "  transition-duration: 0.01ms !important;",
  "  transition-delay: 0ms !important;",
  "  scroll-behavior: auto !important;",
  "}",
].join("\n");

/** The media feature emulated so media-query-gated motion is also suppressed. */
export const REDUCED_MOTION_MEDIA = { name: "prefers-reduced-motion", value: "reduce" } as const;

/**
 * The injection + media-emulation seam. The live worker binds these to
 * Playwright's `page.addStyleTag({ content })` and
 * `page.emulateMedia({ reducedMotion: "reduce" })`.
 */
export interface MotionFreezeInjector {
  /** Append a stylesheet to the document; later calls win on cascade order. */
  addStyleSheet(content: string): Promise<void>;
  /** Emulate a media feature (`prefers-reduced-motion: reduce`). */
  emulateMedia(feature: { name: string; value: string }): Promise<void>;
}

/** The capture lifecycle phases the freeze interleaves with (injected, shared with #102). */
export interface MotionFreezePhases {
  /** Navigate to the target URL. */
  goto: () => Promise<void>;
  /** The readiness protocol (#12): domcontentloaded → fonts → layout-stable. */
  awaitReadiness: () => Promise<void>;
  /** Single scroll pass for lazy-load (#14), which can mount late-animated content. */
  scrollForLazyLoad: () => Promise<void>;
}

/**
 * Run the capture lifecycle with CSS motion frozen (#13). Ordering:
 *   emulateMedia(reduce) → addStyleSheet(freeze) → goto → awaitReadiness
 *   → scrollForLazyLoad → addStyleSheet(freeze)   // re-inject last
 * so motion is suppressed before first paint AND the freeze sheet is re-appended
 * after the scroll — winning the cascade over any styles late JS injected while
 * lazy content mounted. After this resolves the page has no in-flight CSS
 * motion, ready for the screenshot.
 *
 * Composed with `withDeterministicClock` (#102) by the worker (#11): the clock
 * pin handles JS-driven time, this handles CSS-driven motion.
 */
export async function freezeMotionForCapture(
  injector: MotionFreezeInjector,
  phases: MotionFreezePhases,
): Promise<void> {
  await injector.emulateMedia(REDUCED_MOTION_MEDIA);
  await injector.addStyleSheet(MOTION_FREEZE_STYLESHEET);
  await phases.goto();
  await phases.awaitReadiness();
  await phases.scrollForLazyLoad();
  // Re-inject LAST so the freeze rule wins on cascade order over any animation
  // late JS applied while lazy-loaded content mounted.
  await injector.addStyleSheet(MOTION_FREEZE_STYLESHEET);
}
