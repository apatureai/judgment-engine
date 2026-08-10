/**
 * Deterministic motion freeze for capture (TRD §4.1, #13). CSS animations,
 * transitions, and scroll-behaviour make a page render differently on every
 * shot: an in-flight fade or a mid-cycle carousel churns the stability gate
 * (#15 → false "unstable" → #70 ceiling) and makes the VLM critique transient
 * motion frames that no real user pauses on. The JS clock pin (#102, see
 * `capture-clock.ts`) freezes time-driven UI; this module freezes the CSS
 * motion that the clock does not touch.
 *
 * Two layers, primary + secondary:
 *
 * 1. PRIMARY (`freezeAnimations()`): pause the document's animation timeline at
 *    the engine level (CDP `Animation.setPlaybackRate(0)`). This is specificity-
 *    PROOF: it acts on the running animations directly, NOT through the cascade,
 *    so a late `.spinner{animation:spin 1s infinite !important}` (specificity
 *    0,1,0) is frozen just the same. Run LAST, after the lazy-load scroll, so
 *    animations that late JS mounted are caught too.
 *
 * 2. SECONDARY (the CSS kill sheet + `prefers-reduced-motion: reduce`): zeroes
 *    animation/transition/scroll-behaviour and suppresses media-query-gated
 *    motion, re-injected after the scroll. This is DEFENSE IN DEPTH, not the
 *    guarantee: an author `!important` rule with higher specificity than `*`
 *    out-cascades it (CSS sorts `!important` author declarations by specificity
 *    BEFORE source order, so re-injecting a `*`-only sheet "last" does NOT beat
 *    `.cls !important`, the bug this layering fixes). It still handles the
 *    common case (no-`!important` animations, transitions, scroll-behaviour,
 *    reduced-motion-aware sites) cheaply and covers transitions, which the
 *    Animation domain's `setPlaybackRate` does not.
 *
 * This is the PURE ordering + seam module: the real CDP `Animation.setPlaybackRate`,
 * `addStyleTag` / `emulateMedia`, and the goto/readiness/scroll phases are
 * injected (the live Playwright worker, #11, binds them). Fully unit-testable
 * with a fake injector + phase spies; no real browser.
 */

/**
 * The kill stylesheet. `*` + `*::before` + `*::after` so pseudo-element motion
 * is caught too. `!important` and the `0.01ms` (not `0`) durations are the
 * standard reduced-motion recipe: a tiny non-zero duration lets animations that
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
 * The freeze seam. The live worker binds these to Playwright/CDP:
 * - `freezeAnimations` → CDP `Animation.setPlaybackRate(0)` (the CDP session is
 *   `context.newCDPSession(page)`; this is the specificity-proof primary layer);
 * - `addStyleSheet` → `page.addStyleTag({ content })` (secondary CSS layer);
 * - `emulateMedia` → `page.emulateMedia({ reducedMotion: "reduce" })`.
 */
export interface MotionFreezeInjector {
  /**
   * Pause the document's animation timeline at the engine level (playback rate
   * 0) so EVERY running CSS animation is frozen regardless of cascade
   * specificity. The primary, specificity-proof freeze.
   */
  freezeAnimations(): Promise<void>;
  /** Append a stylesheet to the document (secondary CSS layer). */
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
 * Run the capture lifecycle with motion frozen (#13). Ordering:
 *   emulateMedia(reduce) → addStyleSheet(freeze) → goto → awaitReadiness
 *   → scrollForLazyLoad → addStyleSheet(freeze) → freezeAnimations()
 * so motion is suppressed before first paint (secondary CSS layer + reduced-
 * motion), the CSS sheet is re-applied after the scroll for the common case, and
 * LAST of all, the animation timeline is paused at the engine level so EVERY running
 * animation is frozen regardless of cascade specificity, including ones late JS
 * mounted with a higher-specificity `!important` rule the CSS sheet can't beat.
 * After this resolves the page has no in-flight motion, ready for the screenshot.
 *
 * `freezeAnimations()` runs last on purpose: it must see the final set of
 * animations (post-scroll, post-late-mount) to pause them.
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
  // Secondary CSS layer re-applied for the common (no-`!important`/low-specificity)
  // case after late content mounted.
  await injector.addStyleSheet(MOTION_FREEZE_STYLESHEET);
  // PRIMARY, specificity-proof freeze: pause the animation timeline so even a
  // late high-specificity `!important` animation is frozen at capture.
  await injector.freezeAnimations();
}
