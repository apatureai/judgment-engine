/**
 * Minimal PNG header reader. A capture must report the true pixel dimensions of
 * the bytes it stored (they drive the pixel-budget fit and the coordinate
 * rescale), and the only authority on that is the file itself, not the viewport
 * we asked for, which ignores the device scale factor and full-page height.
 *
 * Only the 8-byte signature and the IHDR width/height are read; no decoding, no
 * image library.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngDimensions {
  width: number;
  height: number;
}

/** Read `width`/`height` from a PNG's IHDR chunk. Throws if the bytes are not a PNG. */
export function pngDimensions(bytes: Uint8Array): PngDimensions {
  if (bytes.length < 24) throw new Error("not a PNG: too short");
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG: bad signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
