import { describe, expect, it } from "vitest";
import { CHROMIUM_MAX_DEVICE_PX, planCaptureSegments, planTiles } from "../src/index.js";

describe("planTiles (send-time)", () => {
  it("returns a single tile when the page fits the viewport", () => {
    const tiles = planTiles(700, 900);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ index: 0, count: 1, yOffset: 0, height: 700 });
  });

  it("tiles a long page with ~15% overlap, labels, and bottom alignment", () => {
    const viewport = 1000;
    const tiles = planTiles(2500, viewport, 0.15);
    expect(tiles.length).toBeGreaterThan(2);

    // Adjacent tiles overlap by at least 15% of the viewport.
    for (let i = 1; i < tiles.length; i++) {
      const overlap = tiles[i - 1]!.yOffset + viewport - tiles[i]!.yOffset;
      expect(overlap).toBeGreaterThanOrEqual(viewport * 0.15 - 1);
    }
    // Last tile is bottom-aligned: covers down to the page bottom.
    const last = tiles[tiles.length - 1]!;
    expect(last.yOffset + last.height).toBe(2500);
    // Labels carry segment k/n and the y-offset.
    expect(tiles[0]!.label).toBe(`segment 1/${tiles.length} (y=0px)`);
  });

  it("rejects an invalid overlap", () => {
    expect(() => planTiles(2000, 800, 1)).toThrow();
  });
});

describe("planCaptureSegments (capture-time ceiling)", () => {
  it("returns one segment when under the device-px ceiling", () => {
    expect(planCaptureSegments(5000, 2)).toEqual([{ yOffset: 0, height: 5000 }]);
  });

  it("splits pages past the ~16384 device-px ceiling into non-overlapping segments", () => {
    const dsf = 2;
    const pageHeight = 20000; // 40000 device px > 16384
    const segments = planCaptureSegments(pageHeight, dsf);
    expect(segments.length).toBeGreaterThan(1);
    // Each segment stays under the raster ceiling.
    for (const seg of segments) {
      expect(seg.height * dsf).toBeLessThanOrEqual(CHROMIUM_MAX_DEVICE_PX);
    }
    // Segments tile the whole page with no gap.
    expect(segments[0]!.yOffset).toBe(0);
    const last = segments[segments.length - 1]!;
    expect(last.yOffset + last.height).toBe(pageHeight);
  });
});
