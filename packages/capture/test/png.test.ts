import { describe, expect, it } from "vitest";
import { pngDimensions } from "../src/index.js";

/** Build a minimal PNG header carrying `width`x`height` in its IHDR. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("pngDimensions", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(pngDimensions(pngHeader(2880, 1800))).toEqual({ width: 2880, height: 1800 });
  });

  it("reads dimensions from a view into a larger buffer", () => {
    const backing = new Uint8Array(64);
    backing.set(pngHeader(780, 1688), 20);
    const view = backing.subarray(20, 44);
    expect(pngDimensions(view)).toEqual({ width: 780, height: 1688 });
  });

  it("rejects bytes that are not a PNG", () => {
    expect(() => pngDimensions(new Uint8Array(24))).toThrow(/bad signature/);
  });

  it("rejects a truncated file rather than reading garbage", () => {
    expect(() => pngDimensions(pngHeader(10, 10).subarray(0, 12))).toThrow(/too short/);
  });
});
