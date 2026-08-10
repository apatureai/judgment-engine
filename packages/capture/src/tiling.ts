/**
 * Full-page tiling (TRD §4.2/§16). Two independent concerns:
 *
 * 1. **Capture-time** segmentation: Chromium can't raster a surface taller than
 *    ~16384 device px, so very long pages are captured in non-overlapping
 *    segments under that ceiling.
 * 2. **Send-time** tiling: the page is sent to the model as viewport-height
 *    tiles with 15% overlap, each labeled (`segment k/n, y=Ypx`) so the model
 *    can reference a region and findings map back to a y-offset.
 *
 * Pure geometry: the actual screenshot rastering is the worker seam; this is
 * fully testable without a browser. Each resulting tile is then fitted to the
 * model pixel budget via `fitForDepth` (#16).
 */

/** Chromium's maximum raster height in device pixels. */
export const CHROMIUM_MAX_DEVICE_PX = 16384;

/** Send-time overlap between adjacent tiles. */
export const DEFAULT_TILE_OVERLAP = 0.15;

export interface CaptureSegment {
  yOffset: number;
  height: number;
}

export interface Tile {
  index: number;
  count: number;
  yOffset: number;
  height: number;
  /** Labeled image-block caption sent alongside the tile. */
  label: string;
}

/**
 * Split a page into non-overlapping capture segments that each stay under the
 * device-px raster ceiling. Returns a single full-page segment when it fits.
 */
export function planCaptureSegments(
  pageHeightPx: number,
  deviceScaleFactor: number,
  ceilingDevicePx: number = CHROMIUM_MAX_DEVICE_PX,
): CaptureSegment[] {
  if (pageHeightPx <= 0) throw new Error("page height must be positive");
  if (pageHeightPx * deviceScaleFactor <= ceilingDevicePx) {
    return [{ yOffset: 0, height: pageHeightPx }];
  }
  const maxCssHeight = Math.floor(ceilingDevicePx / deviceScaleFactor);
  const segments: CaptureSegment[] = [];
  for (let y = 0; y < pageHeightPx; y += maxCssHeight) {
    segments.push({ yOffset: y, height: Math.min(maxCssHeight, pageHeightPx - y) });
  }
  return segments;
}

/**
 * Tile a page into viewport-height, labeled, overlapping send tiles. Adjacent
 * tiles overlap by `overlap` (default 15%); the final tile is bottom-aligned so
 * the whole page is covered with no gap.
 */
export function planTiles(
  pageHeightPx: number,
  viewportHeightPx: number,
  overlap: number = DEFAULT_TILE_OVERLAP,
): Tile[] {
  if (pageHeightPx <= 0 || viewportHeightPx <= 0) {
    throw new Error("dimensions must be positive");
  }
  if (overlap < 0 || overlap >= 1) throw new Error("overlap must be in [0, 1)");

  const label = (yOffset: number, index: number, count: number): string =>
    `segment ${index + 1}/${count} (y=${yOffset}px)`;

  if (pageHeightPx <= viewportHeightPx) {
    return [{ index: 0, count: 1, yOffset: 0, height: pageHeightPx, label: label(0, 0, 1) }];
  }

  const step = Math.max(1, Math.floor(viewportHeightPx * (1 - overlap)));
  const offsets: number[] = [];
  for (let y = 0; y < pageHeightPx - viewportHeightPx; y += step) offsets.push(y);
  const bottom = pageHeightPx - viewportHeightPx;
  if (offsets[offsets.length - 1] !== bottom) offsets.push(bottom);

  return offsets.map((yOffset, index) => ({
    index,
    count: offsets.length,
    yOffset,
    height: viewportHeightPx,
    label: label(yOffset, index, offsets.length),
  }));
}
