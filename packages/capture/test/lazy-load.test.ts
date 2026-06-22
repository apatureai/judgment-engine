import { describe, expect, it } from "vitest";
import {
  LAZY_SETTLE_MS,
  MAX_SCROLL_VIEWPORTS,
  autoScrollForLazyLoad,
  type LazyLoadOps,
} from "../src/index.js";

/**
 * A fake page whose height grows by `growthPerScroll` on each measurement until
 * it reaches `ceilingHeight` (then settles). `growthPerScroll: Infinity`-style
 * unbounded growth is modeled by a high ceiling.
 */
function fakePage(opts: { startHeight: number; growthPerScroll: number; ceilingHeight: number }) {
  let height = opts.startHeight;
  const scrolls: number[] = [];
  let waits = 0;
  const ops: LazyLoadOps = {
    async measureHeight() {
      return height;
    },
    async scrollTo(y) {
      scrolls.push(y);
      // A scroll trips lazy-load: content appends until the ceiling.
      height = Math.min(opts.ceilingHeight, height + opts.growthPerScroll);
    },
    async wait() {
      waits++;
    },
  };
  return { ops, scrolls, getWaits: () => waits, getHeight: () => height };
}

describe("autoScrollForLazyLoad (#14)", () => {
  it("scrolls a finite page to the bottom and back to the top, settling at the bottom", async () => {
    // Static page: 2000px tall, no lazy growth.
    const page = fakePage({ startHeight: 2000, growthPerScroll: 0, ceilingHeight: 2000 });
    const result = await autoScrollForLazyLoad(page.ops, { viewportHeight: 1000 });

    expect(result.infiniteScroll).toBe(false);
    expect(result.finalHeight).toBe(2000);
    expect(result.notReviewedBeyond).toBeNull();
    // Ends back at the top for a clean capture.
    expect(page.scrolls.at(-1)).toBe(0);
    // Waited at least once (the bottom settle).
    expect(page.getWaits()).toBeGreaterThan(0);
  });

  it("keeps scrolling while lazy content grows the page, then settles", async () => {
    // Grows 1000px per scroll up to 5000, then stops.
    const page = fakePage({ startHeight: 2000, growthPerScroll: 1000, ceilingHeight: 5000 });
    const result = await autoScrollForLazyLoad(page.ops, { viewportHeight: 1000, maxViewports: 20 });

    expect(result.infiniteScroll).toBe(false);
    expect(result.finalHeight).toBe(5000);
    expect(page.scrolls.at(-1)).toBe(0);
  });

  it("detects infinite scroll and stops after the viewport cap, flagging coverage", async () => {
    // Unbounded: grows faster than we can reach the bottom.
    const page = fakePage({ startHeight: 2000, growthPerScroll: 2000, ceilingHeight: 10_000_000 });
    const result = await autoScrollForLazyLoad(page.ops, { viewportHeight: 1000, maxViewports: 5 });

    expect(result.infiniteScroll).toBe(true);
    expect(result.viewportsScrolled).toBe(5);
    expect(result.notReviewedBeyond).toBe(
      "content below 5000px (infinite scroll — captured first 5 viewports)",
    );
    expect(page.scrolls.at(-1)).toBe(0); // still returns to top
  });

  it("handles a page shorter than one viewport without scrolling past it", async () => {
    const page = fakePage({ startHeight: 400, growthPerScroll: 0, ceilingHeight: 400 });
    const result = await autoScrollForLazyLoad(page.ops, { viewportHeight: 1000 });
    expect(result.viewportsScrolled).toBe(0);
    expect(result.infiniteScroll).toBe(false);
  });

  it("waits the settle interval after advancing", async () => {
    const waited: number[] = [];
    const ops: LazyLoadOps = {
      async measureHeight() {
        return 1500;
      },
      async scrollTo() {},
      async wait(ms) {
        waited.push(ms);
      },
    };
    await autoScrollForLazyLoad(ops, { viewportHeight: 1000 });
    expect(waited.every((w) => w === LAZY_SETTLE_MS)).toBe(true);
  });

  it("rejects a non-positive viewport height", async () => {
    const page = fakePage({ startHeight: 1000, growthPerScroll: 0, ceilingHeight: 1000 });
    await expect(autoScrollForLazyLoad(page.ops, { viewportHeight: 0 })).rejects.toThrow();
  });

  it("exposes a sane default viewport cap", () => {
    expect(MAX_SCROLL_VIEWPORTS).toBeGreaterThan(0);
  });
});
