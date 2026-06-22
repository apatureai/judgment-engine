import { describe, expect, it } from "vitest";
import {
  CAPTURE_EPOCH_MS,
  PRELOAD_SKEW_MS,
  MOTION_FREEZE_STYLESHEET,
  runCaptureLifecycle,
  type CaptureLifecycleOps,
} from "../src/index.js";

/** Records every op across clock/freeze/readiness/lazy-load in call order. */
function tracer(opts: { pageHeight?: number } = {}) {
  const order: string[] = [];
  const height = opts.pageHeight ?? 1500;
  const ops: CaptureLifecycleOps = {
    clock: {
      async install({ time }) {
        order.push(`clock.install@${time}`);
      },
      async pauseAt(time) {
        order.push(`clock.pauseAt@${time}`);
      },
    },
    freeze: {
      async emulateMedia(f) {
        order.push(`freeze.media:${f.name}=${f.value}`);
      },
      async addStyleSheet(content) {
        order.push(content === MOTION_FREEZE_STYLESHEET ? "freeze.style" : "freeze.style?");
      },
    },
    readiness: {
      async goto(o) {
        order.push(`ready.goto:${o.waitUntil}@${o.timeoutMs}`);
      },
      async waitForSelector(s) {
        order.push(`ready.selector:${s}`);
      },
      async waitForFontsReady() {
        order.push("ready.fonts");
      },
      async waitForLayoutStable() {
        order.push("ready.layout");
      },
    },
    lazyLoad: {
      async measureHeight() {
        return height;
      },
      async scrollTo(y) {
        order.push(`scroll:${y}`);
      },
      async wait() {
        order.push("scroll.wait");
      },
    },
  };
  return { order, ops };
}

describe("runCaptureLifecycle (capture glue)", () => {
  it("runs the seams in the canonical deterministic order", async () => {
    const { order, ops } = tracer({ pageHeight: 800 }); // < viewport, no scroll advance
    await runCaptureLifecycle(ops, { viewportHeight: 1000 });

    // Filter scroll bookkeeping to assert the high-level phase order precisely.
    const phases = order.filter((o) => !o.startsWith("scroll"));
    expect(phases).toEqual([
      // pre-nav: motion suppressed + clock installed before goto
      "freeze.media:prefers-reduced-motion=reduce",
      "freeze.style",
      `clock.install@${CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS}`,
      // navigate + settle (#12), never networkidle
      "ready.goto:domcontentloaded@30000",
      "ready.fonts",
      "ready.layout",
      // freeze time once settled
      `clock.pauseAt@${CAPTURE_EPOCH_MS}`,
      // (lazy-load scroll happens here)
      // post-scroll: re-check fonts, RE-inject freeze, re-pin clock
      "ready.fonts",
      "freeze.style",
      `clock.pauseAt@${CAPTURE_EPOCH_MS}`,
    ]);
  });

  it("installs the clock BEFORE goto and re-pins it AFTER the scroll (twice total)", async () => {
    const { order, ops } = tracer();
    await runCaptureLifecycle(ops, { viewportHeight: 1000 });
    const install = order.indexOf(`clock.install@${CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS}`);
    const goto = order.findIndex((o) => o.startsWith("ready.goto"));
    expect(install).toBeLessThan(goto);
    expect(order.filter((o) => o === `clock.pauseAt@${CAPTURE_EPOCH_MS}`)).toHaveLength(2);
  });

  it("re-injects the freeze stylesheet AFTER the scroll so a late animation loses the cascade", async () => {
    const { order, ops } = tracer();
    await runCaptureLifecycle(ops, { viewportHeight: 1000 });
    const styleInjections = order.flatMap((o, i) => (o === "freeze.style" ? [i] : []));
    expect(styleInjections).toHaveLength(2);
    const lastScroll = order.map((o) => o.startsWith("scroll")).lastIndexOf(true);
    expect(styleInjections[1]!).toBeGreaterThan(lastScroll); // re-inject is post-scroll
  });

  it("honors a ready_selector override inside the readiness phase", async () => {
    const { order, ops } = tracer();
    await runCaptureLifecycle(ops, { viewportHeight: 1000, readiness: { readySelector: "#ready" } });
    const sel = order.indexOf("ready.selector:#ready");
    expect(sel).toBeGreaterThan(order.findIndex((o) => o.startsWith("ready.goto")));
    expect(sel).toBeLessThan(order.indexOf("ready.fonts"));
  });

  it("returns the lazy-load result so infinite-scroll coverage flows out", async () => {
    // 5000px page needs 5 viewport advances but the cap is 2 → infinite-scroll.
    const { ops } = tracer({ pageHeight: 5000 });
    const result = await runCaptureLifecycle(ops, { viewportHeight: 1000, maxScrollViewports: 2 });
    expect(result.lazyLoad.infiniteScroll).toBe(true);
    expect(result.lazyLoad.viewportsScrolled).toBe(2);
    expect(result.lazyLoad.notReviewedBeyond).toContain("infinite scroll");

    // A page that fits within the cap settles normally.
    const fits = tracer({ pageHeight: 1800 });
    const settled = await runCaptureLifecycle(fits.ops, { viewportHeight: 1000, maxScrollViewports: 15 });
    expect(settled.lazyLoad.infiniteScroll).toBe(false);
  });
});
