/**
 * Deterministic page clock for capture (#102, TRD §5). The CSS-animation freeze
 * (#13) and animated-region exclusion (#15) make capture deterministic for CSS
 * motion, but the page's CLOCK is otherwise uncontrolled: `Date.now()`,
 * `setTimeout`/`setInterval`, and `requestAnimationFrame` keep advancing, so
 * JS-driven time-dependent UI (relative timestamps "2 min ago", interval/rAF
 * carousels, countdowns, date-defaulting widgets) renders differently on every
 * capture — churning the stability gate (#15 → false "unstable" → #70 ceiling)
 * and breaking the frozen, content-addressed capture set the eval relies on
 * (#48/#47/#89).
 *
 * Fix: pin time with Playwright's `page.clock` using the documented ordering —
 * `install` BEFORE navigation (so load timers still fire and the page doesn't
 * hang), then `pauseAt` AFTER readiness, and re-pinned after the lazy-load scroll
 * (late JS can schedule new timers; mirrors the #13 re-injection discipline).
 *
 * This module is the PURE ordering seam: the real `page.clock` + the goto/
 * readiness/scroll phases are injected (the live Playwright worker, #11, binds
 * them). Fully unit-testable with a fake clock + phase spies; no real browser.
 *
 * Limitations (Playwright): `page.clock` is per-BrowserContext (we use one
 * context per capture, so this is clean) and does NOT cover Service Worker time
 * (microsoft/playwright#31772) — a documented gap, not handled here.
 */

/**
 * The capture epoch every capture pins to — a deterministic CONSTANT instant,
 * never wall-clock `now()`, and identical for baseline + head so diffs don't
 * churn. 2025-01-01T00:00:00Z.
 */
export const CAPTURE_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/**
 * How far before the epoch to install the clock. The page loads with time
 * flowing from here so load-time timers fire normally and the page can't hang
 * waiting on one; `pauseAt(CAPTURE_EPOCH_MS)` then freezes it at the epoch.
 */
export const PRELOAD_SKEW_MS = 60_000;

/** The subset of Playwright's `page.clock` the capture protocol drives. */
export interface PageClock {
  /** Install fake `Date`/timers/rAF initialized to `time` (ms since epoch). */
  install(options: { time: number }): Promise<void>;
  /** Jump to `time` (ms since epoch) and pause — no timers fire until resumed. */
  pauseAt(time: number): Promise<void>;
}

/** The capture lifecycle phases the clock protocol interleaves with (injected). */
export interface CapturePhases {
  /** Navigate to the target URL. */
  goto: () => Promise<void>;
  /** The readiness protocol (#12): domcontentloaded → fonts → layout-stable. */
  awaitReadiness: () => Promise<void>;
  /** Single scroll pass for lazy-load (#14). */
  scrollForLazyLoad: () => Promise<void>;
}

/**
 * Run the capture lifecycle with a deterministic, pinned clock (#102). Ordering:
 *   install(epoch - skew) → goto → awaitReadiness → pauseAt(epoch)
 *   → scrollForLazyLoad → pauseAt(epoch)
 * so load timers run during navigation, then time is frozen at the epoch before
 * capture and re-frozen after the scroll. After this resolves the page clock is
 * pinned at `CAPTURE_EPOCH_MS`, ready for the screenshot.
 */
export async function withDeterministicClock(clock: PageClock, phases: CapturePhases): Promise<void> {
  await clock.install({ time: CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS });
  await phases.goto();
  await phases.awaitReadiness();
  await clock.pauseAt(CAPTURE_EPOCH_MS);
  await phases.scrollForLazyLoad();
  await clock.pauseAt(CAPTURE_EPOCH_MS);
}
