import { describe, expect, it } from "vitest";
import {
  MOTION_FREEZE_STYLESHEET,
  REDUCED_MOTION_MEDIA,
  freezeMotionForCapture,
  type MotionFreezeInjector,
  type MotionFreezePhases,
} from "../src/index.js";

/**
 * Records every injection + media call and the order of appended stylesheets, so
 * the test can reason about cascade order (later sheet wins at equal specificity)
 * exactly as the browser would.
 */
function tracer() {
  const order: string[] = [];
  const sheets: string[] = [];
  let reducedMotion = false;
  const injector: MotionFreezeInjector = {
    async addStyleSheet(content) {
      sheets.push(content);
      order.push("style");
    },
    async emulateMedia(feature) {
      if (feature.name === REDUCED_MOTION_MEDIA.name && feature.value === REDUCED_MOTION_MEDIA.value) {
        reducedMotion = true;
      }
      order.push(`media:${feature.name}=${feature.value}`);
    },
  };
  const phases: MotionFreezePhases = {
    goto: async () => void order.push("goto"),
    awaitReadiness: async () => void order.push("readiness"),
    scrollForLazyLoad: async () => void order.push("scroll"),
  };
  return { order, sheets, injector, phases, isReduced: () => reducedMotion };
}

describe("freezeMotionForCapture (#13)", () => {
  it("emulates reduced-motion and injects the kill stylesheet before navigation", async () => {
    const { order, injector, phases, isReduced } = tracer();
    await freezeMotionForCapture(injector, phases);
    expect(isReduced()).toBe(true);
    // media + first freeze sheet both precede goto
    expect(order.indexOf("goto")).toBeGreaterThan(order.indexOf("media:prefers-reduced-motion=reduce"));
    expect(order.indexOf("style")).toBeLessThan(order.indexOf("goto"));
  });

  it("re-injects the freeze stylesheet after the scroll, immediately before capture", async () => {
    const { order, injector, phases } = tracer();
    await freezeMotionForCapture(injector, phases);
    expect(order).toEqual([
      "media:prefers-reduced-motion=reduce",
      "style",
      "goto",
      "readiness",
      "scroll",
      "style",
    ]);
    // exactly two freeze injections, the second strictly after the scroll
    const styleAt = order.flatMap((o, i) => (o === "style" ? [i] : []));
    expect(styleAt).toHaveLength(2);
    expect(styleAt[1]!).toBeGreaterThan(order.indexOf("scroll"));
  });

  it("freezes a late-injected animation: the freeze sheet wins the cascade at capture", async () => {
    // The browser applies stylesheets in source order; at equal !important
    // specificity the LAST-applied rule wins. We model the cascade as the ordered
    // list of sheets and assert the freeze rule is last after a late JS animation.
    const cascade: string[] = [];
    const injector: MotionFreezeInjector = {
      async addStyleSheet(content) {
        cascade.push(content);
      },
      async emulateMedia() {
        /* reduced-motion emulation, irrelevant to cascade order here */
      },
    };
    const LATE_ANIMATION = "@keyframes spin{to{transform:rotate(360deg)}} .x{animation:spin 1s infinite!important}";
    const phases: MotionFreezePhases = {
      goto: async () => {},
      awaitReadiness: async () => {},
      // Late JS mounts lazy content and appends its own animation during the scroll.
      scrollForLazyLoad: async () => void cascade.push(LATE_ANIMATION),
    };

    await freezeMotionForCapture(injector, phases);

    // The late animation is in the cascade, but the freeze stylesheet is applied
    // AFTER it, so the freeze wins — the element is frozen at capture.
    expect(cascade).toContain(LATE_ANIMATION);
    expect(cascade.at(-1)).toBe(MOTION_FREEZE_STYLESHEET);
    expect(cascade.lastIndexOf(MOTION_FREEZE_STYLESHEET)).toBeGreaterThan(cascade.indexOf(LATE_ANIMATION));
  });

  it("the kill stylesheet neutralizes animation, transition, and scroll motion", () => {
    expect(MOTION_FREEZE_STYLESHEET).toContain("animation-duration: 0.01ms !important");
    expect(MOTION_FREEZE_STYLESHEET).toContain("transition-duration: 0.01ms !important");
    expect(MOTION_FREEZE_STYLESHEET).toContain("scroll-behavior: auto !important");
    // covers pseudo-elements so ::before/::after motion is caught too
    expect(MOTION_FREEZE_STYLESHEET).toContain("*::before");
    expect(MOTION_FREEZE_STYLESHEET).toContain("*::after");
  });
});
