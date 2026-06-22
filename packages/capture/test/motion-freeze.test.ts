import { describe, expect, it } from "vitest";
import {
  MOTION_FREEZE_STYLESHEET,
  REDUCED_MOTION_MEDIA,
  freezeMotionForCapture,
  type MotionFreezeInjector,
  type MotionFreezePhases,
} from "../src/index.js";

/** Specificity as (id, class, type) — compared lexicographically, like CSS. */
type Specificity = [number, number, number];

function specGte(a: Specificity, b: Specificity): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true; // equal → later source order wins; caller handles order separately
}

/**
 * A fake page that models the parts of the CSS cascade that matter for the
 * freeze guarantee: `!important` author declarations are sorted by SPECIFICITY
 * first, and only ties broken by source order — exactly as a real browser does.
 * It also models a CDP-level animation-timeline pause that overrides the cascade.
 *
 * `isElementFrozen()` answers the real question the capture cares about: at
 * screenshot time, is the spinner's animation actually frozen?
 */
function fakePage() {
  // Each entry: a competing `animation` !important declaration.
  type Decl = { selector: string; spec: Specificity; freezes: boolean; order: number };
  const animationDecls: Decl[] = [];
  let seq = 0;
  let timelinePaused = false;

  /** Parse the freeze sheet's `*`-targeted animation rule into a decl. */
  function applyFreezeSheet(content: string): void {
    if (!content.includes("animation-duration: 0.01ms !important")) return;
    // The freeze sheet targets the universal selector `*` → specificity (0,0,0).
    animationDecls.push({ selector: "*", spec: [0, 0, 0], freezes: true, order: seq++ });
  }

  const injector: MotionFreezeInjector = {
    async addStyleSheet(content) {
      applyFreezeSheet(content);
    },
    async emulateMedia() {
      /* reduced-motion: a media-query layer; the spinner below ignores it */
    },
    async freezeAnimations() {
      timelinePaused = true;
    },
  };

  /** Late JS mounts a high-specificity, !important spinner animation. */
  function mountLateSpinner(): void {
    animationDecls.push({
      selector: ".spinner",
      spec: [0, 1, 0], // class selector beats `*`
      freezes: false, // a live spin animation
      order: seq++,
    });
  }

  /** Resolve the winning `animation` declaration on the spinner, then the timeline. */
  function isElementFrozen(): boolean {
    if (timelinePaused) return true; // CDP pause overrides the cascade entirely
    if (animationDecls.length === 0) return true; // no animation at all
    // Winner = highest specificity, ties → latest source order.
    let winner = animationDecls[0]!;
    for (const d of animationDecls) {
      if (specGte(d.spec, winner.spec) && (d.spec.join() !== winner.spec.join() || d.order > winner.order)) {
        winner = d;
      }
    }
    return winner.freezes;
  }

  return { injector, mountLateSpinner, isElementFrozen, isTimelinePaused: () => timelinePaused };
}

/** Records call order + media for the ordering assertions. */
function tracer() {
  const order: string[] = [];
  let reducedMotion = false;
  const injector: MotionFreezeInjector = {
    async addStyleSheet() {
      order.push("style");
    },
    async emulateMedia(feature) {
      if (feature.name === REDUCED_MOTION_MEDIA.name && feature.value === REDUCED_MOTION_MEDIA.value) {
        reducedMotion = true;
      }
      order.push(`media:${feature.name}=${feature.value}`);
    },
    async freezeAnimations() {
      order.push("freezeAnimations");
    },
  };
  const phases: MotionFreezePhases = {
    goto: async () => void order.push("goto"),
    awaitReadiness: async () => void order.push("readiness"),
    scrollForLazyLoad: async () => void order.push("scroll"),
  };
  return { order, injector, phases, isReduced: () => reducedMotion };
}

describe("freezeMotionForCapture (#13)", () => {
  it("emulates reduced-motion and injects the kill stylesheet before navigation", async () => {
    const { order, injector, phases, isReduced } = tracer();
    await freezeMotionForCapture(injector, phases);
    expect(isReduced()).toBe(true);
    expect(order.indexOf("goto")).toBeGreaterThan(order.indexOf("media:prefers-reduced-motion=reduce"));
    expect(order.indexOf("style")).toBeLessThan(order.indexOf("goto"));
  });

  it("runs the seam in order, ending with the engine-level animation freeze", async () => {
    const { order, injector, phases } = tracer();
    await freezeMotionForCapture(injector, phases);
    expect(order).toEqual([
      "media:prefers-reduced-motion=reduce",
      "style", // secondary CSS layer, pre-nav
      "goto",
      "readiness",
      "scroll",
      "style", // secondary CSS layer, re-applied post-scroll
      "freezeAnimations", // PRIMARY specificity-proof freeze, last
    ]);
    // The specificity-proof freeze is the final step, after the scroll.
    expect(order.lastIndexOf("freezeAnimations")).toBe(order.length - 1);
    expect(order.indexOf("freezeAnimations")).toBeGreaterThan(order.indexOf("scroll"));
  });

  it("freezes a LATE HIGH-SPECIFICITY !important animation that the CSS sheet cannot out-cascade", async () => {
    const page = fakePage();
    const phases: MotionFreezePhases = {
      goto: async () => {},
      awaitReadiness: async () => {},
      // Late JS mounts `.spinner { animation: spin 1s infinite !important }`
      // — specificity (0,1,0) beats the freeze sheet's `*` (0,0,0), so re-injecting
      // the CSS sheet "last" does NOT win. Only the timeline pause freezes it.
      scrollForLazyLoad: async () => void page.mountLateSpinner(),
    };

    await freezeMotionForCapture(page.injector, phases);

    expect(page.isTimelinePaused()).toBe(true);
    expect(page.isElementFrozen()).toBe(true);
  });

  it("CSS sheet ALONE (no timeline pause) does NOT freeze the high-specificity spinner — proving the fix is load-bearing", async () => {
    // Same page, but drive ONLY the CSS layers (the pre-fix behaviour). The
    // spinner is left running because `.spinner !important` out-specifies `*`.
    const page = fakePage();
    await page.injector.emulateMedia(REDUCED_MOTION_MEDIA);
    await page.injector.addStyleSheet(MOTION_FREEZE_STYLESHEET);
    page.mountLateSpinner();
    await page.injector.addStyleSheet(MOTION_FREEZE_STYLESHEET); // re-inject "last"
    // No freezeAnimations() call here.
    expect(page.isTimelinePaused()).toBe(false);
    expect(page.isElementFrozen()).toBe(false); // RED without the primary freeze
  });

  it("the secondary CSS layer still neutralizes animation, transition, and scroll motion", () => {
    expect(MOTION_FREEZE_STYLESHEET).toContain("animation-duration: 0.01ms !important");
    expect(MOTION_FREEZE_STYLESHEET).toContain("transition-duration: 0.01ms !important");
    expect(MOTION_FREEZE_STYLESHEET).toContain("scroll-behavior: auto !important");
    expect(MOTION_FREEZE_STYLESHEET).toContain("*::before");
    expect(MOTION_FREEZE_STYLESHEET).toContain("*::after");
  });
});
